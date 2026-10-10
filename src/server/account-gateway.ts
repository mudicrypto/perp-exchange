import "server-only";
import { HyperliquidInfoClient } from "@/adapters/hyperliquid/info-client";
import type { VenueAccountGateway } from "@/core/ports";
import { getCatalogGateway } from "./catalog-gateway";

/**
 * Read-only venue account access. Only live venues have one; the simulator's
 * paper account lives in the browser and is not exposed here.
 */
export function getVenueAccountGateway(): VenueAccountGateway | null {
  const gateway = getCatalogGateway();
  return gateway instanceof HyperliquidInfoClient ? gateway : null;
}
