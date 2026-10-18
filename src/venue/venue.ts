import { EngineIntegrityError, MatchingEngine, type EngineConfig, type EngineSnapshot } from "./engine.ts";
import { canonicalJson, GENESIS_HASH, Journal, readJournal, sha256, type JournalEntry } from "./journal.ts";
import { assertIdKeyPolicy } from "./id-key.ts";
import type { CommitAnchorStore, JournalStore } from "./storage.ts";
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

/** The exact command was quarantined by an operator (D-7); refused before anything is journaled. */
export class QuarantinedCommandError extends Error {
  override readonly name = "QuarantinedCommandError";
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
   * Commit anchor (MATCHING-RULES D-6): required with a `store`. Written after every journal append and
   * before processing; recovery refuses a journal that lacks the anchored entry. In memory it detects
   * integrity faults only; it is not proof of physical durability.
   */
  readonly anchor?: CommitAnchorStore;
  /**
   * Run a store-backed venue without a commit anchor: the Milestone 10 behaviour, in which an
   * acknowledged entry that the store later truncates or loses is not detected. Explicit opt-in only.
   */
  readonly allowUnanchored?: boolean;
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
  /** Private events kept per account for polling clients (oldest dropped first; `privateEventsPage` reports the gap, A-6). */
  readonly outboxCapacity?: number;
  /**
   * Optional caps on the derivable audit stores (A-6, VR-13). **Disabled by default.** When a store exceeds its
   * cap, the oldest records are dropped (in batches: a store holds at most cap + max(1, ⌊cap/8⌋) records),
   * counted in `auditEvicted`, and `historyComplete` becomes false, so reconciliation skips its history checks;
   * full reconciliation is then done by replaying the journal. Never affects trading state, outputs, the
   * idempotency ledger or the engine's client-ID index.
   */
  readonly auditRetention?: { readonly executions?: number; readonly transitions?: number; readonly publicTape?: number; readonly adminErrors?: number };
}

/** A page of one account's private events, with an explicit retention gap marker (A-6). */
export interface PrivateEventsPage {
  readonly events: PrivateEvent[];
  /** `accountSeq` of the oldest retained event (latest + 1 when none is retained). */
  readonly firstAvailableAccountSeq: number;
  /** Latest `accountSeq` the venue has produced for the account. */
  readonly latestAccountSeq: number;
  /** True when events after the caller's cursor are no longer retained: resynchronise from order queries. */
  readonly gap: boolean;
}

type AuditStore = "executions" | "transitions" | "publicTape" | "adminErrors";
const AUDIT_STORES: readonly AuditStore[] = ["executions", "transitions", "publicTape", "adminErrors"];

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
  /** Sequence number of the commit anchor found before recovery (null: unanchored or a fresh store). */
  readonly anchoredSeq: number | null;
  /** True if an operator bootstrap anchored a previously unanchored (or unreadably anchored) journal. */
  readonly bootstrapped: boolean;
  /** Sequence numbers of quarantined (voided) entries replayed by this recovery (D-7). */
  readonly quarantined: readonly number[];
}

type QuarantineCommand = Extract<EngineCommand, { type: "admin.quarantine" }>;

/**
 * Operator request to quarantine a poison command (D-7). Accepted only for the final valid journal entry,
 * with a matching hash, whose fault reproduces, and whose evidence shows no externally acknowledged output.
 * `approvedBy` and the notes are free text, not an authenticated approval.
 */
export type QuarantineRequest = Omit<QuarantineCommand, "type" | "accountId">;

/**
 * Operator actions that only an explicit recovery call can take. The metadata is free text and
 * not authenticated: the prototype has no operator identity or access control (D-6).
 */
export interface OperatorRecovery {
  /** Anchor a journal whose anchor is missing or unreadable, after a full verified replay (D-6). */
  readonly bootstrapAnchor?: { readonly reason: string; readonly approvedBy: string };
  /** Quarantine the final journal entry, a poison command (D-7). */
  readonly quarantine?: QuarantineRequest;
}

interface Anchor {
  readonly seq: number;
  readonly hash: string;
}

const anchorRecord = (seq: number, hash: string) => canonicalJson({ seq, hash });

/** Parses a stored anchor record (untrusted). */
function parseAnchor(record: string): Anchor | string {
  let raw: unknown;
  try {
    raw = JSON.parse(record);
  } catch {
    return "commit anchor is unreadable";
  }
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    typeof r !== "object" ||
    Object.keys(r).sort().join(",") !== "hash,seq" ||
    typeof r.seq !== "number" ||
    !Number.isSafeInteger(r.seq) ||
    r.seq < 1 ||
    typeof r.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(r.hash)
  ) {
    return "commit anchor record is invalid";
  }
  return { seq: r.seq, hash: r.hash };
}

/** Refuses store/anchor combinations that would weaken D-6 (no anchor without an explicit opt-out). */
function assertAnchorConfig(options: VenueOptions) {
  if (options.anchor && !options.store) throw new Error("a commit anchor needs a journal store to anchor (D-6)");
  if (options.store && !options.anchor && options.allowUnanchored !== true) {
    throw new Error("a store-backed venue needs a commit anchor store (MATCHING-RULES D-6); pass allowUnanchored: true only for the Milestone 10-compatible unanchored mode");
  }
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
  /** Records dropped from each audit store by `auditRetention` (always 0 when the caps are disabled). */
  readonly auditEvicted: Record<AuditStore, number> = { executions: 0, transitions: 0, publicTape: 0, adminErrors: 0 };
  /** Latest private sequence produced per account (from the snapshot on restore, then from routed events). */
  private readonly latestAccountSeq = new Map<string, number>();
  historyComplete = true;
  private haltedReason: string | null = null;
  private readonly ledger = new Map<string, IdempotencyRecord>();
  /** Canonical JSON of every quarantined command: never accepted again (D-7). Rebuilt from the journal. */
  private readonly quarantinedCommands = new Set<string>();
  /** Set only while `Venue.recover` journals an operator record (D-6, D-7). */
  private operatorRecord = false;

  constructor(options: VenueOptions, journal?: Journal, engine?: MatchingEngine) {
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
    assertAnchorConfig(options);
    // A fresh anchored venue must start from empty storage; existing data is recovered, never overwritten.
    if (journal === undefined && options.anchor && (options.store!.read() !== "" || options.anchor.read() !== null)) {
      throw new Error("the journal store or commit anchor already holds data; use Venue.recover");
    }
    for (const [store, cap] of Object.entries(options.auditRetention ?? {})) {
      if (cap !== undefined && (!AUDIT_STORES.includes(store as AuditStore) || !Number.isSafeInteger(cap) || cap < 1)) {
        throw new Error(`auditRetention.${store} must be a positive integer`);
      }
    }
    journal ??= new Journal();
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
    // Operator records change how replay treats earlier entries (a quarantine voids the entry before it), so
    // only recovery may write them: submitted directly, one could void an already acknowledged command.
    if ((parsed.data.type === "admin.quarantine" || parsed.data.type === "admin.anchor-bootstrap") && !this.operatorRecord) {
      throw new Error(`${parsed.data.type} records are written only by Venue.recover (D-6, D-7); nothing was recorded`);
    }
    if (this.quarantinedCommands.size && this.quarantinedCommands.has(canonicalJson(parsed.data))) {
      throw new QuarantinedCommandError("this exact command was quarantined by the venue operator (D-7) and is not accepted again; nothing was recorded");
    }
    const ts = Math.max(this.options.clock(), this.journal.lastTs);
    const entry = this.journal.prepare(ts, parsed.data);
    try {
      this.options.store?.append(`${canonicalJson(entry)}\n`);
    } catch (error) {
      this.haltedReason = `journal write failed at seq ${entry.seq}`;
      throw new OutcomeUnknownError(entry.seq, `${this.haltedReason}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // D-6: anchor the entry before it is processed. Journal append and anchor write together are the commit point.
    try {
      this.options.anchor?.write(anchorRecord(entry.seq, entry.hash));
    } catch (error) {
      this.haltedReason = `commit anchor write failed at seq ${entry.seq}`;
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

  private submitOperatorRecord(command: EngineCommand): CommandResult {
    this.operatorRecord = true;
    try {
      return this.submit(command);
    } finally {
      this.operatorRecord = false;
    }
  }

  /** Replays a quarantined entry: no effect, a definitive answer to the submitter (D-7). */
  private applyVoid(entry: SequencedCommand): CommandResult {
    const result = this.engineRef.voidEntry(entry);
    this.route(result, entry);
    this.quarantinedCommands.add(canonicalJson(entry.command));
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
    if (this.options.auditRetention) this.trimAudit();
    const capacity = this.options.outboxCapacity ?? 10_000;
    for (const event of result.private) {
      this.latestAccountSeq.set(event.accountId, Math.max(this.latestAccountSeq.get(event.accountId) ?? 0, event.accountSeq));
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

  /** Drops the oldest audit records beyond the configured caps, in batches (amortised O(1) per record). */
  private trimAudit() {
    for (const store of AUDIT_STORES) {
      const cap = this.options.auditRetention?.[store];
      if (cap === undefined) continue;
      const records = this[store] as unknown[];
      if (records.length <= cap + Math.max(1, Math.floor(cap / 8))) continue;
      const drop = records.length - cap;
      records.splice(0, drop);
      this.auditEvicted[store] += drop;
      this.historyComplete = false;
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

  /** Private events of one account only, after the given per-account sequence. Retention gaps are silent here; use `privateEventsPage`. */
  privateEvents(accountId: string, afterAccountSeq = 0): PrivateEvent[] {
    return (this.outbox.get(accountId) ?? []).filter((e) => e.accountSeq > afterAccountSeq);
  }

  /**
   * Private events after the cursor, with an explicit retention marker (A-6): `gap` is true when events the
   * caller has not seen were dropped by the outbox or are not retained after a snapshot restore. The client
   * then resynchronises from its order queries (`order`, `openOrders`).
   */
  privateEventsPage(accountId: string, afterAccountSeq = 0): PrivateEventsPage {
    const box = this.outbox.get(accountId) ?? [];
    const latest = this.latestAccountSeq.get(accountId) ?? 0;
    const first = box[0]?.accountSeq ?? latest + 1;
    return {
      events: box.filter((e) => e.accountSeq > afterAccountSeq),
      firstAvailableAccountSeq: first,
      latestAccountSeq: latest,
      gap: afterAccountSeq < latest && afterAccountSeq + 1 < first,
    };
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
  static recover(options: VenueOptions, journalJsonl?: string, snapshot?: VenueSnapshot, operator: OperatorRecovery = {}): { venue: Venue; report: RecoveryReport } {
    assertIdKeyPolicy(options.engine.idKey, options.allowTestFixtureIdKey === true);
    assertAnchorConfig(options);
    if (journalJsonl !== undefined && options.store) throw new Error("recover from journal text or from a store, not both");
    const text = journalJsonl ?? options.store?.read();
    if (text === undefined) throw new Error("no journal to recover from");
    const read = readJournal(text);
    if (!read.ok) throw new Error(`journal corrupt at line ${read.failedAtLine}: ${read.reason}`);
    const anchorCheck = checkAnchor(options, read.entries, read.tornTail, snapshot, operator);
    const voided = journaledQuarantines(read.entries);
    const request = operator.quarantine ? checkQuarantineRequest(read.entries, voided, snapshot, operator.quarantine) : null;
    const fromSeq = snapshot?.engine.lastSeq ?? 0;
    if (snapshot && voided.has(fromSeq)) throw new Error(`snapshot taken at quarantined entry seq ${fromSeq} is ambiguous; recover by full replay (D-7)`);
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
      for (const a of snapshot.engine.accounts) venue.latestAccountSeq.set(a.id, a.accountSeq);
      venue.outputHash = snapshot.outputHead;
      for (const [k, r] of snapshot.idempotency) venue.ledger.set(k, frozenRecord(r));
      venue.historyComplete = false;
    }
    // Quarantined commands earlier than a snapshot are not replayed, but are still never accepted again.
    for (const entry of read.entries.slice(0, fromSeq)) if (voided.has(entry.seq)) venue.quarantinedCommands.add(canonicalJson(entry.command));
    let replayed = 0;
    const quarantined: number[] = [];
    for (const entry of read.entries.slice(fromSeq)) {
      if (voided.has(entry.seq)) {
        venue.applyVoid(entry);
        quarantined.push(entry.seq);
        replayed++;
        continue;
      }
      if (request && entry.seq === request.seq) {
        confirmPoison(options, venue, entry, request);
        venue.applyVoid(entry);
        quarantined.push(entry.seq);
        replayed++;
        continue;
      }
      try {
        venue.apply(entry);
      } catch (error) {
        // A command that faults deterministically faults again on every replay ("poison command").
        // An operator may quarantine it if it is the final entry (D-7, docs/venue/runbooks/POISON-COMMAND.md).
        if (error instanceof EngineIntegrityError) throw new Error(`replay stopped at seq ${entry.seq}: ${error.message}`);
        throw error;
      }
      replayed++;
    }
    if (options.store) {
      options.store.truncate(read.validLength);
      if (read.validLength > 0 && !text.slice(0, read.validLength).endsWith("\n")) options.store.append("\n");
    }
    if (request) {
      // The decision goes through the normal commit path: journaled and anchored. If it fails, the venue stops
      // with outcome-unknown; the operator repeats the quarantine (record lost) or recovers plainly (record written).
      const command = read.entries[request.seq - 1]!.command;
      venue.submitOperatorRecord({ type: "admin.quarantine", ...request, ...("accountId" in command ? { accountId: command.accountId } : {}) });
    }
    if (anchorCheck.bootstrap) {
      // The audit record goes through the normal commit path, so it is journaled and anchors the journal.
      // If it fails, nothing is anchored yet and the operator repeats the bootstrap.
      venue.submitOperatorRecord({
        type: "admin.anchor-bootstrap",
        seq: venue.journal.lastSeq,
        hash: venue.journal.head,
        prior: anchorCheck.bootstrap.prior,
        reason: anchorCheck.bootstrap.reason,
        approvedBy: anchorCheck.bootstrap.approvedBy,
      });
    }
    return {
      venue,
      report: { replayed, fromSnapshotSeq: fromSeq, tornTail: read.tornTail, journalHead: read.head, anchoredSeq: anchorCheck.anchoredSeq, bootstrapped: anchorCheck.bootstrap !== null, quarantined },
    };
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

/**
 * D-6 recovery check: the journal must contain the anchored entry with the anchored hash. Runs before
 * anything is replayed or repaired, so a refusal changes neither store.
 */
function checkAnchor(
  options: VenueOptions,
  entries: readonly { seq: number; hash: string }[],
  tornTail: boolean,
  snapshot: VenueSnapshot | undefined,
  operator: OperatorRecovery,
): { anchoredSeq: number | null; bootstrap: { prior: "missing" | "unreadable"; reason: string; approvedBy: string } | null } {
  const request = operator.bootstrapAnchor;
  if (!options.anchor) {
    if (request) throw new Error("anchor bootstrap requested, but no commit anchor store is configured");
    return { anchoredSeq: null, bootstrap: null };
  }
  const raw = options.anchor.read();
  const parsed = raw === null ? null : parseAnchor(raw);
  if (parsed === null || typeof parsed === "string") {
    const prior = parsed === null ? "missing" : "unreadable";
    if (raw === null && entries.length === 0 && !request) return { anchoredSeq: null, bootstrap: null }; // fresh store
    if (!request) {
      throw new Error(
        parsed === null
          ? `no commit anchor for a non-empty journal (seq ${entries.length}); an operator bootstrap with a verified full replay is required (D-6)`
          : `${parsed}; recovery refused. An operator bootstrap with a verified full replay is required (D-6)`,
      );
    }
    if (typeof request.reason !== "string" || request.reason.trim() === "" || request.reason.length > 500 || typeof request.approvedBy !== "string" || request.approvedBy.trim() === "" || request.approvedBy.length > 200) {
      throw new Error("anchor bootstrap needs a reason (1-500 characters) and approvedBy (1-200 characters)");
    }
    if (snapshot) throw new Error("anchor bootstrap requires a full replay from the journal; recover without a snapshot");
    if (entries.length === 0) throw new Error("anchor bootstrap refused: the journal is empty, there is nothing to anchor");
    return { anchoredSeq: null, bootstrap: { prior, reason: request.reason, approvedBy: request.approvedBy } };
  }
  if (request) throw new Error(`anchor bootstrap refused: a readable anchor exists (seq ${parsed.seq}); bootstrap only replaces a missing or unreadable anchor`);
  if (parsed.seq > entries.length) {
    if (tornTail && parsed.seq === entries.length + 1) {
      throw new Error(`journal corrupt: anchored entry seq ${parsed.seq} is truncated (incomplete final line); an anchored entry is never dropped as a torn write (D-6)`);
    }
    throw new Error(`journal is missing anchored entries: commit anchor at seq ${parsed.seq}, journal ends at seq ${entries.length} (D-6)`);
  }
  if (entries[parsed.seq - 1]!.hash !== parsed.hash) throw new Error(`commit anchor hash does not match entry seq ${parsed.seq} (D-6)`);
  return { anchoredSeq: parsed.seq, bootstrap: null };
}

/**
 * D-7: quarantine records in the journal. Each must reference the entry immediately before it, with that
 * entry's hash, and must not reference another quarantine or bootstrap record. Returns the voided sequences.
 */
function journaledQuarantines(entries: readonly JournalEntry[]): Set<number> {
  const voided = new Set<number>();
  for (const e of entries) {
    if (e.command.type !== "admin.quarantine") continue;
    const target = entries[e.seq - 2];
    if (e.command.seq !== e.seq - 1 || !target || target.hash !== e.command.hash || !quarantinable(target.command)) {
      throw new Error(`journal corrupt: quarantine record at seq ${e.seq} does not reference the preceding entry (D-7)`);
    }
    voided.add(e.command.seq);
  }
  return voided;
}

const quarantinable = (c: EngineCommand) => c.type !== "admin.quarantine" && c.type !== "admin.anchor-bootstrap";

/** D-7 preconditions that need no replay. Refuses before anything is replayed or repaired. */
function checkQuarantineRequest(entries: readonly JournalEntry[], voided: ReadonlySet<number>, snapshot: VenueSnapshot | undefined, q: QuarantineRequest): QuarantineRequest {
  const last = entries.at(-1);
  if (last && last.command.type === "admin.quarantine" && last.command.seq === q.seq) {
    throw new Error(`quarantine refused: seq ${q.seq} is already quarantined (journaled at seq ${last.seq}); recover without the quarantine request`);
  }
  if (!last || q.seq !== last.seq) throw new Error(`quarantine refused: seq ${q.seq} is not the final journal entry (the final entry is seq ${last?.seq ?? 0}); only a final entry can be quarantined (D-7)`);
  if (q.hash !== last.hash) throw new Error(`quarantine refused: hash does not match entry seq ${q.seq}`);
  if (!quarantinable(last.command)) throw new Error(`quarantine refused: a ${last.command.type} record cannot be quarantined`);
  if (voided.has(q.seq)) throw new Error(`quarantine refused: seq ${q.seq} is already quarantined`);
  if (snapshot && snapshot.engine.lastSeq >= q.seq) throw new Error(`quarantine refused: the snapshot already includes seq ${q.seq}, so it did not fault; recover without the snapshot`);
  if (q.suspendAccount && !("accountId" in last.command)) throw new Error("quarantine refused: suspendAccount needs an account-scoped command");
  const record = engineCommandSchema.safeParse({ type: "admin.quarantine", ...q });
  if (!record.success) {
    const fields = [...new Set(record.error.issues.map((i) => String(i.path[0] ?? "request")))].join(", ");
    throw new Error(`quarantine refused: invalid or incomplete ${fields} (reason, approvedBy and evidence are required; evidence must attest sameEngineBuild and a non-successful client outcome)`);
  }
  if ("accountId" in last.command && record.data.type === "admin.quarantine" && !(last.command.accountId in record.data.evidence.observedAccountSeqs)) {
    throw new Error(`quarantine refused: the evidence must include the observed private sequence of account ${last.command.accountId}`);
  }
  return q;
}

/**
 * D-7 preconditions checked against the state just before the entry: the fault must reproduce (on a scratch
 * copy, so the venue's engine is never half-applied), and no consumer may have observed output beyond that
 * state — otherwise the command produced an acknowledged effect and must not be voided.
 */
function confirmPoison(options: VenueOptions, venue: Venue, entry: JournalEntry, q: QuarantineRequest) {
  const before = venue.engine.snapshot();
  if (q.evidence.observedPublicSeq > before.publicSeq) {
    throw new Error(`quarantine refused: consumers observed public output up to seq ${q.evidence.observedPublicSeq}, beyond the ${before.publicSeq} that existed before entry ${entry.seq}; it may have been acknowledged`);
  }
  for (const [accountId, observed] of Object.entries(q.evidence.observedAccountSeqs)) {
    const current = before.accounts.find((a) => a.id === accountId)?.accountSeq ?? 0;
    if (observed > current) {
      throw new Error(`quarantine refused: account ${accountId} observed private output up to ${observed}, beyond the ${current} that existed before entry ${entry.seq}; it may have been acknowledged`);
    }
  }
  const scratch = MatchingEngine.restore(options.engine, before);
  try {
    scratch.process(entry);
  } catch (error) {
    if (error instanceof EngineIntegrityError) return;
    throw error;
  }
  throw new Error(`quarantine refused: entry seq ${entry.seq} does not fault on replay, so it may have produced acknowledged outputs (D-7)`);
}
