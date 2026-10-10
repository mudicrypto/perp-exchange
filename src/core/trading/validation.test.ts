import { describe, expect, it } from "vitest";
import {
  CAPABILITY_IDS,
  defineCapabilities,
  instrumentFromMarket,
  notImplemented,
  supported,
  venueUnsupported,
  type CapabilityId,
  type CapabilityStatus,
  type Market,
} from "../domain";
import { CapabilityRegistry, checkRequestCapabilities, requiredCapabilities, type VenueCapabilities } from "./capability-registry";
import { fitsSignificantFigures, validateOrderRequest } from "./validation";

const market: Market = {
  id: "BTC-PERP",
  base: "BTC",
  quote: "USDC",
  sizeDecimals: 3,
  priceDecimals: 3,
  maxLeverage: 20,
  isolatedOnly: true,
  maintenanceMarginRate: 0.025,
};
const instrument = instrumentFromMarket(market, { venueId: "test", priceSignificantFigures: 5, integerPricesExempt: true, minOrderValue: 10 });

function caps(overrides: Partial<Record<CapabilityId, CapabilityStatus>> = {}) {
  const all = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, supported()])) as Record<CapabilityId, CapabilityStatus>;
  return defineCapabilities({ ...all, ...overrides });
}

const limit = { clientOrderId: "c1", marketId: "BTC-PERP", side: "buy", type: "limit", price: 100.5, timeInForce: "gtc", size: 0.5, reduceOnly: false, leverage: 5, marginMode: "isolated" };

describe("validateOrderRequest", () => {
  it("accepts a valid request", () => {
    expect(validateOrderRequest(limit, instrument, caps())).toMatchObject({ ok: true, value: { type: "limit", price: 100.5 } });
  });

  it("enforces significant figures, but exempts integer prices", () => {
    expect(fitsSignificantFigures(1234.5, 5)).toBe(true);
    expect(fitsSignificantFigures(1234.56, 5)).toBe(false);
    const tooPrecise = validateOrderRequest({ ...limit, price: 1234.56 }, instrument, caps());
    expect(tooPrecise).toMatchObject({ ok: false, error: { code: "validation" } });
    if (!tooPrecise.ok && tooPrecise.error.code === "validation") {
      expect(tooPrecise.error.issues.map((i) => i.message)).toContain("Price allows at most 5 significant figures");
    }
    expect(validateOrderRequest({ ...limit, price: 123456, size: 0.001 }, instrument, caps()).ok).toBe(true);
  });

  it("checks decimals, leverage, margin mode and trigger prices, reporting all issues together", () => {
    const result = validateOrderRequest(
      { ...limit, type: "stop-limit", triggerPrice: 99.12345, price: 100.0001, size: 0.0001, leverage: 50, marginMode: "cross" },
      instrument,
      caps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "validation") {
      expect(new Set(result.error.issues.map((i) => i.field))).toEqual(new Set(["size", "price", "triggerPrice", "leverage", "marginMode"]));
    }
  });

  it("enforces a minimum order value using the limit price or a reference price", () => {
    expect(validateOrderRequest({ ...limit, size: 0.05 }, instrument, caps())).toMatchObject({ ok: false, error: { code: "validation" } });
    const market = { clientOrderId: "c2", marketId: "BTC-PERP", side: "sell", type: "market", maxSlippage: 0.05, size: 0.05, reduceOnly: false, leverage: 5, marginMode: "isolated" };
    expect(validateOrderRequest(market, instrument, caps(), { referencePrice: 100 })).toMatchObject({ ok: false });
    expect(validateOrderRequest(market, instrument, caps(), { referencePrice: 1000 }).ok).toBe(true);
  });

  it("rejects malformed requests", () => {
    for (const bad of [{ ...limit, size: 0 }, { ...limit, size: Number.NaN }, { ...limit, price: undefined }, { ...limit, clientOrderId: "" }, { ...limit, side: "up" }]) {
      expect(validateOrderRequest(bad, instrument, caps())).toMatchObject({ ok: false, error: { code: "validation" } });
    }
    const iceberg = { ...limit, type: "iceberg", displaySize: 0.5 };
    expect(validateOrderRequest(iceberg, instrument, caps())).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("returns an explicit unsupported error for unsupported order types — before any other check", () => {
    const map = caps({ "order.hidden": venueUnsupported("No hidden orders here") });
    expect(validateOrderRequest({ ...limit, type: "hidden", size: -1 }, instrument, map)).toEqual({
      ok: false,
      error: { code: "unsupported", capability: "order.hidden", scope: "venue", message: "No hidden orders here" },
    });
  });

  it("returns unsupported for unsupported flags and time-in-force", () => {
    expect(validateOrderRequest({ ...limit, timeInForce: "post-only" }, instrument, caps({ "tif.post-only": notImplemented("nope") }))).toMatchObject({
      ok: false,
      error: { code: "unsupported", capability: "tif.post-only", scope: "nova" },
    });
    expect(validateOrderRequest({ ...limit, reduceOnly: true }, instrument, caps({ "order.reduce-only": notImplemented("nope") }))).toMatchObject({
      ok: false,
      error: { code: "unsupported", capability: "order.reduce-only" },
    });
  });

  it("rejects orders on delisted or reduce-only instruments appropriately", () => {
    const delisted = { ...instrument, status: "delisted" as const };
    expect(validateOrderRequest(limit, delisted, caps()).ok).toBe(false);
    const reduceOnly = { ...instrument, status: "reduce-only" as const };
    expect(validateOrderRequest(limit, reduceOnly, caps()).ok).toBe(false);
    expect(validateOrderRequest({ ...limit, reduceOnly: true }, reduceOnly, caps()).ok).toBe(true);
  });
});

describe("capability registry", () => {
  const venue = (id: string, overrides: Partial<Record<CapabilityId, CapabilityStatus>>): VenueCapabilities => ({
    venueId: id,
    venueName: id,
    origin: "venue",
    capabilities: caps(overrides),
    visibility: { venueId: id, venueName: id, restingOrderVisibility: "public-book", fillVisibility: "public-tape", publicAccountAttribution: false, supportedPrivateModes: [], notes: [] },
  });

  it("answers supports/check per venue, and unknown venues are unsupported", () => {
    const registry = new CapabilityRegistry();
    registry.register(venue("a", { "order.iceberg": venueUnsupported("no") }));
    expect(registry.supports("a", "order.limit")).toBe(true);
    expect(registry.supports("a", "order.iceberg")).toBe(false);
    expect(registry.check("a", "order.iceberg")).toEqual({ status: "unsupported", scope: "venue", reason: "no" });
    expect(registry.check("missing", "order.limit")).toMatchObject({ status: "unsupported", scope: "nova" });
    expect(registry.list("a")).toHaveLength(CAPABILITY_IDS.length);
  });

  it("refuses a venue that does not declare every capability", () => {
    const partial = venue("b", {});
    const incomplete = { ...partial, capabilities: { ...partial.capabilities, "order.hidden": undefined } } as unknown as VenueCapabilities;
    expect(() => new CapabilityRegistry().register(incomplete)).toThrow(/order.hidden/);
  });

  it("derives the capabilities a request needs", () => {
    const req = { clientOrderId: "c", marketId: "BTC-PERP", side: "buy", type: "stop-limit", triggerPrice: 90, price: 89, timeInForce: "post-only", size: 1, reduceOnly: true, leverage: 2, marginMode: "cross" } as const;
    expect(requiredCapabilities(req)).toEqual(["order.stop-limit", "margin.cross", "tif.post-only", "order.reduce-only"]);
    expect(checkRequestCapabilities(req, caps({ "margin.cross": notImplemented("isolated only") }))).toMatchObject({ code: "unsupported", capability: "margin.cross" });
  });
});
