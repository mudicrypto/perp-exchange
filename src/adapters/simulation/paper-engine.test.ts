import { describe, expect, it } from "vitest";
import {
  AccountSnapshotSchema,
  FillSchema,
  OrderSchema,
  type Market,
  type MarketId,
  type OrderIntent,
} from "@/core/domain";
import { DEMO_ACCOUNT_FIXTURE, DEMO_STARTING_BALANCE, createDemoPaperEngine } from "./demo-account-fixture";
import { PAPER_FEES, PaperEngine } from "./paper-engine";
import { SimulationEngine } from "./simulation-engine";

const NOW = 1_700_000_000_000;
const markets: ReadonlyMap<MarketId, Market> = new Map(
  [...new SimulationEngine().markets.values()].map((m) => [m.id, m.market]),
);
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

const intent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  marketId: "ALPHA-PERP",
  side: "buy",
  type: "market",
  size: 1,
  limitPrice: null,
  timeInForce: "ioc",
  reduceOnly: false,
  leverage: 10,
  marginMode: "isolated",
  ...overrides,
});

function engineWithBook(balance = 10_000) {
  const engine = new PaperEngine(markets, balance);
  engine.setBook("ALPHA-PERP", book, NOW);
  engine.setMark("ALPHA-PERP", 1000, NOW);
  return engine;
}

describe("PaperEngine — market orders", () => {
  it("walks the book, charges taker fees and opens a position", () => {
    const engine = engineWithBook();
    const result = engine.submit(intent({ size: 2 }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.status).toBe("filled");
    expect(result.order.averageFillPrice).toBeCloseTo((1000.1 + 1000.5) / 2);

    const state = engine.state(NOW);
    expect(state.fills).toHaveLength(2);
    expect(state.fills.every((f) => f.liquidity === "taker")).toBe(true);
    const fees = state.fills.reduce((sum, f) => sum + f.fee, 0);
    expect(fees).toBeCloseTo((1000.1 + 1000.5) * PAPER_FEES.taker);

    const [position] = state.snapshot.positions;
    expect(position).toMatchObject({ marketId: "ALPHA-PERP", size: 2, leverage: 10 });
    expect(position!.marginUsed).toBeCloseTo(200.06);
    expect(state.snapshot.balance).toBeCloseTo(10_000 - fees);
    expect(state.orderHistory[0]!.id).toBe(result.order.id);
  });

  it("cancels the unfilled remainder when visible depth runs out", () => {
    const engine = engineWithBook();
    const result = engine.submit(intent({ size: 5 }), NOW);
    expect(result.ok && result.order).toMatchObject({ status: "cancelled", filledSize: 3 });
    expect(result.ok && result.order.statusReason).toMatch(/remainder cancelled/);
  });

  it("rejects without a book or without liquidity", () => {
    const noBook = new PaperEngine(markets, 10_000);
    expect(noBook.submit(intent(), NOW)).toMatchObject({ ok: false, code: "feed-unavailable" });
    const empty = new PaperEngine(markets, 10_000);
    empty.setBook("ALPHA-PERP", { bids: [], asks: [] }, NOW);
    expect(empty.submit(intent(), NOW)).toMatchObject({ ok: false, code: "no-liquidity" });
  });

  it("rejects orders that exceed available margin and records them", () => {
    const engine = engineWithBook(100);
    const result = engine.submit(intent({ size: 2 }), NOW);
    expect(result).toMatchObject({ ok: false, code: "insufficient-margin" });
    const state = engine.state(NOW);
    expect(state.snapshot.positions).toHaveLength(0);
    expect(state.orderHistory[0]).toMatchObject({ status: "rejected" });
    expect(state.orderHistory[0]!.statusReason).toMatch(/Insufficient margin/);
  });

  it("rejects invalid intents using market precision rules", () => {
    const engine = engineWithBook();
    expect(engine.submit(intent({ size: 0.0001 }), NOW)).toMatchObject({ ok: false, code: "validation-failed" });
  });
});

describe("PaperEngine — limit orders", () => {
  it("rests a non-crossing limit order and reserves margin", () => {
    const engine = engineWithBook();
    const result = engine.submit(intent({ type: "limit", limitPrice: 990, timeInForce: "gtc", size: 1 }), NOW);
    expect(result.ok && result.order.status).toBe("open");
    const state = engine.state(NOW);
    expect(state.openOrders).toHaveLength(1);
    expect(state.snapshot.orderMargin).toBeCloseTo(99);
    expect(state.snapshot.available).toBeCloseTo(10_000 - 99);
  });

  it("fills a resting order as maker when the book crosses its price", () => {
    const engine = engineWithBook();
    engine.submit(intent({ type: "limit", limitPrice: 990, timeInForce: "gtc" }), NOW);
    engine.setBook("ALPHA-PERP", { bids: [{ price: 989, size: 1, orders: 1 }], asks: [{ price: 989.5, size: 1, orders: 1 }] }, NOW + 1);
    const state = engine.state(NOW + 1);
    expect(state.openOrders).toHaveLength(0);
    expect(state.fills[0]).toMatchObject({ price: 990, liquidity: "maker" });
    expect(state.fills[0]!.fee).toBeCloseTo(990 * PAPER_FEES.maker);
    expect(state.orderHistory[0]).toMatchObject({ status: "filled", filledSize: 1 });
  });

  it("takes crossing liquidity immediately up to the limit price, rests the rest", () => {
    const engine = engineWithBook();
    const result = engine.submit(intent({ type: "limit", limitPrice: 1000.2, timeInForce: "gtc", size: 2 }), NOW);
    expect(result.ok && result.order).toMatchObject({ status: "partially-filled", filledSize: 1 });
    expect(engine.state(NOW).openOrders).toHaveLength(1);
  });

  it("rejects post-only orders that would cross", () => {
    const engine = engineWithBook();
    expect(
      engine.submit(intent({ type: "limit", limitPrice: 1001, timeInForce: "post-only" }), NOW),
    ).toMatchObject({ ok: false, code: "would-take-liquidity" });
  });

  it("cancels one or all open orders", () => {
    const engine = engineWithBook();
    const a = engine.submit(intent({ type: "limit", limitPrice: 990, timeInForce: "gtc" }), NOW);
    engine.submit(intent({ type: "limit", limitPrice: 980, timeInForce: "gtc" }), NOW);
    expect(engine.cancel(a.ok ? a.order.id : "", NOW)).toMatchObject({ ok: true });
    expect(engine.cancel("missing", NOW)).toMatchObject({ ok: false, code: "not-found" });
    expect(engine.cancelAll(NOW)).toBe(1);
    expect(engine.state(NOW).openOrders).toHaveLength(0);
  });
});

describe("PaperEngine — positions", () => {
  it("realises PnL when reducing and flips with the remainder", () => {
    const engine = engineWithBook();
    engine.submit(intent({ size: 1 }), NOW); // long 1 @ 1000.1
    engine.setBook("ALPHA-PERP", { bids: [{ price: 1010, size: 5, orders: 1 }], asks: [{ price: 1010.5, size: 5, orders: 1 }] }, NOW + 1);
    const result = engine.submit(intent({ side: "sell", size: 3 }), NOW + 1);
    expect(result.ok).toBe(true);
    const state = engine.state(NOW + 1);
    expect(state.fills[0]!.realizedPnl).toBeCloseTo(1010 - 1000.1);
    expect(state.snapshot.positions[0]).toMatchObject({ size: -2, entryPrice: 1010 });
    expect(state.snapshot.realizedPnl).toBeCloseTo(9.9);
  });

  it("caps reduce-only orders to the position and rejects them without one", () => {
    const engine = engineWithBook();
    expect(engine.submit(intent({ side: "sell", reduceOnly: true }), NOW)).toMatchObject({ ok: false, code: "reduce-only-invalid" });
    engine.submit(intent({ size: 1 }), NOW);
    const result = engine.submit(intent({ side: "sell", reduceOnly: true, size: 3 }), NOW);
    expect(result.ok && result.order).toMatchObject({ size: 1, status: "filled" });
    expect(engine.state(NOW).snapshot.positions).toHaveLength(0);
  });

  it("requires leverage to match an open position", () => {
    const engine = engineWithBook();
    engine.submit(intent({ size: 1, leverage: 10 }), NOW);
    expect(engine.submit(intent({ size: 1, leverage: 5 }), NOW)).toMatchObject({ ok: false, code: "validation-failed" });
  });

  it("computes unrealised PnL from the mark and liquidates at the liquidation price", () => {
    const engine = engineWithBook();
    engine.submit(intent({ size: 1, leverage: 20 }), NOW); // long 1 @ 1000.1, margin 50.005
    engine.setMark("ALPHA-PERP", 990, NOW + 1);
    const before = engine.state(NOW + 1).snapshot;
    expect(before.unrealizedPnl).toBeCloseTo(990 - 1000.1);
    const liq = before.positions[0]!.liquidationPrice!;
    // (1000.1 - 50.005) / (1 - 0.02)
    expect(liq).toBeCloseTo((1000.1 - 50.005) / 0.98, 6);

    engine.setMark("ALPHA-PERP", liq - 0.1, NOW + 2);
    const after = engine.state(NOW + 2);
    expect(after.snapshot.positions).toHaveLength(0);
    expect(after.fills[0]).toMatchObject({ liquidity: "liquidation", side: "sell", orderId: null });
    expect(after.orderHistory[0]!.statusReason).toMatch(/Liquidated/);
  });
});

describe("demo account fixture", () => {
  const engine = createDemoPaperEngine(markets, NOW);
  const state = engine.state(NOW);

  it("conforms to the domain schemas", () => {
    AccountSnapshotSchema.parse(state.snapshot);
    [...state.openOrders, ...state.orderHistory].forEach((o) => OrderSchema.parse(o));
    state.fills.forEach((f) => FillSchema.parse(f));
  });

  it("has positions consistent with the fill history", () => {
    const net = new Map<string, number>();
    for (const fill of state.fills) {
      net.set(fill.marketId, (net.get(fill.marketId) ?? 0) + (fill.side === "buy" ? fill.size : -fill.size));
    }
    for (const position of state.snapshot.positions) {
      expect(net.get(position.marketId)).toBeCloseTo(position.size, 9);
    }
    const flat = [...net.entries()].filter(([, size]) => Math.abs(size) < 1e-9).map(([m]) => m);
    expect(flat).toEqual(["GAMMA-PERP"]);
  });

  it("has a balance equal to starting balance + realised PnL − fees", () => {
    const realized = state.fills.reduce((sum, f) => sum + f.realizedPnl, 0);
    const fees = state.fills.reduce((sum, f) => sum + f.fee, 0);
    expect(state.snapshot.balance).toBeCloseTo(DEMO_STARTING_BALANCE + realized - fees, 6);
    expect(state.snapshot.realizedPnl).toBeCloseTo(realized, 6);
  });

  it("contains every order state with past, ordered timestamps", () => {
    expect(state.snapshot.positions.map((p) => p.marketId)).toEqual(["ALPHA-PERP", "BETA-PERP"]);
    expect(state.openOrders).toHaveLength(2);
    expect(new Set(state.orderHistory.map((o) => o.status))).toEqual(new Set(["filled", "cancelled", "rejected"]));
    const times = state.fills.map((f) => f.time);
    expect(times.every((t) => t < NOW)).toBe(true);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(state.orderHistory.length + state.openOrders.length).toBe(DEMO_ACCOUNT_FIXTURE.length);
  });
});
