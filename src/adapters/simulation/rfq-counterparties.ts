import type { MarketId } from "@/core/domain";
import type { RfqCounterparty } from "@/core/rfq";
import { SimulationEngine } from "./simulation-engine";

/**
 * Fictitious RFQ counterparties for the simulated venue. Two quote
 * automatically; "Desk C" only quotes through its counterparty API.
 */
export const SIMULATED_RFQ_COUNTERPARTIES: readonly RfqCounterparty[] = [
  { id: "sim-desk-a", name: "Simulated Desk A", autoQuoteSpreadBps: 8 },
  { id: "sim-desk-b", name: "Simulated Desk B", autoQuoteSpreadBps: 15 },
  { id: "sim-desk-c", name: "Simulated Desk C (manual)", autoQuoteSpreadBps: null },
];

const priceDecimals = new Map([...new SimulationEngine(42).markets.values()].map((m) => [m.id, m.market.priceDecimals]));

/** Rounds to the simulated market's tick; null for unknown markets. */
export function roundSimulatedPrice(marketId: MarketId, price: number): number | null {
  const decimals = priceDecimals.get(marketId);
  if (decimals === undefined || !Number.isFinite(price) || price <= 0) return null;
  const rounded = Number(price.toFixed(decimals));
  return rounded > 0 ? rounded : null;
}
