import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Market, MarketId, OrderRequest } from "@/core/domain";
import { DEFAULT_RISK_LIMITS, OUTPUT_DECIMALS, assessPortfolio, dec, reconstructPosition, roundDp, toPlain, type RiskLimits } from "@/core/risk";
import { RiskGuardedExecutionAdapter } from "@/core/trading";
import { createTerminalServices } from "@/features/terminal/create-sources";
import { hyperliquidMarginRules } from "./hyperliquid/margin-rules";
import { HyperliquidAdapter } from "./hyperliquid/hyperliquid-adapter";
import { simulationMarginRules } from "./simulation/margin-rules";
import { PAPER_FEES, PaperEngine } from "./simulation/paper-engine";
import { SimulationAdapter } from "./simulation/simulation-adapter";
import { SimulatedMarketDataSource } from "./simulation/simulated-market-data-source";
import { SimulationEngine } from "./simulation/simulation-engine";

const NOW = 1_700_000_000_000;
const simMarkets: ReadonlyMap<MarketId, Market> = new Map([...new SimulationEngine().markets.values()].map((m) => [m.id, m.market]));
const alpha = simMarkets.get("ALPHA-PERP")!;
const btc: Market = { id: "BTC-PERP", base: "BTC", quote: "USDC", sizeDecimals: 5, priceDecimals: 1, maxLeverage: 40, isolatedOnly: false, maintenanceMarginRate: 1 / 80 };

describe("simulator margin rules match what the paper engine enforces", () => {
  it("liquidation price equals the engine's own, for longs and shorts", () => {
    const engine = new PaperEngine(simMarkets, { startingBalance: 100_000 });
    engine.setBook("ALPHA-PERP", { bids: [{ price: 999.9, size: 50, orders: 1 }], asks: [{ price: 1000.1, size: 50, orders: 1 }] }, NOW);
    engine.setMark("ALPHA-PERP", 1000, NOW);
    for (const [side, leverage] of [["buy", 10], ["sell", 7]] as const) {
      const fresh = new PaperEngine(simMarkets, { startingBalance: 100_000 });
      fresh.setBook("ALPHA-PERP", { bids: [{ price: 999.9, size: 50, orders: 1 }], asks: [{ price: 1000.1, size: 50, orders: 1 }] }, NOW);
      fresh.setMark("ALPHA-PERP", 1000, NOW);
      fresh.submit({ clientOrderId: `c-${side}`, marketId: "ALPHA-PERP", side, type: "market", maxSlippage: 0.05, size: 3, reduceOnly: false, leverage, marginMode: "isolated" }, NOW);
      const p = fresh.snapshot(NOW).positions[0]!;
      const rule = simulationMarginRules.liquidationPrice({ market: alpha, side, size: dec(Math.abs(p.size)), entryPrice: dec(p.entryPrice), collateral: dec(p.marginUsed), marginMode: "isolated", reportedLiquidationPrice: null });
      expect(rule.ok).toBe(true);
      if (rule.ok) expect(rule.value.toNumber()).toBe(p.liquidationPrice);
    }
  });

  it("fees and initial margin match the engine; funding is not charged", () => {
    expect(simulationMarginRules.feeRates()).toMatchObject({ ok: true, value: { taker: dec(PAPER_FEES.taker), maker: dec(PAPER_FEES.maker) } });
    const im = simulationMarginRules.initialMargin({ market: alpha, notional: dec(3000), leverage: dec(10) });
    expect(im.ok && toPlain(im.value)).toBe("300");
    expect(simulationMarginRules.funding.charged).toBe(false);
    expect(simulationMarginRules.liquidationPrice({ market: alpha, side: "buy", size: dec(1), entryPrice: dec(1000), collateral: dec(1000), marginMode: "isolated", reportedLiquidationPrice: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be liquidated/) });
  });

  it("realised PnL reported on simulated fills matches an independent average-cost reconstruction", () => {
    const engine = new PaperEngine(simMarkets, { startingBalance: 100_000 });
    const book = (bid: number, ask: number) => ({ bids: [{ price: bid, size: 50, orders: 1 }], asks: [{ price: ask, size: 50, orders: 1 }] });
    const trade = (id: string, side: "buy" | "sell", size: number) =>
      engine.submit({ clientOrderId: id, marketId: "ALPHA-PERP", side, type: "market", maxSlippage: 0.05, size, reduceOnly: false, leverage: 10, marginMode: "isolated" }, NOW);
    engine.setBook("ALPHA-PERP", book(999.9, 1000.1), NOW);
    engine.setMark("ALPHA-PERP", 1000, NOW);
    trade("a", "buy", 2);
    engine.setBook("ALPHA-PERP", book(1010.3, 1010.5), NOW);
    trade("b", "buy", 1.5);
    engine.setBook("ALPHA-PERP", book(1020.7, 1020.9), NOW);
    trade("c", "sell", 2.25);
    engine.setBook("ALPHA-PERP", book(995.1, 995.3), NOW);
    trade("d", "sell", 3);
    // Chronological order (the account lists newest first; ids are sequential).
    const fills = [...engine.state(NOW).fills!].sort((a, b) => a.id.localeCompare(b.id));
    const reported = fills.reduce((s, f) => s.add(dec(f.realizedPnl)), dec(0));
    const rebuilt = reconstructPosition(fills);
    // The engine accumulates in floating point; the reconstruction is decimal (exact to 40 digits,
    // so a repeating entry price leaves a residue far below the 8-dp output precision).
    expect(toPlain(roundDp(rebuilt.realizedPnl, OUTPUT_DECIMALS.amount))).toBe("24.5");
    expect(reported.sub(rebuilt.realizedPnl).abs().lt(dec("1e-9"))).toBe(true);
    expect(toPlain(rebuilt.size)).toBe(String(engine.snapshot(NOW).positions[0]!.size));
  });
});

describe("Hyperliquid margin rules never guess", () => {
  it("maintenance margin and liquidation are unavailable unless the venue reports a liquidation price", () => {
    expect(hyperliquidMarginRules.maintenanceMargin({ market: btc, notional: dec(1000) })).toMatchObject({ ok: false, missing: ["Hyperliquid margin tables"] });
    expect(hyperliquidMarginRules.liquidationPrice({ market: btc, side: "buy", size: dec(1), entryPrice: dec(60000), collateral: dec(6000), marginMode: "isolated", reportedLiquidationPrice: null })).toMatchObject({ ok: false });
    expect(hyperliquidMarginRules.liquidationPrice({ market: btc, side: "buy", size: dec(1), entryPrice: dec(60000), collateral: dec(6000), marginMode: "cross", reportedLiquidationPrice: dec("54321.5") })).toMatchObject({ ok: true, kind: "venue-reported" });
    expect(hyperliquidMarginRules.feeRates()).toMatchObject({ ok: false, missing: ["Account fee tier"] });
    expect(hyperliquidMarginRules.funding).toMatchObject({ charged: true, priceBasis: "oracle" });
  });

  it("a Hyperliquid portfolio shows the venue's liquidation price and no Nova-computed maintenance margin", () => {
    const report = assessPortfolio({
      now: NOW,
      venue: hyperliquidMarginRules,
      account: {
        value: { origin: "venue", currency: "USDC", balances: [], balance: null, equity: 10_000, unrealizedPnl: 0, realizedPnl: null, feesPaid: null, marginUsed: 1_500, orderMargin: null, available: 8_500, maintenanceMargin: null, positions: [{ marketId: "BTC-PERP", size: 0.5, entryPrice: 60_000, leverage: 20, marginMode: "cross", marginUsed: 1_500, liquidationPrice: 41_234.5, markPrice: null, unrealizedPnl: 0 }], observedAt: NOW },
        observedAt: NOW,
        source: "Hyperliquid clearinghouseState",
      },
      markets: new Map([[btc.id, btc]]),
      marks: new Map([["BTC-PERP", { value: 61_000, observedAt: NOW, source: "Hyperliquid activeAssetCtx" }]]),
      funding: new Map(),
      fills: null,
    });
    expect(report.positions[0]!.liquidationPrice).toMatchObject({ status: "available", value: "41234.5", kind: "venue-reported" });
    expect(report.margin.maintenanceMargin).toMatchObject({ status: "unavailable", missing: ["Hyperliquid margin tables"] });
    expect(report.pnl.realized).toMatchObject({ status: "unavailable" });
    expect(report.positions[0]!.notional).toMatchObject({ value: "30500" });
  });
});

describe("RiskGuardedExecutionAdapter enforces limits in the execution layer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(limits: Partial<RiskLimits>) {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const sim = new SimulationAdapter(source, { now: () => NOW });
    sim.subscribeAccount(() => {});
    vi.advanceTimersByTime(100);
    const guard = new RiskGuardedExecutionAdapter(sim, (id) => sim.riskSnapshot(id), () => ({ ...DEFAULT_RISK_LIMITS, ...limits }));
    const instrument = sim.describeInstrument(alpha);
    const submit = vi.spyOn(sim, "submitOrder");
    const mark = sim.riskSnapshot("ALPHA-PERP").marks.get("ALPHA-PERP")!.value;
    return { guard, sim, instrument, submit, mark };
  }
  const order = (o: Partial<OrderRequest>) =>
    ({ clientOrderId: `g-${Math.random()}`, marketId: "ALPHA-PERP", side: "buy", type: "limit", timeInForce: "gtc", size: 1, reduceOnly: false, leverage: 10, marginMode: "isolated", ...o }) as OrderRequest;

  it("refuses an order over a blocking limit without calling the venue", async () => {
    const { guard, instrument, submit, mark } = setup({ maxOrderNotional: { value: "500", action: "block" } });
    const result = await guard.submitOrder(order({ price: Number((mark * 0.9).toFixed(1)), size: 1 }), instrument);
    expect(result).toMatchObject({ ok: false, error: { code: "risk-limit", limits: ["maxOrderNotional"] } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("passes orders within limits (warnings do not block)", async () => {
    const { guard, instrument, submit, mark } = setup({ maxConcentration: { value: "0.01", action: "warn" } });
    const result = await guard.submitOrder(order({ price: Number((mark * 0.9).toFixed(1)), size: 0.01 }), instrument);
    expect(result.ok).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("refuses when the venue mark is stale (fail closed)", async () => {
    const { guard, instrument, submit, mark } = setup({});
    vi.setSystemTime(NOW);
    const staleGuard = new RiskGuardedExecutionAdapter(guard, () => ({ ...guard["snapshot"]("ALPHA-PERP"), now: NOW + 60_000 }), () => DEFAULT_RISK_LIMITS);
    const result = await staleGuard.submitOrder(order({ price: Number((mark * 0.9).toFixed(1)), size: 0.01 }), instrument);
    expect(result).toMatchObject({ ok: false, error: { code: "risk-limit", limits: expect.arrayContaining(["markFreshness"]) } });
    expect(submit).not.toHaveBeenCalled();
  });

  it("the browser composition wraps every venue, including RFQ bookings, in the guard", () => {
    const tight = { ...DEFAULT_RISK_LIMITS, maxOrderNotional: { value: "100", action: "block" as const } };
    const sim = createTerminalServices({ marketDataSource: "simulation", hyperliquidNetwork: "mainnet", executionMode: "paper", riskLimits: tight });
    expect(sim.execution).toBeInstanceOf(RiskGuardedExecutionAdapter);
    vi.advanceTimersByTime(600);
    const refusal = sim.privateVenue!.checkRfqTrade({ clientOrderId: "r1", marketId: "ALPHA-PERP", side: "buy", size: 1, price: 1000, leverage: 10 });
    expect(refusal).toMatchObject({ code: "risk-limit", limits: expect.arrayContaining(["maxOrderNotional"]) });
    expect(sim.privateVenue!.recordRfqTrade({ clientOrderId: "r2", marketId: "ALPHA-PERP", side: "buy", size: 1, price: 1000, leverage: 10 })).toMatchObject({ ok: false, error: { code: "risk-limit" } });
    const live = createTerminalServices({ marketDataSource: "hyperliquid", hyperliquidNetwork: "mainnet", executionMode: "disabled", riskLimits: DEFAULT_RISK_LIMITS });
    expect(live.execution).toBeInstanceOf(RiskGuardedExecutionAdapter);
    expect(live.risk.rules).toBe(hyperliquidMarginRules);
    sim.marketData.dispose();
    sim.account.dispose();
    live.marketData.dispose();
  });

  it("a Hyperliquid order is refused by the guard first (no venue state), then by the adapter", async () => {
    const hl = new HyperliquidAdapter({ getVenueAccount: vi.fn() });
    const submit = vi.spyOn(hl, "submitOrder");
    const guard = new RiskGuardedExecutionAdapter(hl, () => ({ now: NOW, venue: hyperliquidMarginRules, account: null, markets: new Map(), marks: new Map(), book: null }), () => DEFAULT_RISK_LIMITS);
    const result = await guard.submitOrder(order({ marketId: "BTC-PERP", price: 60000, size: 0.001 }), hl.describeInstrument(btc));
    expect(result).toMatchObject({ ok: false, error: { code: "risk-limit" } });
    expect(submit).not.toHaveBeenCalled();
  });
});
