import { describe, expect, it } from "vitest";
import type { OrderRequest } from "../domain";
import { account, EX, exampleRules, longA, NOW, shortB, WHY } from "./__fixtures__/example-venue";
import { DEFAULT_RISK_LIMITS, type RiskLimits } from "./limits";
import { assessPortfolio } from "./portfolio";
import { assessOrder, estimateBookImpact, type PreTradeInput } from "./pre-trade";
import { dec } from "./decimal";

const limit = (o: Partial<OrderRequest> = {}): OrderRequest =>
  ({ clientOrderId: "c", marketId: "EX-PERP", side: "buy", type: "limit", price: 1000, timeInForce: "gtc", size: 2, reduceOnly: false, leverage: 10, marginMode: "isolated", ...o }) as OrderRequest;
const mark = (value = 1000, observedAt = NOW - 1_000) => ({ value, observedAt, source: "test feed" });
const noLimits: RiskLimits = { maxOrderNotional: null, maxPositionNotional: null, maxGrossExposure: null, maxLeverage: null, maxConcentration: null, minLiquidationDistance: null, maxPriceDeviation: null, maxMarkAgeMs: 15_000 };

function input(o: Partial<PreTradeInput> = {}): PreTradeInput {
  return { now: NOW, order: limit(), market: EX, venue: exampleRules, mark: mark(), book: null, position: null, portfolio: null, limits: noLimits, ...o };
}

describe("assessOrder — example E (docs/RISK.md)", () => {
  const a = assessOrder(input());

  it("computes notional, initial margin, fee, liquidation and distance", () => {
    expect(a.notional).toMatchObject({ status: "available", value: "2000", unit: { kind: "amount", asset: "USDC" } });
    expect(a.initialMargin).toMatchObject({ value: "200" });
    expect(a.feeEstimate).toMatchObject({ value: "0.9", kind: "estimate" });
    expect(a.liquidationPrice).toMatchObject({ value: "918.4", kind: "estimate" });
    expect(a.liquidationDistance).toMatchObject({ value: "0.0816" });
    expect(a.decision).toBe("allow");
  });

  it("uses the maker rate for post-only orders, and short liquidation rounds down", () => {
    expect(assessOrder(input({ order: limit({ timeInForce: "post-only" } as Partial<OrderRequest>) })).feeEstimate).toMatchObject({ value: "0.3" });
    const short = assessOrder(input({ order: limit({ side: "sell", size: 3, price: 50, leverage: 5, marketId: "WHY-PERP" }), market: WHY, mark: mark(50) }));
    expect(short.liquidationPrice).toMatchObject({ value: "58.8" });
  });

  it("combines an order with an existing same-side position (average cost, summed collateral)", () => {
    const r = assessOrder(input({ order: limit({ size: 2, price: 1100 }), position: longA, mark: mark(1080) }));
    // Size 4, entry (2·1000 + 2·1100)/4 = 1050, collateral 200 + 220 = 420 → (4200 − 420)/(4·0.98) = 964.28… → 964.3
    expect(r.liquidationPrice).toMatchObject({ value: "964.3" });
    expect(r.resultingPositionNotional).toMatchObject({ value: "4400" });
  });

  it("does not estimate liquidation for reducing/flipping or reduce-only orders", () => {
    expect(assessOrder(input({ order: limit({ side: "sell" }), position: longA })).liquidationPrice).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/reduces or flips/) });
    expect(assessOrder(input({ order: limit({ side: "sell", reduceOnly: true }), position: longA })).liquidationPrice).toMatchObject({ reason: expect.stringMatching(/reduce-only/) });
  });

  it("market orders use the visible-book VWAP; trigger orders are flagged", () => {
    const book = { value: { bids: [{ price: 999, size: 5, orders: 1 }], asks: [{ price: 1001, size: 1, orders: 1 }, { price: 1003, size: 5, orders: 1 }] }, observedAt: NOW, source: "test book" };
    const m = assessOrder(input({ order: { ...limit(), type: "market", maxSlippage: 0.05 } as OrderRequest, book }));
    expect(m.referencePrice).toMatchObject({ value: "1002", kind: "estimate" });
    expect(m.bookImpact).toMatchObject({ averagePrice: "1002", levelsConsumed: 2, exceedsVisibleDepth: false });
    const t = assessOrder(input({ order: { ...limit(), type: "stop-market", triggerPrice: 990, maxSlippage: 0.05 } as OrderRequest }));
    expect(t.notices).toContainEqual({ code: "trigger-reference-price" });
  });

  it("without venue rules: notional only, everything venue-dependent unavailable", () => {
    const r = assessOrder(input({ venue: null }));
    expect(r.notional.status).toBe("available");
    expect(r.initialMargin).toMatchObject({ status: "unavailable", missing: ["Venue margin rules"] });
    expect(r.feeEstimate).toMatchObject({ status: "unavailable", missing: ["Venue fee schedule"] });
    expect(r.liquidationPrice.status).toBe("unavailable");
  });
});

describe("pre-trade limits", () => {
  const portfolio = assessPortfolio({
    now: NOW,
    venue: exampleRules,
    account: { value: account([shortB]), observedAt: NOW, source: "test" },
    markets: new Map([[EX.id, EX], [WHY.id, WHY]]),
    marks: new Map([["WHY-PERP", mark(48)]]),
    funding: new Map(),
    fills: null,
  });
  const check = (r: ReturnType<typeof assessOrder>, name: string) => r.checks.find((c) => c.limit === name);

  it("blocks a stale or missing mark (fail closed)", () => {
    expect(assessOrder(input({ mark: mark(1000, NOW - 60_000) })).decision).toBe("block");
    expect(assessOrder(input({ mark: null }))).toMatchObject({ decision: "block" });
  });

  it("blocks leverage above the venue maximum regardless of configuration", () => {
    const r = assessOrder(input({ order: limit({ leverage: 30 }) }));
    expect(check(r, "venueMaxLeverage")).toMatchObject({ status: "breach", action: "block" });
    expect(r.decision).toBe("block");
  });

  it("order, position and gross notional limits", () => {
    const limits = { ...noLimits, maxOrderNotional: { value: "1500", action: "block" as const }, maxGrossExposure: { value: "2100", action: "warn" as const } };
    const r = assessOrder(input({ limits, portfolio }));
    expect(check(r, "maxOrderNotional")).toMatchObject({ status: "breach", observed: "2000", threshold: "1500" });
    // Gross after = 144 (WHY at mark) + 2000 = 2144 > 2100
    expect(check(r, "maxGrossExposure")).toMatchObject({ status: "breach", action: "warn", observed: "2144" });
    expect(r.decision).toBe("block");
    expect(assessOrder(input({ limits: { ...noLimits, maxPositionNotional: { value: "3000", action: "block" } }, position: longA })).checks.find((c) => c.limit === "maxPositionNotional")).toMatchObject({ status: "breach", observed: "4000" });
  });

  it("a limit that needs data Nova does not have is unverifiable — blocking ones block", () => {
    const r = assessOrder(input({ limits: { ...noLimits, maxGrossExposure: { value: "1000000", action: "block" } }, portfolio: null }));
    expect(check(r, "maxGrossExposure")).toMatchObject({ status: "unverifiable", message: expect.stringMatching(/No account data/) });
    expect(r.decision).toBe("block");
  });

  it("concentration, liquidation distance and price deviation", () => {
    const limits: RiskLimits = { ...noLimits, maxConcentration: { value: "0.8", action: "warn" }, minLiquidationDistance: { value: "0.1", action: "warn" }, maxPriceDeviation: { value: "0.1", action: "block" } };
    const r = assessOrder(input({ limits, portfolio }));
    expect(check(r, "maxConcentration")).toMatchObject({ status: "breach", observed: "0.9328358209" });
    expect(check(r, "minLiquidationDistance")).toMatchObject({ status: "breach", observed: "0.0816" });
    expect(check(r, "maxPriceDeviation")).toMatchObject({ status: "pass" });
    expect(r.decision).toBe("warn");
    const fat = assessOrder(input({ limits, portfolio, order: limit({ price: 1200 }) }));
    expect(check(fat, "maxPriceDeviation")).toMatchObject({ status: "breach", observed: "0.2" });
    expect(fat.decision).toBe("block");
  });

  it("reduce-only orders skip exposure-increasing limits", () => {
    const r = assessOrder(input({ order: limit({ side: "sell", reduceOnly: true, size: 1 }), position: longA, limits: { ...DEFAULT_RISK_LIMITS, maxOrderNotional: { value: "1", action: "block" } } }));
    expect(check(r, "maxOrderNotional")).toBeUndefined();
    expect(r.decision).toBe("allow");
  });

  it("extreme inputs stay exact", () => {
    const r = assessOrder(input({ order: limit({ size: 1e15, price: 1e-9 }), mark: mark(1e-9) }));
    expect(r.notional).toMatchObject({ value: "1000000" });
    expect(estimateBookImpact([], dec(1))).toMatchObject({ averagePrice: null, exceedsVisibleDepth: true });
  });
});
