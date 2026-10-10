import { NovaApiClient } from "@/adapters/http/nova-api-client";
import { hyperliquidCapabilities } from "@/adapters/hyperliquid/capabilities";
import { HyperliquidMarketDataSource } from "@/adapters/hyperliquid/ws-market-data-source";
import { simulationCapabilities } from "@/adapters/simulation/capabilities";
import { SimulatedMarketDataSource } from "@/adapters/simulation/simulated-market-data-source";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import type { MarketDataSource, VenueExecutionCapabilities } from "@/core/ports";

/** Browser composition root: picks adapters from the public runtime config. */
export function createMarketDataSource(runtime: PublicRuntimeConfig): MarketDataSource {
  if (runtime.marketDataSource === "simulation") return new SimulatedMarketDataSource();
  return new HyperliquidMarketDataSource({
    network: runtime.hyperliquidNetwork,
    catalog: new NovaApiClient(),
  });
}

export function executionCapabilitiesFor(runtime: PublicRuntimeConfig): VenueExecutionCapabilities {
  return runtime.marketDataSource === "simulation" ? simulationCapabilities : hyperliquidCapabilities;
}
