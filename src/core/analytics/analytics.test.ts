import { describe, expect, it } from "vitest";
import type { Fill } from "../domain";
import { feesAndFunding, summarizeExecutions } from "./activity";
import { attributeEquityChange } from "./attribution";
import { periodWindow, type FundingPayment, type Transfer } from "./records";

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const H = 3_600_000;
const fill = (o: Partial<Fill>): Fill => ({ id: "f", orderId: null, marketId: "EX-PERP", side: "buy", price: 100, size: 1, fee: 0, liquidity: "taker", realizedPnl: 0, time: T0, origin: "simulated", ...o });
const window = { from: T0 - 10 * H, to: T0, label: "test" };

describe("periodWindow (UTC)", () => {
  it("today starts at 00:00 UTC; 24h and 7d are rolling", () => {
    expect(periodWindow("today", T0)).toMatchObject({ from: Date.UTC(2026, 9, 10), to: T0 });
    expect(periodWindow("24h", T0).from).toBe(T0 - 24 * H);
    expect(periodWindow("7d", T0).from).toBe(T0 - 7 * 24 * H);
  });
});

describe("attributeEquityChange", () => {
  // Hand-checkable: equity 10,000 → 10,431.4
  //   realised +250 (closing trade), fees 12.3 + 4.5 = 16.8, funding −2.1 + 0.4 = −1.7,
  //   deposit +100, unrealised 40 → 139.9 (+99.9).  250 − 16.8 − 1.7 + 100 + 99.9 = 431.4
  const fills = [fill({ id: "a", time: T0 - 5 * H, realizedPnl: 250, fee: 12.3 }), fill({ id: "b", time: T0 - 2 * H, fee: 4.5 }), fill({ id: "old", time: T0 - 20 * H, realizedPnl: 999, fee: 9 })];
  const funding: FundingPayment[] = [
    { id: "p1", marketId: "EX-PERP", time: T0 - 4 * H, amount: -2.1, rate: 0.0001, positionSize: 1 },
    { id: "p2", marketId: "EX-PERP", time: T0 - H, amount: 0.4, rate: -0.00002, positionSize: 1 },
  ];
  const transfers: Transfer[] = [{ id: "t", time: T0 - 3 * H, amount: 100 }];
  const start = { time: window.from, equity: 10_000, unrealizedPnl: 40, source: "s" };

  it("reconciles exactly when the records are complete", () => {
    const a = attributeEquityChange({ window, start, end: { time: T0, equity: 10_431.4, unrealizedPnl: 139.9, source: "s" }, fills, funding, transfers });
    expect(a).toMatchObject({ change: "431.4", realizedPnl: "250", fees: "16.8", funding: "-1.7", transfers: "100", unrealizedChange: "99.9", residual: "0", fillCount: 2, fundingCount: 2, transferCount: 1 });
  });

  it("reports unexplained amounts as a residual instead of hiding them", () => {
    const a = attributeEquityChange({ window, start, end: { time: T0, equity: 10_400, unrealizedPnl: 139.9, source: "s" }, fills, funding, transfers });
    expect(a.residual).toBe("-31.4");
  });

  it("excludes records outside the window and rejects reversed observations", () => {
    expect(() => attributeEquityChange({ window, start: { ...start, time: T0 + 1 }, end: { ...start, time: T0 }, fills, funding, transfers })).toThrow(RangeError);
  });
});

describe("feesAndFunding", () => {
  it("separates fees from funding paid and received, per market", () => {
    const r = feesAndFunding(
      [fill({ id: "a", time: T0 - H, fee: 1.25 }), fill({ id: "b", marketId: "WHY-PERP", time: T0 - H, fee: -0.05, liquidity: "maker" })],
      [
        { id: "p1", marketId: "EX-PERP", time: T0 - H, amount: -0.3, rate: 0, positionSize: 1 },
        { id: "p2", marketId: "WHY-PERP", time: T0 - H, amount: 0.1, rate: 0, positionSize: -1 },
      ],
      window,
    );
    expect(r).toMatchObject({ feesPaid: "1.2", fundingPaid: "0.3", fundingReceived: "0.1", fundingNet: "-0.2", totalCost: "1.4" });
    expect(r.byMarket).toEqual([
      { marketId: "EX-PERP", fees: "1.25", funding: "-0.3" },
      { marketId: "WHY-PERP", fees: "-0.05", funding: "0.1" },
    ]);
  });
});

describe("summarizeExecutions", () => {
  it("summarises counts, notional, VWAPs and lists the most recent first", () => {
    const s = summarizeExecutions(
      [
        fill({ id: "1", time: T0 - 3 * H, side: "buy", size: 2, price: 100, fee: 0.09 }),
        fill({ id: "2", time: T0 - 2 * H, side: "buy", size: 1, price: 130, fee: 0.0585, liquidity: "maker" }),
        fill({ id: "3", time: T0 - H, side: "sell", size: 3, price: 120, fee: 0.162, realizedPnl: 30 }),
      ],
      window,
      2,
    );
    expect(s).toMatchObject({ count: 3, notional: "690", fees: "0.3105", realizedPnl: "30", makerCount: 1, takerCount: 2 });
    expect(s.byMarket[0]).toMatchObject({ buys: 2, sells: 1, boughtSize: "3", soldSize: "3", vwapBuy: "110", vwapSell: "120" });
    expect(s.recent.map((f) => f.id)).toEqual(["3", "2"]);
  });

  it("handles an empty window", () => {
    expect(summarizeExecutions([], window)).toMatchObject({ count: 0, notional: "0", first: null, last: null, recent: [] });
  });
});
