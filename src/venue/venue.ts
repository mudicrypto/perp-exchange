import { EngineIntegrityError, MatchingEngine, type EngineConfig, type EngineSnapshot } from "./engine.ts";
import { canonicalJson, GENESIS_HASH, Journal, readJournal, sha256 } from "./journal.ts";
import type { JournalStore } from "./storage.ts";
import {
  engineCommandSchema,
  type CommandResult,
  type EngineCommand,
  type Execution,
  type PrivateEvent,
  type PublicMessage,
  type SequencedCommand,
  type Transition,
} from "./types.ts";

/**
 * Sequencer + engine + output routing for the local prototype.
 *
 * Processing order per command (durable event processing):
 *   1. refuse if the venue has stopped (nothing is journaled)
 *   2. validate the command (Zod)
 *   3. assign seq + timestamp and append to the durable store (commit point)
 *   4. apply to the deterministic engine
 *   5. hash-chain the outputs, record them in the audit stores, public tape
 *      and per-account outboxes, and only then notify public listeners
 *      (a failing listener cannot block or corrupt delivery)
 *
 * Errors: `VenueUnavailableError` means nothing was journaled (safe to retry).
 * `OutcomeUnknownError` means the command was, or may have been, journaled
 * and will take effect on recovery if it was; the venue then stops.
 *
 * After a crash, `Venue.recover` rebuilds the identical state from a snapshot
 * plus the journal suffix and regenerates the same outputs; consumers drop
 * outputs whose `seq` they have already processed.
 */

export class VenueUnavailableError extends Error {
  override readonly name = "VenueUnavailableError";
}

export class OutcomeUnknownError extends Error {
  override readonly name = "OutcomeUnknownError";
  readonly seq: number;
  constructor(seq: number, message: string) {
    super(message);
    this.seq = seq;
  }
}

/** Persistence boundaries at which a test subclass may simulate process death (see `Venue.boundary`). */
export type PersistenceBoundary = "after-journal" | "after-process";

export interface VenueOptions {
  readonly engine: EngineConfig;
  /** Durable journal store. Without one, the in-memory journal is the only record. */
  readonly store?: JournalStore;
  /** Sequencer clock (ms). Timestamps are clamped to be non-decreasing. */
  readonly clock: () => number;
  /** Private events kept per account for polling clients (oldest dropped first). */
  readonly outboxCapacity?: number;
}

export interface VenueSnapshot {
  readonly engine: EngineSnapshot;
  /** State hash at snapshot time; restore must reproduce it exactly. */
  readonly stateHash: string;
  /** Hash of the journal entry the snapshot was taken after (binds snapshot to journal). */
  readonly journalHead: string;
  readonly outputHead: string;
}

export interface RecoveryReport {
  readonly replayed: number;
  readonly fromSnapshotSeq: number;
  readonly tornTail: boolean;
  readonly journalHead: string;
}

export class Venue {
  readonly journal: Journal;
  private engineRef: MatchingEngine;
  private readonly options: VenueOptions;
  private readonly outbox = new Map<string, PrivateEvent[]>();
  private readonly publicListeners = new Set<(message: PublicMessage) => void>();
  private outputHash = GENESIS_HASH;
  /** Audit stores (operator access only). Complete only if built from seq 1. */
  readonly executions: Execution[] = [];
  readonly transitions: (Transition & { seq: number })[] = [];
  readonly publicTape: PublicMessage[] = [];
  readonly adminErrors: { seq: number; error: string }[] = [];
  /** Public listeners that threw (isolated; delivery to stores and other listeners continued). */
  listenerFailures = 0;
  historyComplete = true;
  private haltedReason: string | null = null;

  constructor(options: VenueOptions, journal = new Journal(), engine = new MatchingEngine(options.engine)) {
    this.options = options;
    this.journal = journal;
    this.engineRef = engine;
  }

  get engine(): MatchingEngine {
    return this.engineRef;
  }

  /** Head of the hash chain over every command result (determinism witness). */
  get outputHead(): string {
    return this.outputHash;
  }

  /** Why the venue stopped accepting commands, or null while it is running. */
  get stoppedReason(): string | null {
    return this.haltedReason ?? this.engineRef.stoppedReason;
  }

  submit(command: EngineCommand): CommandResult {
    const stopped = this.stoppedReason;
    if (stopped) throw new VenueUnavailableError(`venue stopped: ${stopped}`);
    const parsed = engineCommandSchema.safeParse(command);
    if (!parsed.success) throw new Error("invalid engine command");
    const ts = Math.max(this.options.clock(), this.journal.lastTs);
    const entry = this.journal.prepare(ts, parsed.data);
    try {
      this.options.store?.append(`${canonicalJson(entry)}\n`);
    } catch (error) {
      this.haltedReason = `journal write failed at seq ${entry.seq}`;
      throw new OutcomeUnknownError(entry.seq, `${this.haltedReason}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.journal.commit(entry);
    this.crashPoint("after-journal", entry.seq);
    let result: CommandResult;
    try {
      result = this.engineRef.process(entry);
    } catch (error) {
      throw new OutcomeUnknownError(entry.seq, `engine stopped at seq ${entry.seq}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.crashPoint("after-process", entry.seq);
    // Past the commit point every failure is "outcome unknown", never "nothing recorded".
    try {
      this.route(result);
    } catch (error) {
      this.haltedReason = `output routing failed at seq ${entry.seq}`;
      throw new OutcomeUnknownError(entry.seq, `${this.haltedReason}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  /**
   * No-op in the venue. Crash tests subclass `Venue` and throw here to simulate process death at
   * a persistence boundary; production code has no way to configure it.
   */
  protected boundary(point: PersistenceBoundary, seq: number): void {
    void point;
    void seq;
  }

  private crashPoint(point: PersistenceBoundary, seq: number) {
    try {
      this.boundary(point, seq);
    } catch (error) {
      // A crash gives no answer at all; if anything observes it, the truthful answer is "unknown".
      this.haltedReason = `simulated crash at seq ${seq}`;
      throw new OutcomeUnknownError(seq, `${this.haltedReason}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private apply(entry: SequencedCommand): CommandResult {
    const result = this.engineRef.process(entry);
    this.route(result);
    return result;
  }

  private route(result: CommandResult): void {
    this.outputHash = sha256(`${this.outputHash}\n${canonicalJson(result)}`);
    this.executions.push(...result.executions);
    for (const t of result.transitions) this.transitions.push({ ...t, seq: result.seq });
    if (result.adminError) this.adminErrors.push({ seq: result.seq, error: result.adminError });
    this.publicTape.push(...result.public);
    const capacity = this.options.outboxCapacity ?? 10_000;
    for (const event of result.private) {
      let box = this.outbox.get(event.accountId);
      if (!box) this.outbox.set(event.accountId, (box = []));
      box.push(event);
      if (box.length > capacity) box.shift();
    }
    for (const message of result.public) {
      for (const listener of this.publicListeners) {
        try {
          listener(message);
        } catch {
          this.listenerFailures++;
        }
      }
    }
  }

  onPublic(listener: (message: PublicMessage) => void): () => void {
    this.publicListeners.add(listener);
    return () => this.publicListeners.delete(listener);
  }

  /** Private events of one account only, after the given per-account sequence. */
  privateEvents(accountId: string, afterAccountSeq = 0): PrivateEvent[] {
    return (this.outbox.get(accountId) ?? []).filter((e) => e.accountSeq > afterAccountSeq);
  }

  snapshot(): VenueSnapshot {
    return { engine: this.engineRef.snapshot(), stateHash: this.engineRef.stateHash(), journalHead: this.journal.head, outputHead: this.outputHash };
  }

  /**
   * Rebuilds a venue from a serialised journal (untrusted input: parsed,
   * validated and hash-checked) and an optional snapshot taken from it.
   * Pass either `journalJsonl` (no store) or `options.store` (no text), never
   * both: the recovered venue appends to the store, so its state must come
   * from that same store. The store is repaired (torn tail truncated, final
   * newline restored) only after the journal, the snapshot and the whole
   * replay have succeeded; a failed recovery leaves it untouched.
   */
  static recover(options: VenueOptions, journalJsonl?: string, snapshot?: VenueSnapshot): { venue: Venue; report: RecoveryReport } {
    if (journalJsonl !== undefined && options.store) throw new Error("recover from journal text or from a store, not both");
    const text = journalJsonl ?? options.store?.read();
    if (text === undefined) throw new Error("no journal to recover from");
    const read = readJournal(text);
    if (!read.ok) throw new Error(`journal corrupt at line ${read.failedAtLine}: ${read.reason}`);
    const fromSeq = snapshot?.engine.lastSeq ?? 0;
    if (fromSeq > read.entries.length) throw new Error("snapshot is newer than the journal");
    const expectedHead = fromSeq === 0 ? GENESIS_HASH : read.entries[fromSeq - 1]!.hash;
    if (snapshot && snapshot.journalHead !== expectedHead) throw new Error("snapshot does not belong to this journal");
    const engine = snapshot ? MatchingEngine.restore(options.engine, snapshot.engine) : new MatchingEngine(options.engine);
    if (snapshot && engine.stateHash() !== snapshot.stateHash) throw new Error("snapshot state hash mismatch (corrupted or altered snapshot)");
    const venue = new Venue(options, Journal.fromEntries(read.entries), engine);
    if (snapshot) {
      venue.outputHash = snapshot.outputHead;
      venue.historyComplete = false;
    }
    let replayed = 0;
    for (const entry of read.entries.slice(fromSeq)) {
      try {
        venue.apply(entry);
      } catch (error) {
        // A command that faults deterministically faults again on every replay ("poison command").
        if (error instanceof EngineIntegrityError) throw new Error(`replay stopped at seq ${entry.seq}: ${error.message}`);
        throw error;
      }
      replayed++;
    }
    if (options.store) {
      options.store.truncate(read.validLength);
      if (read.validLength > 0 && !text.slice(0, read.validLength).endsWith("\n")) options.store.append("\n");
    }
    return { venue, report: { replayed, fromSnapshotSeq: fromSeq, tornTail: read.tornTail, journalHead: read.head } };
  }
}
