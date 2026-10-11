import type { MarginMode, Market, Side } from "../domain";
import { ONE, ZERO, type Decimal } from "./decimal";
import type { RiskValueKind } from "./value";

export type RuleResult<T> =
  | { ok: true; value: T; kind: RiskValueKind; method: string; assumptions: string[] }
  | { ok: false; reason: string; missing: string[] };

export const ruleUnavailable = (reason: string, missing: string[] = []): RuleResult<never> => ({ ok: false, reason, missing });

export interface LiquidationInput {
  market: Market;
  side: Side;
  /** Absolute position size (base units). */
  size: Decimal;
  /** Average entry price (quote per base). */
  entryPrice: Decimal;
  /** Collateral allocated to the position (quote). Meaningful for isolated margin. */
  collateral: Decimal;
  marginMode: MarginMode;
  /** The venue's own liquidation price for an open position, if it reports one. */
  reportedLiquidationPrice: Decimal | null;
}

export type FundingRule =
  | { charged: false; reason: string }
  | {
      charged: true;
      /** Price the venue multiplies by size × rate to compute the payment. */
      priceBasis: "mark" | "oracle";
      source: string;
    };

/**
 * A venue's margin, fee and funding rules. There is deliberately no default
 * implementation: each venue states its own rules (and where they come from),
 * and returns "unavailable" for anything it cannot compute from known inputs.
 */
export interface VenueMarginRules {
  venueId: string;
  venueName: string;
  /** Where the rules come from (documentation, SDK, or "Nova simulator"). */
  source: string;
  initialMargin(input: { market: Market; notional: Decimal; leverage: Decimal }): RuleResult<Decimal>;
  maintenanceMargin(input: { market: Market; notional: Decimal }): RuleResult<Decimal>;
  liquidationPrice(input: LiquidationInput): RuleResult<Decimal>;
  /** Fee rates for this account, if known (fraction of traded notional). */
  feeRates(): RuleResult<{ taker: Decimal; maker: Decimal }>;
  funding: FundingRule;
}

/**
 * Liquidation price of an isolated position under a *constant* maintenance
 * margin rate `m` (no tiers), where liquidation happens once equity equals
 * maintenance margin at price P:
 *
 *   long:  C + q·(P − E) = m·q·P   ⇒  P = (q·E − C) / (q·(1 − m))
 *   short: C + q·(E − P) = m·q·P   ⇒  P = (q·E + C) / (q·(1 + m))
 *
 * q = |size|, E = entry, C = collateral. Returns null when no positive price
 * satisfies the equation (the position cannot be liquidated by price alone).
 * Fees and funding are not included. Only a venue whose rules match this
 * model may use it.
 */
export function constantRateIsolatedLiquidationPrice(input: {
  side: Side;
  size: Decimal;
  entryPrice: Decimal;
  collateral: Decimal;
  maintenanceMarginRate: Decimal;
}): Decimal | null {
  const { side, size: q, entryPrice: e, collateral: c, maintenanceMarginRate: m } = input;
  if (q.lte(ZERO) || e.lte(ZERO) || c.lt(ZERO) || m.lte(ZERO) || m.gte(ONE)) {
    throw new RangeError("Invalid liquidation input: size and entry must be positive, collateral ≥ 0, 0 < rate < 1");
  }
  const price = side === "buy" ? q.mul(e).sub(c).div(q.mul(ONE.sub(m))) : q.mul(e).add(c).div(q.mul(ONE.add(m)));
  return price.gt(ZERO) ? price : null;
}
