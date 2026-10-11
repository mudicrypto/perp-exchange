import DecimalJs from "decimal.js";

/**
 * Decimal arithmetic for risk calculations. Binary floating point cannot
 * represent most decimal prices exactly (0.1 + 0.2 ≠ 0.3), so every risk
 * figure is computed with `decimal.js` at 40 significant digits and
 * banker's rounding (ROUND_HALF_EVEN), then rounded once for output.
 */
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
export type Decimal = InstanceType<typeof Decimal>;

/** A finite decimal number serialised as a string (e.g. "1234.5"). */
export type DecimalString = string;

export type DecimalInput = number | string | Decimal;

/** Parses a finite decimal; throws RangeError on NaN, ±Infinity or malformed strings. */
export function dec(value: DecimalInput): Decimal {
  if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new RangeError(`Not a decimal: ${String(value)}`);
  }
  if (!d.isFinite()) throw new RangeError(`Not a finite decimal: ${String(value)}`);
  return d;
}

/** Like `dec`, but returns null for null/undefined/non-finite input instead of throwing. */
export function decOrNull(value: DecimalInput | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    return dec(value);
  } catch {
    return null;
  }
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export type RoundingDirection = "half-even" | "up" | "down" | "toward-zero" | "away-from-zero";

const MODE: Record<RoundingDirection, DecimalJs.Rounding> = {
  "half-even": DecimalJs.ROUND_HALF_EVEN,
  up: DecimalJs.ROUND_CEIL,
  down: DecimalJs.ROUND_FLOOR,
  "toward-zero": DecimalJs.ROUND_DOWN,
  "away-from-zero": DecimalJs.ROUND_UP,
};

/** Rounds to a number of decimal places. `up`/`down` are toward +∞/−∞. */
export function roundDp(value: Decimal, decimals: number, direction: RoundingDirection = "half-even"): Decimal {
  return value.toDecimalPlaces(decimals, MODE[direction]);
}

/** Output precision for each kind of figure (see docs/RISK.md "Rounding"). */
export const OUTPUT_DECIMALS = { amount: 8, fraction: 10, quantity: 12 } as const;

/** Plain decimal string without exponent notation; "-0" normalised to "0". */
export function toPlain(value: Decimal): DecimalString {
  const s = value.toFixed();
  return s === "-0" ? "0" : s;
}

/** For display only (formatting). Never feed the result back into calculations. */
export function toDisplayNumber(value: DecimalString): number {
  return Number(value);
}
