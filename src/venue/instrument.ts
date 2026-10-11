import { z } from "zod";

/**
 * Instrument and account configuration for the Nova venue prototype.
 *
 * All engine arithmetic uses integers: prices are whole ticks and quantities
 * are whole lots. Decimal strings exist only at the gateway boundary and are
 * converted exactly (no floating point) or refused.
 *
 * Prototype instruments and accounts are synthetic by construction: their
 * identifiers must carry the `SYN-` / `syn-` prefix.
 */

/** Largest tick count; keeps |price - ref| * 10_000 exact in a double. */
export const MAX_PRICE_TICKS = 100_000_000_000;

export const instrumentSpecSchema = z
  .object({
    id: z.string().regex(/^SYN-[A-Z0-9]{1,12}$/, "Prototype instruments must be synthetic (SYN-…)"),
    /** Decimal places of the quote price; tick size = tickUnits × 10^-priceDecimals. */
    priceDecimals: z.number().int().min(0).max(8),
    tickUnits: z.number().int().positive().max(1_000_000),
    /** Decimal places of the base quantity; lot size = lotUnits × 10^-sizeDecimals. */
    sizeDecimals: z.number().int().min(0).max(8),
    lotUnits: z.number().int().positive().max(1_000_000),
    minPriceTicks: z.number().int().positive(),
    maxPriceTicks: z.number().int().positive().max(MAX_PRICE_TICKS),
    minQtyLots: z.number().int().positive(),
    maxQtyLots: z.number().int().positive(),
    /** Limit orders further than this from the reference price are refused (fat-finger collar). */
    priceBandBps: z.number().int().min(1).max(5_000),
    /** Hidden orders must be at least this large (discourages cheap hidden probes and dust). */
    minHiddenQtyLots: z.number().int().positive(),
    referencePriceTicks: z.number().int().positive(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.minPriceTicks > s.maxPriceTicks) ctx.addIssue({ code: "custom", message: "minPriceTicks > maxPriceTicks" });
    if (s.minQtyLots > s.maxQtyLots) ctx.addIssue({ code: "custom", message: "minQtyLots > maxQtyLots" });
    if (s.minHiddenQtyLots > s.maxQtyLots) ctx.addIssue({ code: "custom", message: "minHiddenQtyLots > maxQtyLots" });
    if (s.referencePriceTicks < s.minPriceTicks || s.referencePriceTicks > s.maxPriceTicks) {
      ctx.addIssue({ code: "custom", message: "referencePriceTicks outside the price range" });
    }
    // Every single-order notional (ticks × lots) must be an exact integer in a double.
    if (s.maxPriceTicks * s.maxQtyLots > Number.MAX_SAFE_INTEGER) {
      ctx.addIssue({ code: "custom", message: "maxPriceTicks × maxQtyLots exceeds the safe integer range" });
    }
  });

export type InstrumentSpec = z.infer<typeof instrumentSpecSchema>;

export const accountLimitsSchema = z
  .object({
    /** Resting (GTC) orders the account may hold across all instruments. */
    maxOpenOrders: z.number().int().min(1).max(10_000),
    /** Per-order notional cap in tick·lot units. */
    maxOrderNotional: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** Worst-case |position| per instrument, counting all open orders as filled. */
    maxPositionLots: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type AccountLimits = z.infer<typeof accountLimitsSchema>;

export const accountIdSchema = z.string().regex(/^syn-[a-z0-9-]{1,32}$/, "Prototype accounts must be synthetic (syn-…)");

const DECIMAL = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,18}))?$/;

/**
 * Parses a plain decimal string ("123.45") into an integer count of
 * 10^-decimals units. Refuses exponents, signs, hex, whitespace, non-ASCII
 * digits, and digits beyond `decimals` unless they are zeros.
 */
export function parseScaled(text: string, decimals: number): number | null {
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals && /[^0]/.test(frac.slice(decimals))) return null;
  const units = Number(m[1]! + frac.slice(0, decimals).padEnd(decimals, "0"));
  return Number.isSafeInteger(units) ? units : null;
}

export type ConversionError = "invalid-number" | "not-on-tick" | "not-on-lot";

export function priceToTicks(spec: InstrumentSpec, price: string): { ok: true; value: number } | { ok: false; error: ConversionError } {
  const units = parseScaled(price, spec.priceDecimals);
  if (units === null) return { ok: false, error: "invalid-number" };
  if (units % spec.tickUnits !== 0) return { ok: false, error: "not-on-tick" };
  return { ok: true, value: units / spec.tickUnits };
}

export function quantityToLots(spec: InstrumentSpec, quantity: string): { ok: true; value: number } | { ok: false; error: ConversionError } {
  const units = parseScaled(quantity, spec.sizeDecimals);
  if (units === null) return { ok: false, error: "invalid-number" };
  if (units % spec.lotUnits !== 0) return { ok: false, error: "not-on-lot" };
  return { ok: true, value: units / spec.lotUnits };
}

function formatScaled(units: number, decimals: number): string {
  const s = String(units).padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

export const formatPrice = (spec: InstrumentSpec, ticks: number) => formatScaled(ticks * spec.tickUnits, spec.priceDecimals);
export const formatQuantity = (spec: InstrumentSpec, lots: number) => formatScaled(lots * spec.lotUnits, spec.sizeDecimals);

/** Fictitious instruments used by the demo, benchmarks and tests. */
export const SYNTHETIC_INSTRUMENTS: readonly InstrumentSpec[] = [
  {
    id: "SYN-ALPHA",
    priceDecimals: 2,
    tickUnits: 50, // tick 0.50
    sizeDecimals: 3,
    lotUnits: 1, // lot 0.001
    minPriceTicks: 1,
    maxPriceTicks: 2_000_000, // 1,000,000.00
    minQtyLots: 1,
    maxQtyLots: 1_000_000, // 1,000.000
    priceBandBps: 1_000, // ±10 %
    minHiddenQtyLots: 100, // 0.100
    referencePriceTicks: 4_000, // 2,000.00
  },
  {
    id: "SYN-BETA",
    priceDecimals: 4,
    tickUnits: 1, // tick 0.0001
    sizeDecimals: 0,
    lotUnits: 1,
    minPriceTicks: 1,
    maxPriceTicks: 100_000_000,
    minQtyLots: 1,
    maxQtyLots: 10_000_000,
    priceBandBps: 500,
    minHiddenQtyLots: 1_000,
    referencePriceTicks: 12_500, // 1.2500
  },
];
