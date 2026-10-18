import { describe, expect, it } from "vitest";
import { BookSide } from "./book";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway } from "./gateway";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { canonicalJson, Journal, readJournal } from "./journal";
import { MemoryAnchorStore, MemoryJournalStore } from "./storage";
import { SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA } from "./test-helpers";
import type { EngineCommand } from "./types";
import { OutcomeUnknownError, Venue, type QuarantineRequest, type VenueOptions } from "./venue";

/**
 * Milestone 11, WP2: quarantine of a poison command (VR-18, MATCHING-RULES D-7).
 *
 * A command that faults deterministically faults again on every replay, so recovery can never complete.
 * An operator may quarantine it only when it is the final valid journal entry, its hash matches, the fault
 * reproduces, and the evidence shows that it produced no externally acknowledged output. The decision is
 * journaled, so every later replay — with or without operator input — reaches the same state.
 *
 * The fault is injected by patching `BookSide.add` for one client order id, live and during replay (a
 * stand-in for an engine bug, as in the Milestone 9 VR-18 test). Written before the implementation and run
 * first against 9812049 (docs/venue/verification/m11/wp2-tests-against-9812049.log).
 */

const ACCOUNTS = ["syn-a", "syn-b"];
const opts = (store: MemoryJournalStore, anchor: MemoryAnchorStore): VenueOptions => ({
  engine: { idKey: "local-prototype-key", publication: "immediate" },
  allowTestFixtureIdKey: true,
  clock: () => 1_700_000_000_000,
  store,
  anchor,
});
const order = (clientOrderId: string, o: Partial<Extract<EngineCommand, { type: "new-order" }>> = {}): EngineCommand => ({
  type: "new-order",
  accountId: "syn-a",
  clientOrderId,
  instrumentId: ALPHA,
  side: "buy",
  orderType: "limit",
  priceTicks: 3_990,
  qtyLots: 5,
  tif: "gtc",
  visibility: "displayed",
  postOnly: false,
  stp: "cancel-taker",
  ...o,
});

/**
 * Runs `fn` while orders with the given client order id (and, if given, price) fault when they rest:
 * a deterministic fault tied to that exact command.
 */
function withFault<T>(clientOrderId: string, fn: () => T, priceTicks?: number): T {
  const original = BookSide.prototype.add;
  BookSide.prototype.add = function (this: BookSide, o: Parameters<BookSide["add"]>[0]) {
    if (o.clientOrderId === clientOrderId && (priceTicks === undefined || o.priceTicks === priceTicks)) throw new Error("deterministic fault");
    return original.call(this, o);
  };
  try {
    return fn();
  } finally {
    BookSide.prototype.add = original;
  }
}

/** A live anchored venue that processes some flow, then faults on a poison order (journaled, outcome unknown). */
function poisoned(o: { resting?: boolean } = {}) {
  const store = new MemoryJournalStore();
  const anchor = new MemoryAnchorStore();
  const venue = new Venue(opts(store, anchor));
  venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
  for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  venue.submit(order("r1", { priceTicks: 3_980 }));
  venue.submit(order("x1", { accountId: "syn-b", side: "sell", priceTicks: 4_010 }));
  venue.submit(order("t1", { accountId: "syn-b", side: "sell", priceTicks: 3_980, qtyLots: 2 })); // trades with r1
  if (o.resting) venue.submit(order("r2", { priceTicks: 3_970 }));
  const ordersBefore = venue.engine.snapshot().orders;
  const observed = {
    publicSeq: venue.publicTape.at(-1)?.publicSeq ?? 0,
    accountSeqs: Object.fromEntries(ACCOUNTS.map((a) => [a, venue.privateEvents(a).at(-1)?.accountSeq ?? 0])),
  };
  const poison = order("poison", { priceTicks: 3_985 });
  withFault("poison", () => expect(() => venue.submit(poison)).toThrow(OutcomeUnknownError));
  const entry = readJournal(store.read());
  if (!entry.ok) throw new Error("journal unreadable");
  const last = entry.entries.at(-1)!;
  expect(last.command).toEqual(poison);
  return { store, anchor, venue, ordersBefore, observed, poison, poisonSeq: last.seq, poisonHash: last.hash };
}

function request(p: ReturnType<typeof poisoned>, o: Partial<QuarantineRequest> = {}): QuarantineRequest {
  return {
    seq: p.poisonSeq,
    hash: p.poisonHash,
    reason: "deterministic engine fault on replay (test)",
    approvedBy: "operator-1 (prototype, unauthenticated)",
    suspendAccount: false,
    evidence: {
      clientOutcome: "outcome-unknown",
      sameEngineBuild: true,
      observedPublicSeq: p.observed.publicSeq,
      observedAccountSeqs: p.observed.accountSeqs,
      notes: "consumers checked: no public or private output with this sequence",
    },
    ...o,
  };
}

/** Recovery must refuse with `pattern` and leave both stores untouched. */
function refuses(p: ReturnType<typeof poisoned>, q: QuarantineRequest, pattern: RegExp, snapshot?: Parameters<typeof Venue.recover>[2]) {
  const text = p.store.read();
  const record = p.anchor.read();
  withFault("poison", () => expect(() => Venue.recover(opts(p.store, p.anchor), undefined, snapshot, { quarantine: q })).toThrow(pattern));
  expect(p.store.read()).toBe(text);
  expect(p.anchor.read()).toBe(record);
}

describe("D-7 quarantine of a poison command (VR-18)", () => {
  it("D-7 without a quarantine, recovery still stops at the poison command and names its sequence number", () => {
    const p = poisoned();
    withFault("poison", () => expect(() => Venue.recover(opts(p.store, p.anchor))).toThrow(new RegExp(`replay stopped at seq ${p.poisonSeq}: deterministic fault`)));
  });

  it("D-7 the operator quarantines the final faulting entry: recovery completes, the client gets a definitive rejection, the decision is journaled and anchored", () => {
    const p = poisoned();
    const { venue, report } = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p) }));
    expect(report.quarantined).toEqual([p.poisonSeq]);
    expect(venue.stoppedReason).toBeNull();
    // Nothing of the poison took effect: exactly the orders that existed before it.
    expect(venue.engine.orderFor("syn-a", { clientOrderId: "poison" })).toBeNull();
    expect(venue.engine.snapshot().orders).toEqual(p.ordersBefore);
    // The client's outcome-unknown is resolved: one rejected event, reason quarantined.
    const events = venue.privateEvents("syn-a", p.observed.accountSeqs["syn-a"]);
    expect(events).toEqual([expect.objectContaining({ kind: "rejected", clientOrderId: "poison", reason: "quarantined", accountSeq: p.observed.accountSeqs["syn-a"]! + 1 })]);
    // The decision is the next journal entry, and the anchor covers it.
    const last = venue.journal.entries.at(-1)!;
    expect(last.seq).toBe(p.poisonSeq + 1);
    expect(last.command).toMatchObject({ type: "admin.quarantine", seq: p.poisonSeq, hash: p.poisonHash, suspendAccount: false, evidence: { clientOutcome: "outcome-unknown", sameEngineBuild: true } });
    expect(JSON.parse(p.anchor.read()!)).toEqual({ seq: last.seq, hash: last.hash });
    // Trading continues.
    const r = venue.submit(order("after", { priceTicks: 3_981 }));
    expect(r.private.some((e) => e.kind === "accepted")).toBe(true);
  });

  it("D-7 later plain recoveries (full replay, snapshot + suffix) reproduce the same state and outputs without operator input, fault still present", () => {
    const p = poisoned();
    const first = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p) })).venue;
    const snap = first.snapshot();
    first.submit(order("later", { priceTicks: 3_982 }));
    const full = withFault("poison", () => Venue.recover(opts(p.store, p.anchor)).venue);
    expect(full.engine.stateHash()).toBe(first.engine.stateHash());
    expect(full.outputHead).toBe(first.outputHead);
    expect(full.privateEvents("syn-a")).toEqual(first.privateEvents("syn-a"));
    const fromSnap = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, snap).venue);
    expect(fromSnap.engine.stateHash()).toBe(first.engine.stateHash());
    expect(fromSnap.outputHead).toBe(first.outputHead);
    // Replay from text, outside the store, agrees too (a replica replaying the same journal).
    const replica = withFault("poison", () => Venue.recover({ engine: { idKey: "local-prototype-key", publication: "immediate" }, allowTestFixtureIdKey: true, clock: () => 0 }, p.store.read()).venue);
    expect(replica.engine.stateHash()).toBe(first.engine.stateHash());
  });

  it("D-7 an identical resubmission of the quarantined command is refused before journaling; the gateway answers quarantined", () => {
    const p = poisoned();
    const venue = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p) })).venue;
    const seq = venue.journal.lastSeq;
    expect(() => venue.submit(p.poison)).toThrow(/quarantined/);
    expect(venue.journal.lastSeq).toBe(seq);
    expect(venue.stoppedReason).toBeNull();
    const gateway = new VenueGateway(venue, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
    const token = gateway.openSession("syn-a");
    const res = gateway.handle(token, { op: "new", clientOrderId: "poison", instrumentId: ALPHA, side: "buy", type: "limit", price: "1992.50", quantity: "0.005" });
    expect(res).toMatchObject({ ok: false, error: { code: "quarantined" } });
    expect(venue.journal.lastSeq).toBe(seq);
    // A different request with the same client order id is evaluated normally (it never consumed the id).
    const other = gateway.handle(token, { op: "new", clientOrderId: "poison", instrumentId: ALPHA, side: "buy", type: "limit", price: "1990.00", quantity: "0.005" });
    expect(other).toMatchObject({ ok: true, replayed: false });
    // The block survives a restart: it is rebuilt from the journal.
    // (The injected fault is tied to the poison command itself — same id *and* price — not to the other order.)
    const restarted = withFault("poison", () => Venue.recover(opts(p.store, p.anchor)).venue, 3_985);
    expect(() => restarted.submit(p.poison)).toThrow(/quarantined/);
  });

  it("D-7 suspendAccount suspends the account in the same journaled decision", () => {
    const p = poisoned({ resting: true });
    const venue = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p, { suspendAccount: true }) })).venue;
    expect(venue.engine.openOrdersFor("syn-a")).toEqual([]);
    const r = venue.submit(order("new-after-suspend", { priceTicks: 3_981 }));
    expect(r.private).toEqual([expect.objectContaining({ kind: "rejected", reason: "account-suspended" })]);
  });

  it("D-7 refused: wrong sequence, wrong hash, a snapshot at the entry, incomplete or contradicting evidence", () => {
    const p = poisoned();
    refuses(p, request(p, { seq: p.poisonSeq - 1 }), /not the final journal entry/);
    refuses(p, request(p, { hash: "0".repeat(64) }), /hash does not match/);
    refuses(p, request(p, { evidence: { ...request(p).evidence, sameEngineBuild: false as true } }), /evidence/);
    refuses(p, request(p, { evidence: { ...request(p).evidence, clientOutcome: "filled" as "outcome-unknown" } }), /evidence/);
    refuses(p, request(p, { reason: "" }), /reason/);
    refuses(p, request(p, { approvedBy: "" }), /approvedBy/);
    // Downstream evidence contradicts "no acknowledged output": consumers saw output beyond the state before the entry.
    refuses(p, request(p, { evidence: { ...request(p).evidence, observedPublicSeq: p.observed.publicSeq + 1 } }), /acknowledged/);
    refuses(p, request(p, { evidence: { ...request(p).evidence, observedAccountSeqs: { ...p.observed.accountSeqs, "syn-a": p.observed.accountSeqs["syn-a"]! + 1 } } }), /acknowledged/);
  });

  it("D-7 refused: an entry that does not fault (it may have produced acknowledged outputs) and an entry in the middle of the journal", () => {
    // A healthy final entry: no reproducible fault.
    const healthy = poisoned();
    const store = healthy.store;
    const recovered = withFault("poison", () => Venue.recover(opts(store, healthy.anchor), undefined, undefined, { quarantine: request(healthy) })).venue;
    recovered.submit(order("fine", { priceTicks: 3_983 }));
    const fine = recovered.journal.entries.at(-1)!;
    const q = { ...request(healthy), seq: fine.seq, hash: fine.hash };
    const text = store.read();
    expect(() => Venue.recover(opts(store, healthy.anchor), undefined, undefined, { quarantine: q })).toThrow(/does not fault/);
    expect(store.read()).toBe(text);
    // A fault in the middle of the journal (e.g. after a code change) is never quarantined.
    const mid = recovered.journal.entries.find((e) => e.command.type === "new-order" && e.command.clientOrderId === "x1")!;
    withFault("x1", () => {
      expect(() => Venue.recover(opts(store, healthy.anchor))).toThrow(new RegExp(`replay stopped at seq ${mid.seq}`));
      expect(() => Venue.recover(opts(store, healthy.anchor), undefined, undefined, { quarantine: { ...q, seq: mid.seq, hash: mid.hash } })).toThrow(/not the final journal entry/);
    });
    expect(store.read()).toBe(text);
  });

  it("D-7 refused: suspendAccount for a command without an account, a quarantine of a quarantine record, and a snapshot at or after the entry", () => {
    const p = poisoned();
    const venue = withFault("poison", () => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p) })).venue;
    const record = venue.journal.entries.at(-1)!;
    expect(() => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: { ...request(p), seq: record.seq, hash: record.hash } })).toThrow(/cannot be quarantined/);
    expect(() => Venue.recover(opts(p.store, p.anchor), undefined, undefined, { quarantine: request(p) })).toThrow(/already quarantined/);
    const snap = venue.snapshot();
    expect(() => Venue.recover(opts(p.store, p.anchor), undefined, snap, { quarantine: request(p) })).toThrow(/already quarantined|snapshot/);
    // suspendAccount needs an account-scoped command: a final admin.add-instrument has no account.
    const store = new MemoryJournalStore();
    const anchor = new MemoryAnchorStore();
    new Venue(opts(store, anchor)).submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
    const only = readJournal(store.read());
    if (!only.ok) throw new Error("unreadable");
    expect(() => Venue.recover(opts(store, anchor), undefined, undefined, { quarantine: request(p, { suspendAccount: true, seq: 1, hash: only.entries[0]!.hash }) })).toThrow(/suspendAccount needs an account-scoped command/);
  });

  it("D-7 a crash while journaling the quarantine record is safe: repeat the quarantine (torn) or recover plainly (written)", () => {
    const torn = poisoned();
    torn.store.failNextAppend = "torn-write";
    expect(() => withFault("poison", () => Venue.recover(opts(torn.store, torn.anchor), undefined, undefined, { quarantine: request(torn) }))).toThrow(OutcomeUnknownError);
    const retried = withFault("poison", () => Venue.recover(opts(torn.store, torn.anchor), undefined, undefined, { quarantine: request(torn) }));
    expect(retried.report.tornTail).toBe(true);
    expect(retried.venue.journal.entries.at(-1)!.command.type).toBe("admin.quarantine");

    const written = poisoned();
    written.store.failNextAppend = "after-write";
    expect(() => withFault("poison", () => Venue.recover(opts(written.store, written.anchor), undefined, undefined, { quarantine: request(written) }))).toThrow(OutcomeUnknownError);
    expect(() => withFault("poison", () => Venue.recover(opts(written.store, written.anchor), undefined, undefined, { quarantine: request(written) }))).toThrow(/already quarantined/);
    const plain = withFault("poison", () => Venue.recover(opts(written.store, written.anchor)).venue);
    expect(plain.engine.orderFor("syn-a", { clientOrderId: "poison" })).toBeNull();
    expect(plain.journal.entries.at(-1)!.command.type).toBe("admin.quarantine");
  });

  it("D-7 a journaled quarantine record that does not reference the immediately preceding entry is refused", () => {
    const p = poisoned();
    const read = readJournal(p.store.read());
    if (!read.ok) throw new Error("unreadable");
    const forged = Journal.fromEntries(read.entries);
    const target = read.entries.at(-2)!; // not the entry just before the record
    forged.append(1_700_000_000_000, { type: "admin.quarantine", seq: target.seq, hash: target.hash, reason: "forged", approvedBy: "x", suspendAccount: false, evidence: request(p).evidence });
    expect(() => withFault("poison", () => Venue.recover({ engine: { idKey: "local-prototype-key", publication: "immediate" }, allowTestFixtureIdKey: true, clock: () => 0 }, forged.toJsonl()))).toThrow(/quarantine record at seq \d+ does not reference the preceding entry/);
    expect(canonicalJson(read.entries.at(-1)!.command)).toContain("poison");
  });

  it("D-7 quarantined cancel and replace requests resolve with request-rejected: quarantined", () => {
    const store = new MemoryJournalStore();
    const anchor = new MemoryAnchorStore();
    const venue = new Venue(opts(store, anchor));
    venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
    for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
    venue.submit(order("c1", { priceTicks: 3_980 }));
    const before = venue.privateEvents("syn-a").at(-1)!.accountSeq;
    // A fault that hits this cancel on every replay (stands in for an engine bug).
    const original = BookSide.prototype.remove;
    BookSide.prototype.remove = function () {
      throw new Error("deterministic fault in cancel");
    };
    try {
      expect(() => venue.submit({ type: "cancel", accountId: "syn-a", ref: { clientOrderId: "c1" } })).toThrow(OutcomeUnknownError);
      const last = readJournal(store.read());
      if (!last.ok) throw new Error("unreadable");
      const e = last.entries.at(-1)!;
      const q: QuarantineRequest = {
        seq: e.seq,
        hash: e.hash,
        reason: "cancel faults",
        approvedBy: "operator-1",
        suspendAccount: false,
        evidence: { clientOutcome: "outcome-unknown", sameEngineBuild: true, observedPublicSeq: venue.publicTape.at(-1)!.publicSeq, observedAccountSeqs: { "syn-a": before }, notes: "checked" },
      };
      const recovered = Venue.recover(opts(store, anchor), undefined, undefined, { quarantine: q }).venue;
      expect(recovered.privateEvents("syn-a", before)).toEqual([expect.objectContaining({ kind: "request-rejected", request: "cancel", reason: "quarantined" })]);
      expect(recovered.engine.orderFor("syn-a", { clientOrderId: "c1" })).toMatchObject({ status: "new" });
    } finally {
      BookSide.prototype.remove = original;
    }
  });
});

describe("D-7 / D-6 operator records are written only by recovery", () => {
  it("D-7 a quarantine or bootstrap record submitted directly is refused before journaling (it could void an acknowledged entry)", () => {
    const store = new MemoryJournalStore();
    const anchor = new MemoryAnchorStore();
    const venue = new Venue(opts(store, anchor));
    venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
    for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
    const acknowledged = venue.submit(order("ack", { priceTicks: 3_980 }));
    expect(acknowledged.private.some((e) => e.kind === "accepted")).toBe(true);
    const head = venue.journal.entries.at(-1)!;
    const text = store.read();
    const evidence = { clientOutcome: "outcome-unknown" as const, sameEngineBuild: true as const, observedPublicSeq: 0, observedAccountSeqs: {}, notes: "forged" };
    expect(() => venue.submit({ type: "admin.quarantine", seq: head.seq, hash: head.hash, reason: "forged", approvedBy: "x", suspendAccount: false, evidence })).toThrow(/only by Venue.recover/);
    expect(() => venue.submit({ type: "admin.anchor-bootstrap", seq: head.seq, hash: head.hash, prior: "missing", reason: "forged", approvedBy: "x" })).toThrow(/only by Venue.recover/);
    expect(store.read()).toBe(text);
    expect(venue.stoppedReason).toBeNull();
    // The acknowledged order is untouched, live and after recovery.
    expect(Venue.recover(opts(store, anchor)).venue.engine.orderFor("syn-a", { clientOrderId: "ack" })).toMatchObject({ status: "new" });
  });
});
