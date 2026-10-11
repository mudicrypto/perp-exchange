import { describe, expect, it } from "vitest";
import { dec, decOrNull, OUTPUT_DECIMALS, roundDp, toPlain } from "./decimal";
import { constantRateIsolatedLiquidationPrice } from "./margin-rules";

describe("decimal arithmetic", () => {
  it("is exact where binary floating point is not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toPlain(dec(0.1).add(dec(0.2)))).toBe("0.3");
    expect(toPlain(dec("1234.5").mul(dec("0.003")))).toBe("3.7035");
  });

  it("rounds half-even for outputs and directionally for liquidation prices", () => {
    expect(toPlain(roundDp(dec("0.123456785"), OUTPUT_DECIMALS.amount))).toBe("0.12345678");
    expect(toPlain(roundDp(dec("0.123456775"), OUTPUT_DECIMALS.amount))).toBe("0.12345678");
    expect(toPlain(roundDp(dec("-2.5"), 0))).toBe("-2");
    expect(toPlain(roundDp(dec("918.31"), 1, "up"))).toBe("918.4");
    expect(toPlain(roundDp(dec("58.89"), 1, "down"))).toBe("58.8");
    expect(toPlain(roundDp(dec("-0.0000000001"), 8))).toBe("0");
  });

  it("refuses non-finite and malformed input instead of propagating NaN", () => {
    expect(() => dec(Number.NaN)).toThrow(RangeError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => dec("12abc")).toThrow(RangeError);
    expect(decOrNull(Number.NaN)).toBeNull();
    expect(decOrNull(null)).toBeNull();
  });

  it("handles extreme magnitudes without exponent notation or precision loss", () => {
    const huge = dec("123456789012345678").mul(dec("98765.4321"));
    expect(toPlain(huge)).toBe("12193263112482853122237.4638");
    expect(toPlain(dec("0.000000000001").mul(dec("3")))).toBe("0.000000000003");
  });
});

describe("constant-rate isolated liquidation formula", () => {
  it("long: P = (q·E − C) / (q·(1 − m))", () => {
    const p = constantRateIsolatedLiquidationPrice({ side: "buy", size: dec(2), entryPrice: dec(1000), collateral: dec(200), maintenanceMarginRate: dec("0.02") });
    expect(toPlain(p!)).toBe("918.3673469387755102040816326530612244898");
  });

  it("short: P = (q·E + C) / (q·(1 + m))", () => {
    const p = constantRateIsolatedLiquidationPrice({ side: "sell", size: dec(3), entryPrice: dec(50), collateral: dec(30), maintenanceMarginRate: dec("0.02") });
    expect(toPlain(roundDp(p!, 12))).toBe("58.823529411765");
  });

  it("at the liquidation price, equity equals maintenance margin", () => {
    const [q, e, c, m] = [dec("0.37"), dec("61234.5"), dec("2265.68"), dec("0.0125")];
    const p = constantRateIsolatedLiquidationPrice({ side: "buy", size: q, entryPrice: e, collateral: c, maintenanceMarginRate: m })!;
    const equity = c.add(q.mul(p.sub(e)));
    expect(equity.sub(m.mul(q).mul(p)).abs().lt(dec("1e-30"))).toBe(true);
  });

  it("returns null when a 1x long cannot be liquidated by price, and rejects invalid input", () => {
    expect(constantRateIsolatedLiquidationPrice({ side: "buy", size: dec(1), entryPrice: dec(100), collateral: dec(100), maintenanceMarginRate: dec("0.02") })).toBeNull();
    expect(() => constantRateIsolatedLiquidationPrice({ side: "buy", size: dec(0), entryPrice: dec(100), collateral: dec(1), maintenanceMarginRate: dec("0.02") })).toThrow(RangeError);
    expect(() => constantRateIsolatedLiquidationPrice({ side: "buy", size: dec(1), entryPrice: dec(100), collateral: dec(1), maintenanceMarginRate: dec(1) })).toThrow(RangeError);
    expect(() => constantRateIsolatedLiquidationPrice({ side: "sell", size: dec(1), entryPrice: dec(100), collateral: dec(-1), maintenanceMarginRate: dec("0.02") })).toThrow(RangeError);
  });
});
