import type { Fill, Side } from "../domain";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal } from "./decimal";
import type { Observed } from "./freshness";
import type { Unit } from "./units";
import { available, unavailable, type RiskValue } from "./value";

const amt = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));

function checkRecords(fills: readonly Fill[]): string | null {
  const ids = new Set<string>();
  for (const f of fills) {
    if (ids.has(f.id)) return `Duplicate fill id ${f.id}`;
    ids.add(f.id);
  }
  return null;
}

/**
 * Realised PnL (before fees) as the sum of the PnL each fill reports. Only as
 * complete as the loaded history: fills outside it are not included.
 */
export function realizedPnlFromFills(fills: Observed<readonly Fill[]>, unit: Unit, now: number): RiskValue {
  const problem = checkRecords(fills.value);
  if (problem) return unavailable(unit, `Execution records are inconsistent: ${problem}`, ["Fill history"], now);
  const total = fills.value.reduce((s, f) => s.add(dec(f.realizedPnl)), ZERO);
  const first = fills.value.reduce<number | null>((t, f) => (t === null || f.time < t ? f.time : t), null);
  return available({
    value: amt(total),
    unit,
    kind: "calculated",
    method: "Σ realised PnL reported on each fill (before fees)",
    inputs: [{ name: "Fills", value: String(fills.value.length), unit: null, source: fills.source, observedAt: fills.observedAt }],
    assumptions: [`Covers the ${fills.value.length} fill(s) in the loaded history${first === null ? "" : ` since ${new Date(first).toISOString()}`}; earlier fills are not included.`],
    asOf: now,
  });
}

/** Total fees (positive = paid, negative = rebates received) from fill records. */
export function feesFromFills(fills: Observed<readonly Fill[]>, unit: Unit, now: number): RiskValue {
  const problem = checkRecords(fills.value);
  if (problem) return unavailable(unit, `Execution records are inconsistent: ${problem}`, ["Fill history"], now);
  const total = fills.value.reduce((s, f) => s.add(dec(f.fee)), ZERO);
  return available({
    value: amt(total),
    unit,
    kind: "calculated",
    method: "Σ fee reported on each fill (negative = rebate)",
    inputs: [{ name: "Fills", value: String(fills.value.length), unit: null, source: fills.source, observedAt: fills.observedAt }],
    assumptions: ["Covers only the loaded fill history."],
    asOf: now,
  });
}

export interface ReconstructedPosition {
  /** Signed size (+ long). */
  size: Decimal;
  /** Average entry price of the open position; null when flat. */
  entryPrice: Decimal | null;
  /** Realised PnL before fees. */
  realizedPnl: Decimal;
  fees: Decimal;
}

const signOf = (side: Side) => (side === "buy" ? 1 : -1);

/**
 * Replays fills for one market with average-cost accounting (the method
 * perpetual venues use for entry price): increasing a position re-averages the
 * entry; reducing realises (exit − entry) × closed size × direction; a fill
 * that flips the position opens the remainder at the fill price.
 * `opening` must describe the position before the first fill (default: flat).
 */
export function reconstructPosition(fills: readonly Pick<Fill, "side" | "price" | "size" | "fee">[], opening: { size: Decimal; entryPrice: Decimal | null } = { size: ZERO, entryPrice: null }): ReconstructedPosition {
  let size = opening.size;
  let entry = opening.entryPrice;
  let realized = ZERO;
  let fees = ZERO;
  if (!size.isZero() && entry === null) throw new RangeError("An open opening position needs an entry price");
  for (const f of fills) {
    const qty = dec(f.size);
    const price = dec(f.price);
    if (qty.lte(ZERO) || price.lte(ZERO)) throw new RangeError("Fill size and price must be positive");
    fees = fees.add(dec(f.fee));
    const signed = qty.mul(signOf(f.side));
    if (size.isZero() || size.isPositive() === signed.isPositive()) {
      const total = size.abs().add(qty);
      entry = size.isZero() ? price : size.abs().mul(entry!).add(qty.mul(price)).div(total);
      size = size.add(signed);
      continue;
    }
    const closing = minDec(qty, size.abs());
    const direction = size.isPositive() ? 1 : -1;
    realized = realized.add(price.sub(entry!).mul(closing).mul(direction));
    const remaining = size.add(signed);
    if (remaining.isZero()) {
      size = ZERO;
      entry = null;
    } else if (remaining.isPositive() !== size.isPositive()) {
      size = remaining;
      entry = price;
    } else {
      size = remaining;
    }
  }
  return { size, entryPrice: entry, realizedPnl: realized, fees };
}

function minDec(a: Decimal, b: Decimal): Decimal {
  return a.lt(b) ? a : b;
}
