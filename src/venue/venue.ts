import { EngineIntegrityError, MatchingEngine, type EngineConfig, type EngineSnapshot } from "./engine.ts";
import { canonicalJson, GENESIS_HASH, Journal, readJournal, sha256 } from "./journal.ts";
import { assertIdKeyPolicy } from "./id-key.ts";
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
  /**
   * Accept a registered deterministic test-fixture id key (tests, demo, benchmarks only).
   * Never relaxes the key policy for any other key (MATCHING-RULES A-5).
   */
  readonly allowTestFixtureIdKey?: boolean;
  /**
   * Idempotency ledger entries kept (oldest evicted first; default 100 000). After eviction the
   * engine's permanent client-id index still refuses the duplicate (A-4). Recorded in snapshots;
   * restoring a snapshot under a different capacity is refused (VR-26).
   */
  readonly idempotencyCapacity?: number;
  /** Sequencer clock (ms). Timestamps are clamped to be non-decreasing. */
  readonly clock: () => number;
  /** Private events kept per account for polling clients (oldest dropped first). */
  readonly outboxCapacity?: number;
}

/**
 * Idempotency ledger entry (MATCHING-RULES A-4): one per accepted new order, keyed by
 * (account, client order id). Derived only from journaled commands and their deterministic
 * results, so replaying the journal rebuilds it exactly.
 */
export interface IdempotencyRecord {
  readonly seq: number;
  /** Canonical JSON of the journaled (normalised) new-order command. */
  readonly command: string;
  /** Private events the command produced for the requesting account (the original response). */
  readonly events: readonly PrivateEvent[];
}

export interface VenueSnapshot {
  readonly engine: EngineSnapshot;
  /** State hash at snapshot time; restore must reproduce it exactly. */
  readonly stateHash: string;
  /** Hash of the journal entry the snapshot was taken after (binds snapshot to journal). */
  readonly journalHead: string;
  readonly outputHead: string;
  /** Idempotency ledger at snapshot time, in eviction order, its capacity, and a hash over both (verified on restore). */
  readonly idempotency: readonly (readonly [string, IdempotencyRecord])[];
  readonly idempotencyCapacity: number;
  readonly idempotencyHash: string;
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
  private readonly ledger = new Map<string, IdempotencyRecord>();

  constructor(options: VenueOptions, journal = new Journal(), engine?: MatchingEngine) {
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
    engine ??= new MatchingEngine(options.engine);
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
      this.route(result, entry);
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
    this.route(result, entry);
    return result;
  }

  private route(result: CommandResult, entry: SequencedCommand): void {
    // Every routed event is delivered by reference to several consumers (the first response, the account's
    // outbox, the public tape, each listener). Freezing makes them immutable, so no consumer can alter what
    // another observes (VR-29). The engine builds a fresh object per event and keeps none of them; a
    // request-rejected event's `ref` is the journaled command's own object, frozen with it.
    for (const event of result.private) deepFreeze(event);
    for (const message of result.public) deepFreeze(message);
    this.recordIdempotency(result, entry);
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

  /** Ledger update: only accepted new orders consume a client order id (A-4, §11). */
  private recordIdempotency(result: CommandResult, entry: SequencedCommand): void {
    const command = entry.command;
    if (command.type !== "new-order") return;
    const events = result.private.filter((e) => e.accountId === command.accountId);
    if (!events.some((e) => e.kind === "accepted")) return;
    // A deep-frozen private copy: responses, outboxes and callers can never alter what later replays return (VR-25).
    this.ledger.set(ledgerKey(command.accountId, command.clientOrderId), frozenRecord({ seq: entry.seq, command: canonicalJson(command), events }));
    if (this.ledger.size > this.idempotencyCapacity) this.ledger.delete(this.ledger.keys().next().value!);
  }

  private get idempotencyCapacity(): number {
    return this.options.idempotencyCapacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
  }

  /** The ledger entry for an accepted order, if it is still within capacity. Deep-frozen; callers clone before handing it out. */
  acceptedOrder(accountId: string, clientOrderId: string): IdempotencyRecord | undefined {
    return this.ledger.get(ledgerKey(accountId, clientOrderId));
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
    const idempotency = [...this.ledger].map(([k, r]) => [k, r] as const);
    const idempotencyCapacity = this.idempotencyCapacity;
    return {
      engine: this.engineRef.snapshot(),
      stateHash: this.engineRef.stateHash(),
      journalHead: this.journal.head,
      outputHead: this.outputHash,
      idempotency,
      idempotencyCapacity,
      idempotencyHash: ledgerHash(idempotency, idempotencyCapacity),
    };
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
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
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
    if (snapshot && ledgerHash(snapshot.idempotency, snapshot.idempotencyCapacity) !== snapshot.idempotencyHash) throw new Error("snapshot idempotency ledger hash mismatch");
    const capacity = options.idempotencyCapacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
    if (snapshot && snapshot.idempotencyCapacity !== capacity) {
      throw new Error(`snapshot idempotency capacity ${snapshot.idempotencyCapacity} differs from the configured ${capacity}; restore with the same capacity or recover by full replay (VR-26)`);
    }
    const venue = new Venue(options, Journal.fromEntries(read.entries), engine);
    if (snapshot) {
      venue.outputHash = snapshot.outputHead;
      for (const [k, r] of snapshot.idempotency) venue.ledger.set(k, frozenRecord(r));
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

const ledgerKey = (accountId: string, clientOrderId: string) => `${accountId}\u0000${clientOrderId}`;

export const DEFAULT_IDEMPOTENCY_CAPACITY = 100_000;

const ledgerHash = (entries: readonly (readonly [string, IdempotencyRecord])[], capacity: number) => sha256(canonicalJson({ capacity, entries }));

/** Deep, private, immutable copy of a ledger record. */
function frozenRecord(record: IdempotencyRecord): IdempotencyRecord {
  return deepFreeze(structuredClone(record));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
