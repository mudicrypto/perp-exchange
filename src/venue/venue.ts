import { encodeCommitRecord, newLineage, selectCommitRecord, slotFor, type CommitRecord } from "./commit-record.ts";
import { EngineIntegrityError, MatchingEngine, type EngineConfig, type EngineSnapshot } from "./engine.ts";
import { canonicalJson, GENESIS_HASH, Journal, readJournal, sha256 } from "./journal.ts";
import { assertIdKeyPolicy } from "./id-key.ts";
import { VENUE_RULES_VERSION } from "./rules-version.ts";
import type { CommitRecordStore, JournalStore } from "./storage.ts";
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
 *   3. assign seq + timestamp and append to the durable store
 *   3b. with a commit-record store: write the commit record (MATCHING-RULES D-6). Only then is the
 *      command committed; without one, the journal append is the commit point (Milestone 10)
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

/**
 * Recovery refused the stores (DURABILITY-PROTOCOL §1.3 RI-1): nothing was written to the journal
 * store or the commit-record store. `code` names the condition (F1–F10, or a snapshot or argument check).
 */
export class RecoveryRefusedError extends Error {
  override readonly name: string = "RecoveryRefusedError";
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/**
 * A command faulted during replay (poison command, MATCHING-RULES D-3). The message names the sequence
 * number, entry hash and command type only: the raw engine error can carry order data and is kept as
 * `cause` for in-process operator diagnosis. See docs/venue/RUNBOOK-POISON-COMMAND.md.
 */
export class ReplayFaultError extends RecoveryRefusedError {
  override readonly name = "ReplayFaultError";
  readonly seq: number;
  readonly entryHash: string;
  readonly commandType: EngineCommand["type"];
  readonly isFinalEntry: boolean;
  /** `committed`: covered by the commit record; `uncommitted`: journaled, would have been rolled forward. */
  readonly commitState: "committed" | "uncommitted" | "no-commit-record";
  readonly codeRulesVersion: string;
  readonly snapshotRulesVersion: string | null;
  readonly writerRulesVersion: string | null;
  constructor(d: Omit<ReplayFaultError, keyof Error | "code" | "name">, cause: unknown) {
    super("F10-replay-fault", `replay stopped at seq ${d.seq}: engine fault while replaying a ${d.commandType} command (entry ${d.entryHash.slice(0, 16)}…); details withheld from this message, see the error's cause and RUNBOOK-POISON-COMMAND.md`, { cause });
    this.seq = d.seq;
    this.entryHash = d.entryHash;
    this.commandType = d.commandType;
    this.isFinalEntry = d.isFinalEntry;
    this.commitState = d.commitState;
    this.codeRulesVersion = d.codeRulesVersion;
    this.snapshotRulesVersion = d.snapshotRulesVersion;
    this.writerRulesVersion = d.writerRulesVersion;
  }
}

/** One store mutation recovery may perform (DURABILITY-PROTOCOL §1.2). Nothing else is ever written. */
export type RepairStep =
  | { readonly kind: "truncate-torn-tail"; readonly length: number; readonly removedBytes: number }
  | { readonly kind: "restore-newline" }
  | { readonly kind: "advance-commit-record"; readonly seq: number }
  | { readonly kind: "bootstrap-commit-record" };

/**
 * A repair step failed or its read-back did not match. Repair is not atomic across the two stores:
 * they are left in a documented intermediate state that the next recovery completes (RI-3), or, for a
 * nonconforming store, refuses (RI-6). No venue is returned.
 */
export class RecoveryRepairError extends Error {
  override readonly name = "RecoveryRepairError";
  readonly completedSteps: readonly RepairStep[];
  readonly failedStep: RepairStep;
  constructor(completedSteps: readonly RepairStep[], failedStep: RepairStep, cause: unknown) {
    super(`recovery repair failed at ${failedStep.kind} (after ${completedSteps.map((s) => s.kind).join(", ") || "no steps"}); run recovery again: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.completedSteps = completedSteps;
    this.failedStep = failedStep;
  }
}

/** Persistence boundaries at which a test subclass may simulate process death (see `Venue.boundary`). */
export type PersistenceBoundary = "after-journal" | "after-record" | "after-process";

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
  /** Private events kept per account for polling clients (oldest dropped first; gaps reported by `privateEventsPage`). */
  readonly outboxCapacity?: number;
  /**
   * Commit-record store (MATCHING-RULES D-6). Requires `store`. A command is committed, and may be
   * acknowledged, only once both its journal entry and its commit record are written.
   */
  readonly commitRecords?: CommitRecordStore;
  /**
   * Audit records kept per audit store (`executions`, `transitions`, `publicTape`, `adminErrors`).
   * Unset (the default): nothing is discarded. When set, the oldest are discarded and the history is
   * reported as partial (MATCHING-RULES A-6). Authoritative and recovery data is never discarded.
   */
  readonly auditRetention?: number;
  /** `"head"`: keep only the last journal entry in memory (requires `store`). Default `"full"`. */
  readonly journalMemory?: "full" | "head";
  /** Restore a snapshot written before snapshots carried a rules version (MATCHING-RULES D-7). Reported. */
  readonly allowLegacySnapshot?: boolean;
}

export interface PrivateEventsPage {
  readonly events: PrivateEvent[];
  /** Lowest per-account sequence still retained (high-water mark + 1 if none is). */
  readonly firstRetainedAccountSeq: number;
  /** Highest per-account sequence produced so far. */
  readonly highWaterAccountSeq: number;
  /** Events after the caller's position that are no longer retained, or null. */
  readonly gap: { readonly fromAccountSeq: number; readonly toAccountSeq: number } | null;
}

const AUDIT_STORES = ["executions", "transitions", "publicTape", "adminErrors"] as const;
type AuditStore = (typeof AUDIT_STORES)[number];

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
  /** Rules version that wrote the snapshot (D-7). Absent in snapshots written before Milestone 11 (Venue). */
  readonly rulesVersion?: string;
}

export interface RecoveryReport {
  readonly replayed: number;
  readonly fromSnapshotSeq: number;
  readonly tornTail: boolean;
  readonly journalHead: string;
  /** Store mutations performed, in order (empty when the stores needed no repair). */
  readonly repairs: readonly RepairStep[];
  /** The commit record after recovery, or null without a commit-record store. */
  readonly commitRecord: {
    readonly seq: number;
    readonly base: number;
    readonly lineage: string;
    /** One slot held an interrupted (torn) write (selection rule S4). */
    readonly tornSlot: boolean;
    /** A journaled but uncommitted final entry was committed by this recovery. */
    readonly rolledForward: boolean;
    /** Rules version of the writer of the record found (report-only, D-7). */
    readonly writerRulesVersion: string;
    readonly writerRulesVersionMatches: boolean;
  } | null;
  /** A snapshot without a rules version was restored under `allowLegacySnapshot`. */
  readonly legacySnapshot: boolean;
}

/** Recovery constructs venues on existing stores; only it may skip the empty-store check. */
const RECOVERING = Symbol("recovering");

/** Per-account private-event ring buffer with exact retention bookkeeping. */
class AccountOutbox {
  private events: PrivateEvent[] = [];
  private start = 0;
  highWater: number;
  constructor(highWater = 0) {
    this.highWater = highWater;
  }
  push(event: PrivateEvent, capacity: number) {
    this.events.push(event);
    if (event.accountSeq > this.highWater) this.highWater = event.accountSeq;
    if (this.events.length - this.start > capacity) this.start++;
    // Amortised compaction: retained ≤ capacity, storage ≤ capacity + max(capacity, 1024).
    if (this.start > Math.max(capacity, 1024)) {
      this.events = this.events.slice(this.start);
      this.start = 0;
    }
  }
  after(afterAccountSeq: number): PrivateEvent[] {
    const out: PrivateEvent[] = [];
    for (let i = this.start; i < this.events.length; i++) if (this.events[i]!.accountSeq > afterAccountSeq) out.push(this.events[i]!);
    return out;
  }
  firstRetained(): number {
    for (let i = this.start; i < this.events.length; i++) if (this.events[i]!.accountSeq > 0) return this.events[i]!.accountSeq;
    return this.highWater + 1;
  }
}

export class Venue {
  readonly journal: Journal;
  private engineRef: MatchingEngine;
  private readonly options: VenueOptions;
  private readonly outbox = new Map<string, AccountOutbox>();
  private readonly publicListeners = new Set<(message: PublicMessage) => void>();
  private outputHash = GENESIS_HASH;
  /** Audit stores (operator access only). Complete only if built from seq 1. */
  readonly executions: Execution[] = [];
  readonly transitions: (Transition & { seq: number })[] = [];
  readonly publicTape: PublicMessage[] = [];
  readonly adminErrors: { seq: number; error: string }[] = [];
  /** Public listeners that threw (isolated; delivery to stores and other listeners continued). */
  listenerFailures = 0;
  /** True only while the audit stores hold every record since seq 1 (see `historyIncompleteReasons`). */
  historyComplete = true;
  private readonly incompleteReasons: string[] = [];
  private readonly dropped: Record<AuditStore, number> = { executions: 0, transitions: 0, publicTape: 0, adminErrors: 0 };
  private haltedReason: string | null = null;
  private readonly ledger = new Map<string, IdempotencyRecord>();
  /** The current commit-record lineage and the last committed seq (D-6), or null without a record store. */
  private record: { lineage: string; base: number; seq: number } | null = null;

  constructor(options: VenueOptions, journal = new Journal({ headOnly: options.journalMemory === "head" }), engine?: MatchingEngine, internal?: typeof RECOVERING) {
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
    if (options.journalMemory === "head" && !options.store) throw new Error('journalMemory: "head" requires a journal store');
    if (options.commitRecords && !options.store) throw new Error("commitRecords requires a journal store");
    if (options.auditRetention !== undefined && !(Number.isSafeInteger(options.auditRetention) && options.auditRetention > 0)) throw new Error("auditRetention must be a positive integer");
    engine ??= new MatchingEngine(options.engine);
    this.options = options;
    this.journal = journal;
    this.engineRef = engine;
    if (options.commitRecords && internal !== RECOVERING) {
      // Bootstrap (D-6): a fresh venue writes the genesis record before it accepts any command.
      const [s0, s1] = options.commitRecords.readSlots();
      if (options.store!.read() !== "" || s0 !== null || s1 !== null || journal.lastSeq !== 0) {
        throw new Error("the journal or commit-record store is not empty; open existing stores with Venue.recover");
      }
      const lineage = newLineage();
      options.commitRecords.writeSlot(0, encodeCommitRecord({ lineage, base: 0, seq: 0, head: GENESIS_HASH, writerRulesVersion: VENUE_RULES_VERSION }));
      this.record = { lineage, base: 0, seq: 0 };
    }
  }

  /** Reasons the audit history is incomplete: `snapshot-restore`, `audit-retention:<store>`. */
  get historyIncompleteReasons(): readonly string[] {
    return [...this.incompleteReasons];
  }

  /** Audit records discarded under `auditRetention`, per store. */
  get auditDropped(): Readonly<Record<AuditStore, number>> {
    return { ...this.dropped };
  }

  private markIncomplete(reason: string) {
    this.historyComplete = false;
    if (!this.incompleteReasons.includes(reason)) this.incompleteReasons.push(reason);
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
    if (this.record) {
      const record = this.record;
      try {
        this.options.commitRecords!.writeSlot(slotFor(entry.seq), encodeCommitRecord({ lineage: record.lineage, base: record.base, seq: entry.seq, head: entry.hash, writerRulesVersion: VENUE_RULES_VERSION }));
      } catch (error) {
        this.haltedReason = `commit record write failed at seq ${entry.seq}`;
        throw new OutcomeUnknownError(entry.seq, `${this.haltedReason}: ${error instanceof Error ? error.message : String(error)}`);
      }
      record.seq = entry.seq;
    }
    this.crashPoint("after-record", entry.seq);
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
    if (this.options.auditRetention !== undefined) this.trimAudit(this.options.auditRetention);
    const capacity = this.options.outboxCapacity ?? 10_000;
    for (const event of result.private) {
      let box = this.outbox.get(event.accountId);
      if (!box) this.outbox.set(event.accountId, (box = new AccountOutbox()));
      box.push(event, capacity);
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

  private trimAudit(capacity: number) {
    for (const name of AUDIT_STORES) {
      const store = this[name] as unknown[];
      const excess = store.length - capacity;
      if (excess <= 0) continue;
      store.splice(0, excess);
      this.dropped[name] += excess;
      this.markIncomplete(`audit-retention:${name}`);
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
    return this.outbox.get(accountId)?.after(afterAccountSeq) ?? [];
  }

  /**
   * Like `privateEvents`, plus exact retention bookkeeping (MATCHING-RULES A-6): `gap` names the
   * per-account sequence numbers after `afterAccountSeq` that are no longer retained. Per-account
   * sequences are contiguous, so a gap can only come from retention or a snapshot restore.
   */
  privateEventsPage(accountId: string, afterAccountSeq = 0): PrivateEventsPage {
    const box = this.outbox.get(accountId);
    const highWaterAccountSeq = box?.highWater ?? 0;
    const firstRetainedAccountSeq = box?.firstRetained() ?? 1;
    const gap = afterAccountSeq + 1 < firstRetainedAccountSeq ? { fromAccountSeq: afterAccountSeq + 1, toAccountSeq: firstRetainedAccountSeq - 1 } : null;
    return { events: box?.after(afterAccountSeq) ?? [], firstRetainedAccountSeq, highWaterAccountSeq, gap };
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
      rulesVersion: VENUE_RULES_VERSION,
    };
  }

  /**
   * Rebuilds a venue from a serialised journal (untrusted input: parsed, validated and hash-checked),
   * the commit record when a commit-record store is configured, and an optional snapshot.
   * Pass either `journalJsonl` (no store) or `options.store` (no text), never both.
   *
   * Two phases (docs/venue/DURABILITY-PROTOCOL.md §1):
   * - Verify: read-only. Every refusal happens here and leaves both stores byte-identical (RI-1).
   * - Repair: the planned steps, journal first and commit record last, each read back. Repair is not
   *   atomic across the two stores; if it fails, `RecoveryRepairError` is thrown, no venue is returned,
   *   and the next recovery completes the repair (RI-3) or refuses a nonconforming store (RI-6).
   */
  static recover(options: VenueOptions, journalJsonl?: string, snapshot?: VenueSnapshot): { venue: Venue; report: RecoveryReport } {
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
    const refuse = (code: string, message: string): never => {
      throw new RecoveryRefusedError(code, message);
    };
    if (journalJsonl !== undefined && options.store) refuse("invalid-arguments", "recover from journal text or from a store, not both");
    if (options.commitRecords && !options.store) refuse("invalid-arguments", "commit records require a journal store (recover from options.store, not from journal text)");
    const text = journalJsonl ?? options.store?.read();
    if (text === undefined) return refuse("invalid-arguments", "no journal to recover from");
    const read = readJournal(text);
    if (!read.ok) return refuse("F1-journal", `journal corrupt at line ${read.failedAtLine}: ${read.reason}`);
    const L = read.entries.length;
    const headAt = (seq: number) => (seq === 0 ? GENESIS_HASH : read.entries[seq - 1]!.hash);

    // Commit record (D-6): select (S1–S6), then compare with the journal (F3–F6).
    let found: { record: CommitRecord; tornSlot: boolean } | null = null;
    let bootstrap = false;
    if (options.commitRecords) {
      const selection = selectCommitRecord(...options.commitRecords.readSlots());
      if (!selection.ok) return refuse(selection.code, `commit record unusable (${selection.code}): ${selection.reason}`);
      if (!selection.record) {
        if (L > 0) refuse("F3-unrecorded-journal", `the journal has ${L} entries but the commit-record store is empty; adopt it with the offline migration procedure (migrateToCommitRecord), not by recovery`);
        bootstrap = true;
      } else {
        const r = selection.record.seq;
        if (r > L) {
          if (read.tornTail && r === L + 1) refuse("F4-record-ahead", `committed entry seq ${r} is truncated (torn final line); the journal's last complete entry is seq ${L}`);
          refuse("F4-record-ahead", `committed entry seq ${r} missing: the commit record is at seq ${r} but the journal ends at seq ${L}`);
        }
        if (headAt(r) !== selection.record.head) refuse("F5-record-mismatch", `journal and commit record disagree at seq ${r}`);
        if (L - r >= 2) refuse("F6-journal-ahead", `the journal is ${L - r} entries ahead of the commit record (journal seq ${L}, record seq ${r}); at most one uncommitted entry is possible`);
        found = { record: selection.record, tornSlot: selection.tornSlot };
      }
    }
    const committedSeq = found ? found.record.seq : null;

    // Snapshot checks.
    const fromSeq = snapshot?.engine.lastSeq ?? 0;
    let legacySnapshot = false;
    if (snapshot) {
      if (fromSeq > L) refuse("snapshot-invalid", "snapshot is newer than the journal");
      if (snapshot.journalHead !== headAt(fromSeq)) refuse("snapshot-invalid", "snapshot does not belong to this journal");
      if (committedSeq !== null && fromSeq > committedSeq) refuse("F7-snapshot-ahead", `snapshot at seq ${fromSeq} is ahead of the commit record (seq ${committedSeq})`);
      if (snapshot.rulesVersion === undefined) {
        if (!options.allowLegacySnapshot) refuse("F8-snapshot-rules-version", "legacy snapshot without a rules version; recover by full replay or pass allowLegacySnapshot");
        legacySnapshot = true;
      } else if (snapshot.rulesVersion !== VENUE_RULES_VERSION) {
        refuse("F8-snapshot-rules-version", `snapshot rules version ${snapshot.rulesVersion} is incompatible with ${VENUE_RULES_VERSION}; recover by full replay`);
      }
    }
    const engine = snapshot ? MatchingEngine.restore(options.engine, snapshot.engine) : new MatchingEngine(options.engine);
    if (snapshot && engine.stateHash() !== snapshot.stateHash) refuse("snapshot-invalid", "snapshot state hash mismatch (corrupted or altered snapshot)");
    if (snapshot && ledgerHash(snapshot.idempotency, snapshot.idempotencyCapacity) !== snapshot.idempotencyHash) refuse("snapshot-invalid", "snapshot idempotency ledger hash mismatch");
    const capacity = options.idempotencyCapacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
    if (snapshot && snapshot.idempotencyCapacity !== capacity) {
      refuse("snapshot-invalid", `snapshot idempotency capacity ${snapshot.idempotencyCapacity} differs from the configured ${capacity}; restore with the same capacity or recover by full replay (VR-26)`);
    }
    const venue = new Venue(options, Journal.fromEntries(read.entries, { headOnly: options.journalMemory === "head" }), engine, RECOVERING);
    if (snapshot) {
      venue.outputHash = snapshot.outputHead;
      for (const [k, r] of snapshot.idempotency) venue.ledger.set(k, frozenRecord(r));
      // Outboxes start empty; their high-water marks come from the snapshot, so earlier events are an exact gap (A-6).
      for (const a of snapshot.engine.accounts) venue.outbox.set(a.id, new AccountOutbox(a.accountSeq));
      venue.markIncomplete("snapshot-restore");
    }
    let replayed = 0;
    for (const entry of read.entries.slice(fromSeq)) {
      try {
        venue.apply(entry);
      } catch (error) {
        // A command that faults deterministically faults again on every replay ("poison command", D-3).
        if (!(error instanceof EngineIntegrityError)) throw error;
        throw new ReplayFaultError(
          {
            seq: entry.seq,
            entryHash: entry.hash,
            commandType: entry.command.type,
            isFinalEntry: entry.seq === L,
            commitState: committedSeq === null ? "no-commit-record" : entry.seq <= committedSeq ? "committed" : "uncommitted",
            codeRulesVersion: VENUE_RULES_VERSION,
            snapshotRulesVersion: snapshot?.rulesVersion ?? null,
            writerRulesVersion: found?.record.writerRulesVersion ?? null,
          },
          error,
        );
      }
      replayed++;
    }

    // Repair plan: journal steps first, the commit record last (DURABILITY-PROTOCOL §1.2).
    const plan: RepairStep[] = [];
    if (options.store) {
      if (read.tornTail) plan.push({ kind: "truncate-torn-tail", length: read.validLength, removedBytes: text.length - read.validLength });
      else if (read.validLength > 0 && !text.endsWith("\n")) plan.push({ kind: "restore-newline" });
    }
    const rolledForward = found !== null && found.record.seq === L - 1;
    if (rolledForward) plan.push({ kind: "advance-commit-record", seq: L });
    if (bootstrap) plan.push({ kind: "bootstrap-commit-record" });
    const lineage = found?.record.lineage ?? newLineage();
    const base = found?.record.base ?? 0;
    const completed: RepairStep[] = [];
    for (const step of plan) {
      try {
        const problem = venue.repair(step, text, read.validLength, lineage, base, headAt(L));
        if (problem) throw new Error(problem);
      } catch (error) {
        throw new RecoveryRepairError(completed, step, error);
      }
      completed.push(step);
    }
    if (options.commitRecords) venue.record = { lineage, base, seq: L };
    return {
      venue,
      report: {
        replayed,
        fromSnapshotSeq: fromSeq,
        tornTail: read.tornTail,
        journalHead: read.head,
        repairs: completed,
        commitRecord: options.commitRecords
          ? {
              seq: L,
              base,
              lineage,
              tornSlot: found?.tornSlot ?? false,
              rolledForward,
              writerRulesVersion: found?.record.writerRulesVersion ?? VENUE_RULES_VERSION,
              writerRulesVersionMatches: (found?.record.writerRulesVersion ?? VENUE_RULES_VERSION) === VENUE_RULES_VERSION,
            }
          : null,
        legacySnapshot,
      },
    };
  }

  /** Performs one repair step and reads it back; returns a problem description, or null. */
  private repair(step: RepairStep, text: string, validLength: number, lineage: string, base: number, head: string): string | null {
    const store = this.options.store!;
    switch (step.kind) {
      case "truncate-torn-tail": {
        store.truncate(step.length);
        const now = store.read();
        return now === text.slice(0, step.length) ? null : `journal read-back after truncation does not match (expected ${step.length} bytes, found ${now.length})`;
      }
      case "restore-newline": {
        store.append("\n");
        return store.read() === `${text.slice(0, validLength)}\n` ? null : "journal read-back after restoring the final newline does not match";
      }
      case "advance-commit-record":
      case "bootstrap-commit-record": {
        const seq = step.kind === "bootstrap-commit-record" ? 0 : step.seq;
        const records = this.options.commitRecords!;
        records.writeSlot(slotFor(seq), encodeCommitRecord({ lineage, base, seq, head, writerRulesVersion: VENUE_RULES_VERSION }));
        const back = selectCommitRecord(...records.readSlots());
        return back.ok && back.record?.seq === seq && back.record.head === head && back.record.lineage === lineage ? null : `commit record read-back does not show seq ${seq}`;
      }
    }
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
