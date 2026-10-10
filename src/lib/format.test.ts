import { describe, expect, it } from "vitest";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice, formatRelativeTime } from "./format";

describe("format", () => {
  it("formats prices with grouping and fixed decimals", () => {
    expect(formatPrice(61234.5, 1)).toBe("61,234.5");
    expect(formatPrice(null, 2)).toBe("—");
  });

  it("keeps ~5 significant digits for display", () => {
    expect(displayPriceDecimals(61234.5, 6)).toBe(0);
    expect(displayPriceDecimals(42.512, 6)).toBe(3);
    expect(displayPriceDecimals(0.80123, 6)).toBe(5);
    expect(displayPriceDecimals(0.80123, 2)).toBe(2);
  });

  it("formats signed amounts and never shows negative zero", () => {
    expect(formatAmount(1234.567, { signed: true })).toBe("+1,234.57");
    expect(formatAmount(-0.001)).toBe("0.00");
    expect(formatAmount(-12.5)).toBe("-12.50");
    expect(formatAmount(Number.NaN)).toBe("—");
  });

  it("formats percentages and relative times", () => {
    expect(formatPercent(0.01234, 2, true)).toBe("+1.23%");
    expect(formatRelativeTime(0, 90_000)).toBe("2m ago");
  });
});
