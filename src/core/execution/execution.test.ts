import { describe, expect, it } from "vitest";
import type { Market, OrderIntent } from "../domain";
import { DisabledExecutionAdapter } from "./disabled-adapter";
import { validateOrderIntent } from "./order-intent";

const market: Market = {
  id: "BTC-PERP",
  base: "BTC",
  quote: "USDC",
  sizeDecimals: 3,
  priceDecimals: 1,
  maxLeverage: 20,
  isolatedOnly: true,
  maintenanceMarginRate: 0.025,
};

const base: OrderIntent = {
  marketId: "BTC-PERP",
  side: "buy",
  type: "limit",
  size: 0.5,
  limitPrice: 100.5,
  timeInForce: "gtc",
  reduceOnly: false,
  leverage: 5,
  marginMode: "isolated",
};

describe("validateOrderIntent", () => {
  it("accepts a valid intent", () => {
    expect(validateOrderIntent(base, market)).toEqual({ ok: true, intent: base });
  });

  it("requires a limit price for limit orders", () => {
    const result = validateOrderIntent({ ...base, limitPrice: null }, market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.field).toBe("limitPrice");
  });

  it("rejects non-positive and NaN sizes", () => {
    expect(validateOrderIntent({ ...base, size: 0 }, market).ok).toBe(false);
    expect(validateOrderIntent({ ...base, size: Number.NaN }, market).ok).toBe(false);
    expect(validateOrderIntent({ ...base, size: -1 }, market).ok).toBe(false);
  });

  it("enforces market precision, leverage and margin mode", () => {
    const result = validateOrderIntent(
      { ...base, size: 0.0001, limitPrice: 100.55, leverage: 25, marginMode: "cross" },
      market,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.field).sort()).toEqual(["leverage", "limitPrice", "marginMode", "size"]);
    }
  });

  it("handles exponent-formatted small numbers when counting decimals", () => {
    expect(validateOrderIntent({ ...base, size: 1e-7 }, market).ok).toBe(false);
  });

  it("reports schema and market-precision problems together", () => {
    const result = validateOrderIntent({ ...base, limitPrice: null, size: 0.00001 }, market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.field).sort()).toEqual(["limitPrice", "size"]);
  });

  it("rejects post-only market orders", () => {
    expect(validateOrderIntent({ ...base, type: "market", limitPrice: null, timeInForce: "post-only" }, market).ok).toBe(false);
  });
});

describe("DisabledExecutionAdapter", () => {
  it("rejects every submission and cancel", async () => {
    const adapter = new DisabledExecutionAdapter("hyperliquid");
    expect(adapter.mode).toBe("disabled");
    await expect(adapter.submit()).resolves.toMatchObject({ ok: false, code: "execution-disabled" });
    await expect(adapter.cancel()).resolves.toMatchObject({ ok: false, code: "execution-disabled" });
  });
});
