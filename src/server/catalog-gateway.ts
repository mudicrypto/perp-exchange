import "server-only";
import { HyperliquidInfoClient } from "@/adapters/hyperliquid/info-client";
import { SimulatedCatalogGateway } from "@/adapters/simulation/simulated-catalog-gateway";
import { getServerEnv } from "@/config/server-env";
import type { MarketCatalogGateway } from "@/core/ports";

let gateway: MarketCatalogGateway | null = null;

/** Composition root for server-side market catalog access. */
export function getCatalogGateway(): MarketCatalogGateway {
  if (gateway) return gateway;
  const env = getServerEnv();
  gateway =
    env.NOVA_MARKET_DATA_SOURCE === "simulation"
      ? new SimulatedCatalogGateway()
      : new HyperliquidInfoClient({ network: env.NOVA_HYPERLIQUID_NETWORK });
  return gateway;
}
