import { describe, expect, it } from "vitest";
import type { Candle, OrderBookSnapshot, Trade } from "../domain";
import { CandleSeries } from "./candle-series";
import { OrderBookState, withCumulativeDepth } from "./order-book-state";
import { freshness } from "./staleness";
import { TradeBuffer } from "./trade-buffer";

const book = (venueTime: number, bid = 100, ask = 101): OrderBookSnapshot => ({
  marketId: "BTC-PERP",
  bids: [{ price: bid - 1, size: 2, orders: 1 }, { price: bid, size: 1, orders: 1 }],
  asks: [{ price: ask + 1, size: 2, orders: 1 }, { price: ask, size: 1, orders: 1 }],
  venueTime,
});

describe("OrderBookState", () => {
  it("sorts levels best-first and derives mid and spread", () => {
    const state = new OrderBookState("BTC-PERP");
    expect(state.apply(book(1), 1000)).toBe("applied");
    const view = state.current()!;
    expect(view.bids.map((l) => l.price)).toEqual([100, 99]);
    expect(view.asks.map((l) => l.price)).toEqual([101, 102]);
    expect(view.mid).toBe(100.5);
    expect(view.spread).toBe(1);
    expect(view.receivedAt).toBe(1000);
  });

  it("drops out-of-order and duplicate snapshots", () => {
    const state = new OrderBookState("BTC-PERP");
    state.apply(book(10), 0);
    expect(state.apply(book(10, 50, 51), 1)).toBe("ignored-out-of-order");
    expect(state.apply(book(9, 50, 51), 1)).toBe("ignored-out-of-order");
    expect(state.current()!.bestBid).toBe(100);
  });

  it("rejects crossed books and other markets", () => {
    const state = new OrderBookState("BTC-PERP");
    expect(state.apply(book(1, 105, 101), 0)).toBe("rejected-crossed");
    expect(state.apply({ ...book(2), marketId: "ETH-PERP" }, 0)).toBe("ignored-wrong-market");
    expect(state.current()).toBeNull();
  });

  it("accepts an older timestamp after reset (e.g. reconnect to another node)", () => {
    const state = new OrderBookState("BTC-PERP");
    state.apply(book(10), 0);
    state.reset();
    expect(state.apply(book(5), 0)).toBe("applied");
  });

  it("computes cumulative depth", () => {
    const rows = withCumulativeDepth(
      [{ price: 1, size: 2, orders: null }, { price: 2, size: 3, orders: null }, { price: 3, size: 4, orders: null }],
      2,
    );
    expect(rows.map((r) => r.cumulative)).toEqual([2, 5]);
  });
});

const trade = (id: string, venueTime: number): Trade => ({
  marketId: "BTC-PERP",
  id,
  side: "buy",
  price: 100,
  size: 1,
  venueTime,
});

describe("TradeBuffer", () => {
  it("de-duplicates by trade id and keeps newest first", () => {
    const buffer = new TradeBuffer(10);
    expect(buffer.add([trade("a", 1), trade("b", 2)])).toHaveLength(2);
    expect(buffer.add([trade("b", 2), trade("c", 3)]).map((t) => t.id)).toEqual(["c"]);
    expect(buffer.list().map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("bounds the tape and the seen-id memory", () => {
    const buffer = new TradeBuffer(2, 3);
    buffer.add([trade("1", 1), trade("2", 2), trade("3", 3), trade("4", 4)]);
    expect(buffer.list().map((t) => t.id)).toEqual(["4", "3"]);
    // "1" was evicted from the seen set (capacity 3), so it is accepted again.
    expect(buffer.add([trade("1", 1)])).toHaveLength(1);
    expect(buffer.add([trade("4", 4)])).toHaveLength(0);
  });
});

const candle = (openTime: number, close: number): Candle => ({
  openTime,
  open: 100,
  high: Math.max(100, close),
  low: Math.min(100, close),
  close,
  volume: 1,
});

describe("CandleSeries", () => {
  it("sorts and de-duplicates history", () => {
    const series = new CandleSeries();
    series.setHistory([candle(120, 1), candle(60, 2), candle(120, 3)]);
    expect(series.list().map((c) => [c.openTime, c.close])).toEqual([[60, 2], [120, 3]]);
  });

  it("replaces the current candle, appends new ones and ignores stale ones", () => {
    const series = new CandleSeries();
    series.setHistory([candle(60, 1), candle(120, 2)]);
    expect(series.update(candle(120, 5))).toBe("replaced");
    expect(series.update(candle(180, 6))).toBe("appended");
    expect(series.update(candle(60, 9))).toBe("ignored-stale");
    expect(series.list().map((c) => c.close)).toEqual([1, 5, 6]);
  });

  it("caps the number of candles", () => {
    const series = new CandleSeries(2);
    series.setHistory([candle(1, 1), candle(2, 2), candle(3, 3)]);
    expect(series.list()).toHaveLength(2);
    series.update(candle(4, 4));
    expect(series.list().map((c) => c.openTime)).toEqual([3, 4]);
  });
});

describe("freshness", () => {
  it("classifies data age", () => {
    expect(freshness(null, 1000)).toBe("no-data");
    expect(freshness(1000, 2000, 5000)).toBe("fresh");
    expect(freshness(1000, 7000, 5000)).toBe("stale");
  });
});
