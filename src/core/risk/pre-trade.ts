import { isTriggerType, requestLimitPrice, requestTriggerPrice, type BookLevel, type Market, type OrderRequest, type Position } from "../domain";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal } from "./decimal";
import { checkFreshness, type Observed } from "./freshness";
import type { LimitName, RiskLimits } from "./limits";
import type { VenueMarginRules } from "./margin-rules";
import type { PortfolioRiskReport } from "./portfolio";
import { amount, fraction, multiple, price, quantity, type Unit } from "./units";
import { available, isAvailable, unavailable, type AvailableValue, type RiskInput, type RiskValue } from "./value";

export interface BookImpact {
  /** Volume-weighted average price over visible levels; null if no liquidity. */
  averagePrice: string | null;
  /** |average − best| / best (fraction). */
  priceImpact: string | null;
  filledSize: string;
  levelsConsumed: number;
  exceedsVisibleDepth: boolean;
}

/** Walks visible levels of the side being consumed (best first). Only visible depth is considered. */
export function estimateBookImpact(levels: readonly BookLevel[], size: Decimal): BookImpact {
  let remaining = size;
  let cost = ZERO;
  let filled = ZERO;
  let consumed = 0;
  for (const level of levels) {
    if (remaining.lte(ZERO)) break;
    const levelSize = dec(level.size);
    const take = remaining.lt(levelSize) ? remaining : levelSize;
    cost = cost.add(take.mul(dec(level.price)));
    filled = filled.add(take);
    remaining = remaining.sub(take);
    consumed += 1;
  }
  const best = levels[0] ? dec(levels[0].price) : null;
  const avg = filled.gt(ZERO) ? cost.div(filled) : null;
  return {
    averagePrice: avg ? toPlain(roundDp(avg, OUTPUT_DECIMALS.amount)) : null,
    priceImpact: avg && best ? toPlain(roundDp(avg.sub(best).abs().div(best), OUTPUT_DECIMALS.fraction)) : null,
    filledSize: toPlain(filled),
    levelsConsumed: consumed,
    exceedsVisibleDepth: remaining.gt(ZERO),
  };
}

export type CheckStatus = "pass" | "breach" | "unverifiable";

export interface LimitCheck {
  limit: LimitName;
  action: "block" | "warn";
  status: CheckStatus;
  message: string;
  observed: string | null;
  threshold: string | null;
  unit: Unit | null;
}

export type PreTradeNotice =
  | { code: "exceeds-visible-depth" }
  | { code: "high-price-impact"; impact: string }
  | { code: "limit-crosses-book" }
  | { code: "trigger-reference-price" };

export interface PreTradeAssessment {
  asOf: number;
  /** "block": the execution layer refuses the order; "warn": allowed with warnings. */
  decision: "allow" | "warn" | "block";
  referencePrice: RiskValue;
  notional: RiskValue;
  initialMargin: RiskValue;
  feeEstimate: RiskValue;
  liquidationPrice: RiskValue;
  liquidationDistance: RiskValue;
  resultingPositionNotional: RiskValue;
  bookImpact: BookImpact | null;
  checks: LimitCheck[];
  notices: PreTradeNotice[];
}

export interface PreTradeInput {
  now: number;
  order: OrderRequest;
  market: Market;
  venue: VenueMarginRules | null;
  mark: Observed<number> | null;
  book: Observed<{ bids: readonly BookLevel[]; asks: readonly BookLevel[] }> | null;
  /** Existing position in this market, if any. */
  position: Position | null;
  /** Current portfolio (for gross exposure and concentration). Null when there is no account. */
  portfolio: PortfolioRiskReport | null;
  limits: RiskLimits;
  /** Warn when visible-book price impact exceeds this fraction. */
  highImpactThreshold?: string;
}

const amt = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));
const frac = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.fraction));
const LIMIT_STYLE = new Set<OrderRequest["type"]>(["limit", "iceberg", "hidden", "stop-limit", "take-profit-limit"]);

/**
 * Pre-trade figures and limit checks for one order. Used by the order ticket
 * (preview) *and* by `RiskGuardedExecutionAdapter` (enforcement), so both
 * always agree. Pure and deterministic.
 */
export function assessOrder(input: PreTradeInput): PreTradeAssessment {
  const { now, order, market, venue, limits } = input;
  const q = market.quote;
  const pUnit = price(q, market.base);
  const aUnit = amount(q);
  const size = dec(order.size);
  const signedOrder = order.side === "buy" ? size : size.neg();
  const notices: PreTradeNotice[] = [];
  const checks: LimitCheck[] = [];

  // ---- mark freshness (always enforced)
  const markFresh = input.mark ? checkFreshness(input.mark.observedAt, now, limits.maxMarkAgeMs, "Mark price") : null;
  const mark = input.mark && markFresh?.fresh ? dec(input.mark.value) : null;
  const markInput: RiskInput | null = input.mark
    ? { name: "Mark price", value: toPlain(dec(input.mark.value)), unit: pUnit, source: input.mark.source, observedAt: input.mark.observedAt }
    : null;
  checks.push(
    mark
      ? { limit: "markFreshness", action: "block", status: "pass", message: "Mark price is fresh", observed: null, threshold: `${limits.maxMarkAgeMs} ms`, unit: null }
      : { limit: "markFreshness", action: "block", status: "unverifiable", message: markFresh && !markFresh.fresh ? markFresh.reason : "No mark price", observed: null, threshold: `${limits.maxMarkAgeMs} ms`, unit: null },
  );

  // ---- reference price
  const sideLevels = input.book ? (order.side === "buy" ? input.book.value.asks : input.book.value.bids) : null;
  const bookImpact = order.type === "market" && sideLevels ? estimateBookImpact(sideLevels, size) : null;
  if (bookImpact?.exceedsVisibleDepth) notices.push({ code: "exceeds-visible-depth" });
  const impactThreshold = dec(input.highImpactThreshold ?? "0.005");
  if (bookImpact?.priceImpact && dec(bookImpact.priceImpact).gt(impactThreshold)) notices.push({ code: "high-price-impact", impact: bookImpact.priceImpact });

  let reference: RiskValue;
  const limitPrice = requestLimitPrice(order);
  const triggerPrice = requestTriggerPrice(order);
  if (LIMIT_STYLE.has(order.type) && limitPrice !== null) {
    reference = available({ value: toPlain(dec(limitPrice)), unit: pUnit, kind: "calculated", method: "Order limit price", inputs: [], assumptions: [], asOf: now });
  } else if (isTriggerType(order.type) && triggerPrice !== null) {
    notices.push({ code: "trigger-reference-price" });
    reference = available({
      value: toPlain(dec(triggerPrice)),
      unit: pUnit,
      kind: "estimate",
      method: "Trigger price",
      inputs: [],
      assumptions: ["A triggered market order fills at book prices after the trigger, which can be worse than the trigger price."],
      asOf: now,
    });
  } else if (bookImpact?.averagePrice && !bookImpact.exceedsVisibleDepth && input.book) {
    reference = available({
      value: bookImpact.averagePrice,
      unit: pUnit,
      kind: "estimate",
      method: "Volume-weighted price over visible book levels",
      inputs: [{ name: "Order book", value: `${bookImpact.levelsConsumed} level(s)`, unit: null, source: input.book.source, observedAt: input.book.observedAt }],
      assumptions: ["The book can change before the order arrives; hidden liquidity is not visible."],
      asOf: now,
    });
  } else if (mark && markInput) {
    reference = available({ value: toPlain(mark), unit: pUnit, kind: "estimate", method: "Mark price (no usable visible book)", inputs: [markInput], assumptions: ["Market orders fill at book prices, not at the mark."], asOf: now });
  } else {
    reference = unavailable(pUnit, "No limit price, usable order book or fresh mark price", ["Mark price"], now);
  }

  const refInputs = (r: AvailableValue): RiskInput[] => [{ name: "Reference price", value: r.value, unit: pUnit, source: r.method, observedAt: null }, ...r.inputs];
  const sizeInput: RiskInput = { name: "Order size", value: toPlain(size), unit: quantity(market.base), source: "order", observedAt: null };

  let notional: RiskValue = unavailable(aUnit, isAvailable(reference) ? "" : reference.reason, ["Reference price"], now);
  let initialMargin: RiskValue = notional;
  let feeEstimate: RiskValue = notional;
  let liquidationPrice: RiskValue = unavailable(pUnit, isAvailable(reference) ? "" : reference.reason, ["Reference price"], now);
  let liquidationDistance: RiskValue = unavailable(fraction, liquidationPrice.status === "unavailable" ? liquidationPrice.reason : "", [], now);
  let resultingPositionNotional: RiskValue = notional;

  if (isAvailable(reference)) {
    const ref = dec(reference.value);
    const n = size.mul(ref);
    notional = available({ value: amt(n), unit: aUnit, kind: reference.kind, method: "|order size| × reference price", inputs: [sizeInput, ...refInputs(reference)], assumptions: ["Order notional is exposure, not the collateral required and not a maximum loss."], asOf: now });

    // Initial margin and fees: venue rules only.
    if (!venue) {
      initialMargin = unavailable(aUnit, "No margin rules are known for this venue", ["Venue margin rules"], now);
      feeEstimate = unavailable(aUnit, "No fee schedule is known for this venue", ["Venue fee schedule"], now);
    } else {
      const im = venue.initialMargin({ market, notional: n, leverage: dec(order.leverage) });
      initialMargin = im.ok
        ? available({ value: amt(im.value), unit: aUnit, kind: reference.kind === "estimate" ? "estimate" : im.kind, method: im.method, inputs: [sizeInput, ...refInputs(reference), { name: "Leverage", value: toPlain(dec(order.leverage)), unit: multiple, source: "order", observedAt: null }], assumptions: im.assumptions, asOf: now })
        : unavailable(aUnit, im.reason, im.missing, now);
      const fees = venue.feeRates();
      if (fees.ok) {
        const maker = "timeInForce" in order && order.timeInForce === "post-only";
        const rate = maker ? fees.value.maker : fees.value.taker;
        feeEstimate = available({
          value: amt(n.mul(rate)),
          unit: aUnit,
          kind: "estimate",
          method: `notional × ${maker ? "maker" : "taker"} fee rate`,
          inputs: [...notional.inputs, { name: `${maker ? "Maker" : "Taker"} fee rate`, value: toPlain(rate), unit: { kind: "fee-rate" }, source: fees.method, observedAt: null }],
          assumptions: [maker ? "Post-only orders always add liquidity." : "Assumes the whole order pays the taker rate (a resting part may pay the lower maker rate).", ...fees.assumptions],
          asOf: now,
        });
      } else {
        feeEstimate = unavailable(aUnit, fees.reason, fees.missing, now);
      }
    }

    // Resulting position (average-cost combination when adding to the same side).
    const existing = input.position ? dec(input.position.size) : ZERO;
    const resulting = order.reduceOnly ? reduceOnlyResult(existing, signedOrder) : existing.add(signedOrder);
    resultingPositionNotional = available({
      value: amt(resulting.abs().mul(ref)),
      unit: aUnit,
      kind: "estimate",
      method: "|resulting position size| × reference price",
      inputs: [sizeInput, ...refInputs(reference), { name: "Existing position", value: toPlain(existing), unit: quantity(market.base), source: "venue account", observedAt: null }],
      assumptions: ["Values the whole resulting position at this order's reference price."],
      asOf: now,
    });

    const liq = preTradeLiquidation(input, ref, existing, resulting, initialMargin);
    liquidationPrice = liq;
    if (isAvailable(liq)) {
      liquidationDistance = available({
        value: frac(ref.sub(dec(liq.value)).abs().div(ref)),
        unit: fraction,
        kind: "estimate",
        method: "|reference price − estimated liquidation price| / reference price",
        inputs: liq.inputs,
        assumptions: liq.assumptions,
        asOf: now,
      });
    } else {
      liquidationDistance = unavailable(fraction, liq.reason, liq.missing, now);
    }
  }

  // ---- limit checks
  const exposureIncreasing = !order.reduceOnly;
  checks.push(
    dec(order.leverage).gt(dec(market.maxLeverage))
      ? { limit: "venueMaxLeverage", action: "block", status: "breach", message: `Leverage ${order.leverage}x exceeds the venue maximum of ${market.maxLeverage}x`, observed: String(order.leverage), threshold: String(market.maxLeverage), unit: multiple }
      : { limit: "venueMaxLeverage", action: "block", status: "pass", message: "Within the venue's maximum leverage", observed: String(order.leverage), threshold: String(market.maxLeverage), unit: multiple },
  );
  if (limits.maxLeverage) {
    checks.push(compare("maxLeverage", limits.maxLeverage, available({ value: toPlain(dec(order.leverage)), unit: multiple, kind: "calculated", method: "order leverage", inputs: [], assumptions: [], asOf: now }), "Leverage"));
  }
  if (exposureIncreasing) {
    if (limits.maxOrderNotional) {
      // Market orders are checked at the higher of the estimate and the mark (conservative).
      const checked = order.type === "market" && isAvailable(notional) && mark ? maxValue(notional, size.mul(mark)) : notional;
      checks.push(compare("maxOrderNotional", limits.maxOrderNotional, checked, "Order notional"));
    }
    if (limits.maxPositionNotional) checks.push(compare("maxPositionNotional", limits.maxPositionNotional, resultingPositionNotional, "Resulting position notional"));
    const grossAfter = grossAfterOrder(input, resultingPositionNotional);
    if (limits.maxGrossExposure) checks.push(compare("maxGrossExposure", limits.maxGrossExposure, grossAfter, "Gross exposure after the order"));
    if (limits.maxConcentration) {
      const share =
        isAvailable(grossAfter) && isAvailable(resultingPositionNotional) && dec(grossAfter.value).gt(ZERO)
          ? available({ value: frac(dec(resultingPositionNotional.value).div(dec(grossAfter.value))), unit: fraction, kind: "estimate", method: "resulting instrument notional / gross exposure after", inputs: [], assumptions: [], asOf: now })
          : unavailable(fraction, isAvailable(grossAfter) ? "Gross exposure is zero" : grossAfter.reason, [], now);
      checks.push(compare("maxConcentration", limits.maxConcentration, share, "Concentration after the order"));
    }
    if (limits.minLiquidationDistance) {
      checks.push(
        isAvailable(liquidationDistance)
          ? dec(liquidationDistance.value).lt(dec(limits.minLiquidationDistance.value))
            ? { limit: "minLiquidationDistance", action: limits.minLiquidationDistance.action, status: "breach", message: `Estimated liquidation is ${pct(liquidationDistance.value)} away (minimum ${pct(limits.minLiquidationDistance.value)})`, observed: liquidationDistance.value, threshold: limits.minLiquidationDistance.value, unit: fraction }
            : { limit: "minLiquidationDistance", action: limits.minLiquidationDistance.action, status: "pass", message: "Estimated liquidation distance is above the minimum", observed: liquidationDistance.value, threshold: limits.minLiquidationDistance.value, unit: fraction }
          : liquidationDistance.missing.length === 0 && /cannot be liquidated|reduce-only/.test(liquidationDistance.reason)
            ? { limit: "minLiquidationDistance", action: limits.minLiquidationDistance.action, status: "pass", message: liquidationDistance.reason, observed: null, threshold: limits.minLiquidationDistance.value, unit: fraction }
            : { limit: "minLiquidationDistance", action: limits.minLiquidationDistance.action, status: "unverifiable", message: `Liquidation distance unavailable: ${liquidationDistance.reason}`, observed: null, threshold: limits.minLiquidationDistance.value, unit: fraction },
      );
    }
  }
  if (limits.maxPriceDeviation && LIMIT_STYLE.has(order.type) && limitPrice !== null) {
    const deviation = mark
      ? available({ value: frac(dec(limitPrice).sub(mark).abs().div(mark)), unit: fraction, kind: "calculated", method: "|limit − mark| / mark", inputs: markInput ? [markInput] : [], assumptions: [], asOf: now })
      : unavailable(fraction, "No fresh mark price", ["Mark price"], now);
    checks.push(compare("maxPriceDeviation", limits.maxPriceDeviation, deviation, "Limit price deviation from mark"));
  }
  if (limitPrice !== null && !isTriggerType(order.type) && input.book) {
    const bestAsk = input.book.value.asks[0]?.price;
    const bestBid = input.book.value.bids[0]?.price;
    const crosses = order.side === "buy" ? bestAsk !== undefined && limitPrice >= bestAsk : bestBid !== undefined && limitPrice <= bestBid;
    if (crosses) notices.push({ code: "limit-crosses-book" });
  }

  const blocking = checks.some((c) => c.action === "block" && c.status !== "pass");
  const warning = checks.some((c) => c.status !== "pass");
  return {
    asOf: now,
    decision: blocking ? "block" : warning ? "warn" : "allow",
    referencePrice: reference,
    notional,
    initialMargin,
    feeEstimate,
    liquidationPrice,
    liquidationDistance,
    resultingPositionNotional,
    bookImpact,
    checks,
    notices,
  };
}

const pct = (fractionString: string) => `${dec(fractionString).mul(100).toDecimalPlaces(2).toFixed()}%`;

function maxValue(value: AvailableValue, other: Decimal): AvailableValue {
  const v = dec(value.value);
  return other.gt(v) ? { ...value, value: amt(other), method: `${value.method}, raised to |size| × mark (conservative)` } : value;
}

function compare(limit: LimitName, threshold: { value: string; action: "block" | "warn" }, observed: RiskValue, label: string): LimitCheck {
  if (!isAvailable(observed)) {
    return { limit, action: threshold.action, status: "unverifiable", message: `${label} cannot be verified: ${observed.reason}`, observed: null, threshold: threshold.value, unit: observed.unit };
  }
  const breach = dec(observed.value).gt(dec(threshold.value));
  const show = (v: string) => (observed.unit.kind === "fraction" ? pct(v) : v);
  return {
    limit,
    action: threshold.action,
    status: breach ? "breach" : "pass",
    message: breach ? `${label} ${show(observed.value)} exceeds the limit of ${show(threshold.value)}` : `${label} within the limit of ${show(threshold.value)}`,
    observed: observed.value,
    threshold: threshold.value,
    unit: observed.unit,
  };
}

function reduceOnlyResult(existing: Decimal, signedOrder: Decimal): Decimal {
  // A reduce-only order can only move the position toward zero.
  if (existing.isZero() || existing.isPositive() === signedOrder.isPositive()) return existing;
  const after = existing.add(signedOrder);
  return after.isZero() || after.isPositive() !== existing.isPositive() ? ZERO : after;
}

function grossAfterOrder(input: PreTradeInput, resulting: RiskValue): RiskValue {
  const unit = amount(input.market.quote);
  if (!isAvailable(resulting)) return unavailable(unit, resulting.reason, resulting.missing, input.now);
  if (!input.portfolio) return unavailable(unit, "No account data to compute portfolio exposure", ["Account snapshot"], input.now);
  let total = dec(resulting.value);
  for (const p of input.portfolio.positions) {
    if (p.marketId === input.market.id) continue;
    if (!isAvailable(p.notional)) return unavailable(unit, `${p.marketId}: ${p.notional.reason}`, p.notional.missing, input.now);
    total = total.add(dec(p.notional.value));
  }
  return available({ value: amt(total), unit, kind: "estimate", method: "Σ other positions' notional at mark + resulting position notional", inputs: [], assumptions: [], asOf: input.now });
}

function preTradeLiquidation(input: PreTradeInput, ref: Decimal, existing: Decimal, resulting: Decimal, initialMargin: RiskValue): RiskValue {
  const { now, market, venue, order } = input;
  const unit = price(market.quote, market.base);
  if (order.reduceOnly) return unavailable(unit, "Not applicable: a reduce-only order cannot increase the position", [], now);
  if (!venue) return unavailable(unit, "No margin rules are known for this venue", ["Venue margin rules"], now);
  if (!isAvailable(initialMargin)) return unavailable(unit, initialMargin.reason, initialMargin.missing, now);
  const signedOrder = order.side === "buy" ? dec(order.size) : dec(order.size).neg();
  if (!existing.isZero() && existing.isPositive() !== signedOrder.isPositive()) {
    return unavailable(unit, "The order reduces or flips an existing position; the resulting liquidation price is not estimated", [], now);
  }
  let entry = ref;
  let collateral = dec(initialMargin.value);
  if (!existing.isZero() && input.position) {
    entry = existing.abs().mul(dec(input.position.entryPrice)).add(dec(order.size).mul(ref)).div(resulting.abs());
    collateral = collateral.add(dec(input.position.marginUsed));
  }
  const result = venue.liquidationPrice({
    market,
    side: order.side,
    size: resulting.abs(),
    entryPrice: entry,
    collateral,
    marginMode: order.marginMode,
    reportedLiquidationPrice: null,
  });
  if (!result.ok) return unavailable(unit, result.reason, result.missing, now);
  const rounded = roundDp(result.value, market.priceDecimals, order.side === "buy" ? "up" : "down");
  return available({
    value: toPlain(rounded),
    unit,
    kind: "estimate",
    method: result.method,
    inputs: [
      { name: "Entry price (after order)", value: toPlain(roundDp(entry, OUTPUT_DECIMALS.amount)), unit, source: "reference price, averaged with the existing position", observedAt: null },
      { name: "Position size (after order)", value: toPlain(resulting.abs()), unit: quantity(market.base), source: "order + existing position", observedAt: null },
      { name: "Collateral", value: amt(collateral), unit: amount(market.quote), source: "initial margin + existing position margin", observedAt: null },
    ],
    assumptions: [...result.assumptions, "Assumes the order fills entirely at the reference price.", "An estimate, not a guarantee: the venue may liquidate at a different price."],
    asOf: now,
  });
}
