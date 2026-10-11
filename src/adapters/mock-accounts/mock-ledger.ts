import type { AccountSnapshot, Fill, Liquidity, Market, MarketId, Position, Side } from "@/core/domain";
import type { AccountHistory, AccountRecord, FundingPayment, Transfer } from "@/core/analytics";
import { constantRateIsolatedLiquidationPrice, dec, ruleUnavailable, ZERO, type Decimal, type FundingObservation, type Observed, type VenueMarginRules } from "@/core/risk";
import { SimulationEngine } from "../simulation/simulation-engine";

/**
 * Deterministic, internally consistent ledgers for MOCK accounts. Every
 * figure is fictitious and derived from scripted events plus a closed-form
 * price path, so cash, positions, fees, funding and equity always reconcile.
 */

const HOUR = 3_600_000;
export const MOCK_FEES = { taker: "0.00045", maker: "0.00015" } as const;
const MOCK_SOURCE = "Mock ledger (fictitious demo data)";

const markets: ReadonlyMap<MarketId, Market> = new Map([...new SimulationEngine(42).markets.values()].map((m) => [m.id, m.market]));
const basePrice: Record<string, number> = { "ALPHA-PERP": 1000, "BETA-PERP": 42.5, "GAMMA-PERP": 0.8 };

/** Closed-form mock mark price (quote per base) at time t, rounded to the market tick. */
export function mockPrice(marketId: MarketId, t: number): number {
  const market = markets.get(marketId);
  const base = basePrice[marketId];
  if (!market || base === undefined) throw new RangeError(`No mock price for ${marketId}`);
  const phase = marketId.length * 0.7;
  const x = 1 + 0.04 * Math.sin((2 * Math.PI * t) / (31 * HOUR) + phase) + 0.015 * Math.sin((2 * Math.PI * t) / (6.5 * HOUR) + 1.3 * phase);
  return Number((base * x).toFixed(market.priceDecimals));
}

/** Mock hourly funding rate (fraction per hour; positive = longs pay). */
export function mockFundingRate(marketId: MarketId, t: number): number {
  return Number((0.0000125 * (1 + 0.8 * Math.sin(t / (7 * HOUR) + marketId.length))).toFixed(10));
}

/** Mock venue: isolated margin, constant per-market maintenance rate, mock fees, hourly funding on the mark. */
export const mockVenueRules: VenueMarginRules = {
  venueId: "mock",
  venueName: "Mock venue",
  source: "Mock venue rules (src/adapters/mock-accounts/mock-ledger.ts)",
  initialMargin: ({ notional, leverage }) => ({ ok: true, value: notional.abs().div(leverage), kind: "calculated", method: "notional / leverage (mock venue)", assumptions: [] }),
  maintenanceMargin: ({ market, notional }) => ({ ok: true, value: notional.abs().mul(dec(market.maintenanceMarginRate)), kind: "calculated", method: `notional × ${market.maintenanceMarginRate} (mock venue)`, assumptions: [] }),
  liquidationPrice: ({ market, side, size, entryPrice, collateral, marginMode }) => {
    if (marginMode !== "isolated") return ruleUnavailable("The mock venue supports isolated margin only");
    const p = constantRateIsolatedLiquidationPrice({ side, size, entryPrice, collateral, maintenanceMarginRate: dec(market.maintenanceMarginRate) });
    return p ? { ok: true, value: p, kind: "estimate", method: "Isolated, constant maintenance rate (mock venue)", assumptions: ["Fees and funding are not included."] } : ruleUnavailable("The position cannot be liquidated by price alone");
  },
  feeRates: () => ({ ok: true, value: { taker: dec(MOCK_FEES.taker), maker: dec(MOCK_FEES.maker) }, kind: "calculated", method: "Mock venue fee schedule", assumptions: [] }),
  funding: { charged: true, priceBasis: "mark", source: "Mock venue: hourly, −size × mark × rate" },
};

export type ScriptedEvent =
  | { kind: "transfer"; hoursAgo: number; amount: number }
  | { kind: "fill"; hoursAgo: number; marketId: MarketId; side: Side; size: number; liquidity: Exclude<Liquidity, "rfq" | "liquidation"> };

export interface MockAccountScript {
  account: AccountRecord;
  leverage: number;
  events: ScriptedEvent[];
}

interface PositionState {
  size: Decimal;
  entry: Decimal | null;
}

interface LedgerEvent {
  time: number;
  apply(state: LedgerState): void;
}

interface LedgerState {
  cash: Decimal;
  positions: Map<MarketId, PositionState>;
  realized: Decimal;
  fees: Decimal;
}

/**
 * Builds a mock account's history; event times are relative to `anchor`
 * (fixed for the process lifetime). Funding keeps accruing hourly until
 * `horizon`; callers must not read records later than their `now`.
 */
export function buildMockHistory(script: MockAccountScript, anchor: number, horizon = anchor + 7 * 24 * HOUR): AccountHistory {
  const fills: Fill[] = [];
  const funding: FundingPayment[] = [];
  const transfers: Transfer[] = [];
  const events: LedgerEvent[] = [];
  const sorted = [...script.events].sort((a, b) => b.hoursAgo - a.hoursAgo);
  const openedAt = anchor - sorted[0]!.hoursAgo * HOUR;

  // Replay the script once to produce fills with realised PnL (average cost) and fees.
  const replay: LedgerState = { cash: ZERO, positions: new Map(), realized: ZERO, fees: ZERO };
  let seq = 0;
  for (const e of sorted) {
    const time = anchor - Math.round(e.hoursAgo * HOUR);
    if (e.kind === "transfer") {
      const t: Transfer = { id: `${script.account.id}-T${++seq}`, time, amount: e.amount };
      transfers.push(t);
      events.push({ time, apply: (s) => void (s.cash = s.cash.add(dec(t.amount))) });
      continue;
    }
    const price = dec(mockPrice(e.marketId, time));
    const size = dec(e.size);
    const fee = size.mul(price).mul(dec(e.liquidity === "maker" ? MOCK_FEES.maker : MOCK_FEES.taker));
    const realized = applyFill(replay, e.marketId, e.side, size, price);
    const fill: Fill = {
      id: `${script.account.id}-F${++seq}`,
      orderId: `${script.account.id}-O${seq}`,
      marketId: e.marketId,
      side: e.side,
      price: price.toNumber(),
      size: e.size,
      fee: fee.toNumber(),
      liquidity: e.liquidity,
      realizedPnl: realized.toNumber(),
      time,
      origin: "simulated",
    };
    fills.push(fill);
    events.push({
      time,
      apply: (s) => {
        const r = applyFill(s, fill.marketId, fill.side, dec(fill.size), dec(fill.price));
        s.realized = s.realized.add(r);
        s.fees = s.fees.add(dec(fill.fee));
        s.cash = s.cash.add(r).sub(dec(fill.fee));
      },
    });
  }

  // Hourly funding on open positions from the first fill until the anchor.
  const firstFill = fills[0]?.time;
  if (firstFill !== undefined) {
    const state: LedgerState = { cash: ZERO, positions: new Map(), realized: ZERO, fees: ZERO };
    const fillEvents = events.filter((e) => fills.some((f) => f.time === e.time));
    let i = 0;
    for (let h = Math.ceil(firstFill / HOUR) * HOUR; h <= horizon; h += HOUR) {
      while (i < fillEvents.length && fillEvents[i]!.time <= h) fillEvents[i++]!.apply(state);
      for (const [marketId, p] of state.positions) {
        if (p.size.isZero()) continue;
        const rate = mockFundingRate(marketId, h);
        const amount = p.size.mul(dec(mockPrice(marketId, h))).mul(dec(rate)).neg();
        const payment: FundingPayment = { id: `${script.account.id}-P${h}-${marketId}`, marketId, time: h, amount: amount.toNumber(), rate, positionSize: p.size.toNumber() };
        funding.push(payment);
        events.push({ time: h, apply: (s) => void (s.cash = s.cash.add(dec(payment.amount))) });
      }
    }
  }
  // Same-time ordering: transfers/fills before funding at that instant (funding uses the post-fill position).
  events.sort((a, b) => a.time - b.time);
  funding.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

  const snapshotAt = (time: number): AccountSnapshot | null => {
    if (time < openedAt || time > horizon) return null;
    const s: LedgerState = { cash: ZERO, positions: new Map(), realized: ZERO, fees: ZERO };
    for (const e of events) if (e.time <= time) e.apply(s);
    const positions: Position[] = [];
    let upnl = ZERO;
    let marginUsed = ZERO;
    let maintenance = ZERO;
    for (const [marketId, p] of [...s.positions].sort(([a], [b]) => a.localeCompare(b))) {
      if (p.size.isZero() || !p.entry) continue;
      const market = markets.get(marketId)!;
      const mark = dec(mockPrice(marketId, time));
      const pnl = p.size.mul(mark.sub(p.entry));
      const margin = p.size.abs().mul(p.entry).div(script.leverage);
      upnl = upnl.add(pnl);
      marginUsed = marginUsed.add(margin);
      maintenance = maintenance.add(p.size.abs().mul(mark).mul(dec(market.maintenanceMarginRate)));
      const liq = constantRateIsolatedLiquidationPrice({ side: p.size.isPositive() ? "buy" : "sell", size: p.size.abs(), entryPrice: p.entry, collateral: margin, maintenanceMarginRate: dec(market.maintenanceMarginRate) });
      positions.push({
        marketId,
        size: p.size.toNumber(),
        entryPrice: p.entry.toNumber(),
        leverage: script.leverage,
        marginMode: "isolated",
        marginUsed: margin.toNumber(),
        liquidationPrice: liq ? liq.toNumber() : null,
        markPrice: mark.toNumber(),
        unrealizedPnl: pnl.toNumber(),
      });
    }
    const equity = s.cash.add(upnl);
    return {
      origin: "simulated",
      currency: script.account.currency,
      balances: [{ asset: script.account.currency, total: s.cash.toNumber(), available: equity.sub(marginUsed).toNumber() }],
      balance: s.cash.toNumber(),
      equity: equity.toNumber(),
      unrealizedPnl: upnl.toNumber(),
      realizedPnl: s.realized.toNumber(),
      feesPaid: s.fees.toNumber(),
      marginUsed: marginUsed.toNumber(),
      orderMargin: 0,
      available: equity.sub(marginUsed).toNumber(),
      maintenanceMargin: maintenance.toNumber(),
      positions,
      observedAt: time,
    };
  };

  return {
    account: script.account,
    rules: mockVenueRules,
    markets,
    openedAt,
    snapshotAt,
    marks: (time) => new Map([...markets.keys()].map((id) => [id, { value: mockPrice(id, time), observedAt: time, source: "Mock price path" } satisfies Observed<number>])),
    fundingRates: (time) =>
      new Map(
        [...markets.keys()].map((id) => [id, { value: { rate: mockFundingRate(id, time), intervalHours: 1, oraclePrice: null }, observedAt: time, source: "Mock funding schedule" } satisfies Observed<FundingObservation>]),
      ),
    fills,
    funding,
    transfers,
    source: MOCK_SOURCE,
  };
}

/** Average-cost position update; returns realised PnL (before fees). */
function applyFill(state: LedgerState, marketId: MarketId, side: Side, size: Decimal, price: Decimal): Decimal {
  const p = state.positions.get(marketId) ?? { size: ZERO, entry: null };
  const signed = side === "buy" ? size : size.neg();
  let realized = ZERO;
  if (p.size.isZero() || p.size.isPositive() === signed.isPositive()) {
    const total = p.size.abs().add(size);
    p.entry = p.size.isZero() ? price : p.size.abs().mul(p.entry!).add(size.mul(price)).div(total);
    p.size = p.size.add(signed);
  } else {
    const closing = size.lt(p.size.abs()) ? size : p.size.abs();
    realized = price.sub(p.entry!).mul(closing).mul(p.size.isPositive() ? 1 : -1);
    const remaining = p.size.add(signed);
    if (remaining.isZero()) {
      p.size = ZERO;
      p.entry = null;
    } else if (remaining.isPositive() !== p.size.isPositive()) {
      p.size = remaining;
      p.entry = price;
    } else {
      p.size = remaining;
    }
  }
  state.positions.set(marketId, p);
  return realized;
}
