import { describe, expect, it } from "vitest";
import type { Fill } from "../domain";
import { account, EX, exampleRules, longA, NOW, shortB, WHY } from "./__fixtures__/example-venue";
import { assessPortfolio, type RiskContext } from "./portfolio";
import { marketMoveScenario, priceMoveScenarios } from "./scenarios";
import type { AvailableValue, RiskValue } from "./value";

const markets = new Map([
  [EX.id, EX],
  [WHY.id, WHY],
]);
const mark = (value: number, observedAt = NOW - 1_000) => ({ value, observedAt, source: "test feed" });

function ctx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    now: NOW,
    venue: exampleRules,
    account: { value: account([longA, shortB]), observedAt: NOW - 500, source: "test account" },
    markets,
    marks: new Map([
      ["EX-PERP", mark(1050)],
      ["WHY-PERP", mark(48)],
    ]),
    funding: new Map([
      ["EX-PERP", { value: { rate: 0.0000125, intervalHours: 1, oraclePrice: 1049 }, observedAt: NOW - 2_000, source: "test feed" }],
      ["WHY-PERP", { value: { rate: -0.00002, intervalHours: 1, oraclePrice: 48.1 }, observedAt: NOW - 2_000, source: "test feed" }],
    ]),
    fills: null,
    ...overrides,
  };
}

const v = (value: RiskValue) => {
  if (value.status !== "available") throw new Error(`unavailable: ${value.reason}`);
  return value.value;
};

describe("assessPortfolio — worked examples (docs/RISK.md)", () => {
  const report = assessPortfolio(ctx());
  const [a, b] = report.positions as [NonNullable<(typeof report.positions)[0]>, NonNullable<(typeof report.positions)[1]>];

  it("long A: notional, unrealised PnL, liquidation and distance", () => {
    expect(a.direction).toBe("long");
    expect(v(a.notional)).toBe("2100");
    expect(v(a.signedExposure)).toBe("2100");
    expect(v(a.unrealizedPnl)).toBe("100");
    // 918.367… rounded *up* to the 0.1 tick (toward the mark).
    expect(v(a.liquidationPrice)).toBe("918.4");
    expect(v(a.liquidationDistance)).toBe("0.1253333333");
    expect(v(a.collateral)).toBe("200");
    expect((a.collateral as AvailableValue).assumptions.join(" ")).toMatch(/not a maximum loss/);
  });

  it("short B: signs and liquidation above the entry", () => {
    expect(b.direction).toBe("short");
    expect(v(b.notional)).toBe("144");
    expect(v(b.signedExposure)).toBe("-144");
    expect(v(b.unrealizedPnl)).toBe("6");
    // 58.823… rounded *down* to the tick (toward the mark).
    expect(v(b.liquidationPrice)).toBe("58.8");
    expect(v(b.liquidationDistance)).toBe("0.225");
  });

  it("exposure by direction and instrument, and concentration", () => {
    expect(v(report.exposure.long)).toBe("2100");
    expect(v(report.exposure.short)).toBe("144");
    expect(v(report.exposure.gross)).toBe("2244");
    expect(v(report.exposure.net)).toBe("1956");
    expect(report.exposure.byInstrument.map((e) => [e.marketId, e.direction, v(e.share)])).toEqual([
      ["EX-PERP", "long", "0.935828877"],
      ["WHY-PERP", "short", "0.064171123"],
    ]);
    expect(report.concentration.largestMarketId).toBe("EX-PERP");
    expect(v(report.concentration.hhi)).toBe("0.8798936201");
  });

  it("margin utilisation and effective leverage", () => {
    expect(v(report.margin.maintenanceMargin)).toBe("44.88");
    expect(report.margin.maintenanceMargin).toMatchObject({ kind: "calculated" });
    expect(v(report.margin.maintenanceUtilization)).toBe("0.0044409262");
    expect(v(report.margin.initialUtilization)).toBe("0.0227587572");
    expect(v(report.margin.effectiveLeverage)).toBe("0.2220463091");
  });

  it("funding: projected on the oracle price, positive = received", () => {
    expect(v(a.fundingNextInterval)).toBe("-0.026225");
    expect(v(b.fundingNextInterval)).toBe("-0.002886");
    expect(report.pnl.fundingNextInterval).toMatchObject({ status: "available", value: "-0.029111", kind: "estimate" });
    expect((report.pnl.fundingNextInterval as AvailableValue).assumptions.join(" ")).toMatch(/rates change/);
    expect(report.pnl.fundingPaid).toMatchObject({ status: "unavailable", missing: ["Funding history"] });
  });

  it("every available value carries its inputs with timestamps", () => {
    const n = a.notional as AvailableValue;
    expect(n.inputs.map((i) => i.name)).toEqual(["Position size", "Mark price"]);
    expect(n.inputs[1]).toMatchObject({ source: "test feed", observedAt: NOW - 1_000, unit: { kind: "price", quote: "USDC", base: "EX" } });
    expect(n.unit).toEqual({ kind: "amount", asset: "USDC" });
    expect(n.asOf).toBe(NOW);
  });

  it("is deterministic", () => {
    expect(assessPortfolio(ctx())).toEqual(report);
  });
});

describe("assessPortfolio — missing and stale data", () => {
  it("a stale mark makes that position's figures and every aggregate unavailable", () => {
    const report = assessPortfolio(ctx({ marks: new Map([["EX-PERP", mark(1050, NOW - 60_000)], ["WHY-PERP", mark(48)]]) }));
    const ex = report.positions[0]!;
    expect(ex.notional).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/stale/), missing: ["Mark price"] });
    expect(ex.unrealizedPnl.status).toBe("unavailable");
    expect(report.exposure.gross.status).toBe("unavailable");
    expect(report.concentration.hhi.status).toBe("unavailable");
    expect(report.margin.effectiveLeverage.status).toBe("unavailable");
    // The other position is still assessed.
    expect(report.positions[1]!.notional.status).toBe("available");
  });

  it("no mark at all, a future timestamp, and a stale account are unavailable, not guessed", () => {
    expect(assessPortfolio(ctx({ marks: new Map([["WHY-PERP", mark(48)]]) })).positions[0]!.notional).toMatchObject({ status: "unavailable", reason: "No mark price for EX-PERP" });
    expect(assessPortfolio(ctx({ marks: new Map([["EX-PERP", mark(1050, NOW + 60_000)], ["WHY-PERP", mark(48)]]) })).positions[0]!.notional).toMatchObject({ reason: expect.stringMatching(/future/) });
    const stale = assessPortfolio(ctx({ account: { value: account([longA]), observedAt: NOW - 120_000, source: "test" } }));
    expect(stale.positions).toEqual([]);
    expect(stale.margin.equity).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/stale/) });
    expect(assessPortfolio(ctx({ account: null })).exposure.gross).toMatchObject({ status: "unavailable", reason: "No account data" });
  });

  it("without venue rules, liquidation and maintenance margin are unavailable", () => {
    const report = assessPortfolio(ctx({ venue: null }));
    expect(report.positions[0]!.liquidationPrice).toMatchObject({ status: "unavailable", missing: ["Venue margin rules"] });
    expect(report.margin.maintenanceMargin.status).toBe("unavailable");
    expect(report.positions[0]!.notional.status).toBe("available");
  });

  it("prefers venue-reported maintenance margin, and refuses ratios at zero or negative equity", () => {
    const reported = assessPortfolio(ctx({ account: { value: account([longA, shortB], { maintenanceMargin: 50 }), observedAt: NOW, source: "test" } }));
    expect(reported.margin.maintenanceMargin).toMatchObject({ value: "50", kind: "venue-reported" });
    const broke = assessPortfolio(ctx({ account: { value: account([longA], { equity: -5 }), observedAt: NOW, source: "test" } }));
    expect(broke.margin.effectiveLeverage).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/zero or negative/) });
  });

  it("cross-margin positions do not report per-position collateral", () => {
    const report = assessPortfolio(ctx({ account: { value: account([{ ...longA, marginMode: "cross" }]), observedAt: NOW, source: "test" } }));
    expect(report.positions[0]!.collateral).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/Cross margin/) });
    expect(report.positions[0]!.liquidationPrice.status).toBe("unavailable");
  });

  it("a funding rule that does not charge reports zero; a missing rate is unavailable", () => {
    const noFunding = assessPortfolio(ctx({ venue: { ...exampleRules, funding: { charged: false, reason: "Venue charges no funding" } } }));
    expect(noFunding.pnl.fundingPaid).toMatchObject({ value: "0", method: "Venue charges no funding" });
    expect(assessPortfolio(ctx({ funding: new Map() })).positions[0]!.fundingNextInterval).toMatchObject({ status: "unavailable", missing: ["Funding rate"] });
    const markBasis = assessPortfolio(ctx({ venue: { ...exampleRules, funding: { charged: true, priceBasis: "mark", source: "x" } } }));
    expect(markBasis.positions[0]!.fundingNextInterval).toMatchObject({ value: "-0.02625" });
  });

  it("an empty account has zero exposure but no concentration", () => {
    const report = assessPortfolio(ctx({ account: { value: account([], { marginUsed: 0 }), observedAt: NOW, source: "test" } }));
    expect(report.exposure.gross).toMatchObject({ value: "0" });
    expect(report.concentration.largestShare).toMatchObject({ status: "unavailable", reason: "No open positions" });
  });
});

describe("realised PnL and fees from execution records", () => {
  const fill = (id: string, realizedPnl: number, fee: number): Fill => ({ id, orderId: "o", marketId: "EX-PERP", side: "sell", price: 1, size: 1, fee, liquidity: "taker", realizedPnl, time: NOW - 10_000, origin: "simulated" });

  it("sums per-fill PnL and fees exactly", () => {
    const fills = { value: [fill("f1", 0.1, 0.01), fill("f2", 0.2, 0.02), fill("f3", -0.05, -0.005)], observedAt: NOW, source: "test fills" };
    const report = assessPortfolio(ctx({ fills }));
    expect(report.pnl.realized).toMatchObject({ status: "available", value: "0.25", kind: "calculated" });
    expect(report.pnl.fees).toMatchObject({ value: "0.025" });
  });

  it("is unavailable without records, and refuses duplicated records", () => {
    expect(assessPortfolio(ctx()).pnl.realized).toMatchObject({ status: "unavailable", missing: ["Fill history"] });
    const dup = { value: [fill("f1", 1, 0), fill("f1", 1, 0)], observedAt: NOW, source: "test" };
    expect(assessPortfolio(ctx({ fills: dup })).pnl.realized).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/Duplicate fill/) });
  });
});

describe("price-move scenarios", () => {
  const report = assessPortfolio(ctx());

  it("applies uniform moves to every mark", () => {
    const [down20, down10, up10] = priceMoveScenarios(report, ["-0.2", "-0.1", "0.1"]);
    expect(down10!.pnlChange).toMatchObject({ value: "-195.6", kind: "estimate" });
    expect(down10!.equityAfter).toMatchObject({ value: "9910.4" });
    expect(down10!.positions).toEqual([
      { marketId: "EX-PERP", priceAfter: "945", pnlChange: "-210", reachesLiquidationEstimate: false },
      { marketId: "WHY-PERP", priceAfter: "43.2", pnlChange: "14.4", reachesLiquidationEstimate: false },
    ]);
    expect(down20!.pnlChange).toMatchObject({ value: "-391.2" });
    expect(down20!.positions[0]!.reachesLiquidationEstimate).toBe(true);
    expect(up10!.pnlChange).toMatchObject({ value: "195.6" });
    expect((up10!.pnlChange as AvailableValue).assumptions.join(" ")).toMatch(/Hypothetical/);
  });

  it("reports an unknown liquidation as unknown, not safe; rejects moves of −100 % or worse", () => {
    const noRules = priceMoveScenarios(assessPortfolio(ctx({ venue: null })), ["-0.5"]);
    expect(noRules[0]!.positions.every((p) => p.reachesLiquidationEstimate === null)).toBe(true);
    expect(() => priceMoveScenarios(report, ["-1"])).toThrow(RangeError);
    expect(() => priceMoveScenarios(report, ["-1.5"])).toThrow(RangeError);
  });

  it("is unavailable when a mark is missing", () => {
    const partial = assessPortfolio(ctx({ marks: new Map([["WHY-PERP", mark(48)]]) }));
    expect(priceMoveScenarios(partial, ["0.1"])[0]!.pnlChange).toMatchObject({ status: "unavailable" });
  });
});

describe("single-market move scenario", () => {
  const report = assessPortfolio(ctx());

  it("moves only one market: A long 2 @ mark 1050, +3% → +63", () => {
    const s = marketMoveScenario(report, "EX-PERP", "0.03");
    expect(s.unrealizedPnlChange).toMatchObject({ value: "63", kind: "estimate" });
    // Current total uPnL 100 + 6 = 106 → 169
    expect(s.unrealizedPnlAfter).toMatchObject({ value: "169" });
    expect(s).toMatchObject({ priceBefore: "1050", priceAfter: "1081.5", reachesLiquidationEstimate: false, noPosition: false });
  });

  it("short positions gain when the market falls; no position means no change", () => {
    expect(marketMoveScenario(report, "WHY-PERP", "-0.03").unrealizedPnlChange).toMatchObject({ value: "4.32" });
    expect(marketMoveScenario(report, "ZED-PERP", "0.5")).toMatchObject({ noPosition: true, unrealizedPnlChange: { value: "0" } });
    expect(() => marketMoveScenario(report, "EX-PERP", "-1")).toThrow(RangeError);
  });
});
