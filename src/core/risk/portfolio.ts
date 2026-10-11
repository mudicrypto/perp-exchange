import type { AccountSnapshot, Fill, Market, MarketId, Position } from "../domain";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal } from "./decimal";
import { checkFreshness, DEFAULT_FRESHNESS, type FreshnessPolicy, type Observed } from "./freshness";
import type { VenueMarginRules } from "./margin-rules";
import { feesFromFills, realizedPnlFromFills } from "./pnl";
import { amount, fraction, multiple, perInterval, price, quantity } from "./units";
import { available, isAvailable, unavailable, type AvailableValue, type RiskInput, type RiskValue } from "./value";

export interface FundingObservation {
  /** Fraction per interval (0.0001 = 0.01 %). Positive: longs pay shorts. */
  rate: number;
  intervalHours: number;
  oraclePrice: number | null;
}

/** Everything a portfolio assessment may use. Missing pieces make dependent figures unavailable. */
export interface RiskContext {
  now: number;
  venue: VenueMarginRules | null;
  account: Observed<AccountSnapshot> | null;
  markets: ReadonlyMap<MarketId, Market>;
  /** Mark prices by market (quote per base). Position-embedded marks are used only when absent here. */
  marks: ReadonlyMap<MarketId, Observed<number>>;
  funding: ReadonlyMap<MarketId, Observed<FundingObservation>>;
  /** Complete fill history of the account, if Nova has one. */
  fills: Observed<readonly Fill[]> | null;
  freshness?: FreshnessPolicy;
}

export interface PositionRisk {
  marketId: MarketId;
  direction: "long" | "short";
  size: RiskValue;
  entryPrice: RiskValue;
  markPrice: RiskValue;
  /** |size| × mark. Exposure, not collateral and not a maximum loss. */
  notional: RiskValue;
  /** size × mark (negative for shorts). */
  signedExposure: RiskValue;
  unrealizedPnl: RiskValue;
  /** Collateral the venue allocates to the position (isolated) — not the maximum loss. */
  collateral: RiskValue;
  liquidationPrice: RiskValue;
  /** |mark − liquidation| / mark. */
  liquidationDistance: RiskValue;
  /** Projected funding for the next interval at the current rate; positive = received. */
  fundingNextInterval: RiskValue;
}

export interface InstrumentExposure {
  marketId: MarketId;
  direction: "long" | "short";
  notional: RiskValue;
  /** Share of gross exposure (fraction). */
  share: RiskValue;
}

export interface PortfolioRiskReport {
  asOf: number;
  currency: string | null;
  venueName: string | null;
  positions: PositionRisk[];
  exposure: {
    byInstrument: InstrumentExposure[];
    long: RiskValue;
    short: RiskValue;
    gross: RiskValue;
    net: RiskValue;
  };
  concentration: {
    /** Largest single-instrument share of gross exposure. */
    largestShare: RiskValue;
    largestMarketId: MarketId | null;
    /** Herfindahl–Hirschman index of shares: 1 = one instrument; 1/n = n equal instruments. */
    hhi: RiskValue;
  };
  margin: {
    equity: RiskValue;
    collateralInUse: RiskValue;
    maintenanceMargin: RiskValue;
    /** collateral in use / equity. */
    initialUtilization: RiskValue;
    /** maintenance margin / equity; at 1 the account is at its liquidation threshold. */
    maintenanceUtilization: RiskValue;
    /** gross exposure / equity. */
    effectiveLeverage: RiskValue;
  };
  pnl: {
    unrealized: RiskValue;
    realized: RiskValue;
    fees: RiskValue;
    fundingPaid: RiskValue;
    fundingNextInterval: RiskValue;
  };
}

const NOT_MAX_LOSS =
  "Collateral is not a maximum loss: liquidation can execute at a worse price than estimated, and fees and funding are extra.";

/** Rounded output helpers (all calculations stay unrounded until here). */
const amt = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));
const frac = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.fraction));

interface ResolvedMark {
  mark: Decimal;
  input: RiskInput;
}

function resolveMark(ctx: RiskContext, position: Position, market: Market | undefined): ResolvedMark | { error: string } {
  const freshness = ctx.freshness ?? DEFAULT_FRESHNESS;
  const quote = market?.quote ?? ctx.account?.value.currency ?? "quote";
  const base = market?.base ?? position.marketId;
  const observed: Observed<number> | null =
    ctx.marks.get(position.marketId) ??
    (position.markPrice !== null && ctx.account
      ? { value: position.markPrice, observedAt: ctx.account.observedAt, source: "venue account snapshot" }
      : null);
  if (!observed) return { error: `No mark price for ${position.marketId}` };
  const fresh = checkFreshness(observed.observedAt, ctx.now, freshness.markPriceMs, `Mark price for ${position.marketId}`);
  if (!fresh.fresh) return { error: fresh.reason };
  return {
    mark: dec(observed.value),
    input: { name: "Mark price", value: toPlain(dec(observed.value)), unit: price(quote, base), source: observed.source, observedAt: observed.observedAt },
  };
}

function positionRisk(ctx: RiskContext, position: Position): PositionRisk {
  const now = ctx.now;
  const market = ctx.markets.get(position.marketId);
  const quote = market?.quote ?? ctx.account?.value.currency ?? "quote";
  const base = market?.base ?? position.marketId;
  const accountObservedAt = ctx.account?.observedAt ?? null;
  const size = dec(position.size);
  const absSize = size.abs();
  const entry = dec(position.entryPrice);
  const sizeInput: RiskInput = { name: "Position size", value: toPlain(size), unit: quantity(base), source: "venue account", observedAt: accountObservedAt };
  const entryInput: RiskInput = { name: "Entry price", value: toPlain(entry), unit: price(quote, base), source: "venue account", observedAt: accountObservedAt };
  const direction = size.gt(ZERO) ? "long" : "short";

  const sizeValue = available({ value: toPlain(size), unit: quantity(base), kind: "venue-reported", method: "Signed size as reported (+ long, − short)", inputs: [sizeInput], assumptions: [], asOf: now });
  const entryValue = available({ value: toPlain(entry), unit: price(quote, base), kind: "venue-reported", method: "Average entry price as reported", inputs: [entryInput], assumptions: [], asOf: now });
  const collateralValue: RiskValue =
    position.marginMode === "isolated"
      ? available({
          value: amt(dec(position.marginUsed)),
          unit: amount(quote),
          kind: "venue-reported",
          method: "Margin allocated to this isolated position",
          inputs: [{ name: "Margin used", value: toPlain(dec(position.marginUsed)), unit: amount(quote), source: "venue account", observedAt: accountObservedAt }],
          assumptions: [NOT_MAX_LOSS],
          asOf: now,
        })
      : unavailable(amount(quote), "Cross margin: the position draws on the whole account's collateral", [], now);

  const resolved = resolveMark(ctx, position, market);
  if ("error" in resolved) {
    const u = (unit: Parameters<typeof unavailable>[0]) => unavailable(unit, resolved.error, ["Mark price"], now);
    return {
      marketId: position.marketId,
      direction,
      size: sizeValue,
      entryPrice: entryValue,
      markPrice: u(price(quote, base)),
      notional: u(amount(quote)),
      signedExposure: u(amount(quote)),
      unrealizedPnl: u(amount(quote)),
      collateral: collateralValue,
      liquidationPrice: liquidationValue(ctx, position, market, null),
      liquidationDistance: u(fraction),
      fundingNextInterval: u(amount(quote)),
    };
  }
  const { mark, input: markInput } = resolved;
  const notional = absSize.mul(mark);
  const liquidation = liquidationValue(ctx, position, market, markInput);
  const liqDistance: RiskValue = isAvailable(liquidation)
    ? available({
        value: frac(mark.sub(dec(liquidation.value)).abs().div(mark)),
        unit: fraction,
        kind: liquidation.kind === "venue-reported" ? "calculated" : "estimate",
        method: "|mark − liquidation price| / mark",
        inputs: [markInput, { name: "Liquidation price", value: liquidation.value, unit: price(quote, base), source: liquidation.method, observedAt: null }],
        assumptions: liquidation.assumptions,
        asOf: now,
      })
    : unavailable(fraction, liquidation.reason, liquidation.missing, now);

  return {
    marketId: position.marketId,
    direction,
    size: sizeValue,
    entryPrice: entryValue,
    markPrice: available({ value: markInput.value, unit: price(quote, base), kind: "venue-reported", method: `Mark price (${markInput.source})`, inputs: [markInput], assumptions: [], asOf: now }),
    notional: available({ value: amt(notional), unit: amount(quote), kind: "calculated", method: "|size| × mark", inputs: [sizeInput, markInput], assumptions: ["Notional is exposure, not collateral and not a maximum loss."], asOf: now }),
    signedExposure: available({ value: amt(size.mul(mark)), unit: amount(quote), kind: "calculated", method: "size × mark (negative = short)", inputs: [sizeInput, markInput], assumptions: [], asOf: now }),
    unrealizedPnl: available({
      value: amt(size.mul(mark.sub(entry))),
      unit: amount(quote),
      kind: "calculated",
      method: "size × (mark − entry)",
      inputs: [sizeInput, entryInput, markInput],
      assumptions: ["Valued at the mark price; closing would execute at book prices and pay fees."],
      asOf: now,
    }),
    collateral: collateralValue,
    liquidationPrice: liquidation,
    liquidationDistance: liqDistance,
    fundingNextInterval: fundingProjection(ctx, position, size, mark, markInput, quote),
  };
}

function liquidationValue(ctx: RiskContext, position: Position, market: Market | undefined, markInput: RiskInput | null): RiskValue {
  const now = ctx.now;
  const quote = market?.quote ?? ctx.account?.value.currency ?? "quote";
  const unit = price(quote, market?.base ?? position.marketId);
  if (!ctx.venue) return unavailable(unit, "No margin rules are known for this venue", ["Venue margin rules"], now);
  if (!market) return unavailable(unit, `Market metadata for ${position.marketId} is missing`, ["Market metadata"], now);
  const size = dec(position.size);
  const result = ctx.venue.liquidationPrice({
    market,
    side: size.gt(ZERO) ? "buy" : "sell",
    size: size.abs(),
    entryPrice: dec(position.entryPrice),
    collateral: dec(position.marginUsed),
    marginMode: position.marginMode,
    reportedLiquidationPrice: position.liquidationPrice === null ? null : dec(position.liquidationPrice),
  });
  if (!result.ok) return unavailable(unit, result.reason, result.missing, now);
  // Rounded to the price tick *toward the mark*, so the displayed level is never further away than computed.
  const rounded = roundDp(result.value, market.priceDecimals, size.gt(ZERO) ? "up" : "down");
  return available({
    value: toPlain(rounded),
    unit,
    kind: result.kind,
    method: result.method,
    inputs: [
      { name: "Entry price", value: toPlain(dec(position.entryPrice)), unit, source: "venue account", observedAt: ctx.account?.observedAt ?? null },
      { name: "Position size", value: toPlain(size), unit: quantity(market.base), source: "venue account", observedAt: ctx.account?.observedAt ?? null },
      { name: "Collateral", value: toPlain(dec(position.marginUsed)), unit: amount(quote), source: "venue account", observedAt: ctx.account?.observedAt ?? null },
      ...(markInput ? [markInput] : []),
    ],
    assumptions: [...result.assumptions, "An estimate, not a guarantee: the venue may liquidate at a different price."],
    asOf: now,
  });
}

function fundingProjection(ctx: RiskContext, position: Position, size: Decimal, mark: Decimal, markInput: RiskInput, quote: string): RiskValue {
  const now = ctx.now;
  const freshness = ctx.freshness ?? DEFAULT_FRESHNESS;
  const unit = amount(quote);
  const rule = ctx.venue?.funding;
  if (!rule) return unavailable(unit, "No funding rules are known for this venue", ["Venue funding rules"], now);
  if (!rule.charged) {
    return available({ value: "0", unit, kind: "calculated", method: rule.reason, inputs: [], assumptions: [], asOf: now });
  }
  const obs = ctx.funding.get(position.marketId);
  if (!obs) return unavailable(unit, `No funding rate for ${position.marketId}`, ["Funding rate"], now);
  const fresh = checkFreshness(obs.observedAt, now, freshness.fundingMs, "Funding rate");
  if (!fresh.fresh) return unavailable(unit, fresh.reason, ["Funding rate"], now);
  let basis = mark;
  let basisInput = markInput;
  if (rule.priceBasis === "oracle") {
    if (obs.value.oraclePrice === null) return unavailable(unit, "The venue computes funding on the oracle price, which is not available", ["Oracle price"], now);
    basis = dec(obs.value.oraclePrice);
    basisInput = { name: "Oracle price", value: toPlain(basis), unit: markInput.unit, source: obs.source, observedAt: obs.observedAt };
  }
  const rate = dec(obs.value.rate);
  // Positive rate: longs pay shorts. Payment received = −size × price × rate.
  const received = size.mul(basis).mul(rate).neg();
  return available({
    value: amt(received),
    unit,
    kind: "estimate",
    method: `−size × ${rule.priceBasis} price × funding rate (positive = received)`,
    inputs: [
      { name: "Position size", value: toPlain(size), unit: null, source: "venue account", observedAt: ctx.account?.observedAt ?? null },
      basisInput,
      { name: "Funding rate", value: toPlain(rate), unit: perInterval(obs.value.intervalHours), source: obs.source, observedAt: obs.observedAt },
    ],
    assumptions: [`Assumes the current rate and price hold for the next ${obs.value.intervalHours}h interval; funding rates change.`, rule.source],
    asOf: now,
  });
}

/** Sums available values; unavailable if any part is unavailable. */
function sumValues(values: RiskValue[], unit: ReturnType<typeof amount>, method: string, now: number, assumptions: string[] = []): RiskValue {
  const missing = values.filter((v) => !isAvailable(v));
  if (missing.length > 0) {
    const first = missing[0] as Exclude<RiskValue, AvailableValue>;
    return unavailable(unit, `${missing.length} component(s) unavailable: ${first.reason}`, [...new Set(missing.flatMap((m) => (m.status === "unavailable" ? m.missing : [])))], now);
  }
  const total = (values as AvailableValue[]).reduce((s, v) => s.add(dec(v.value)), ZERO);
  const kinds = new Set((values as AvailableValue[]).map((v) => v.kind));
  return available({
    value: amt(total),
    unit,
    kind: kinds.has("estimate") ? "estimate" : "calculated",
    method,
    inputs: (values as AvailableValue[]).flatMap((v) => v.inputs),
    assumptions: [...new Set([...assumptions, ...(values as AvailableValue[]).flatMap((v) => v.assumptions)])],
    asOf: now,
  });
}

function ratio(numerator: RiskValue, denominator: RiskValue, method: string, unit: typeof fraction | typeof multiple, now: number, assumptions: string[] = []): RiskValue {
  if (!isAvailable(numerator)) return unavailable(unit, numerator.reason, numerator.missing, now);
  if (!isAvailable(denominator)) return unavailable(unit, denominator.reason, denominator.missing, now);
  const d = dec(denominator.value);
  if (d.lte(ZERO)) return unavailable(unit, "Equity is zero or negative; the ratio is undefined", [], now);
  return available({
    value: frac(dec(numerator.value).div(d)),
    unit,
    kind: numerator.kind === "estimate" || denominator.kind === "estimate" ? "estimate" : "calculated",
    method,
    inputs: [...numerator.inputs, ...denominator.inputs],
    assumptions: [...new Set([...assumptions, ...numerator.assumptions, ...denominator.assumptions])],
    asOf: now,
  });
}

/**
 * Portfolio risk at `ctx.now`. Pure and deterministic: the same context
 * always yields the same report. Any figure whose inputs are missing or stale
 * is returned as unavailable instead of being approximated.
 */
export function assessPortfolio(ctx: RiskContext): PortfolioRiskReport {
  const now = ctx.now;
  const freshness = ctx.freshness ?? DEFAULT_FRESHNESS;
  const currency = ctx.account?.value.currency ?? null;
  const unit = amount(currency ?? "quote");
  const accountFresh = ctx.account ? checkFreshness(ctx.account.observedAt, now, freshness.accountMs, "Account snapshot") : null;
  const noAccount = (u: Parameters<typeof unavailable>[0]) =>
    unavailable(u, !ctx.account ? "No account data" : accountFresh && !accountFresh.fresh ? accountFresh.reason : "No account data", ["Account snapshot"], now);

  const empty: PortfolioRiskReport = {
    asOf: now,
    currency,
    venueName: ctx.venue?.venueName ?? null,
    positions: [],
    exposure: { byInstrument: [], long: noAccount(unit), short: noAccount(unit), gross: noAccount(unit), net: noAccount(unit) },
    concentration: { largestShare: noAccount(fraction), largestMarketId: null, hhi: noAccount(fraction) },
    margin: {
      equity: noAccount(unit),
      collateralInUse: noAccount(unit),
      maintenanceMargin: noAccount(unit),
      initialUtilization: noAccount(fraction),
      maintenanceUtilization: noAccount(fraction),
      effectiveLeverage: noAccount(multiple),
    },
    pnl: { unrealized: noAccount(unit), realized: noAccount(unit), fees: noAccount(unit), fundingPaid: noAccount(unit), fundingNextInterval: noAccount(unit) },
  };
  if (!ctx.account || !accountFresh?.fresh) return empty;

  const account = ctx.account.value;
  const accountInput = (name: string, v: number): RiskInput => ({ name, value: toPlain(dec(v)), unit, source: "venue account", observedAt: ctx.account!.observedAt });
  const positions = account.positions.map((p) => positionRisk(ctx, p));

  // ---- exposure
  const signed = positions.map((p) => p.signedExposure);
  const longs = positions.filter((p) => p.direction === "long").map((p) => p.notional);
  const shorts = positions.filter((p) => p.direction === "short").map((p) => p.notional);
  const long = sumValues(longs, unit, "Σ notional of long positions", now);
  const short = sumValues(shorts, unit, "Σ notional of short positions", now);
  const gross = sumValues([...longs, ...shorts], unit, "Σ |size| × mark over all positions", now, ["Gross exposure is notional, not collateral and not a maximum loss."]);
  const net = sumValues(signed, unit, "Σ size × mark (long − short)", now);

  const byInstrument: InstrumentExposure[] = positions.map((p) => ({
    marketId: p.marketId,
    direction: p.direction,
    notional: p.notional,
    share: ratio(p.notional, gross, "instrument notional / gross exposure", fraction, now),
  }));

  // ---- concentration
  let largestShare: RiskValue = unavailable(fraction, "No open positions", [], now);
  let largestMarketId: MarketId | null = null;
  let hhi: RiskValue = unavailable(fraction, "No open positions", [], now);
  if (positions.length > 0) {
    const shares = byInstrument.map((e) => e.share);
    const missingShare = shares.find((s) => !isAvailable(s));
    if (missingShare && missingShare.status === "unavailable") {
      largestShare = unavailable(fraction, missingShare.reason, missingShare.missing, now);
      hhi = unavailable(fraction, missingShare.reason, missingShare.missing, now);
    } else if (isAvailable(gross) && dec(gross.value).gt(ZERO)) {
      const grossD = dec(gross.value);
      // Shares per instrument (several positions in one market cannot exist, but aggregate defensively).
      const perMarket = new Map<MarketId, Decimal>();
      for (const p of positions) perMarket.set(p.marketId, (perMarket.get(p.marketId) ?? ZERO).add(dec((p.notional as AvailableValue).value)));
      let best: [MarketId, Decimal] | null = null;
      let h = ZERO;
      for (const [id, n] of perMarket) {
        const s = n.div(grossD);
        h = h.add(s.mul(s));
        if (!best || s.gt(best[1])) best = [id, s];
      }
      largestMarketId = best![0];
      const inputs = (gross as AvailableValue).inputs;
      largestShare = available({ value: frac(best![1]), unit: fraction, kind: "calculated", method: `largest instrument notional / gross exposure (${best![0]})`, inputs, assumptions: [], asOf: now });
      hhi = available({ value: frac(h), unit: fraction, kind: "calculated", method: "Σ (instrument share)²; 1 = a single instrument, 1/n = n equal instruments", inputs, assumptions: [], asOf: now });
    } else {
      largestShare = unavailable(fraction, "Gross exposure is zero", [], now);
      hhi = unavailable(fraction, "Gross exposure is zero", [], now);
    }
  }

  // ---- margin
  const equity = available({ value: amt(dec(account.equity)), unit, kind: "venue-reported", method: "Account equity (collateral + unrealised PnL) as reported", inputs: [accountInput("Equity", account.equity)], assumptions: [], asOf: now });
  const collateralInUse = available({
    value: amt(dec(account.marginUsed)),
    unit,
    kind: "venue-reported",
    method: "Margin locked by open positions, as reported",
    inputs: [accountInput("Margin used", account.marginUsed)],
    assumptions: [NOT_MAX_LOSS],
    asOf: now,
  });
  let maintenanceMargin: RiskValue;
  if (account.maintenanceMargin !== null) {
    maintenanceMargin = available({ value: amt(dec(account.maintenanceMargin)), unit, kind: "venue-reported", method: "Maintenance margin as reported by the venue", inputs: [accountInput("Maintenance margin", account.maintenanceMargin)], assumptions: [], asOf: now });
  } else if (ctx.venue) {
    const parts: RiskValue[] = positions.map((p) => {
      const market = ctx.markets.get(p.marketId);
      if (!market) return unavailable(unit, `Market metadata for ${p.marketId} is missing`, ["Market metadata"], now);
      if (!isAvailable(p.notional)) return p.notional;
      const r = ctx.venue!.maintenanceMargin({ market, notional: dec(p.notional.value) });
      return r.ok
        ? available({ value: amt(r.value), unit, kind: r.kind, method: r.method, inputs: p.notional.inputs, assumptions: r.assumptions, asOf: now })
        : unavailable(unit, r.reason, r.missing, now);
    });
    maintenanceMargin = sumValues(parts, unit, `Σ maintenance margin per position (${ctx.venue.venueName} rules)`, now);
  } else {
    maintenanceMargin = unavailable(unit, "The venue does not report maintenance margin and no margin rules are known", ["Venue margin rules"], now);
  }

  // ---- PnL, fees, funding
  const unrealized = sumValues(positions.map((p) => p.unrealizedPnl), unit, "Σ size × (mark − entry)", now);
  const realized = ctx.fills
    ? realizedPnlFromFills(ctx.fills, unit, now)
    : account.realizedPnl !== null
      ? available({ value: amt(dec(account.realizedPnl)), unit, kind: "venue-reported", method: "Realised PnL as reported by the venue", inputs: [accountInput("Realised PnL", account.realizedPnl)], assumptions: [], asOf: now })
      : unavailable(unit, "No reliable execution records: the venue does not report realised PnL and Nova has no fill history", ["Fill history"], now);
  const fees = ctx.fills
    ? feesFromFills(ctx.fills, unit, now)
    : account.feesPaid !== null
      ? available({ value: amt(dec(account.feesPaid)), unit, kind: "venue-reported", method: "Fees paid as reported", inputs: [accountInput("Fees paid", account.feesPaid)], assumptions: [], asOf: now })
      : unavailable(unit, "No fee records available", ["Fill history"], now);
  const fundingPaid: RiskValue =
    ctx.venue?.funding.charged === false
      ? available({ value: "0", unit, kind: "calculated", method: ctx.venue.funding.reason, inputs: [], assumptions: [], asOf: now })
      : unavailable(unit, "No funding payment records are loaded for this account", ["Funding history"], now);
  const fundingNextInterval = sumValues(positions.map((p) => p.fundingNextInterval), unit, "Σ projected funding per position (positive = received)", now);

  return {
    asOf: now,
    currency,
    venueName: ctx.venue?.venueName ?? null,
    positions,
    exposure: { byInstrument, long, short, gross, net },
    concentration: { largestShare, largestMarketId, hhi },
    margin: {
      equity,
      collateralInUse,
      maintenanceMargin,
      initialUtilization: ratio(collateralInUse, equity, "collateral in use / equity", fraction, now),
      maintenanceUtilization: ratio(maintenanceMargin, equity, "maintenance margin / equity (1 = liquidation threshold)", fraction, now),
      effectiveLeverage: ratio(gross, equity, "gross exposure / equity", multiple, now),
    },
    pnl: { unrealized, realized, fees, fundingPaid, fundingNextInterval },
  };
}
