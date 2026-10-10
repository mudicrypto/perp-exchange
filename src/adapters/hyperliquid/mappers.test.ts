import { describe, expect, it } from "vitest";
import metaFixture from "./__fixtures__/meta-and-asset-ctxs.json";
import candlesFixture from "./__fixtures__/candle-snapshot.json";
import wsFixture from "./__fixtures__/ws-messages.json";
import { mapAllMids, mapCandle, mapL2Book, mapMetaAndAssetCtxs, mapTrade } from "./mappers";
import {
  HlCandleSnapshotSchema,
  HlL2BookSchema,
  HlMetaAndAssetCtxsSchema,
  HlTradesSchema,
} from "./wire-schemas";

describe("Hyperliquid wire schemas", () => {
  it("accepts documented metaAndAssetCtxs shape and strips unknown fields", () => {
    const parsed = HlMetaAndAssetCtxsSchema.parse(metaFixture);
    expect(parsed[0].universe).toHaveLength(5);
    expect(parsed[0]).not.toHaveProperty("marginTables");
  });

  it("rejects non-decimal price strings", () => {
    const bad = structuredClone(candlesFixture);
    bad[0]!.o = "NaN";
    expect(HlCandleSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a book without both sides", () => {
    const bad = { coin: "BTC", time: 1, levels: [[]] };
    expect(HlL2BookSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown trade side", () => {
    const bad = structuredClone(wsFixture.trades.data);
    (bad[0] as { side: string }).side = "X";
    expect(HlTradesSchema.safeParse(bad).success).toBe(false);
  });
});

describe("Hyperliquid mappers", () => {
  const observedAt = 1_700_000_000_000;

  it("maps markets, skipping delisted and non-main-dex names", () => {
    const summaries = mapMetaAndAssetCtxs(HlMetaAndAssetCtxsSchema.parse(metaFixture), observedAt);
    expect(summaries.map((s) => s.market.id)).toEqual(["BTC-PERP", "ETH-PERP", "ISO-PERP"]);
  });

  it("derives price decimals, maintenance margin and isolated flag", () => {
    const [btc, , iso] = mapMetaAndAssetCtxs(HlMetaAndAssetCtxsSchema.parse(metaFixture), observedAt);
    expect(btc!.market).toMatchObject({
      base: "BTC",
      quote: "USDC",
      sizeDecimals: 5,
      priceDecimals: 1,
      maxLeverage: 40,
      isolatedOnly: false,
    });
    expect(btc!.market.maintenanceMarginRate).toBeCloseTo(1 / 80);
    expect(iso!.market.isolatedOnly).toBe(true);
  });

  it("maps asset context numbers and keeps nulls as nulls", () => {
    const [btc, eth] = mapMetaAndAssetCtxs(HlMetaAndAssetCtxsSchema.parse(metaFixture), observedAt);
    expect(btc!.stats).toMatchObject({
      markPrice: 61010,
      oraclePrice: 61000,
      midPrice: 61009.5,
      fundingRate: 0.0000125,
      fundingIntervalHours: 1,
      openInterest: 1234.56789,
      prevDayPrice: 60000,
      observedAt,
    });
    expect(eth!.stats!.midPrice).toBeNull();
    expect(eth!.stats!.fundingRate).toBeLessThan(0);
  });

  it("maps candles", () => {
    const candles = HlCandleSnapshotSchema.parse(candlesFixture).map(mapCandle);
    expect(candles[0]).toEqual({
      openTime: 1700000000000,
      open: 61000,
      high: 61010,
      low: 60990,
      close: 61005,
      volume: 12.345,
    });
  });

  it("maps the L2 book with bids and asks best-first", () => {
    const book = mapL2Book(HlL2BookSchema.parse(wsFixture.l2Book.data));
    expect(book.marketId).toBe("BTC-PERP");
    expect(book.bids[0]).toEqual({ price: 61000, size: 1.5, orders: 3 });
    expect(book.asks[0]).toEqual({ price: 61001, size: 0.75, orders: 2 });
    expect(book.venueTime).toBe(1700000000500);
  });

  it("maps trade side B to buy and A to sell, with a stable unique id", () => {
    const trades = HlTradesSchema.parse(wsFixture.trades.data).map(mapTrade);
    expect(trades.map((t) => t.side)).toEqual(["buy", "sell"]);
    expect(trades[0]!.id).toContain("1001");
    expect(new Set(trades.map((t) => t.id)).size).toBe(2);
  });
});

describe("mapAllMids", () => {
  it("keeps perp coins, skips spot keys, and counts malformed prices", () => {
    const { prices, skipped } = mapAllMids(
      { mids: { BTC: "61000.5", ETH: "2950", "@107": "1.2", "PURR/USDC": "0.2", BAD: "1e5", ZERO: "0" } },
      123,
    );
    expect([...prices.mids.entries()]).toEqual([
      ["BTC-PERP", 61000.5],
      ["ETH-PERP", 2950],
    ]);
    expect(skipped).toBe(2);
    expect(prices.observedAt).toBe(123);
  });

  it("can restrict output to known markets", () => {
    const { prices } = mapAllMids({ mids: { BTC: "1", ETH: "2" } }, 0, new Set(["ETH-PERP"]));
    expect([...prices.mids.keys()]).toEqual(["ETH-PERP"]);
  });
});

describe("normalisation edge cases", () => {
  it("drops zero-size book levels", () => {
    const book = mapL2Book(
      HlL2BookSchema.parse({ coin: "BTC", time: 5, levels: [[{ px: "100", sz: "0", n: 0 }, { px: "99", sz: "1", n: 1 }], [{ px: "101", sz: "2", n: 1 }]] }),
    );
    expect(book.bids).toEqual([{ price: 99, size: 1, orders: 1 }]);
  });

  it("maps negative funding and missing mid to null rather than a guess", () => {
    const [, eth] = mapMetaAndAssetCtxs(HlMetaAndAssetCtxsSchema.parse(metaFixture), 0);
    expect(eth!.stats!.fundingRate).toBeCloseTo(-0.00002);
    expect(eth!.stats!.midPrice).toBeNull();
  });
});
