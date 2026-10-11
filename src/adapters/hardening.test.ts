import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RISK_LIMITS } from "@/core/risk";
import { RiskGuardedExecutionAdapter } from "@/core/trading";
import { createTerminalServices } from "@/features/terminal/create-sources";
import { HyperliquidAdapter } from "./hyperliquid/hyperliquid-adapter";
import { SimulationAdapter } from "./simulation/simulation-adapter";
import { SimulatedMarketDataSource } from "./simulation/simulated-market-data-source";

/**
 * Milestone 7 robustness checks across the execution stack: idempotency,
 * cancellation of partial fills and pending orders, numeric edge cases,
 * and simulation/live separation.
 */

const NOW = 1_700_000_000_000;

function setup(options: ConstructorParameters<typeof SimulationAdapter>[1] = {}) {
  const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
  const sim = new SimulationAdapter(source, { now: () => NOW, ...options });
  sim.subscribeAccount(() => {});
  vi.advanceTimersByTime(100);
  const alpha = [...source.markets.values()].find((m) => m.id === "ALPHA-PERP")!.market;
  const guard = new RiskGuardedExecutionAdapter(sim, (id) => sim.riskSnapshot(id), () => DEFAULT_RISK_LIMITS);
  const book = sim.riskSnapshot("ALPHA-PERP").book!.value;
  return { sim, guard, instrument: sim.describeInstrument(alpha), book };
}

async function accountState(sim: SimulationAdapter) {
  const r = await sim.fetchAccountState({ kind: "simulated" });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

let n = 0;
const limit = (price: number, o: Record<string, unknown> = {}) => ({
  clientOrderId: `h-${++n}`,
  marketId: "ALPHA-PERP",
  side: "buy",
  type: "limit",
  price,
  timeInForce: "gtc",
  size: 0.5,
  reduceOnly: false,
  // The demo account holds ALPHA at 10x; the simulator requires matching leverage.
  leverage: 10,
  marginMode: "isolated",
  ...o,
});

describe("order idempotency and duplicate submissions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("two concurrent submissions with the same client order id create exactly one order", async () => {
    const { guard, sim, instrument, book } = setup({ ackLatencyMs: 50 });
    const req = limit(Number((book.bids[0]!.price * 0.999).toFixed(1)), { clientOrderId: "dup-1" });
    const before = (await sim.fetchAccountState({ kind: "simulated" })).ok ? (await sim.fetchOpenOrders({ kind: "simulated" })) : null;
    const first = guard.submitOrder(req as never, instrument);
    const second = guard.submitOrder(req as never, instrument);
    vi.advanceTimersByTime(60);
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "duplicate-client-order-id" } });
    const open = await sim.fetchOpenOrders({ kind: "simulated" });
    expect(open.ok && before?.ok && open.value.length - before.value.length).toBe(1);
  });
});

describe("cancellation and partial fills", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cancelling a partially filled order keeps the filled part and releases only the remainder's margin", async () => {
    const { sim, instrument, book } = setup({ config: { liquidityFraction: 0.25 } });
    const ask = book.asks[0]!;
    const placed = await sim.submitOrder(limit(ask.price, { size: Math.min(ask.size, 1), clientOrderId: "pf-1" }) as never, instrument);
    if (!placed.ok) throw new Error(placed.error.message);
    expect(placed.value.status).toBe("partially-filled");
    const filled = placed.value.filledSize;
    const marginBefore = await accountState(sim);
    const cancelled = await sim.cancelOrder({ orderId: placed.value.id });
    expect(cancelled).toMatchObject({ ok: true, value: { status: "cancelled", filledSize: filled } });
    const after = await accountState(sim);
    expect(after.snapshot.orderMargin!).toBeLessThan(marginBefore.snapshot.orderMargin!);
    expect((after.fills ?? []).filter((f) => f.orderId === placed.value.id).length).toBeGreaterThan(0);
    // A second cancel is refused, not double-applied.
    expect(await sim.cancelOrder({ orderId: placed.value.id })).toMatchObject({ ok: false, error: { code: "order-not-cancellable" } });
  });

  it("an order cancelled while pending acknowledgement is never matched", async () => {
    const { sim, instrument, book } = setup({ ackLatencyMs: 50 });
    const pending = sim.submitOrder(limit(book.asks[0]!.price, { clientOrderId: "pend-1" }) as never, instrument);
    await Promise.resolve();
    expect(await sim.cancelOrder({ clientOrderId: "pend-1" })).toMatchObject({ ok: true, value: { status: "cancelled", filledSize: 0 } });
    vi.advanceTimersByTime(60);
    expect(await pending).toMatchObject({ ok: true, value: { status: "cancelled", filledSize: 0 } });
  });
});

describe("incorrect or missing numerical inputs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["NaN size", { size: Number.NaN }],
    ["infinite size", { size: Number.POSITIVE_INFINITY }],
    ["negative size", { size: -1 }],
    ["zero price", { price: 0 }],
    ["string price", { price: "1000" }],
    ["missing price", { price: undefined }],
    ["absurd leverage", { leverage: Number.MAX_VALUE }],
    ["size below the step", { size: 0.0001 }],
    ["too many price decimals", { price: 1000.123 }],
    ["missing side", { side: undefined }],
    ["unknown market", { marketId: "NOPE-PERP" }],
  ])("refuses %s before anything reaches the venue", async (_label, patch) => {
    const { guard, sim, instrument } = setup();
    const submit = vi.spyOn(sim, "submitOrder");
    const result = await guard.submitOrder(limit(1000, patch) as never, instrument);
    expect(result.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("simulation / live separation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("live configuration has no paper venue, no RFQ desk, no demo controls, and refuses submissions", async () => {
    const live = createTerminalServices({ marketDataSource: "hyperliquid", hyperliquidNetwork: "mainnet", executionMode: "disabled", riskLimits: DEFAULT_RISK_LIMITS });
    expect(live.execution.origin).toBe("venue");
    expect(live.capabilities.venueId).toBe("hyperliquid");
    expect(live.privateVenue).toBeNull();
    expect(live.demo).toBeNull();
    expect(live.marketData.descriptor.kind).toBe("live");
    const inner = vi.spyOn(HyperliquidAdapter.prototype, "submitOrder");
    const instrument = live.execution.describeInstrument({ id: "BTC-PERP", base: "BTC", quote: "USDC", sizeDecimals: 5, priceDecimals: 1, maxLeverage: 40, isolatedOnly: false, maintenanceMarginRate: 0.0125 });
    const r = await live.execution.submitOrder(limit(60000, { marketId: "BTC-PERP", size: 0.001, leverage: 5 }) as never, instrument);
    expect(r.ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
    live.marketData.dispose();
  });

  it("simulated configuration is labelled simulated end to end", () => {
    const sim = createTerminalServices({ marketDataSource: "simulation", hyperliquidNetwork: "mainnet", executionMode: "paper", riskLimits: DEFAULT_RISK_LIMITS });
    expect(sim.execution.origin).toBe("simulated");
    expect(sim.capabilities.origin).toBe("simulated");
    expect(sim.marketData.descriptor.kind).toBe("simulation");
    sim.marketData.dispose();
    sim.account.dispose();
  });
});
