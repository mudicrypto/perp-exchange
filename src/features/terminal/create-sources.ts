import { NovaApiClient } from "@/adapters/http/nova-api-client";
import { RfqClient } from "@/adapters/http/rfq-client";
import { hyperliquidCapabilities } from "@/adapters/hyperliquid/capabilities";
import { HyperliquidAdapter } from "@/adapters/hyperliquid/hyperliquid-adapter";
import { HyperliquidMarketDataSource } from "@/adapters/hyperliquid/ws-market-data-source";
import { simulationCapabilities } from "@/adapters/simulation/capabilities";
import type { IcebergState, RfqTradeRequest } from "@/adapters/simulation/paper-engine";
import { SimulationAdapter } from "@/adapters/simulation/simulation-adapter";
import { SimulatedMarketDataSource } from "@/adapters/simulation/simulated-market-data-source";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import { DisconnectedAccountDataSource } from "@/core/account/disconnected-account-source";
import type { AccountDataSource, MarketDataSource } from "@/core/ports";
import type { Order, Result, TradingError } from "@/core/domain";
import type { RiskLimits, VenueMarginRules } from "@/core/risk";
import { CapabilityRegistry, PrivateExecutionService, RiskGuardedExecutionAdapter, type RiskSnapshot, type VenueCapabilities } from "@/core/trading";
import { hyperliquidMarginRules } from "@/adapters/hyperliquid/margin-rules";
import { simulationMarginRules } from "@/adapters/simulation/margin-rules";

/** Demo-only controls, available exclusively with the simulated source. */
export interface DemoControls {
  simulateOutage(durationMs: number): void;
  failNextCandleRequest(): void;
  resetAccount(): void;
  /** The simulated venue rejects the next order (a configured simulated rejection). */
  rejectNextOrder(): void;
}

/** Venue hooks for private modes; present only where the venue implements them. */
export interface PrivateVenue {
  rfq: RfqClient;
  /** Books an RFQ execution confirmed by the RFQ service. */
  recordRfqTrade(trade: RfqTradeRequest): Result<Order>;
  checkRfqTrade(trade: RfqTradeRequest): TradingError | null;
  icebergState(orderId: string): IcebergState | null;
}

/** Risk configuration and the venue state the execution guard assesses against. */
export interface RiskServices {
  rules: VenueMarginRules;
  limits: RiskLimits;
  snapshot(marketId: string): RiskSnapshot;
}

export interface TerminalServices {
  marketData: MarketDataSource;
  account: AccountDataSource;
  /** Always wrapped by RiskGuardedExecutionAdapter: limits are enforced on every submission. */
  execution: RiskGuardedExecutionAdapter;
  risk: RiskServices;
  /** Capabilities of the active execution venue. */
  capabilities: VenueCapabilities;
  /** All known venues' capabilities (lets the UI explain what other venues offer). */
  registry: CapabilityRegistry;
  /** Routes hidden/iceberg orders; refuses modes the venue does not support. */
  privateExecution: PrivateExecutionService;
  privateVenue: PrivateVenue | null;
  demo: DemoControls | null;
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(simulationCapabilities);
  registry.register(hyperliquidCapabilities);
  return registry;
}

/** An RFQ trade is assessed as the equivalent immediate limit order at the agreed price. */
function rfqRiskRefusal(guard: RiskGuardedExecutionAdapter, venue: SimulationAdapter, trade: RfqTradeRequest): TradingError | null {
  const market = venue.marketById(trade.marketId);
  if (!market) return { code: "validation", issues: [{ field: "marketId", message: "Unknown market" }], message: "Unknown market" };
  const assessment = guard.assess(
    { clientOrderId: trade.clientOrderId, marketId: trade.marketId, side: trade.side, type: "limit", price: trade.price, timeInForce: "ioc", size: trade.size, reduceOnly: false, leverage: trade.leverage, marginMode: "isolated" },
    market,
  );
  const blocking = assessment.checks.filter((c) => c.action === "block" && c.status !== "pass");
  return blocking.length > 0 ? { code: "risk-limit", limits: blocking.map((c) => c.limit), message: `Blocked by risk limits: ${blocking.map((c) => c.message).join("; ")}` } : null;
}

/** Browser composition root: picks adapters from the public runtime config. */
export function createTerminalServices(runtime: PublicRuntimeConfig): TerminalServices {
  const registry = createCapabilityRegistry();
  if (runtime.marketDataSource === "simulation") {
    const marketData = new SimulatedMarketDataSource({ latencyMs: 250 });
    // A short acknowledgement delay makes the pending-new state visible.
    const venue = new SimulationAdapter(marketData, { ackLatencyMs: 150 });
    const snapshot = (marketId: string) => venue.riskSnapshot(marketId);
    const execution = new RiskGuardedExecutionAdapter(venue, snapshot, () => runtime.riskLimits);
    return {
      marketData,
      account: venue,
      execution,
      risk: { rules: simulationMarginRules, limits: runtime.riskLimits, snapshot },
      capabilities: venue.getCapabilities(),
      registry,
      privateExecution: new PrivateExecutionService(execution),
      privateVenue: {
        rfq: new RfqClient(),
        // RFQ trades bypass submitOrder, so the same risk limits are applied here explicitly.
        recordRfqTrade: (trade) => {
          const refused = rfqRiskRefusal(execution, venue, trade);
          return refused ? { ok: false, error: refused } : venue.recordRfqTrade(trade);
        },
        checkRfqTrade: (trade) => rfqRiskRefusal(execution, venue, trade) ?? venue.checkRfqTrade(trade),
        icebergState: (orderId) => venue.icebergState(orderId),
      },
      demo: {
        simulateOutage: (ms) => marketData.simulateOutage(ms),
        failNextCandleRequest: () => marketData.failNextCandleRequest(),
        resetAccount: () => venue.reset(),
        rejectNextOrder: () => venue.rejectNextOrders("Simulated venue rejection (demo control)"),
      },
    };
  }
  const api = new NovaApiClient("", undefined, "live");
  const hyperliquid = new HyperliquidAdapter(api);
  // No account or venue marks are available to the guard in live mode, so it blocks
  // (fail closed); submission is disabled at the adapter regardless.
  const snapshot = (): RiskSnapshot => ({ now: Date.now(), venue: hyperliquidMarginRules, account: null, markets: new Map(), marks: new Map(), book: null });
  const execution = new RiskGuardedExecutionAdapter(hyperliquid, snapshot, () => runtime.riskLimits);
  return {
    marketData: new HyperliquidMarketDataSource({ network: runtime.hyperliquidNetwork, catalog: api }),
    account: new DisconnectedAccountDataSource(),
    execution,
    risk: { rules: hyperliquidMarginRules, limits: runtime.riskLimits, snapshot },
    capabilities: execution.getCapabilities(),
    registry,
    privateExecution: new PrivateExecutionService(execution),
    privateVenue: null,
    demo: null,
  };
}
