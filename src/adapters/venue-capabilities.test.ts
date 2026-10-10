import { describe, expect, it, vi } from "vitest";
import { CAPABILITY_IDS, type CapabilityId, type Market } from "@/core/domain";
import { describeExecution, EXECUTION_MODES, MODE_CAPABILITY, validateVenuePrivacy } from "@/core/privacy";
import { createCapabilityRegistry } from "@/features/terminal/create-sources";
import { HYPERLIQUID_ORDER_MODEL, hyperliquidCapabilities } from "./hyperliquid/capabilities";
import { HyperliquidAdapter } from "./hyperliquid/hyperliquid-adapter";
import { simulationCapabilities } from "./simulation/capabilities";

const btc: Market = {
  id: "BTC-PERP",
  base: "BTC",
  quote: "USDC",
  sizeDecimals: 5,
  priceDecimals: 1,
  maxLeverage: 40,
  isolatedOnly: false,
  maintenanceMarginRate: 1 / 80,
};

describe("capability detection", () => {
  const registry = createCapabilityRegistry();
  const status = (venue: string, cap: CapabilityId) => registry.check(venue, cap);

  it("registers both venues with an explicit status for every capability", () => {
    for (const venue of ["simulation", "hyperliquid"]) {
      expect(registry.list(venue).map((c) => c.id)).toEqual([...CAPABILITY_IDS]);
    }
  });

  it("simulator supports exactly what it implements", () => {
    for (const cap of ["order.limit", "order.market", "order.stop-market", "order.take-profit-market", "action.submit", "action.cancel", "stream.fills"] as const) {
      expect(registry.supports("simulation", cap), cap).toBe(true);
    }
    expect(status("simulation", "order.stop-limit")).toMatchObject({ status: "unsupported", scope: "nova" });
    expect(status("simulation", "margin.cross")).toMatchObject({ status: "unsupported", scope: "nova" });
  });

  it("Hyperliquid offers no hidden, iceberg or RFQ execution; nobody offers batch auctions or encrypted orders", () => {
    for (const cap of ["order.hidden", "order.iceberg", "execution.rfq", "execution.batch-auction"] as const) {
      expect(status("hyperliquid", cap), cap).toMatchObject({ status: "unsupported", scope: "venue" });
    }
    for (const venue of ["simulation", "hyperliquid"]) {
      expect(status(venue, "execution.batch-auction")).toMatchObject({ status: "unsupported", scope: "venue" });
      expect(status(venue, "execution.encrypted")).toMatchObject({ status: "unsupported", scope: "nova", reason: expect.stringMatching(/^Planned/) });
    }
  });

  it("the simulator implements hidden, iceberg and RFQ execution", () => {
    for (const cap of ["order.hidden", "order.iceberg", "execution.rfq"] as const) {
      expect(registry.supports("simulation", cap), cap).toBe(true);
    }
  });

  it("Hyperliquid exposes only read capabilities; every trading action is unsupported in Nova", () => {
    const supportedCaps = CAPABILITY_IDS.filter((id) => registry.supports("hyperliquid", id));
    expect(supportedCaps).toEqual(["read.open-orders", "read.positions", "read.account"]);
    for (const cap of ["order.limit", "order.market", "order.stop-market", "action.submit", "action.cancel", "action.cancel-all"] as const) {
      expect(status("hyperliquid", cap), cap).toMatchObject({ status: "unsupported", scope: "nova" });
      expect((status("hyperliquid", cap) as { reason: string }).reason).toMatch(/security-reviewed milestone/);
    }
  });

  it("Hyperliquid's validation model matches the official SDK order types", () => {
    expect(HYPERLIQUID_ORDER_MODEL["order.limit"].status).toBe("supported");
    expect(HYPERLIQUID_ORDER_MODEL["tif.post-only"]).toMatchObject({ status: "supported", note: expect.stringContaining("Alo") });
    expect(HYPERLIQUID_ORDER_MODEL["order.stop-limit"].status).toBe("supported");
    expect(HYPERLIQUID_ORDER_MODEL["order.hidden"]).toMatchObject({ status: "unsupported", scope: "venue" });
  });

  it("both venues' privacy declarations are consistent with their capabilities", () => {
    expect(validateVenuePrivacy(hyperliquidCapabilities.capabilities, hyperliquidCapabilities.privacy)).toEqual([]);
    expect(validateVenuePrivacy(simulationCapabilities.capabilities, simulationCapabilities.privacy)).toEqual([]);
  });

  it("disclosures match each venue's actual capabilities for every mode", () => {
    for (const venue of [hyperliquidCapabilities, simulationCapabilities]) {
      for (const mode of EXECUTION_MODES) {
        const disclosure = describeExecution(venue.capabilities, venue.privacy, mode);
        const supportedCap = venue.capabilities[MODE_CAPABILITY[mode]].status === "supported";
        expect(disclosure.executable, `${venue.venueId} ${mode}`).toBe(supportedCap);
        if (disclosure.level === "unavailable") expect(disclosure.rows).toEqual([]);
      }
    }
  });

  it("Hyperliquid: public orders are disclosed as public and attributable; private modes are unavailable", () => {
    const pub = describeExecution(hyperliquidCapabilities.capabilities, hyperliquidCapabilities.privacy, "public-limit");
    expect(pub.level).toBe("public");
    expect(pub.profile?.["public-observers"]["account-identity"].exposure).toBe("visible");
    for (const mode of ["hidden", "iceberg", "rfq", "encrypted"] as const) {
      expect(describeExecution(hyperliquidCapabilities.capabilities, hyperliquidCapabilities.privacy, mode).level).toBe("unavailable");
    }
  });

  it("simulator: hidden is pre-trade private, iceberg partially displayed, RFQ private to selected counterparties", () => {
    const d = (mode: (typeof EXECUTION_MODES)[number]) => describeExecution(simulationCapabilities.capabilities, simulationCapabilities.privacy, mode);
    expect(d("hidden").level).toBe("pre-trade-private");
    expect(d("iceberg").level).toBe("partially-displayed");
    expect(d("rfq").level).toBe("pre-trade-private");
    expect(d("encrypted")).toMatchObject({ level: "unavailable", executable: false });
  });
});

describe("HyperliquidAdapter (read-only)", () => {
  const client = { getVenueAccount: vi.fn() };
  const adapter = new HyperliquidAdapter(client);
  const instrument = adapter.describeInstrument(btc);
  const limit = { clientOrderId: "c1", marketId: "BTC-PERP", side: "buy", type: "limit", price: 61234, timeInForce: "gtc", size: 0.001, reduceOnly: false, leverage: 5, marginMode: "cross" };

  it("applies the SDK price rules: ≤ 5 significant figures, ≤ 6 − szDecimals decimals, integers exempt", () => {
    expect(instrument).toMatchObject({ priceSignificantFigures: 5, integerPricesExempt: true, venueId: "hyperliquid" });
    expect(adapter.validateOrder(limit, instrument).ok).toBe(true);
    expect(adapter.validateOrder({ ...limit, price: 61234.5 }, instrument)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(adapter.validateOrder({ ...limit, price: 123456 }, instrument).ok).toBe(true);
  });

  it("rejects order types the venue does not offer, explicitly", () => {
    expect(adapter.validateOrder({ ...limit, type: "iceberg", displaySize: 0.0005 }, instrument)).toMatchObject({
      ok: false,
      error: { code: "unsupported", capability: "order.iceberg", scope: "venue" },
    });
  });

  it("never submits or cancels: explicit unsupported results, no network call", async () => {
    const valid = adapter.validateOrder(limit, instrument);
    if (!valid.ok) throw new Error("expected valid");
    expect(await adapter.submitOrder(valid.value, instrument)).toMatchObject({ ok: false, error: { code: "unsupported", capability: "action.submit", scope: "nova" } });
    expect(await adapter.cancelOrder({ orderId: "1" })).toMatchObject({ ok: false, error: { capability: "action.cancel" } });
    expect(await adapter.cancelAllOrders()).toMatchObject({ ok: false, error: { capability: "action.cancel-all" } });
    expect(adapter.subscribeFills({ kind: "address", address: "0x" + "1".repeat(40) }, () => {})).toMatchObject({ ok: false, error: { capability: "stream.fills" } });
    expect(adapter.subscribeOrderUpdates({ kind: "address", address: "0x" + "1".repeat(40) }, () => {})).toMatchObject({ ok: false, error: { capability: "stream.order-updates" } });
    expect(client.getVenueAccount).not.toHaveBeenCalled();
  });

  it("requires a valid public address for account reads", async () => {
    expect(await adapter.fetchOpenOrders({ kind: "simulated" })).toMatchObject({ ok: false, error: { code: "account-required" } });
    expect(await adapter.fetchPositions({ kind: "address", address: "0x123" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(client.getVenueAccount).not.toHaveBeenCalled();
  });
});
