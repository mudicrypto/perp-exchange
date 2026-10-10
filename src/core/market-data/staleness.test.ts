import { describe, expect, it } from "vitest";
import type { MarketStats } from "../domain";
import { mergeMarketSummaries, newerStats } from "./merge";
import { STALE_AFTER_MS, freshnessOf, streamStatus } from "./staleness";

describe("streamStatus", () => {
  const base = { connected: true, lastUpdateAt: 1_000, now: 2_000, staleAfterMs: 10_000 };

  it("is live while updates arrive within the threshold", () => {
    expect(streamStatus(base)).toBe("live");
    expect(streamStatus({ ...base, now: 11_000 })).toBe("live");
  });

  it("is stale once the threshold is exceeded", () => {
    expect(streamStatus({ ...base, now: 11_001 })).toBe("stale");
  });

  it("is waiting before the first update", () => {
    expect(streamStatus({ ...base, lastUpdateAt: null })).toBe("waiting");
  });

  it("is disconnected whenever the connection is down, even with recent data", () => {
    expect(streamStatus({ ...base, connected: false })).toBe("disconnected");
    expect(streamStatus({ ...base, connected: false, lastUpdateAt: null })).toBe("disconnected");
  });

  it("reports venue errors above everything else", () => {
    expect(streamStatus({ ...base, connected: false, error: "Invalid subscription" })).toBe("error");
  });

  it("never marks event-driven streams stale while connected", () => {
    expect(streamStatus({ ...base, staleAfterMs: STALE_AFTER_MS.trades, now: 10_000_000 })).toBe("live");
  });

  it("maps to coarse freshness for styling", () => {
    expect(freshnessOf("live")).toBe("fresh");
    expect(freshnessOf("waiting")).toBe("no-data");
    expect(freshnessOf("stale")).toBe("stale");
    expect(freshnessOf("disconnected")).toBe("stale");
  });
});

const stats = (observedAt: number, markPrice: number): MarketStats => ({
  marketId: "BTC-PERP",
  markPrice,
  oraclePrice: null,
  midPrice: null,
  fundingRate: 0,
  fundingIntervalHours: 1,
  openInterest: 0,
  dayNotionalVolume: 0,
  prevDayPrice: null,
  observedAt,
});

describe("newest-wins merging", () => {
  it("keeps the newer observation regardless of arrival order", () => {
    expect(newerStats(stats(10, 1), stats(5, 2))!.markPrice).toBe(1);
    expect(newerStats(stats(5, 1), stats(10, 2))!.markPrice).toBe(2);
    expect(newerStats(null, stats(1, 3))!.markPrice).toBe(3);
    expect(newerStats(stats(1, 3), null)!.markPrice).toBe(3);
  });

  it("does not let a slow catalog refresh overwrite newer streamed stats", () => {
    const market = { id: "BTC-PERP", base: "BTC", quote: "USDC", sizeDecimals: 5, priceDecimals: 1, maxLeverage: 40, isolatedOnly: false, maintenanceMarginRate: 0.0125 };
    const previous = [{ market, stats: stats(200, 61_000) }];
    const refreshed = [
      { market, stats: stats(100, 60_000) },
      { market: { ...market, id: "ETH-PERP", base: "ETH" }, stats: stats(100, 3_000) },
    ];
    const merged = mergeMarketSummaries(previous, refreshed);
    expect(merged.map((m) => m.market.id)).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(merged[0]!.stats!.markPrice).toBe(61_000);
    expect(merged[1]!.stats!.markPrice).toBe(3_000);
  });

  it("drops markets that disappear from the catalog (e.g. delisted)", () => {
    const market = { id: "OLD-PERP", base: "OLD", quote: "USDC", sizeDecimals: 0, priceDecimals: 6, maxLeverage: 3, isolatedOnly: false, maintenanceMarginRate: 0.1 };
    expect(mergeMarketSummaries([{ market, stats: null }], [])).toEqual([]);
  });
});
