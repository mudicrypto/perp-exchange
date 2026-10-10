import { NovaApiClient } from "@/adapters/http/nova-api-client";
import { hyperliquidCapabilities } from "@/adapters/hyperliquid/capabilities";
import { HyperliquidAdapter } from "@/adapters/hyperliquid/hyperliquid-adapter";
import { HyperliquidMarketDataSource } from "@/adapters/hyperliquid/ws-market-data-source";
import { simulationCapabilities } from "@/adapters/simulation/capabilities";
import { SimulationAdapter } from "@/adapters/simulation/simulation-adapter";
import { SimulatedMarketDataSource } from "@/adapters/simulation/simulated-market-data-source";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import { DisconnectedAccountDataSource } from "@/core/account/disconnected-account-source";
import type { AccountDataSource, ExecutionAdapter, MarketDataSource } from "@/core/ports";
import { CapabilityRegistry, type VenueCapabilities } from "@/core/trading";

/** Demo-only controls, available exclusively with the simulated source. */
export interface DemoControls {
  simulateOutage(durationMs: number): void;
  failNextCandleRequest(): void;
  resetAccount(): void;
  /** The simulated venue rejects the next order (a configured simulated rejection). */
  rejectNextOrder(): void;
}

export interface TerminalServices {
  marketData: MarketDataSource;
  account: AccountDataSource;
  execution: ExecutionAdapter;
  /** Capabilities of the active execution venue. */
  capabilities: VenueCapabilities;
  /** All known venues' capabilities (lets the UI explain what other venues offer). */
  registry: CapabilityRegistry;
  demo: DemoControls | null;
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(simulationCapabilities);
  registry.register(hyperliquidCapabilities);
  return registry;
}

/** Browser composition root: picks adapters from the public runtime config. */
export function createTerminalServices(runtime: PublicRuntimeConfig): TerminalServices {
  const registry = createCapabilityRegistry();
  if (runtime.marketDataSource === "simulation") {
    const marketData = new SimulatedMarketDataSource({ latencyMs: 250 });
    // A short acknowledgement delay makes the pending-new state visible.
    const venue = new SimulationAdapter(marketData, { ackLatencyMs: 150 });
    return {
      marketData,
      account: venue,
      execution: venue,
      capabilities: venue.getCapabilities(),
      registry,
      demo: {
        simulateOutage: (ms) => marketData.simulateOutage(ms),
        failNextCandleRequest: () => marketData.failNextCandleRequest(),
        resetAccount: () => venue.reset(),
        rejectNextOrder: () => venue.rejectNextOrders("Simulated venue rejection (demo control)"),
      },
    };
  }
  const api = new NovaApiClient("", undefined, "live");
  const execution = new HyperliquidAdapter(api);
  return {
    marketData: new HyperliquidMarketDataSource({ network: runtime.hyperliquidNetwork, catalog: api }),
    account: new DisconnectedAccountDataSource(),
    execution,
    capabilities: execution.getCapabilities(),
    registry,
    demo: null,
  };
}
