import { describe, expect, it } from "vitest";
import {
  AccountSnapshotSchema,
  FillSchema,
  OrderSchema,
  type Market,
  type MarketId,
  type OrderRequest,
} from "@/core/domain";
import { DEMO_ACCOUNT_FIXTURE, DEMO_STARTING_BALANCE, createDemoPaperEngine } from "./demo-account-fixture";
import { PAPER_FEES, PaperEngine, type SimulationConfig } from "./paper-engine";
import { SimulationEngine } from "./simulation-engine";

const NOW = 1_700_000_000_000;
const markets: ReadonlyMap<MarketId, Market> = new Map([...new SimulationEngine().markets.values()].map((m) => [m.id, m.market]));
// ALPHA: sizeDecimals 3, priceDecimals 1, maxLeverage 25 (MMR 2%).

const book = {
  bids: [
    { price: 999.9, size: 1, orders: 1 },
    { price: 999.5, size: 2, orders: 1 },
  ],
  asks: [
    { price: 1000.1, size: 1, orders: 1 },
    { price: 1000.5, size: 2, orders: 1 },
  ],
};

let cid = 0;
const base = (o: Partial<{ side: "buy" | "sell"; size: number; reduceOnly: boolean; leverage: number }> = {}) => ({
  clientOrderId: `c${++cid}`,
  marketId: "ALPHA-PERP",
  side: o.side ?? "buy",
  size: o.size ?? 1,
  reduceOnly: o.reduceOnly ?? false,
  leverage: o.leverage ?? 10,
  marginMode: "isolated" as const,
});
const marketReq = (o: Parameters<typeof base>[0] = {}): OrderRequest => ({ ...base(o), type: "market", maxSlippage: 0.05 });
const limitReq = (price: number, o: Parameters<typeof base>[0] & { tif?: "gtc" | "ioc" | "post-only" } = {}): OrderRequest => ({
  ...base(o),
  type: "limit",
  price,
  timeInForce: o.tif ?? "gtc",
});
const triggerReq = (type: "stop-market" | "take-profit-market", triggerPrice: number, o: Parameters<typeof base>[0] = {}): OrderRequest => ({
  ...base(o),
  type,
  triggerPrice,
  maxSlippage: 0.05,
});

function engineWithBook(config: Partial<SimulationConfig> = {}) {
  const engine = new PaperEngine(markets, { startingBalance: 10_000, ...config });
  engine.setBook("ALPHA-PERP", book, NOW);
  engine.setMark("ALPHA-PERP", 1000, NOW);
  return engine;
}

describe("PaperEngine — market orders", () => {
  it("walks the book, charges taker fees, opens a position and labels everything simulated", () => {
    const engine = engineWithBook();
    const result = engine.submit(marketReq({ size: 2 }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ status: "filled", origin: "simulated" });
    expect(result.value.averageFillPrice).toBeCloseTo((1000.1 + 1000.5) / 2);
    const state = engine.state(NOW);
    expect(state.fills).toHaveLength(2);
    expect(state.fills!.every((f) => f.liquidity === "taker" && f.origin === "simulated")).toBe(true);
    const fees = state.fills!.reduce((sum, f) => sum + f.fee, 0);
    expect(fees).toBeCloseTo((1000.1 + 1000.5) * PAPER_FEES.taker);
    expect(state.snapshot).toMatchObject({ origin: "simulated", currency: "SIMUSD" });
    expect(state.snapshot.positions[0]).toMatchObject({ marketId: "ALPHA-PERP", size: 2, leverage: 10 });
    expect(state.snapshot.balance).toBeCloseTo(10_000 - fees);
  });

  it("cancels the unfilled remainder when visible depth runs out", () => {
    const result = engineWithBook().submit(marketReq({ size: 5 }), NOW);
    expect(result.ok && result.value).toMatchObject({ status: "cancelled", filledSize: 3 });
    expect(result.ok && result.value.statusReason).toMatch(/remainder cancelled/);
  });

  it("rejects without a book or without liquidity", () => {
    const noBook = new PaperEngine(markets);
    expect(noBook.submit(marketReq(), NOW)).toMatchObject({ ok: false, error: { code: "feed-unavailable" } });
    const empty = new PaperEngine(markets);
    empty.setBook("ALPHA-PERP", { bids: [], asks: [] }, NOW);
    expect(empty.submit(marketReq(), NOW)).toMatchObject({ ok: false, error: { code: "no-liquidity" } });
    expect(empty.state(NOW).orderHistory![0]).toMatchObject({ status: "rejected" });
  });

  it("rejects orders exceeding available margin and records them", () => {
    const engine = engineWithBook({ startingBalance: 100 });
    expect(engine.submit(marketReq({ size: 2 }), NOW)).toMatchObject({ ok: false, error: { code: "insufficient-margin" } });
    const state = engine.state(NOW);
    expect(state.snapshot.positions).toHaveLength(0);
    expect(state.orderHistory![0]!.statusReason).toMatch(/Insufficient margin/);
  });

  it("refuses a duplicate client order id without creating an order", () => {
    const engine = engineWithBook();
    const req = marketReq();
    expect(engine.submit(req, NOW).ok).toBe(true);
    expect(engine.submit(req, NOW)).toMatchObject({ ok: false, error: { code: "duplicate-client-order-id" } });
    expect(engine.state(NOW).orderHistory).toHaveLength(1);
  });
});

describe("PaperEngine — limit orders and cancellation", () => {
  it("rests a non-crossing limit order and reserves margin", () => {
    const engine = engineWithBook();
    expect(engine.submit(limitReq(990), NOW)).toMatchObject({ ok: true, value: { status: "open" } });
    const state = engine.state(NOW);
    expect(state.openOrders).toHaveLength(1);
    expect(state.snapshot.orderMargin).toBeCloseTo(99);
  });

  it("fills a resting order as maker when the book crosses its price", () => {
    const engine = engineWithBook();
    engine.submit(limitReq(990), NOW);
    engine.setBook("ALPHA-PERP", { bids: [{ price: 989, size: 1, orders: 1 }], asks: [{ price: 989.5, size: 1, orders: 1 }] }, NOW + 1);
    const state = engine.state(NOW + 1);
    expect(state.openOrders).toHaveLength(0);
    expect(state.fills![0]).toMatchObject({ price: 990, liquidity: "maker" });
    expect(state.orderHistory![0]).toMatchObject({ status: "filled", filledSize: 1 });
  });

  it("takes crossing liquidity up to the limit and rests the remainder", () => {
    const result = engineWithBook().submit(limitReq(1000.2, { size: 2 }), NOW);
    expect(result.ok && result.value).toMatchObject({ status: "partially-filled", filledSize: 1 });
  });

  it("rejects post-only orders that would cross; IOC remainders are cancelled", () => {
    const engine = engineWithBook();
    expect(engine.submit(limitReq(1001, { tif: "post-only" }), NOW)).toMatchObject({ ok: false, error: { code: "would-take-liquidity" } });
    expect(engine.submit(limitReq(1000.2, { size: 2, tif: "ioc" }), NOW)).toMatchObject({ ok: true, value: { status: "cancelled", filledSize: 1 } });
  });

  it("cancels through cancel-pending and refuses to cancel terminal or unknown orders", () => {
    const engine = engineWithBook();
    const statuses: string[] = [];
    engine.subscribe(({ order }) => statuses.push(order.status));
    const placed = engine.submit(limitReq(990), NOW);
    const id = placed.ok ? placed.value.id : "";
    expect(engine.cancel(id, NOW)).toMatchObject({ ok: true, value: { status: "cancelled", statusReason: "Cancelled by user" } });
    expect(statuses).toEqual(["pending-new", "open", "cancel-pending", "cancelled"]);
    expect(engine.cancel(id, NOW)).toMatchObject({ ok: false, error: { code: "order-not-cancellable", status: "cancelled" } });
    expect(engine.cancel("missing", NOW)).toMatchObject({ ok: false, error: { code: "order-not-found" } });
  });

  it("cancel-all cancels only the requested market", () => {
    const engine = engineWithBook();
    engine.setBook("BETA-PERP", { bids: [{ price: 42, size: 10, orders: 1 }], asks: [{ price: 43, size: 10, orders: 1 }] }, NOW);
    engine.submit(limitReq(990), NOW);
    engine.submit({ ...limitReq(41), marketId: "BETA-PERP" }, NOW);
    expect(engine.cancelAll(NOW, "ALPHA-PERP")).toBe(1);
    expect(engine.state(NOW).openOrders.map((o) => o.marketId)).toEqual(["BETA-PERP"]);
  });
});

describe("PaperEngine — trigger orders", () => {
  it("waits, triggers on the mark, then executes against the book", () => {
    const engine = engineWithBook();
    const placed = engine.submit(triggerReq("stop-market", 1005), NOW);
    expect(placed).toMatchObject({ ok: true, value: { status: "waiting-trigger", triggerPrice: 1005 } });
    engine.setMark("ALPHA-PERP", 1004, NOW + 1);
    expect(engine.state(NOW + 1).openOrders[0]!.status).toBe("waiting-trigger");
    engine.setMark("ALPHA-PERP", 1005.5, NOW + 2);
    const history = engine.state(NOW + 2).orderHistory!;
    expect(history[0]).toMatchObject({ type: "stop-market", status: "filled", triggeredAt: NOW + 2 });
  });

  it("take-profit sells trigger when the mark rises to the trigger", () => {
    const engine = engineWithBook();
    engine.submit(marketReq({ size: 1 }), NOW);
    engine.submit(triggerReq("take-profit-market", 1010, { side: "sell", reduceOnly: true }), NOW);
    engine.setMark("ALPHA-PERP", 1011, NOW + 1);
    expect(engine.state(NOW + 1).snapshot.positions).toHaveLength(0);
  });

  it("rejects a trigger that is already reached", () => {
    expect(engineWithBook().submit(triggerReq("stop-market", 995), NOW)).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("PaperEngine — configurable fills and rejections", () => {
  it("fillModel 'none' accepts orders but never fills them", () => {
    const engine = engineWithBook({ fillModel: "none" });
    expect(engine.submit(limitReq(1001), NOW)).toMatchObject({ ok: true, value: { status: "open", filledSize: 0 } });
    expect(engine.submit(marketReq(), NOW)).toMatchObject({ ok: false, error: { code: "no-liquidity" } });
  });

  it("liquidityFraction produces partial fills", () => {
    const result = engineWithBook({ liquidityFraction: 0.5 }).submit(limitReq(1000.1, { size: 1 }), NOW);
    expect(result.ok && result.value).toMatchObject({ status: "partially-filled", filledSize: 0.5 });
    expect(() => new PaperEngine(markets, { liquidityFraction: 0 })).toThrow();
  });

  it("rejects the next N orders with a simulated reason", () => {
    const engine = engineWithBook();
    engine.addRejectionRule({ kind: "next", remaining: 2, reason: "Simulated outage" });
    expect(engine.submit(marketReq(), NOW)).toMatchObject({ ok: false, error: { code: "simulated-rejection", message: "Simulated outage" } });
    expect(engine.submit(marketReq(), NOW).ok).toBe(false);
    expect(engine.submit(marketReq(), NOW).ok).toBe(true);
  });

  it("supports every-nth and per-market rejection rules", () => {
    const engine = engineWithBook();
    engine.addRejectionRule({ kind: "every-nth", n: 2, reason: "every second" });
    const outcomes = [1, 2, 3, 4].map(() => engine.submit(limitReq(900, { size: 0.1 }), NOW).ok);
    expect(outcomes).toEqual([true, false, true, false]);
    engine.clearRejectionRules();
    engine.addRejectionRule({ kind: "market", marketId: "ALPHA-PERP", reason: "halted" });
    expect(engine.submit(limitReq(900, { size: 0.1 }), NOW)).toMatchObject({ ok: false, error: { message: "halted" } });
  });

  it("is deterministic for the same inputs", () => {
    const run = () => {
      const engine = engineWithBook();
      engine.submit(marketReq({ size: 1.5 }), NOW);
      engine.submit(limitReq(990), NOW);
      engine.setBook("ALPHA-PERP", { bids: [{ price: 989, size: 5, orders: 1 }], asks: [{ price: 989.5, size: 5, orders: 1 }] }, NOW + 1);
      return engine.state(NOW + 1);
    };
    cid = 0;
    const a = run();
    cid = 0;
    const b = run();
    expect(a).toEqual(b);
  });
});

describe("PaperEngine — positions", () => {
  it("realises PnL when reducing and flips with the remainder", () => {
    const engine = engineWithBook();
    engine.submit(marketReq({ size: 1 }), NOW);
    engine.setBook("ALPHA-PERP", { bids: [{ price: 1010, size: 5, orders: 1 }], asks: [{ price: 1010.5, size: 5, orders: 1 }] }, NOW + 1);
    expect(engine.submit(marketReq({ side: "sell", size: 3 }), NOW + 1).ok).toBe(true);
    const state = engine.state(NOW + 1);
    expect(state.fills![0]!.realizedPnl).toBeCloseTo(1010 - 1000.1);
    expect(state.snapshot.positions[0]).toMatchObject({ size: -2, entryPrice: 1010 });
  });

  it("reduce-only orders never increase a position", () => {
    const engine = engineWithBook();
    expect(engine.submit(marketReq({ side: "sell", reduceOnly: true }), NOW)).toMatchObject({ ok: false, error: { code: "reduce-only-invalid" } });
    engine.submit(marketReq({ size: 1 }), NOW);
    const result = engine.submit(marketReq({ side: "sell", reduceOnly: true, size: 3 }), NOW);
    expect(result.ok && result.value).toMatchObject({ size: 3, filledSize: 1, status: "cancelled" });
    expect(engine.state(NOW).snapshot.positions).toHaveLength(0);
  });

  it("requires leverage to match an open position", () => {
    const engine = engineWithBook();
    engine.submit(marketReq({ leverage: 10 }), NOW);
    expect(engine.submit(marketReq({ leverage: 5 }), NOW)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("liquidates at the simulator's liquidation price through the normal lifecycle", () => {
    const engine = engineWithBook();
    engine.submit(marketReq({ size: 1, leverage: 20 }), NOW);
    const liq = engine.snapshot(NOW).positions[0]!.liquidationPrice!;
    expect(liq).toBeCloseTo((1000.1 - 50.005) / 0.98, 6);
    engine.setMark("ALPHA-PERP", liq - 0.1, NOW + 2);
    const after = engine.state(NOW + 2);
    expect(after.snapshot.positions).toHaveLength(0);
    expect(after.fills![0]).toMatchObject({ liquidity: "liquidation", side: "sell" });
    expect(after.orderHistory![0]).toMatchObject({ status: "filled", statusReason: "Liquidated by the simulator at mark price" });
  });
});

describe("demo account fixture", () => {
  const engine = createDemoPaperEngine(markets, NOW);
  const state = engine.state(NOW);

  it("conforms to the domain schemas and is labelled simulated", () => {
    AccountSnapshotSchema.parse(state.snapshot);
    [...state.openOrders, ...state.orderHistory!].forEach((o) => expect(OrderSchema.parse(o).origin).toBe("simulated"));
    state.fills!.forEach((f) => expect(FillSchema.parse(f).origin).toBe("simulated"));
  });

  it("has positions consistent with the fill history", () => {
    const net = new Map<string, number>();
    for (const fill of state.fills!) net.set(fill.marketId, (net.get(fill.marketId) ?? 0) + (fill.side === "buy" ? fill.size : -fill.size));
    for (const position of state.snapshot.positions) expect(net.get(position.marketId)).toBeCloseTo(position.size, 9);
  });

  it("has a balance equal to starting balance + realised PnL − fees", () => {
    const realized = state.fills!.reduce((sum, f) => sum + f.realizedPnl, 0);
    const fees = state.fills!.reduce((sum, f) => sum + f.fee, 0);
    expect(state.snapshot.balance).toBeCloseTo(DEMO_STARTING_BALANCE + realized - fees, 6);
  });

  it("contains every order state with past, ordered timestamps", () => {
    expect(state.openOrders).toHaveLength(2);
    expect(new Set(state.orderHistory!.map((o) => o.status))).toEqual(new Set(["filled", "cancelled", "rejected"]));
    const times = state.fills!.map((f) => f.time);
    expect(times.every((t) => t < NOW)).toBe(true);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(state.orderHistory!.length + state.openOrders.length).toBe(DEMO_ACCOUNT_FIXTURE.length);
  });
});
