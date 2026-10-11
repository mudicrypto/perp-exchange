import { MatchingEngine, type EngineConfig, type EngineSnapshot } from "./engine.ts";
import { canonicalJson, GENESIS_HASH, Journal, readJournal, sha256 } from "./journal.ts";
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
 *   1. validate the command (Zod)
 *   2. assign seq + timestamp and append to the journal (write-ahead)
 *   3. apply to the deterministic engine
 *   4. hash-chain the outputs, then route them: public tape, per-account
 *      outboxes, audit stores
 *
 * After a crash, `Venue.recover` rebuilds the identical state from a snapshot
 * plus the journal suffix and regenerates the same outputs; consumers drop
 * outputs whose `seq` they have already processed.
 */

export interface VenueOptions {
  readonly engine: EngineConfig;
  /** Sequencer clock (ms). Timestamps are clamped to be non-decreasing. */
  readonly clock: () => number;
  /** Private events kept per account for polling clients (oldest dropped first). */
  readonly outboxCapacity?: number;
}

export interface VenueSnapshot {
  readonly engine: EngineSnapshot;
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
  historyComplete = true;

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

  submit(command: EngineCommand): CommandResult {
    const parsed = engineCommandSchema.safeParse(command);
    if (!parsed.success) throw new Error("invalid engine command");
    const ts = Math.max(this.options.clock(), this.journal.lastTs);
    const entry = this.journal.append(ts, parsed.data);
    return this.apply(entry);
  }

  private apply(entry: SequencedCommand): CommandResult {
    const result = this.engineRef.process(entry);
    this.outputHash = sha256(`${this.outputHash}\n${canonicalJson(result)}`);
    this.executions.push(...result.executions);
    for (const t of result.transitions) this.transitions.push({ ...t, seq: result.seq });
    if (result.adminError) this.adminErrors.push({ seq: result.seq, error: result.adminError });
    for (const message of result.public) {
      this.publicTape.push(message);
      for (const listener of this.publicListeners) listener(message);
    }
    const capacity = this.options.outboxCapacity ?? 10_000;
    for (const event of result.private) {
      let box = this.outbox.get(event.accountId);
      if (!box) this.outbox.set(event.accountId, (box = []));
      box.push(event);
      if (box.length > capacity) box.shift();
    }
    return result;
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
    return { engine: this.engineRef.snapshot(), journalHead: this.journal.head, outputHead: this.outputHash };
  }

  /**
   * Rebuilds a venue from a serialised journal (untrusted input: parsed,
   * validated and hash-checked) and an optional snapshot taken from it.
   */
  static recover(options: VenueOptions, journalJsonl: string, snapshot?: VenueSnapshot): { venue: Venue; report: RecoveryReport } {
    const read = readJournal(journalJsonl);
    if (!read.ok) throw new Error(`journal corrupt at line ${read.failedAtLine}: ${read.reason}`);
    const fromSeq = snapshot?.engine.lastSeq ?? 0;
    if (fromSeq > read.entries.length) throw new Error("snapshot is newer than the journal");
    const expectedHead = fromSeq === 0 ? GENESIS_HASH : read.entries[fromSeq - 1]!.hash;
    if (snapshot && snapshot.journalHead !== expectedHead) throw new Error("snapshot does not belong to this journal");
    const engine = snapshot ? MatchingEngine.restore(options.engine, snapshot.engine) : new MatchingEngine(options.engine);
    const venue = new Venue(options, Journal.fromEntries(read.entries), engine);
    if (snapshot) {
      venue.outputHash = snapshot.outputHead;
      venue.historyComplete = false;
    }
    let replayed = 0;
    for (const entry of read.entries.slice(fromSeq)) {
      venue.apply(entry);
      replayed++;
    }
    return { venue, report: { replayed, fromSnapshotSeq: fromSeq, tornTail: read.tornTail, journalHead: read.head } };
  }
}
