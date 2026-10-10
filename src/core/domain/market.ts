import { z } from "zod";

/**
 * Venue-agnostic market identifier, e.g. "BTC-PERP".
 * Adapters own the mapping between this id and a venue's own symbol.
 */
export const MarketIdSchema = z
  .string()
  .regex(/^[A-Z0-9]{1,20}-PERP$/, "Invalid market id");
export type MarketId = z.infer<typeof MarketIdSchema>;

export function marketIdFromBase(base: string): MarketId {
  return MarketIdSchema.parse(`${base.toUpperCase()}-PERP`);
}

export function baseFromMarketId(id: MarketId): string {
  return id.slice(0, -"-PERP".length);
}

export const MarketSchema = z.object({
  id: MarketIdSchema,
  base: z.string().min(1),
  /** Settlement / collateral asset, e.g. "USDC". */
  quote: z.string().min(1),
  /** Decimal places allowed for order size. */
  sizeDecimals: z.number().int().min(0).max(18),
  /** Maximum decimal places allowed for price. */
  priceDecimals: z.number().int().min(0).max(18),
  maxLeverage: z.number().positive(),
  /** True if cross margin is not available for this market. */
  isolatedOnly: z.boolean(),
  /**
   * Maintenance margin as a fraction of notional for the base tier.
   * Venue-specific; set by the adapter. Tiered tables are not modelled in M1.
   */
  maintenanceMarginRate: z.number().positive().lt(1),
});
export type Market = z.infer<typeof MarketSchema>;

export const MarketStatsSchema = z.object({
  marketId: MarketIdSchema,
  markPrice: z.number().positive(),
  oraclePrice: z.number().positive().nullable(),
  midPrice: z.number().positive().nullable(),
  /** Funding rate per funding interval, as a fraction (0.0001 = 0.01%). */
  fundingRate: z.number(),
  /** Funding interval in hours that `fundingRate` applies to. */
  fundingIntervalHours: z.number().positive(),
  /** Open interest in base units. */
  openInterest: z.number().nonnegative(),
  /** 24h notional volume in quote units. */
  dayNotionalVolume: z.number().nonnegative(),
  prevDayPrice: z.number().positive().nullable(),
  /** Time the stats were observed (ms since epoch). */
  observedAt: z.number().int().nonnegative(),
});
export type MarketStats = z.infer<typeof MarketStatsSchema>;

export const MarketSummarySchema = z.object({
  market: MarketSchema,
  stats: MarketStatsSchema.nullable(),
});
export type MarketSummary = z.infer<typeof MarketSummarySchema>;

export function dayChangeFraction(stats: MarketStats): number | null {
  if (stats.prevDayPrice === null) return null;
  return (stats.markPrice - stats.prevDayPrice) / stats.prevDayPrice;
}
