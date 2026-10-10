import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandleListSchema,
  MarketSummarySchema,
  OrderBookSnapshotSchema,
  TradeSchema,
  type Candle,
  type OrderBookSnapshot,
  type Trade,
} from "@/core/domain";
import { SimulatedCatalogGateway } from "./simulated-catalog-gateway";
import { SimulatedMarketDataSource } from "./simulated-market-data-source";
import { SimulationEngine } from "./simulation-engine";

const NOW = 1_700_000_000_000;

describe("SimulationEngine", () => {
  it("is deterministic for a given seed", () => {
    const a = new SimulationEngine(7).get("ALPHA-PERP")!;
    const b = new SimulationEngine(7).get("ALPHA-PERP")!;
    for (let i = 0; i < 50; i += 1) expect(a.step()).toBe(b.step());
  });

  it("uses clearly synthetic market names and quote asset", () => {
    const summaries = new SimulationEngine().summaries(NOW);
    expect(summaries.map((s) => s.market.base)).toEqual(["ALPHA", "BETA", "GAMMA"]);
    for (const summary of summaries) {
      expect(MarketSummarySchema.parse(summary)).toBeTruthy();
      expect(summary.market.quote).toBe("SIMUSD");
    }
  });

  it("produces valid, uncrossed books and valid history", () => {
    const market = new SimulationEngine().get("GAMMA-PERP")!;
    for (let i = 0; i < 200; i += 1) {
      market.step();
      const book = OrderBookSnapshotSchema.parse(market.book(NOW + i));
      expect(book.bids[0]!.price).toBeLessThan(book.asks[0]!.price);
    }
    const history = CandleListSchema.parse(market.history("1m", NOW, 100));
    expect(history).toHaveLength(100);
    for (const c of history) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
    }
    expect(history.at(-1)!.openTime).toBe(Math.floor(NOW / 60_000) * 60_000);
  });
});

describe("SimulatedMarketDataSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is labelled as simulation", () => {
    expect(new SimulatedMarketDataSource().descriptor.kind).toBe("simulation");
  });

  it("streams valid domain data on each tick with unique trade ids", () => {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const books: OrderBookSnapshot[] = [];
    const trades: Trade[] = [];
    source.subscribeOrderBook("ALPHA-PERP", { onData: (b) => books.push(b) });
    source.subscribeTrades("ALPHA-PERP", { onData: (t) => trades.push(...t) });
    vi.advanceTimersByTime(2_000);
    expect(books.length).toBe(20);
    books.forEach((b) => OrderBookSnapshotSchema.parse(b));
    trades.forEach((t) => TradeSchema.parse(t));
    expect(new Set(trades.map((t) => t.id)).size).toBe(trades.length);
    // Book timestamps strictly increase even when the clock does not move.
    expect(books.every((b, i) => i === 0 || b.venueTime > books[i - 1]!.venueTime)).toBe(true);
    source.dispose();
  });

  it("continues live candles from loaded history without replacing it with a blank candle", async () => {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const history = await source.getCandles("BETA-PERP", "1m");
    const updates: Candle[] = [];
    source.subscribeCandles("BETA-PERP", "1m", { onData: (c) => updates.push(c) });
    vi.advanceTimersByTime(100);
    const last = history.at(-1)!;
    expect(updates[0]!.openTime).toBe(last.openTime);
    expect(updates[0]!.open).toBe(last.open);
    expect(updates[0]!.high).toBeGreaterThanOrEqual(last.high);
    source.dispose();
  });

  it("stops ticking after dispose and restarts on new subscriptions", () => {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const onData = vi.fn();
    source.subscribeOrderBook("ALPHA-PERP", { onData });
    source.dispose();
    vi.advanceTimersByTime(1_000);
    expect(onData).not.toHaveBeenCalled();
    source.subscribeOrderBook("ALPHA-PERP", { onData });
    vi.advanceTimersByTime(100);
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown markets", () => {
    expect(() => new SimulatedMarketDataSource().subscribeOrderBook("BTC-PERP", { onData: () => {} })).toThrow();
  });
});

describe("SimulatedCatalogGateway", () => {
  it("serves synthetic markets and candles", async () => {
    const gateway = new SimulatedCatalogGateway(42, () => NOW);
    expect(gateway.descriptor.kind).toBe("simulation");
    expect((await gateway.listMarkets()).length).toBe(3);
    expect((await gateway.getCandles("ALPHA-PERP", "1h", { endTime: NOW })).length).toBeGreaterThan(0);
    expect(await gateway.getCandles("BTC-PERP", "1h", { endTime: NOW })).toEqual([]);
  });
});
