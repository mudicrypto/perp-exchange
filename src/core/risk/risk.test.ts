import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Market, MarketStats, OrderRequest } from "../domain";
import { DefaultRiskEngine } from "./risk-engine";
import { estimateBookImpact, estimateIsolatedLiquidationPrice, initialMargin } from "./risk-math";

const market: Market = {
  id: "BTC-PERP",
  base: "BTC",
  quote: "USDC",
  sizeDecimals: 4,
  priceDecimals: 1,
  maxLeverage: 20,
  isolatedOnly: false,
  maintenanceMarginRate: 0.025,
};

const stats: MarketStats = {
  marketId: "BTC-PERP",
  markPrice: 100,
  oraclePrice: 100,
  midPrice: 100,
  fundingRate: 0.00001,
  fundingIntervalHours: 1,
  openInterest: 10,
  dayNotionalVolume: 1000,
  prevDayPrice: 95,
  observedAt: 0,
};

type Overrides = { type?: "limit" | "market"; limitPrice?: number | null; timeInForce?: string; size?: number; leverage?: number };
const intent = (o: Overrides = {}): OrderRequest => {
  const base = { clientOrderId: "c1", marketId: "BTC-PERP", side: "buy" as const, size: o.size ?? 1, reduceOnly: false, leverage: o.leverage ?? 10, marginMode: "isolated" as const };
  return (o.type ?? "limit") === "market"
    ? { ...base, type: "market", maxSlippage: 0.05 }
    : { ...base, type: "limit", price: o.limitPrice ?? 100, timeInForce: "gtc" };
};

describe("estimateIsolatedLiquidationPrice", () => {
  it("long at 10x with 2.5% maintenance", () => {
    // P = (100 - 10) / (1 - 0.025) = 92.307...
    const p = estimateIsolatedLiquidationPrice({ side: "buy", entryPrice: 100, size: 1, collateral: 10, maintenanceMarginRate: 0.025 });
    expect(p).toBeCloseTo(92.3077, 3);
  });

  it("short at 10x with 2.5% maintenance", () => {
    // P = (100 + 10) / (1 + 0.025) = 107.317...
    const p = estimateIsolatedLiquidationPrice({ side: "sell", entryPrice: 100, size: 1, collateral: 10, maintenanceMarginRate: 0.025 });
    expect(p).toBeCloseTo(107.3171, 3);
  });

  it("at liquidation price equity equals maintenance margin", () => {
    const params = { side: "buy" as const, entryPrice: 250, size: 3, collateral: 50, maintenanceMarginRate: 0.01 };
    const p = estimateIsolatedLiquidationPrice(params)!;
    const equity = params.collateral + params.size * (p - params.entryPrice);
    expect(equity).toBeCloseTo(params.maintenanceMarginRate * params.size * p, 9);
  });

  it("returns null for a fully collateralised long and for invalid input", () => {
    expect(estimateIsolatedLiquidationPrice({ side: "buy", entryPrice: 100, size: 1, collateral: 100, maintenanceMarginRate: 0.025 })).toBeNull();
    expect(estimateIsolatedLiquidationPrice({ side: "buy", entryPrice: 100, size: 0, collateral: 1, maintenanceMarginRate: 0.025 })).toBeNull();
    expect(estimateIsolatedLiquidationPrice({ side: "buy", entryPrice: 100, size: 1, collateral: 1, maintenanceMarginRate: 1 })).toBeNull();
  });
});

describe("initialMargin", () => {
  it("is notional over leverage", () => {
    expect(initialMargin(1000, 10)).toBe(100);
    expect(initialMargin(-1000, 4)).toBe(250);
    expect(() => initialMargin(1, 0)).toThrow();
  });
});

describe("estimateBookImpact", () => {
  const asks = [
    { price: 100, size: 1, orders: 1 },
    { price: 101, size: 1, orders: 1 },
    { price: 102, size: 2, orders: 1 },
  ];

  it("walks levels to compute VWAP and impact", () => {
    const est = estimateBookImpact(asks, 2.5);
    expect(est.averagePrice).toBeCloseTo((100 + 101 + 0.5 * 102) / 2.5);
    expect(est.levelsConsumed).toBe(3);
    expect(est.exceedsVisibleDepth).toBe(false);
    expect(est.priceImpact).toBeCloseTo((est.averagePrice! - 100) / 100);
  });

  it("flags orders larger than visible depth", () => {
    const est = estimateBookImpact(asks, 10);
    expect(est.filledSize).toBe(4);
    expect(est.exceedsVisibleDepth).toBe(true);
  });

  it("handles an empty book", () => {
    expect(estimateBookImpact([], 1)).toMatchObject({ averagePrice: null, priceImpact: null, exceedsVisibleDepth: true });
  });
});

describe("DefaultRiskEngine.preTrade", () => {
  const engine = new DefaultRiskEngine();
  const book = {
    bids: [{ price: 99.9, size: 5, orders: 1 }],
    asks: [{ price: 100.1, size: 0.5, orders: 1 }, { price: 101, size: 0.5, orders: 1 }],
  };

  it("computes margin and liquidation for a limit order", () => {
    const risk = engine.preTrade({ request: intent(), market, stats, book, dataIsStale: false })!;
    expect(risk.notional).toBe(100);
    expect(risk.initialMargin).toBe(10);
    expect(risk.estimatedLiquidationPrice).toBeCloseTo(92.3077, 3);
    expect(risk.liquidationDistance).toBeCloseTo(0.0769, 3);
    expect(risk.bookImpact).toBeNull();
    expect(risk.warnings).toEqual([]);
  });

  it("uses book VWAP as reference for market orders", () => {
    const risk = engine.preTrade({ request: intent({ type: "market", limitPrice: null, timeInForce: "ioc" }), market, stats, book, dataIsStale: false })!;
    expect(risk.referencePrice).toBeCloseTo(100.55);
    expect(risk.bookImpact?.levelsConsumed).toBe(2);
    expect(risk.bookImpact?.priceImpact).toBeCloseTo(0.45 / 100.1, 6);
    // 0.45% is below the default 0.5% threshold.
    expect(risk.warnings.map((w) => w.code)).not.toContain("high-price-impact");
  });

  it("warns on high impact and on orders beyond visible depth", () => {
    const thin = { bids: book.bids, asks: [{ price: 100.1, size: 0.5, orders: 1 }, { price: 102, size: 1, orders: 1 }] };
    const marketIntent = intent({ type: "market", limitPrice: null, timeInForce: "ioc" });
    const impact = engine.preTrade({ request: marketIntent, market, stats, book: thin, dataIsStale: false })!;
    expect(impact.warnings.map((w) => w.code)).toEqual(["high-price-impact"]);
    const deep = engine.preTrade({ request: { ...marketIntent, size: 5 }, market, stats, book: thin, dataIsStale: false })!;
    expect(deep.warnings.map((w) => w.code)).toContain("exceeds-visible-depth");
  });

  it("falls back to mark price for market orders without a book", () => {
    const risk = engine.preTrade({ request: intent({ type: "market", limitPrice: null, timeInForce: "ioc" }), market, stats, book: null, dataIsStale: true })!;
    expect(risk.referencePrice).toBe(100);
    expect(risk.warnings.map((w) => w.code)).toContain("stale-market-data");
  });

  it("returns null when no reference price exists", () => {
    expect(engine.preTrade({ request: intent({ type: "market", limitPrice: null, timeInForce: "ioc" }), market, stats: null, book: null, dataIsStale: false })).toBeNull();
  });

  it("warns on excess leverage, near liquidation and crossing limits", () => {
    const risk = engine.preTrade({ request: intent({ leverage: 50, limitPrice: 101 }), market, stats, book, dataIsStale: false })!;
    const codes = risk.warnings.map((w) => w.code);
    expect(codes).toContain("exceeds-max-leverage");
    expect(codes).toContain("liquidation-near");
    expect(codes).toContain("limit-crosses-book");
  });
});

describe("DefaultRiskEngine.portfolio", () => {
  const engine = new DefaultRiskEngine();
  const account: AccountSnapshot = {
    origin: "venue",
    currency: "USDC",
    balances: [{ asset: "USDC", total: 960, available: 920 }],
    balance: 960,
    equity: 1000,
    unrealizedPnl: 40,
    realizedPnl: 0,
    feesPaid: 0,
    marginUsed: 80,
    orderMargin: 0,
    available: 920,
    maintenanceMargin: 50,
    observedAt: 0,
    positions: [
      { marketId: "BTC-PERP", size: 2, entryPrice: 100, leverage: 5, marginMode: "isolated", marginUsed: 40, liquidationPrice: 99, markPrice: 110, unrealizedPnl: 20 },
      { marketId: "ETH-PERP", size: -10, entryPrice: 20, leverage: 5, marginMode: "isolated", marginUsed: 40, liquidationPrice: 23.4, markPrice: 18, unrealizedPnl: 20 },
    ],
  };

  it("aggregates exposure, leverage, utilisation and PnL from mark prices", () => {
    const risk = engine.portfolio(account);
    expect(risk.longExposure).toBe(220);
    expect(risk.shortExposure).toBe(180);
    expect(risk.grossExposure).toBe(400);
    expect(risk.netExposure).toBe(40);
    expect(risk.effectiveLeverage).toBeCloseTo(0.4);
    expect(risk.marginUtilization).toBeCloseTo(0.05);
    expect(risk.unrealizedPnl).toBeCloseTo(40);
  });

  it("finds the position closest to liquidation", () => {
    const risk = engine.portfolio(account);
    // BTC: |110 - 99| / 110 = 10%; ETH: |18 - 23.4| / 18 = 30%
    expect(risk.closestLiquidation?.marketId).toBe("BTC-PERP");
    expect(risk.closestLiquidation?.distance).toBeCloseTo(0.1);
  });

  it("falls back to entry price without a mark and does not divide by non-positive equity", () => {
    const risk = engine.portfolio({
      ...account,
      equity: 0,
      positions: account.positions.map((p) => ({ ...p, markPrice: null })),
    });
    expect(risk.unrealizedPnl).toBe(0);
    expect(risk.effectiveLeverage).toBeNull();
    expect(risk.marginUtilization).toBeNull();
  });
});
