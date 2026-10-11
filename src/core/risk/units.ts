/**
 * Explicit units for every risk figure.
 *
 * - price:            quote currency per 1 unit of the base asset (e.g. USDC per BTC)
 * - quantity:         base-asset units; position sizes are signed (+ long, − short)
 * - amount:           quote/collateral currency (notional, PnL, fees, funding, margin)
 * - fraction:         dimensionless ratio; 0.01 means 1 %. Percentages exist only in the UI
 * - multiple:         dimensionless "x" (leverage)
 * - rate-per-interval: fraction of notional per funding interval of `intervalHours`
 * - fee-rate:         fraction of traded notional charged per fill
 */
export type Unit =
  | { kind: "price"; quote: string; base: string }
  | { kind: "quantity"; asset: string }
  | { kind: "amount"; asset: string }
  | { kind: "fraction" }
  | { kind: "multiple" }
  | { kind: "rate-per-interval"; intervalHours: number }
  | { kind: "fee-rate" };

export const fraction: Unit = { kind: "fraction" };
export const multiple: Unit = { kind: "multiple" };
export const feeRate: Unit = { kind: "fee-rate" };
export const amount = (asset: string): Unit => ({ kind: "amount", asset });
export const quantity = (asset: string): Unit => ({ kind: "quantity", asset });
export const price = (quote: string, base: string): Unit => ({ kind: "price", quote, base });
export const perInterval = (intervalHours: number): Unit => ({ kind: "rate-per-interval", intervalHours });

export function unitLabel(unit: Unit): string {
  switch (unit.kind) {
    case "price":
      return `${unit.quote}/${unit.base}`;
    case "quantity":
    case "amount":
      return unit.asset;
    case "fraction":
      return "fraction (0.01 = 1%)";
    case "multiple":
      return "x";
    case "rate-per-interval":
      return `fraction per ${unit.intervalHours}h`;
    case "fee-rate":
      return "fraction of notional";
  }
}
