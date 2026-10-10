import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, type Fill, type Order, type OrderStatus } from "../domain";
import { canApply, transitionOrder, type OrderEvent, type OrderEventBody } from "./order-lifecycle";
import { OrderStore } from "./order-store";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "O1",
  clientOrderId: "c1",
  venueOrderId: null,
  marketId: "BTC-PERP",
  side: "buy",
  type: "limit",
  price: 100,
  triggerPrice: null,
  triggeredAt: null,
  size: 2,
  filledSize: 0,
  averageFillPrice: null,
  status: "pending-new",
  timeInForce: "gtc",
  reduceOnly: false,
  leverage: 5,
  marginMode: "isolated",
  createdAt: 0,
  updatedAt: 0,
  statusReason: null,
  lastSequence: null,
  origin: "simulated",
  ...overrides,
});

const fill = (id: string, size: number, price = 100): Fill => ({
  id,
  orderId: "O1",
  marketId: "BTC-PERP",
  side: "buy",
  price,
  size,
  fee: 0,
  liquidity: "maker",
  realizedPnl: 0,
  time: 1,
  origin: "simulated",
});

let n = 0;
const ev = (body: OrderEventBody, extra: Partial<OrderEvent> = {}): OrderEvent =>
  ({ ...body, eventId: `e${++n}`, orderId: "O1", time: 10, ...extra }) as OrderEvent;

function apply(o: Order, ...bodies: OrderEventBody[]): Order {
  return bodies.reduce((current, body) => {
    const r = transitionOrder(current, ev(body));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.order;
  }, o);
}

describe("order state transitions", () => {
  it("pending-new → open → partially-filled → filled with VWAP", () => {
    const filled = apply(order(), { type: "accepted" }, { type: "fill", fill: fill("f1", 0.5, 100) }, { type: "fill", fill: fill("f2", 1.5, 104) });
    expect(filled.status).toBe("filled");
    expect(filled.filledSize).toBe(2);
    expect(filled.averageFillPrice).toBeCloseTo((0.5 * 100 + 1.5 * 104) / 2);
  });

  it("trigger orders wait for their trigger after acceptance", () => {
    const o = apply(order({ type: "stop-market", price: null, triggerPrice: 90 }), { type: "accepted" });
    expect(o.status).toBe("waiting-trigger");
    const triggered = apply(o, { type: "triggered" });
    expect(triggered.status).toBe("open");
    expect(triggered.triggeredAt).toBe(10);
  });

  it("rejection is terminal and keeps the reason", () => {
    const o = apply(order(), { type: "rejected", reason: "insufficient margin" });
    expect(o).toMatchObject({ status: "rejected", statusReason: "insufficient margin" });
    expect(transitionOrder(o, ev({ type: "accepted" }))).toMatchObject({ ok: false, error: { code: "invalid-transition", from: "rejected" } });
  });

  it("cancel flow: cancel-requested → cancelled, or cancel-rejected back to working state", () => {
    const open = apply(order(), { type: "accepted" });
    expect(apply(open, { type: "cancel-requested" }, { type: "cancelled", reason: "user" }).status).toBe("cancelled");
    const partial = apply(open, { type: "fill", fill: fill("f1", 1) });
    expect(apply(partial, { type: "cancel-requested" }, { type: "cancel-rejected", reason: "too late" }).status).toBe("partially-filled");
    const waiting = apply(order({ type: "take-profit-market", price: null, triggerPrice: 120 }), { type: "accepted" });
    expect(apply(waiting, { type: "cancel-requested" }, { type: "cancel-rejected", reason: "x" }).status).toBe("waiting-trigger");
  });

  it("a fill racing a cancel can still complete the order", () => {
    const pending = apply(order(), { type: "accepted" }, { type: "cancel-requested" });
    expect(apply(pending, { type: "fill", fill: fill("f1", 1) }).status).toBe("cancel-pending");
    expect(apply(pending, { type: "fill", fill: fill("f1", 2) }).status).toBe("filled");
  });

  it("refuses overfills and mismatched fills", () => {
    const open = apply(order(), { type: "accepted" });
    expect(transitionOrder(open, ev({ type: "fill", fill: fill("f1", 3) }))).toMatchObject({ ok: false, error: { code: "overfill" } });
    expect(transitionOrder(open, ev({ type: "fill", fill: { ...fill("f1", 1), side: "sell" } }))).toMatchObject({ ok: false, error: { code: "order-mismatch" } });
    expect(transitionOrder(open, ev({ type: "accepted" }, { orderId: "OTHER" }))).toMatchObject({ ok: false, error: { code: "order-mismatch" } });
  });

  it("no event changes a terminal order", () => {
    const terminal: OrderStatus[] = ["filled", "cancelled", "rejected", "expired"];
    const events: OrderEventBody["type"][] = ["accepted", "rejected", "triggered", "fill", "cancel-requested", "cancelled", "cancel-rejected", "expired"];
    for (const status of terminal) for (const event of events) expect(canApply(status, event)).toBe(false);
  });

  it("every non-terminal status has at least one exit", () => {
    const events: OrderEventBody["type"][] = ["accepted", "rejected", "triggered", "fill", "cancel-requested", "cancelled", "cancel-rejected", "expired"];
    for (const status of ORDER_STATUSES.filter((s) => !["filled", "cancelled", "rejected", "expired"].includes(s))) {
      expect(events.some((e) => canApply(status, e)), status).toBe(true);
    }
  });

  it("does not mutate its input", () => {
    const original = order();
    const copy = structuredClone(original);
    transitionOrder(original, ev({ type: "accepted" }));
    expect(original).toEqual(copy);
  });
});

describe("OrderStore reconciliation", () => {
  const event = (body: OrderEventBody, eventId: string, sequence?: number): OrderEvent =>
    ({ ...body, eventId, orderId: "O1", time: 10, ...(sequence !== undefined ? { sequence } : {}) }) as OrderEvent;

  it("ignores duplicate events by event id", () => {
    const store = new OrderStore();
    store.add(order());
    expect(store.apply(event({ type: "accepted" }, "a"))).toMatchObject({ kind: "applied" });
    expect(store.apply(event({ type: "accepted" }, "a"))).toEqual({ kind: "duplicate" });
    expect(store.get("O1")!.status).toBe("open");
  });

  it("ignores the same fill delivered twice under different event ids", () => {
    const store = new OrderStore();
    store.add(order());
    store.apply(event({ type: "accepted" }, "a"));
    expect(store.apply(event({ type: "fill", fill: fill("F1", 1) }, "b"))).toMatchObject({ kind: "applied" });
    expect(store.apply(event({ type: "fill", fill: fill("F1", 1) }, "c"))).toEqual({ kind: "duplicate" });
    expect(store.get("O1")!.filledSize).toBe(1);
    expect(store.allFills()).toHaveLength(1);
  });

  it("drops events older than the last applied sequence", () => {
    const store = new OrderStore();
    store.add(order());
    store.apply(event({ type: "accepted" }, "a", 5));
    store.apply(event({ type: "fill", fill: fill("F2", 2) }, "b", 7));
    expect(store.apply(event({ type: "fill", fill: fill("F1", 1) }, "c", 6))).toEqual({ kind: "stale" });
    expect(store.get("O1")).toMatchObject({ status: "filled", lastSequence: 7, filledSize: 2 });
  });

  it("reports invalid transitions without changing state", () => {
    const store = new OrderStore();
    store.add(order());
    const outcome = store.apply(event({ type: "triggered" }, "a"));
    expect(outcome).toMatchObject({ kind: "rejected", error: { code: "invalid-transition" } });
    expect(store.get("O1")!.status).toBe("pending-new");
  });

  it("rejects duplicate order ids and client order ids, and unknown orders", () => {
    const store = new OrderStore();
    expect(store.add(order())).toBe(true);
    expect(store.add(order())).toBe(false);
    expect(store.add(order({ id: "O2" }))).toBe(false);
    expect(store.apply({ type: "accepted", eventId: "z", orderId: "missing", time: 0 })).toEqual({ kind: "unknown-order" });
  });

  it("separates working orders from history and notifies listeners", () => {
    const store = new OrderStore();
    const changes: string[] = [];
    store.subscribe(({ order: o, fill: f }) => changes.push(`${o.status}${f ? `+${f.id}` : ""}`));
    store.add(order());
    store.apply(event({ type: "accepted" }, "a"));
    expect(store.openOrders().map((o) => o.id)).toEqual(["O1"]);
    store.apply(event({ type: "fill", fill: fill("F1", 2) }, "b"));
    expect(store.openOrders()).toEqual([]);
    expect(store.history().map((o) => o.id)).toEqual(["O1"]);
    expect(changes).toEqual(["pending-new", "open", "filled+F1"]);
  });
});
