import { NovaApiClient } from "@/adapters/http/nova-api-client";
import { hyperliquidCapabilities } from "@/adapters/hyperliquid/capabilities";
import { HYPERLIQUID_VENUE_ID } from "@/adapters/hyperliquid/constants";
import { HyperliquidMarketDataSource } from "@/adapters/hyperliquid/ws-market-data-source";
import { simulationCapabilities } from "@/adapters/simulation/capabilities";
import { PaperVenue } from "@/adapters/simulation/paper-venue";
import { SimulatedMarketDataSource } from "@/adapters/simulation/simulated-market-data-source";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import { DisconnectedAccountDataSource } from "@/core/account/disconnected-account-source";
import { DisabledExecutionAdapter } from "@/core/execution";
import type {
  AccountDataSource,
  ExecutionAdapter,
  MarketDataSource,
  VenueExecutionCapabilities,
} from "@/core/ports";

/** Demo-only controls, available exclusively with the simulated source. */
export interface DemoControls {
  simulateOutage(durationMs: number): void;
  failNextCandleRequest(): void;
  resetAccount(): void;
}

export interface TerminalServices {
  marketData: MarketDataSource;
  account: AccountDataSource;
  execution: ExecutionAdapter;
  capabilities: VenueExecutionCapabilities;
  demo: DemoControls | null;
}

/** Browser composition root: picks adapters from the public runtime config. */
export function createTerminalServices(runtime: PublicRuntimeConfig): TerminalServices {
  if (runtime.marketDataSource === "simulation") {
    const marketData = new SimulatedMarketDataSource({ latencyMs: 250 });
    const venue = new PaperVenue(marketData);
    return {
      marketData,
      account: venue,
      execution: venue,
      capabilities: simulationCapabilities,
      demo: {
        simulateOutage: (ms) => marketData.simulateOutage(ms),
        failNextCandleRequest: () => marketData.failNextCandleRequest(),
        resetAccount: () => venue.reset(),
      },
    };
  }
  return {
    marketData: new HyperliquidMarketDataSource({
      network: runtime.hyperliquidNetwork,
      catalog: new NovaApiClient("", undefined, "live"),
    }),
    account: new DisconnectedAccountDataSource(),
    execution: new DisabledExecutionAdapter(HYPERLIQUID_VENUE_ID),
    capabilities: hyperliquidCapabilities,
    demo: null,
  };
}
