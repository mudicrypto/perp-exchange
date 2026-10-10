import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderBookSnapshot, Trade } from "@/core/domain";
import { describeExecution } from "@/core/privacy";
import { RFQ_COUNTERPARTY_FIELDS, RFQ_RETENTION_MS, RfqCreateSchema } from "@/core/rfq";
import { PrivateExecutionService, type VenueCapabilities } from "@/core/trading";
import { hyperliquidCapabilities } from "./hyperliquid/capabilities";
import { HyperliquidAdapter } from "./hyperliquid/hyperliquid-adapter";
import { simulationCapabilities } from "./simulation/capabilities";
import { SimulationAdapter } from "./simulation/simulation-adapter";
import { SimulatedMarketDataSource } from "./simulation/simulated-market-data-source";

const NOW = 1_700_000_000_000;
let cid = 0;

const order = (type: "hidden" | "iceberg" | "limit", price: number, extra: Record<string, unknown> = {}) => ({
  clientOrderId: `p${++cid}`,
  marketId: "ALPHA-PERP",
  side: "buy",
  type,
  price,
  size: 2,
  timeInForce: "gtc",
  reduceOnly: false,
  // The demo account holds an ALPHA position at 10x; the simulator requires matching leverage.
  leverage: 10,
  marginMode: "isolated",
  ...extra,
});

const ack = (venue: VenueCapabilities, mode: "hidden" | "iceberg") => ({
  mode,
  venueId: venue.venueId,
  level: describeExecution(venue.capabilities, venue.privacy, mode).level,
});

describe("simulated venue: disclosures are true of the public data", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const adapter = new SimulationAdapter(source, { now: () => NOW });
    adapter.subscribeAccount(() => {});
    const books: OrderBookSnapshot[] = [];
    const tape: Trade[] = [];
    source.subscribeOrderBook("ALPHA-PERP", { onData: (b) => books.push(b) });
    source.subscribeTrades("ALPHA-PERP", { onData: (t) => tape.push(...t) });
    vi.advanceTimersByTime(100);
    const alpha = adapter.describeInstrument([...source.markets.values()].find((m) => m.id === "ALPHA-PERP")!.market);
    const service = new PrivateExecutionService(adapter);
    const bestBid = books.at(-1)!.bids[0]!.price;
    const levelAt = (price: number) => books.at(-1)!.bids.find((l) => l.price === price);
    return { source, adapter, books, tape, alpha, service, bestBid, levelAt };
  }

  it("a resting hidden order never appears in the public book; a public limit order does", async () => {
    const { service, adapter, alpha, bestBid, levelAt } = setup();
    // Far below the market so neither order fills; distinct prices off the synthetic grid.
    const hiddenPrice = Number((bestBid * 0.9).toFixed(1));
    const limitPrice = Number((bestBid * 0.89).toFixed(1));
    const hidden = await service.submit("hidden", order("hidden", hiddenPrice), alpha, ack(simulationCapabilities, "hidden"));
    expect(hidden).toMatchObject({ ok: true, value: { status: "open", type: "hidden" } });
    await adapter.submitOrder(order("limit", limitPrice) as never, alpha);
    vi.advanceTimersByTime(100);
    expect(levelAt(hiddenPrice)).toBeUndefined();
    expect(levelAt(limitPrice)).toMatchObject({ size: 2 });
  });

  it("an iceberg shows only its displayed quantity in the public book", async () => {
    const { service, alpha, bestBid, levelAt } = setup();
    const price = Number((bestBid * 0.9).toFixed(1));
    const result = await service.submit("iceberg", order("iceberg", price, { displaySize: 0.25 }), alpha, ack(simulationCapabilities, "iceberg"));
    expect(result.ok).toBe(true);
    vi.advanceTimersByTime(100);
    expect(levelAt(price)).toMatchObject({ size: 0.25, orders: 1 });
  });

  it("the matching engine does not see the account's own orders as counterparty liquidity", async () => {
    const { source, adapter, alpha, bestBid } = setup();
    const venueBooks: OrderBookSnapshot[] = [];
    source.subscribeVenueBook("ALPHA-PERP", { onData: (b) => venueBooks.push(b) });
    const price = Number((bestBid * 0.9).toFixed(1));
    await adapter.submitOrder(order("limit", price) as never, alpha);
    vi.advanceTimersByTime(100);
    expect(venueBooks.at(-1)!.bids.some((l) => l.price === price)).toBe(false);
  });

  it("fills print on the public tape without account or order identifiers", async () => {
    const { adapter, alpha, tape, books } = setup();
    const ask = books.at(-1)!.asks[0]!.price;
    const filled = await adapter.submitOrder({ ...order("limit", ask, { size: 0.01, timeInForce: "ioc" }) } as never, alpha);
    expect(filled).toMatchObject({ ok: true, value: { status: "filled" } });
    const print = tape.find((t) => t.id.startsWith("sim-print-"));
    expect(print).toEqual({ marketId: "ALPHA-PERP", id: expect.any(String), side: "buy", price: ask, size: 0.01, venueTime: NOW });
    if (!filled.ok) return;
    expect(JSON.stringify(print)).not.toContain(filled.value.id);
    expect(JSON.stringify(print)).not.toContain(filled.value.clientOrderId);
  });
});

describe("PrivateExecutionService", () => {
  const hlClient = { getVenueAccount: vi.fn() };

  it("never sends a hidden or iceberg order to a venue that publishes orders", async () => {
    const adapter = new HyperliquidAdapter(hlClient);
    const submit = vi.spyOn(adapter, "submitOrder");
    const validate = vi.spyOn(adapter, "validateOrder");
    const service = new PrivateExecutionService(adapter);
    const instrument = adapter.describeInstrument({ id: "BTC-PERP", base: "BTC", quote: "USDC", sizeDecimals: 5, priceDecimals: 1, maxLeverage: 40, isolatedOnly: false, maintenanceMarginRate: 0.0125 });
    // Even a forged acknowledgement claiming privacy is refused before the adapter is touched.
    const forged = { mode: "hidden" as const, venueId: "hyperliquid", level: "pre-trade-private" as const };
    for (const mode of ["hidden", "iceberg"] as const) {
      const result = await service.submit(mode, { ...order(mode, 60000, { displaySize: 0.1 }), marketId: "BTC-PERP" }, instrument, { ...forged, mode });
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported", capability: mode === "hidden" ? "order.hidden" : "order.iceberg", scope: "venue" } });
    }
    expect(submit).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(hlClient.getVenueAccount).not.toHaveBeenCalled();
  });

  it("refuses RFQ and encrypted submissions as orders on every venue", async () => {
    vi.useFakeTimers();
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const sim = new SimulationAdapter(source, { now: () => NOW });
    const submit = vi.spyOn(sim, "submitOrder");
    const service = new PrivateExecutionService(sim);
    const alpha = sim.describeInstrument([...source.markets.values()][0]!.market);
    expect(await service.submit("encrypted", order("limit", 900), alpha, null)).toMatchObject({
      ok: false,
      error: { code: "unsupported", capability: "execution.encrypted", scope: "nova", message: expect.stringMatching(/^Planned/) },
    });
    expect(await service.submit("rfq", order("limit", 900), alpha, null)).toMatchObject({ ok: false, error: { code: "unsupported", capability: "execution.rfq" } });
    expect(await new PrivateExecutionService(new HyperliquidAdapter(hlClient)).submit("rfq", {}, alpha, null)).toMatchObject({
      ok: false,
      error: { capability: "execution.rfq", scope: "venue" },
    });
    expect(submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("requires a confirmation matching the venue's actual disclosure, and a matching order type", async () => {
    vi.useFakeTimers();
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const sim = new SimulationAdapter(source, { now: () => NOW });
    sim.subscribeAccount(() => {});
    vi.advanceTimersByTime(100);
    const submit = vi.spyOn(sim, "submitOrder");
    const service = new PrivateExecutionService(sim);
    const alpha = sim.describeInstrument([...source.markets.values()].find((m) => m.id === "ALPHA-PERP")!.market);
    expect(await service.submit("hidden", order("hidden", 800), alpha, null)).toMatchObject({ ok: false, error: { code: "validation" } });
    const wrongLevel = { mode: "hidden" as const, venueId: "simulation", level: "private" as const };
    expect(await service.submit("hidden", order("hidden", 800), alpha, wrongLevel)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await service.submit("hidden", order("limit", 800), alpha, ack(simulationCapabilities, "hidden"))).toMatchObject({
      ok: false,
      error: { code: "validation", issues: [{ field: "type" }] },
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await service.submit("hidden", order("hidden", 800), alpha, ack(simulationCapabilities, "hidden"))).toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it("refuses private modes on a venue whose privacy declarations are inconsistent", async () => {
    const adapter = new HyperliquidAdapter(hlClient);
    const tampered: VenueCapabilities = {
      ...simulationCapabilities,
      privacy: { ...simulationCapabilities.privacy, profiles: { ...simulationCapabilities.privacy.profiles, hidden: hyperliquidCapabilities.privacy.profiles["public-limit"]! } },
    };
    vi.spyOn(adapter, "getCapabilities").mockReturnValue(tampered);
    const submit = vi.spyOn(adapter, "submitOrder");
    const result = await new PrivateExecutionService(adapter).submit("hidden", order("hidden", 800), {} as never, { mode: "hidden", venueId: "simulation", level: "public" });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported", message: expect.stringMatching(/inconsistent/) } });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("RFQ disclosure matches what the RFQ service sends", () => {
  const rfqProfile = simulationCapabilities.privacy.profiles.rfq!;

  it("counterparties: no identity field exists in their view", () => {
    expect(rfqProfile["rfq-counterparties"]["account-identity"].exposure).toBe("not-visible");
    expect([...RFQ_COUNTERPARTY_FIELDS].sort()).toEqual(["createdAt", "execution", "expiresAt", "marketId", "requestId", "requesterSide", "size", "status", "yourQuote"]);
  });

  it("Nova's server never receives a limit price", () => {
    expect(rfqProfile["nova-backend"]["order-details"]).toMatchObject({ exposure: "partial", note: expect.stringContaining("Never your limit price") });
    expect(Object.keys(RfqCreateSchema.shape).sort()).toEqual(["counterpartyIds", "marketId", "referencePrice", "side", "size"]);
  });

  it("states the same retention the desk enforces", () => {
    expect(RFQ_RETENTION_MS).toBe(5 * 60_000);
    expect(rfqProfile["nova-backend"]["execution-details"].note).toMatch(/5 minutes/);
  });
});
