import { describe, expect, it } from "vitest";
import { DURABILITY_ALPHA, DURABILITY_CLOCK, durableOptions, setupCommands } from "./durability-fixtures";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayResponse } from "./gateway";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage";
import { Venue } from "./venue";

/**
 * Milestone 11 (Venue): retries after an unknown outcome (DURABILITY-PROTOCOL §5, MATCHING-RULES A-4).
 * Request idempotency (same response, no further effect) exists only for accepted new orders.
 * Cancel, replace and mass cancel are at most effect-idempotent, and only when nothing else touched the
 * affected state. These tests demonstrate where a blind retry is unsafe; they do not hide it.
 */

const order = (o: Record<string, unknown> = {}): ClientMessage => ({ op: "new", clientOrderId: "r1", instrumentId: DURABILITY_ALPHA, side: "buy", type: "limit", price: "1990.00", quantity: "0.010", ...o }) as ClientMessage;

function world() {
  const store = new MemoryJournalStore();
  const records = new MemoryCommitRecordStore();
  const venue = new Venue(durableOptions({ store, records }));
  for (const c of setupCommands()) venue.submit(c);
  return { store, records, ...sessions(venue) };
}
function sessions(venue: Venue) {
  const gateway = new VenueGateway(venue, { clock: DURABILITY_CLOCK, ...DEFAULT_GATEWAY_LIMITS });
  const a = gateway.openSession("syn-a");
  const a2 = gateway.openSession("syn-a"); // a second session of the same account
  const b = gateway.openSession("syn-b");
  return { venue, gateway, a: (m: ClientMessage) => gateway.handle(a, m), a2: (m: ClientMessage) => gateway.handle(a2, m), b: (m: ClientMessage) => gateway.handle(b, m), lookup: (clientOrderId: string) => gateway.order(a, { clientOrderId }) };
}
/** Sends `message` with a fault armed so that the outcome is unknown, then recovers and returns fresh sessions. */
function unknownOutcome(w: ReturnType<typeof world>, send: (s: ReturnType<typeof world>) => GatewayResponse, committed: boolean) {
  if (committed) w.records.failNextWrite = "before-write";
  else w.store.failNextAppend = "before-write";
  expect(send(w)).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
  return { ...w, ...sessions(Venue.recover(durableOptions({ store: w.store, records: w.records })).venue) };
}
const events = (r: GatewayResponse) => (r.ok ? r.events : []) as unknown as Record<string, unknown>[];
const acceptances = (venue: Venue, clientOrderId: string) => venue.privateEvents("syn-a").filter((e) => e.kind === "accepted" && e.order.clientOrderId === clientOrderId).length;

describe("A-4 retries after outcome-unknown: request idempotency vs effect idempotency", () => {
  it.each([true, false])("A-4 new order (committed: %s): an identical retry returns the original or executes once; never twice", (committed) => {
    const w = unknownOutcome(world(), (s) => s.a(order()), committed);
    const retry = w.a(order());
    expect(retry).toMatchObject({ ok: true, replayed: committed });
    expect(events(retry).map((e) => e.kind)).toEqual(["accepted"]);
    expect(w.a(order())).toMatchObject({ ok: true, replayed: true });
    expect(acceptances(w.venue, "r1")).toBe(1);
  });

  it("A-4 a rejected original does not consume the client order id: the retry is evaluated again and may now be accepted", () => {
    const w = world();
    w.b(order({ clientOrderId: "ask", side: "sell", price: "1990.00" }));
    const r = unknownOutcome(w, (s) => s.a(order({ postOnly: true })), true);
    expect(r.venue.privateEvents("syn-a").map((e) => e.kind)).toEqual(["rejected"]); // post-only would take
    r.b({ op: "cancel", ref: { clientOrderId: "ask" } });
    const retry = r.a(order({ postOnly: true }));
    expect(retry).toMatchObject({ ok: true, replayed: false });
    expect(events(retry).map((e) => e.kind)).toEqual(["accepted"]);
    expect(acceptances(r.venue, "r1")).toBe(1);
  });

  it("A-4 cancel is not request-idempotent: the same retry answer covers different outcomes; only a lookup tells them apart", () => {
    // (a) The cancel was committed: the order is cancelled.
    const a = world();
    a.a(order());
    const ra = unknownOutcome(a, (s) => s.a({ op: "cancel", ref: { clientOrderId: "r1" } }), true);
    const retryA = ra.a({ op: "cancel", ref: { clientOrderId: "r1" } });
    // (b) The cancel was never committed, and the order filled meanwhile.
    const b = world();
    b.a(order());
    const rb = unknownOutcome(b, (s) => s.a({ op: "cancel", ref: { clientOrderId: "r1" } }), false);
    rb.b(order({ clientOrderId: "taker", side: "sell" }));
    const retryB = rb.a({ op: "cancel", ref: { clientOrderId: "r1" } });

    expect(events(retryA)).toEqual([expect.objectContaining({ kind: "request-rejected", reason: "order-not-modifiable" })]);
    expect(events(retryB)).toEqual([expect.objectContaining({ kind: "request-rejected", reason: "order-not-modifiable" })]);
    expect(ra.lookup("r1")).toMatchObject({ status: "cancelled" });
    expect(rb.lookup("r1")).toMatchObject({ status: "filled" });
  });

  it("A-4 replace is not safe to retry blindly: a retry can revert an interleaved replace", () => {
    const w = world();
    w.a(order());
    const r = unknownOutcome(w, (s) => s.a({ op: "replace", ref: { clientOrderId: "r1" }, price: "1990.00", quantity: "0.005" }), true);
    expect(r.lookup("r1")).toMatchObject({ qtyLots: 5 });
    r.a2({ op: "replace", ref: { clientOrderId: "r1" }, price: "1990.00", quantity: "0.008" });
    expect(r.lookup("r1")).toMatchObject({ qtyLots: 8 });
    const retry = r.a({ op: "replace", ref: { clientOrderId: "r1" }, price: "1990.00", quantity: "0.005" });
    expect(events(retry).map((e) => e.kind)).toEqual(["replaced"]);
    expect(r.lookup("r1")).toMatchObject({ qtyLots: 5 }); // the second session's replace is undone
  });

  it("A-4 mass cancel is neither request- nor effect-idempotent: a retry cancels orders placed after the original", () => {
    const w = world();
    w.a(order());
    const r = unknownOutcome(w, (s) => s.a({ op: "mass-cancel" }), true);
    expect(r.lookup("r1")).toMatchObject({ status: "cancelled" });
    r.a2(order({ clientOrderId: "r2" }));
    r.a({ op: "mass-cancel" });
    expect(r.lookup("r2")).toMatchObject({ status: "cancelled" });
  });

  it("A-6 reconciliation: after recovery the private feed resolves the unknown outcome without a gap", () => {
    const w = world();
    w.a(order({ clientOrderId: "r0" }));
    const lastSeen = w.gateway.events(w.gateway.openSession("syn-a"))!.at(-1)!.accountSeq;
    const r = unknownOutcome(w, (s) => s.a({ op: "cancel", ref: { clientOrderId: "r0" } }), true);
    const page = r.gateway.eventsPage(r.gateway.openSession("syn-a"), lastSeen)!;
    expect(page.gap).toBeNull();
    expect(page.events.map((e) => e.kind)).toEqual(["cancelled"]);
    expect(page.highWaterAccountSeq).toBe(lastSeen + 1);
  });
});
