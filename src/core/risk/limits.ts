import { z } from "zod";

const DecimalStringSchema = z.string().regex(/^\d+(\.\d+)?$/, "Expected a non-negative decimal string");
const ActionSchema = z.enum(["block", "warn"]);

const amountLimit = z.object({ value: DecimalStringSchema, action: ActionSchema }).strict().nullable();
const fractionLimit = z
  .object({ value: DecimalStringSchema.refine((v) => Number(v) > 0 && Number(v) <= 1, "Must be in (0, 1]"), action: ActionSchema })
  .strict()
  .nullable();
const multipleLimit = z
  .object({ value: DecimalStringSchema.refine((v) => Number(v) > 0, "Must be positive"), action: ActionSchema })
  .strict()
  .nullable();

/**
 * Pre-trade limits. Amounts are in the account's collateral currency (the
 * venue's quote asset, e.g. USDC or SIMUSD); fractions are 0..1; leverage is
 * a multiple. `null` disables a limit. "block" refuses the order in the
 * execution layer; "warn" lets it through with a warning.
 */
export const RiskLimitsSchema = z
  .object({
    /** |order size| × reference price. */
    maxOrderNotional: amountLimit,
    /** |resulting position size| × reference price, per instrument. */
    maxPositionNotional: amountLimit,
    /** Sum of |position notional| across instruments after the order. */
    maxGrossExposure: amountLimit,
    /** Requested leverage (the venue's own maximum is always enforced separately). */
    maxLeverage: multipleLimit,
    /** Resulting instrument notional / gross exposure after the order. */
    maxConcentration: fractionLimit,
    /** Warn/block when the estimated liquidation is closer than this fraction of the reference price. */
    minLiquidationDistance: fractionLimit,
    /** Limit-style orders: |limit − mark| / mark ("fat finger" check). */
    maxPriceDeviation: fractionLimit,
    /** Orders are refused when the mark price is older than this (ms). */
    maxMarkAgeMs: z.number().int().positive().max(600_000),
  })
  .strict();
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;
export type LimitName = Exclude<keyof RiskLimits, "maxMarkAgeMs"> | "venueMaxLeverage" | "markFreshness";

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxOrderNotional: { value: "250000", action: "block" },
  maxPositionNotional: { value: "500000", action: "block" },
  maxGrossExposure: { value: "1000000", action: "block" },
  maxLeverage: null,
  maxConcentration: { value: "0.8", action: "warn" },
  minLiquidationDistance: { value: "0.05", action: "warn" },
  maxPriceDeviation: { value: "0.1", action: "block" },
  maxMarkAgeMs: 15_000,
};
