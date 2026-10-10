import type { BookLevel, Side } from "../domain";
import type { BookImpactEstimate } from "../ports";

/**
 * Estimated liquidation price for an isolated position.
 *
 * Liquidation happens when equity falls to maintenance margin:
 *   long:  collateral + size·(P − E) = mmr·size·P  ⇒  P = (size·E − collateral) / (size·(1 − mmr))
 *   short: collateral + size·(E − P) = mmr·size·P  ⇒  P = (size·E + collateral) / (size·(1 + mmr))
 *
 * This is an estimate: it ignores fees, funding accrual, tiered margin
 * tables and venue-specific liquidation mechanics.
 * Returns null when the position cannot be liquidated by price (P ≤ 0).
 */
export function estimateIsolatedLiquidationPrice(params: {
  side: Side;
  entryPrice: number;
  size: number;
  collateral: number;
  maintenanceMarginRate: number;
}): number | null {
  const { side, entryPrice, size, collateral, maintenanceMarginRate: mmr } = params;
  if (size <= 0 || entryPrice <= 0 || collateral < 0 || mmr <= 0 || mmr >= 1) return null;
  const price =
    side === "buy"
      ? (size * entryPrice - collateral) / (size * (1 - mmr))
      : (size * entryPrice + collateral) / (size * (1 + mmr));
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function initialMargin(notional: number, leverage: number): number {
  if (leverage <= 0) throw new RangeError("Leverage must be positive");
  return Math.abs(notional) / leverage;
}

/**
 * Walks visible book levels to estimate the average fill price of a market
 * order. `levels` must be the side being consumed (asks for a buy, bids for a
 * sell), best price first. Only *visible* depth is considered.
 */
export function estimateBookImpact(levels: readonly BookLevel[], size: number): BookImpactEstimate {
  let remaining = size;
  let cost = 0;
  let filled = 0;
  let levelsConsumed = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    filled += take;
    remaining -= take;
    levelsConsumed += 1;
  }
  const best = levels[0]?.price ?? null;
  const averagePrice = filled > 0 ? cost / filled : null;
  return {
    averagePrice,
    priceImpact: averagePrice !== null && best !== null ? Math.abs(averagePrice - best) / best : null,
    filledSize: filled,
    levelsConsumed,
    exceedsVisibleDepth: remaining > 1e-12,
  };
}
