import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { BookSide } from "./book";
import { encodeCommitRecord, selectCommitRecord } from "./commit-record";
import { DURABILITY_ALPHA, DURABILITY_CLOCK, durableOptions, fingerprint, orderFlow, referenceVenue } from "./durability-fixtures";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayResponse } from "./gateway";
import { canonicalJson, entryHash, GENESIS_HASH } from "./journal";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage";
import type { EngineCommand } from "./types";
import { RecoveryRefusedError, RecoveryRepairError, Venue, type PersistenceBoundary, type VenueOptions, type VenueSnapshot } from "./venue";

/**
 * Milestone 11 (Venue) workstream A: the commit-record protocol (rule D-6). Crash matrix, fail-closed
 * conditions F1–F10, recovery invariants RI-1–RI-6 and every interrupted-repair boundary IR-1–IR-14
 * (docs/venue/DURABILITY-PROTOCOL.md). Written before the implementation; first run against the
 * Milestone 10 commit 9812049 (docs/venue/verification/m11-tests-against-9812049.log).
 */

const NEXT: ClientMessage = { op: "new", clientOrderId: "k-next", instrumentId: DURABILITY_ALPHA, side: "buy", type: "limit", price: "1999.00", quantity: "0.010" };
/** The engine command the gateway normalises NEXT to. */
const NEXT_COMMAND: EngineCommand = {
  type: "new-order",
  accountId: "syn-a",
  clientOrderId: "k-next",
  instrumentId: DURABILITY_ALPHA,
  side: "buy",
  orderType: "limit",
  priceTicks: 3_998,
  qtyLots: 10,
  tif: "gtc",
  visibility: "displayed",
  postOnly: false,
  stp: "cancel-taker",
};
type Slots = [string | null, string | null];

/** Test-only subclass: simulates process death at one persistence boundary of one command. */
class CrashingVenue extends Venue {
  private readonly at: PersistenceBoundary;
  private readonly seq: number;
  constructor(options: VenueOptions, at: PersistenceBoundary, seq: number) {
    super(options);
    this.at = at;
    this.seq = seq;
  }
  protected override boundary(point: PersistenceBoundary, seq: number): void {
    if (point === this.at && seq === this.seq) throw new Error("process killed");
  }
}

function gatewayOn(venue: Venue) {
  const gateway = new VenueGateway(venue, { clock: DURABILITY_CLOCK, ...DEFAULT_GATEWAY_LIMITS });
  const token = gateway.openSession("syn-a");
  return (message: ClientMessage = NEXT) => gateway.handle(token, message);
}

/** A store-backed venue with commit records after a seeded flow; `history[i]` = record slots after i commands. */
function live(options: { crash?: PersistenceBoundary; n?: number; seed?: number; store?: MemoryJournalStore; records?: MemoryCommitRecordStore } = {}) {
  const store = options.store ?? new MemoryJournalStore();
  const records = options.records ?? new MemoryCommitRecordStore();
  const commands = orderFlow(options.seed ?? 1, options.n ?? 12);
  const venueOptions = durableOptions({ store, records });
  const venue = options.crash ? new CrashingVenue(venueOptions, options.crash, commands.length + 1) : new Venue(venueOptions);
  const history: Slots[] = [[...records.readSlots()] as Slots];
  for (const c of commands) {
    venue.submit(c);
    history.push([...records.readSlots()] as Slots);
  }
  const send = gatewayOn(venue);
  return { store, records, venue, commands, history, send };
}

const bytes = (store: MemoryJournalStore, records: MemoryCommitRecordStore) => ({ journal: store.read(), slots: [...records.readSlots()] });
const recover = (store: MemoryJournalStore, records: MemoryCommitRecordStore, snapshot?: VenueSnapshot) => Venue.recover(durableOptions({ store, records }), undefined, snapshot);
const linesOf = (store: MemoryJournalStore) => store.read().trimEnd().split("\n");
const kinds = (r: { repairs: readonly { kind: string }[] }) => r.repairs.map((s) => s.kind);
const acceptedNext = (venue: Venue) => venue.privateEvents("syn-a").filter((e) => e.kind === "accepted" && e.order.clientOrderId === "k-next").length;

/** RI-1: a refusal throws `RecoveryRefusedError` with `code` and leaves the journal and both slots byte-identical. */
function refusal(store: MemoryJournalStore, records: MemoryCommitRecordStore, code: string, pattern: RegExp, snapshot?: VenueSnapshot) {
  const before = bytes(store, records);
  let error: unknown;
  try {
    recover(store, records, snapshot);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RecoveryRefusedError);
  expect((error as RecoveryRefusedError).code).toBe(code);
  expect((error as Error).message).toMatch(pattern);
  expect(bytes(store, records)).toEqual(before);
}

describe("D-6 bootstrap and live commit records", () => {
  it("D-6 a fresh venue writes the genesis record (seq 0, base 0) to slot 0 before it accepts any command", () => {
    const records = new MemoryCommitRecordStore();
    new Venue(durableOptions({ store: new MemoryJournalStore(), records }));
    const [s0, s1] = records.readSlots();
    expect(s1).toBeNull();
    expect(selectCommitRecord(s0, s1)).toMatchObject({ ok: true, record: { seq: 0, base: 0, head: GENESIS_HASH } });
  });

  it("D-6 every acknowledged command has a record in the slot of its parity that names its journal entry", () => {
    const { store, records, venue, history } = live({ n: 6 });
    history.forEach((slots, i) => expect(selectCommitRecord(...slots)).toMatchObject({ ok: true, record: { seq: i } }));
    const last = linesOf(store).length;
    expect(selectCommitRecord(...records.readSlots())).toMatchObject({ ok: true, record: { seq: last, head: venue.journal.head } });
  });

  it("D-6 a venue with commit records requires a journal store and empty stores; existing stores are opened by recovery", () => {
    expect(() => new Venue(durableOptions({ records: new MemoryCommitRecordStore() }))).toThrow(/journal store/);
    const { store, records } = live({ n: 2 });
    expect(() => new Venue(durableOptions({ store, records }))).toThrow(/Venue\.recover/);
    expect(() => new Venue(durableOptions({ store: new MemoryJournalStore(), records }))).toThrow(/Venue\.recover/);
    expect(() => Venue.recover(durableOptions({ records }), store.read())).toThrow(/journal store/);
  });

  it("D-6 without a commit-record store recovery behaves exactly as in Milestone 10", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue(durableOptions({ store }));
    const commands = orderFlow(3, 10);
    for (const c of commands) venue.submit(c);
    const { venue: recovered, report } = Venue.recover(durableOptions({ store }));
    expect(report).toMatchObject({ commitRecord: null, repairs: [] });
    expect(fingerprint(recovered)).toEqual(fingerprint(referenceVenue(commands)));
  });
});

describe("D-6 crash matrix (DURABILITY-PROTOCOL §2.6)", () => {
  type Row = { inject?: (l: ReturnType<typeof live>) => void; crash?: PersistenceBoundary; committed: boolean; repairs: string[]; tornSlot?: boolean };
  const rows: [string, Row][] = [
    ["1 journal append fails before any byte", { inject: (l) => (l.store.failNextAppend = "before-write"), committed: false, repairs: [] }],
    ["2 torn journal append", { inject: (l) => (l.store.failNextAppend = "torn-write"), committed: false, repairs: ["truncate-torn-tail"] }],
    ["3 journal written, store acknowledgement lost", { inject: (l) => (l.store.failNextAppend = "after-write"), committed: true, repairs: ["advance-commit-record"] }],
    ["4 journal written, commit record missing (crash)", { crash: "after-journal", committed: true, repairs: ["advance-commit-record"] }],
    ["5 record write fails before persisting", { inject: (l) => (l.records.failNextWrite = "before-write"), committed: true, repairs: ["advance-commit-record"] }],
    ["6 torn record slot", { inject: (l) => (l.records.failNextWrite = "torn-write"), committed: true, repairs: ["advance-commit-record"], tornSlot: true }],
    ["7 record written, acknowledgement lost", { inject: (l) => (l.records.failNextWrite = "after-write"), committed: true, repairs: [] }],
    ["8 commit record written, execution not performed (crash)", { crash: "after-record", committed: true, repairs: [] }],
    ["10 executed, outputs not released (crash)", { crash: "after-process", committed: true, repairs: [] }],
  ];

  it.each(rows)("D-6 row %s: outcome-unknown, recovery to the committed state, and an identical retry never executes twice", (_name, row) => {
    const l = live({ crash: row.crash });
    row.inject?.(l);
    expect(l.send()).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
    expect(l.venue.stoppedReason).not.toBeNull();

    const { venue, report } = recover(l.store, l.records);
    expect(kinds(report)).toEqual(row.repairs);
    if (row.tornSlot) expect(report.commitRecord).toMatchObject({ tornSlot: true });
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue(row.committed ? [...l.commands, NEXT_COMMAND] : l.commands)));

    const retry = gatewayOn(venue)();
    expect(retry).toMatchObject({ ok: true, replayed: row.committed });
    expect(acceptedNext(venue)).toBe(1);
    // RI-4: a second recovery of the repaired stores plans nothing and changes no bytes.
    const before = bytes(l.store, l.records);
    expect(kinds(recover(l.store, l.records).report)).toEqual([]);
    expect(bytes(l.store, l.records)).toEqual(before);
  });

  it("D-6 row 9 engine fault (poison): recovery refuses with a replay-fault diagnostic until the code is fixed, stores unchanged", () => {
    const l = live();
    const original = BookSide.prototype.add;
    BookSide.prototype.add = function (this: BookSide, order: Parameters<BookSide["add"]>[0]) {
      if (order.clientOrderId === "k-next") throw new Error("deterministic fault");
      return original.call(this, order);
    };
    try {
      expect(l.send()).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
      refusal(l.store, l.records, "F10-replay-fault", /replay stopped at seq 17/);
    } finally {
      BookSide.prototype.add = original;
    }
    const { venue } = recover(l.store, l.records);
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue([...l.commands, NEXT_COMMAND])));
  });

  it("D-6 row 11 routing fails mid-release: committed, applied once on recovery, retry replays the original", () => {
    const l = live();
    const route = vi.spyOn(Venue.prototype as unknown as { route(): void }, "route").mockImplementationOnce(() => {
      throw new Error("routing fault");
    });
    expect(l.send()).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
    route.mockRestore();
    const { venue, report } = recover(l.store, l.records);
    expect(kinds(report)).toEqual([]);
    expect(gatewayOn(venue)()).toMatchObject({ ok: true, replayed: true });
    expect(acceptedNext(venue)).toBe(1);
  });

  it("D-6 row 12 executed and acknowledged, response lost in transport: indistinguishable from row 10; retry replays", () => {
    const l = live();
    const first = l.send() as Extract<GatewayResponse, { ok: true }>;
    expect(first.ok).toBe(true); // the response "never reaches" the client
    const { venue } = recover(l.store, l.records);
    expect(gatewayOn(venue)()).toEqual({ ...first, replayed: true });
  });

  it("D-6 rows 13–16: after an acknowledged response, loss or corruption of journal data is refused, never silently accepted", () => {
    const l = live();
    expect(l.send()).toMatchObject({ ok: true });
    const text = l.store.read();
    const lines = linesOf(l.store);
    const L = lines.length;
    const variants: [string, string, string, RegExp][] = [
      ["13 last entry lost", text.slice(0, text.length - lines.at(-1)!.length - 1), "F4-record-ahead", new RegExp(`committed entry seq ${L} missing.*journal ends at seq ${L - 1}`)],
      ["14 last entry truncated", text.slice(0, text.length - 1 - Math.floor(lines.at(-1)!.length / 2)), "F4-record-ahead", new RegExp(`committed entry seq ${L} is truncated`)],
      ["15 last entry replaced by the previous bytes", `${[...lines.slice(0, -1), lines.at(-2)].join("\n")}\n`, "F1-journal", /duplicate of the last entry/],
      ["16 interior entry corrupted", `${[...lines.slice(0, 2), lines[2]!.replace(/"hash":"(.)/, (_m, c: string) => `"hash":"${c === "0" ? "1" : "0"}`), ...lines.slice(3)].join("\n")}\n`, "F1-journal", /journal corrupt at line 3/],
    ];
    for (const [name, damaged, code, pattern] of variants) {
      const store = new MemoryJournalStore();
      store.append(damaged);
      const records = new MemoryCommitRecordStore();
      records.replaceSlots([...l.records.readSlots()] as Slots);
      expect(() => refusal(store, records, code, pattern), name).not.toThrow();
    }
  });

  it("D-6 row 17 (limitation): the same entry lost from both stores is not detected; recovery returns the older state", () => {
    const l = live();
    const slotsBefore = [...l.records.readSlots()] as Slots;
    expect(l.send()).toMatchObject({ ok: true });
    const lines = linesOf(l.store);
    l.store.truncate(l.store.read().length - lines.at(-1)!.length - 1);
    l.records.replaceSlots(slotsBefore);
    const { venue } = recover(l.store, l.records);
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue(l.commands))); // the acknowledged order is gone
  });

  it("D-6 rows 18–21: a record ahead of, behind or inconsistent with the journal, unreadable or absent, is refused", () => {
    const l = live();
    const L = linesOf(l.store).length;
    const current = selectCommitRecord(...l.records.readSlots());
    if (!current.ok || !current.record) throw new Error("no record");
    const cases: [string, () => void, string, RegExp][] = [
      ["18 record with an empty journal", () => l.store.truncate(0), "F4-record-ahead", new RegExp(`committed entry seq ${L} missing.*journal ends at seq 0`)],
      ["19 record two behind", () => l.records.replaceSlots(l.history[L - 2]!), "F6-journal-ahead", /2 entries ahead of the commit record/],
      ["20 record names another head", () => l.records.replaceSlots(L % 2 === 0 ? [encodeCommitRecord({ ...current.record!, head: "0".repeat(64) }), l.history[L - 1]![1]] : [l.history[L - 1]![0], encodeCommitRecord({ ...current.record!, head: "0".repeat(64) })]), "F5-record-mismatch", new RegExp(`disagree at seq ${L}`)],
      ["21a unreadable slots", () => l.records.replaceSlots(["x", "y"]), "F2-unreadable", /commit record unusable/],
      ["21b no record for a non-empty journal", () => l.records.replaceSlots([null, null]), "F3-unrecorded-journal", /offline migration.*migrateToCommitRecord/],
    ];
    for (const [name, damage, code, pattern] of cases) {
      const store = new MemoryJournalStore();
      store.append(l.store.read());
      const records = new MemoryCommitRecordStore();
      records.replaceSlots([...l.records.readSlots()] as Slots);
      const original = { store: l.store, records: l.records };
      Object.assign(l, { store, records });
      damage();
      Object.assign(l, original);
      expect(() => refusal(store, records, code, pattern), name).not.toThrow();
    }
  });

  it("D-6 a lost record write: on the final command it rolls forward; followed by one write it is refused; followed by two it is covered", () => {
    const extra = orderFlow(9, 3).slice(-3);
    const a = live();
    a.records.failNextWrite = "lost-write";
    a.venue.submit(extra[0]!);
    expect(kinds(recover(a.store, a.records).report)).toEqual(["advance-commit-record"]);

    // One more write overwrites the other slot: the slots are no longer consecutive (17 lost, 18 next to 15).
    const b = live();
    b.records.failNextWrite = "lost-write";
    for (const c of extra.slice(0, 2)) b.venue.submit(c);
    refusal(b.store, b.records, "F2-stale", /not consecutive \(seq 18 and 15\)/);

    // Two more writes restore a consecutive pair (18, 19). Record 19 names the head that chains through the
    // lost seq 17, so that entry is committed by implication: harmless, and not detected (documented).
    const c = live();
    c.records.failNextWrite = "lost-write";
    for (const cmd of extra) c.venue.submit(cmd);
    const { venue, report } = recover(c.store, c.records);
    expect(kinds(report)).toEqual([]);
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue([...c.commands, ...extra])));
  });

  it("D-5 and VR-28 stay fail-closed with commit records present", () => {
    const l = live();
    const lines = linesOf(l.store);
    const store = new MemoryJournalStore();
    store.append(`${l.store.read()}${lines.at(-1)}\n`);
    refusal(store, l.records, "F1-journal", /duplicate of the last entry/);
    const corrupt = new MemoryJournalStore();
    corrupt.append(`${lines.slice(0, -1).join("\n")}\n${lines.at(-1)!.replace(/"hash":"[0-9a-f]{64}"/, `"hash":"${"0".repeat(64)}"`)}`);
    refusal(corrupt, l.records, "F1-journal", /entry hash mismatch/);
  });
});

describe("D-6 snapshots with commit records (crash-matrix rows 22–26)", () => {
  it("D-6 row 22 a snapshot at or below the record restores to the same state as a full replay", () => {
    const l = live();
    l.send();
    const snapshot = JSON.parse(JSON.stringify(l.venue.snapshot())) as VenueSnapshot;
    expect(fingerprint(recover(l.store, l.records, snapshot).venue)).toEqual(fingerprint(recover(l.store, l.records).venue));
  });

  it("D-6 row 23 snapshot plus a journaled but uncommitted entry rolls forward", () => {
    const l = live();
    const snapshot = JSON.parse(JSON.stringify(l.venue.snapshot())) as VenueSnapshot;
    l.records.failNextWrite = "before-write";
    expect(l.send()).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
    const { venue, report } = recover(l.store, l.records, snapshot);
    expect(kinds(report)).toEqual(["advance-commit-record"]);
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue([...l.commands, NEXT_COMMAND])));
  });

  it("D-6 row 24 a snapshot does not mask a committed entry missing from the journal", () => {
    const l = live();
    const snapshot = JSON.parse(JSON.stringify(l.venue.snapshot())) as VenueSnapshot;
    l.send();
    l.store.truncate(l.store.read().length - linesOf(l.store).at(-1)!.length - 1);
    refusal(l.store, l.records, "F4-record-ahead", /committed entry seq 17 missing/, snapshot);
  });

  it("D-6 row 25 a snapshot ahead of the commit record is refused", () => {
    const l = live();
    l.send();
    const snapshot = JSON.parse(JSON.stringify(l.venue.snapshot())) as VenueSnapshot;
    l.records.replaceSlots(l.history[16]!);
    refusal(l.store, l.records, "F7-snapshot-ahead", /snapshot at seq 17 is ahead of the commit record \(seq 16\)/, snapshot);
  });
});

/** A journal store whose truncate can fail in the modelled ways (recoverable and nonconforming). */
type TruncateFault = "before" | "partial" | "partial-silent" | "noop-silent" | "overshoot-committed" | "overshoot-uncommitted";
class FaultyJournalStore extends MemoryJournalStore {
  truncateFault: TruncateFault | null = null;
  /** The next append returns normally but stores nothing (a nonconforming store). */
  appendLost = false;
  override append(line: string): void {
    if (this.appendLost) {
      this.appendLost = false;
      return;
    }
    super.append(line);
  }
  /** Byte offset where the last complete line (the uncommitted entry, in state A) starts. */
  lastLineStart = 0;
  override truncate(length: number): void {
    const fault = this.truncateFault;
    this.truncateFault = null;
    const current = this.read().length;
    if (fault === "before") throw new Error("injected: truncate failed");
    if (fault === "noop-silent") return;
    if (fault === "partial" || fault === "partial-silent") {
      super.truncate(length + Math.ceil((current - length) / 2));
      if (fault === "partial") throw new Error("injected: partial truncate");
      return;
    }
    if (fault === "overshoot-uncommitted") return super.truncate(this.lastLineStart + 10);
    if (fault === "overshoot-committed") return super.truncate(this.lastLineStart - 10);
    super.truncate(length);
  }
}

/**
 * Repair states. "A": a torn tail after an uncommitted entry (record one behind) — plan R1, R3.
 * "B": the final entry without its newline, record one behind — plan R2, R3. Both are reachable
 * (crash between the journal append and the record write, plus a torn or newline-less tail).
 */
function repairState(kind: "A" | "B", seed = 1) {
  const store = new FaultyJournalStore();
  const l = live({ store, seed });
  expect(l.send()).toMatchObject({ ok: true });
  const L = linesOf(store).length;
  const text = store.read();
  store.lastLineStart = text.length - linesOf(store).at(-1)!.length - 1;
  l.records.replaceSlots(l.history[L - 1]!);
  if (kind === "A") store.append('{"command":{"type":"publish"},"hash":"ab');
  else store.truncate(text.length - 1);
  const clean = kind === "A" ? text : text; // the fully repaired journal, in both states
  return { ...l, store, L, clean, expected: fingerprint(referenceVenue([...l.commands, NEXT_COMMAND])), withoutNext: fingerprint(referenceVenue(l.commands)) };
}

function attempt(store: MemoryJournalStore, records: MemoryCommitRecordStore): "ok" | RecoveryRepairError {
  try {
    recover(store, records);
    return "ok";
  } catch (error) {
    if (error instanceof RecoveryRepairError) return error;
    throw error;
  }
}

describe("D-6 recovery repair is not atomic, but converges (RI-1–RI-6, IR-1–IR-14)", () => {
  it("D-6 RI-2 recovery mutates the stores only by the planned steps, journal first and record last", () => {
    const s = repairState("A");
    const log: string[] = [];
    const { append, truncate } = s.store;
    s.store.append = (line: string) => (log.push(`append ${JSON.stringify(line)}`), append.call(s.store, line));
    s.store.truncate = (n: number) => (log.push(`truncate ${n}`), truncate.call(s.store, n));
    const write = s.records.writeSlot.bind(s.records);
    s.records.writeSlot = (i: 0 | 1, b: string) => (log.push(`slot ${i} seq ${JSON.parse(b).seq}`), write(i, b));
    const { venue, report } = recover(s.store, s.records);
    expect(log).toEqual([`truncate ${s.clean.length}`, `slot ${s.L % 2} seq ${s.L}`]);
    expect(kinds(report)).toEqual(["truncate-torn-tail", "advance-commit-record"]);
    expect(fingerprint(venue)).toEqual(s.expected);
  });

  it("D-6 RI-5 a failed repair returns no venue and reports the completed and failed steps", () => {
    const s = repairState("B");
    s.records.failNextWrite = "before-write";
    const error = attempt(s.store, s.records) as RecoveryRepairError;
    expect(error).toBeInstanceOf(RecoveryRepairError);
    expect(error.completedSteps.map((x) => x.kind)).toEqual(["restore-newline"]);
    expect(error.failedStep.kind).toBe("advance-commit-record");
  });

  type IR = { state: "A" | "B"; fault: (s: ReturnType<typeof repairState>) => void; then: "converges" | "converges-without-uncommitted" | "refused"; firstFails: boolean };
  const irs: [string, IR][] = [
    ["IR-2 truncate throws before changing anything", { state: "A", fault: (s) => (s.store.truncateFault = "before"), then: "converges", firstFails: true }],
    ["IR-3 partial truncate, then throws", { state: "A", fault: (s) => (s.store.truncateFault = "partial"), then: "converges", firstFails: true }],
    ["IR-3b partial truncate reported as success (read-back detects it)", { state: "A", fault: (s) => (s.store.truncateFault = "partial-silent"), then: "converges", firstFails: true }],
    ["IR-4 truncate overshoots into a committed entry (nonconforming)", { state: "A", fault: (s) => (s.store.truncateFault = "overshoot-committed"), then: "refused", firstFails: true }],
    ["IR-5 truncate overshoots into the uncommitted entry (nonconforming)", { state: "A", fault: (s) => (s.store.truncateFault = "overshoot-uncommitted"), then: "converges-without-uncommitted", firstFails: true }],
    ["IR-7 newline append fails before writing", { state: "B", fault: (s) => (s.store.failNextAppend = "before-write"), then: "converges", firstFails: true }],
    ["IR-7b newline append written, then throws", { state: "B", fault: (s) => (s.store.failNextAppend = "after-write"), then: "converges", firstFails: true }],
    ["IR-9 record write fails before persisting", { state: "A", fault: (s) => (s.records.failNextWrite = "before-write"), then: "converges", firstFails: true }],
    ["IR-10 torn record slot", { state: "B", fault: (s) => (s.records.failNextWrite = "torn-write"), then: "converges", firstFails: true }],
    ["IR-11 record written, acknowledgement lost", { state: "A", fault: (s) => (s.records.failNextWrite = "after-write"), then: "converges", firstFails: true }],
    ["IR-12 record write acknowledged but lost (read-back detects it)", { state: "B", fault: (s) => (s.records.failNextWrite = "lost-write"), then: "converges", firstFails: true }],
  ];

  it.each(irs)("D-6 %s", (_name, ir) => {
    const s = repairState(ir.state);
    ir.fault(s);
    const first = attempt(s.store, s.records);
    expect(first === "ok").toBe(!ir.firstFails);
    if (ir.then === "refused") {
      // RI-6: overshoot into committed data is detected; recovery refuses instead of accepting a shorter journal.
      refusal(s.store, s.records, "F4-record-ahead", /committed entry seq \d+ is truncated/);
      return;
    }
    const { venue, report } = recover(s.store, s.records);
    expect(fingerprint(venue)).toEqual(ir.then === "converges" ? s.expected : s.withoutNext);
    // Converged stores are canonical: the clean journal and a record naming its last entry.
    if (ir.then === "converges") expect(s.store.read()).toBe(s.clean);
    expect(selectCommitRecord(...s.records.readSlots())).toMatchObject({ ok: true, record: { seq: venue.journal.lastSeq, head: venue.journal.head } });
    expect(kinds(recover(s.store, s.records).report)).toEqual([]); // RI-4
    void report;
  });

  it("D-6 IR-3 a partial truncation is repaired by a revised R1 that removes fewer bytes (no literal plan suffix)", () => {
    const s = repairState("A");
    const original = s.store.read().length - s.clean.length;
    s.store.truncateFault = "partial";
    expect(attempt(s.store, s.records)).toBeInstanceOf(RecoveryRepairError);
    const { report } = recover(s.store, s.records);
    const r1 = report.repairs.find((x) => x.kind === "truncate-torn-tail") as { removedBytes: number };
    expect(r1.removedBytes).toBeGreaterThan(0);
    expect(r1.removedBytes).toBeLessThan(original);
  });

  it("D-6 IR-14 convergence: any sequence of up to five recoverable repair faults ends in the same committed state", () => {
    const faults = ["truncate-before", "truncate-partial", "truncate-partial-silent", "newline-before", "newline-after", "record-before", "record-torn", "record-after", "record-lost"] as const;
    fc.assert(
      fc.property(fc.constantFrom<"A" | "B">("A", "B"), fc.array(fc.constantFrom(...faults), { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 4 }), (kind, sequence, seed) => {
        const s = repairState(kind, seed);
        for (const fault of sequence) {
          if (fault === "truncate-before") s.store.truncateFault = "before";
          if (fault === "truncate-partial") s.store.truncateFault = "partial";
          if (fault === "truncate-partial-silent") s.store.truncateFault = "partial-silent";
          if (fault === "newline-before") s.store.failNextAppend = "before-write";
          if (fault === "newline-after") s.store.failNextAppend = "after-write";
          if (fault === "record-before") s.records.failNextWrite = "before-write";
          if (fault === "record-torn") s.records.failNextWrite = "torn-write";
          if (fault === "record-after") s.records.failNextWrite = "after-write";
          if (fault === "record-lost") s.records.failNextWrite = "lost-write";
          attempt(s.store, s.records);
          s.store.truncateFault = null;
          s.store.failNextAppend = null;
          s.records.failNextWrite = null;
        }
        const { venue } = recover(s.store, s.records);
        expect(fingerprint(venue)).toEqual(s.expected);
        expect(s.store.read()).toBe(s.clean);
        expect(kinds(recover(s.store, s.records).report)).toEqual([]);
      }),
      { numRuns: 150, seed: 11 },
    );
  });
});

describe("D-6 crash-boundary property with commit records", () => {
  const BOUNDARIES = ["journal-before", "journal-torn", "journal-after", "after-journal", "record-before", "record-torn", "record-after", "after-record", "after-process"] as const;
  const COMMITTED: Record<(typeof BOUNDARIES)[number], boolean> = {
    "journal-before": false,
    "journal-torn": false,
    "journal-after": true,
    "after-journal": true,
    "record-before": true,
    "record-torn": true,
    "record-after": true,
    "after-record": true,
    "after-process": true,
  };

  it("D-6 / D-1 recovery equals exactly the committed commands at every boundary, and the stores stay appendable", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.constantFrom(...BOUNDARIES), fc.nat(), (seed, boundary, at) => {
        const commands = orderFlow(seed, 60);
        const k = 4 + (at % (commands.length - 4)); // the interrupted command (0-based)
        const store = new MemoryJournalStore();
        const records = new MemoryCommitRecordStore();
        const options = durableOptions({ store, records });
        const crash = boundary === "after-journal" || boundary === "after-record" || boundary === "after-process" ? boundary : undefined;
        const venue = crash ? new CrashingVenue(options, crash, k + 1) : new Venue(options);
        for (const c of commands.slice(0, k)) venue.submit(c);
        if (boundary === "journal-before") store.failNextAppend = "before-write";
        if (boundary === "journal-torn") store.failNextAppend = "torn-write";
        if (boundary === "journal-after") store.failNextAppend = "after-write";
        if (boundary === "record-before") records.failNextWrite = "before-write";
        if (boundary === "record-torn") records.failNextWrite = "torn-write";
        if (boundary === "record-after") records.failNextWrite = "after-write";
        expect(() => venue.submit(commands[k]!)).toThrow();
        const committed = commands.slice(0, COMMITTED[boundary] ? k + 1 : k);

        const { venue: recovered } = recover(store, records);
        expect(fingerprint(recovered)).toEqual(fingerprint(referenceVenue(committed)));
        for (const c of commands.slice(committed.length)) recovered.submit(c);
        const again = recover(store, records);
        expect(again.report.repairs).toEqual([]);
        expect(fingerprint(again.venue)).toEqual(fingerprint(referenceVenue(commands)));
      }),
      { numRuns: 150, seed: 7 },
    );
  });
});

describe("D-6 final correctness review", () => {
  /** A lost record write for seq 17, then `more` successful writes. */
  function lostThenWrites(more: number) {
    const l = live();
    const extra = orderFlow(9, 4).slice(-(more + 1));
    l.records.failNextWrite = "lost-write";
    for (const c of extra) l.venue.submit(c);
    return { ...l, all: [...l.commands, ...extra], L: 16 + extra.length };
  }

  it.each([2, 3])("D-6 a lost record write healed by %i later writes: the selected record binds the complete journal prefix", (more) => {
    const h = lostThenWrites(more);
    const selected = selectCommitRecord(...h.records.readSlots());
    expect(selected).toMatchObject({ ok: true, record: { seq: h.L } });
    // Every journaled entry, including the one whose record was lost, is recovered.
    const { venue, report } = recover(h.store, h.records);
    expect(report.repairs).toEqual([]);
    expect(fingerprint(venue)).toEqual(fingerprint(referenceVenue(h.all)));

    const lines = linesOf(h.store);
    const text = h.store.read();
    // (a) The journal loses its newest entry: refused, never accepted as a shorter history.
    const shorter = new MemoryJournalStore();
    shorter.append(text.slice(0, text.length - lines.at(-1)!.length - 1));
    refusal(shorter, h.records, "F4-record-ahead", new RegExp(`committed entry seq ${h.L} missing`));
    // (b) The history is rewritten from the lost seq onward with every hash recomputed (a valid chain):
    // the record names the original head, so the rewrite is refused.
    const rewritten: string[] = lines.slice(0, 16);
    let prev = JSON.parse(lines[15]!).hash as string;
    for (const line of lines.slice(16)) {
      const e = JSON.parse(line) as { seq: number; ts: number; command: EngineCommand };
      const command: EngineCommand = e.seq === 17 ? { type: "publish" } : e.command;
      const hash = entryHash(prev, e.seq, e.ts, command);
      rewritten.push(canonicalJson({ seq: e.seq, ts: e.ts, command, prevHash: prev, hash }));
      prev = hash;
    }
    const forged = new MemoryJournalStore();
    forged.append(`${rewritten.join("\n")}\n`);
    refusal(forged, h.records, "F5-record-mismatch", new RegExp(`disagree at seq ${h.L}`));
  });

  it("D-6 Phase V never calls a mutating store method for any refusal (write trap, not only byte equality)", () => {
    const l = live();
    expect(l.send()).toMatchObject({ ok: true });
    const L = linesOf(l.store).length;
    const text = l.store.read();
    const lines = linesOf(l.store);
    const slots = [...l.records.readSlots()] as Slots;
    const snapshot = JSON.parse(JSON.stringify(l.venue.snapshot())) as VenueSnapshot;
    const current = selectCommitRecord(...slots);
    if (!current.ok || !current.record) throw new Error("no record");
    const wrongHead = encodeCommitRecord({ ...current.record, head: "0".repeat(64) });

    class TrapJournal extends MemoryJournalStore {
      mutations = 0;
      armed = false;
      override append(line: string) {
        if (this.armed) this.mutations++;
        super.append(line);
      }
      override truncate(n: number) {
        if (this.armed) this.mutations++;
        super.truncate(n);
      }
    }
    class TrapRecords extends MemoryCommitRecordStore {
      mutations = 0;
      armed = false;
      override writeSlot(i: 0 | 1, b: string) {
        if (this.armed) this.mutations++;
        super.writeSlot(i, b);
      }
      override replaceSlots(s: readonly [string | null, string | null]) {
        if (this.armed) this.mutations++;
        super.replaceSlots(s);
      }
    }
    const cases: [string, string, Slots, string, VenueSnapshot?][] = [
      ["F1-journal", `${text}${lines.at(-1)}\n`, slots, "duplicate"],
      ["F2-unreadable", text, ["x", "y"], "unreadable"],
      ["F2-inconsistent", text, [slots[1], slots[0]], "inconsistent"],
      ["F2-stale", text, L % 2 === 0 ? [slots[0], l.history[L - 4]![1]] : [l.history[L - 4]![0], slots[1]], "stale"],
      ["F3-unrecorded-journal", text, [null, null], "unrecorded"],
      ["F4-record-ahead", text.slice(0, text.length - lines.at(-1)!.length - 1), slots, "missing"],
      ["F4-record-ahead", text.slice(0, text.length - 20), slots, "truncated"],
      ["F5-record-mismatch", text, L % 2 === 0 ? [wrongHead, slots[1]] : [slots[0], wrongHead], "mismatch"],
      ["F6-journal-ahead", text, l.history[L - 2]!, "behind"],
      ["F7-snapshot-ahead", text, l.history[L - 1]!, "snapshot ahead", snapshot],
      ["F8-snapshot-rules-version", text, slots, "rules version", { ...snapshot, rulesVersion: "other" }],
      ["snapshot-invalid", text, slots, "state hash", { ...snapshot, stateHash: "0".repeat(64) }],
    ];
    for (const [code, journal, slotState, name, snap] of cases) {
      const store = new TrapJournal();
      store.append(journal);
      const records = new TrapRecords();
      records.replaceSlots(slotState);
      store.armed = true;
      records.armed = true;
      let error: unknown;
      try {
        recover(store, records, snap);
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(RecoveryRefusedError);
      expect((error as RecoveryRefusedError).code, name).toBe(code);
      expect({ name, journal: store.mutations, records: records.mutations }).toEqual({ name, journal: 0, records: 0 });
    }

    // F10: a poison command also refuses without touching either store.
    const store = new TrapJournal();
    store.append(text);
    const records = new TrapRecords();
    records.replaceSlots(slots);
    store.armed = records.armed = true;
    const original = BookSide.prototype.add;
    BookSide.prototype.add = function (this: BookSide, order: Parameters<BookSide["add"]>[0]) {
      if (order.clientOrderId === "k-next") throw new Error("fault");
      return original.call(this, order);
    };
    try {
      expect(() => recover(store, records)).toThrow(/replay stopped at seq 17/);
    } finally {
      BookSide.prototype.add = original;
    }
    expect([store.mutations, records.mutations]).toEqual([0, 0]);
  });

  it.each([
    ["a truncation that silently does nothing", "A" as const, (s: ReturnType<typeof repairState>): void => {
      s.store.truncateFault = "noop-silent";
    }, "truncate-torn-tail"],
    ["a newline append acknowledged but not stored", "B" as const, (s: ReturnType<typeof repairState>): void => {
      s.store.appendLost = true;
    }, "restore-newline"],
    ["a record write acknowledged but not stored", "A" as const, (s: ReturnType<typeof repairState>): void => {
      s.records.failNextWrite = "lost-write";
    }, "advance-commit-record"],
  ])("D-6 repair read-back detects %s, returns no venue, and the next recovery converges", (_name, state, fault, step) => {
    const s = repairState(state);
    fault(s);
    const error = attempt(s.store, s.records);
    expect(error).toBeInstanceOf(RecoveryRepairError);
    expect((error as RecoveryRepairError).failedStep.kind).toBe(step);
    expect((error as RecoveryRepairError).message).toMatch(/read-back/);
    const { venue } = recover(s.store, s.records);
    expect(fingerprint(venue)).toEqual(s.expected);
    expect(s.store.read()).toBe(s.clean);
  });
});
