import type { Fill, MarketId } from "../domain";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal, type DecimalString } from "../risk";
import { inWindow, type FundingPayment, type TimeWindow } from "./records";

const amt = (d: Decimal): DecimalString => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));

export interface FeesAndFunding {
  window: TimeWindow;
  /** Positive = paid. Rebates reduce it. */
  feesPaid: DecimalString;
  /** Positive = received, negative = paid. */
  fundingNet: DecimalString;
  fundingPaid: DecimalString;
  fundingReceived: DecimalString;
  /** feesPaid − fundingNet: total cost of trading and holding (positive = cost). */
  totalCost: DecimalString;
  byMarket: { marketId: MarketId; fees: DecimalString; funding: DecimalString }[];
  fillCount: number;
  fundingCount: number;
}

export function feesAndFunding(fills: readonly Fill[], funding: readonly FundingPayment[], window: TimeWindow): FeesAndFunding {
  const f = fills.filter((x) => inWindow(x.time, window));
  const p = funding.filter((x) => inWindow(x.time, window));
  const per = new Map<MarketId, { fees: Decimal; funding: Decimal }>();
  const at = (id: MarketId) => per.get(id) ?? per.set(id, { fees: ZERO, funding: ZERO }).get(id)!;
  let fees = ZERO;
  let paid = ZERO;
  let received = ZERO;
  for (const x of f) {
    fees = fees.add(dec(x.fee));
    at(x.marketId).fees = at(x.marketId).fees.add(dec(x.fee));
  }
  for (const x of p) {
    const a = dec(x.amount);
    if (a.isNegative()) paid = paid.add(a.neg());
    else received = received.add(a);
    at(x.marketId).funding = at(x.marketId).funding.add(a);
  }
  const net = received.sub(paid);
  return {
    window,
    feesPaid: amt(fees),
    fundingNet: amt(net),
    fundingPaid: amt(paid),
    fundingReceived: amt(received),
    totalCost: amt(fees.sub(net)),
    byMarket: [...per.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([marketId, v]) => ({ marketId, fees: amt(v.fees), funding: amt(v.funding) })),
    fillCount: f.length,
    fundingCount: p.length,
  };
}

export interface ExecutionSummary {
  window: TimeWindow;
  count: number;
  /** Σ size × price over fills. */
  notional: DecimalString;
  fees: DecimalString;
  realizedPnl: DecimalString;
  makerCount: number;
  takerCount: number;
  otherCount: number;
  byMarket: { marketId: MarketId; buys: number; sells: number; boughtSize: DecimalString; soldSize: DecimalString; notional: DecimalString; vwapBuy: DecimalString | null; vwapSell: DecimalString | null }[];
  /** Most recent first, at most `limit`. */
  recent: Fill[];
  first: number | null;
  last: number | null;
}

export function summarizeExecutions(fills: readonly Fill[], window: TimeWindow, limit = 10): ExecutionSummary {
  const f = fills.filter((x) => inWindow(x.time, window)).sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  type Acc = { buys: number; sells: number; bought: Decimal; sold: Decimal; buyCost: Decimal; sellValue: Decimal };
  const per = new Map<MarketId, Acc>();
  let notional = ZERO;
  let fees = ZERO;
  let realized = ZERO;
  let maker = 0;
  let taker = 0;
  for (const x of f) {
    const value = dec(x.size).mul(dec(x.price));
    notional = notional.add(value);
    fees = fees.add(dec(x.fee));
    realized = realized.add(dec(x.realizedPnl));
    if (x.liquidity === "maker") maker += 1;
    else if (x.liquidity === "taker") taker += 1;
    const a = per.get(x.marketId) ?? { buys: 0, sells: 0, bought: ZERO, sold: ZERO, buyCost: ZERO, sellValue: ZERO };
    if (x.side === "buy") {
      a.buys += 1;
      a.bought = a.bought.add(dec(x.size));
      a.buyCost = a.buyCost.add(value);
    } else {
      a.sells += 1;
      a.sold = a.sold.add(dec(x.size));
      a.sellValue = a.sellValue.add(value);
    }
    per.set(x.marketId, a);
  }
  return {
    window,
    count: f.length,
    notional: amt(notional),
    fees: amt(fees),
    realizedPnl: amt(realized),
    makerCount: maker,
    takerCount: taker,
    otherCount: f.length - maker - taker,
    byMarket: [...per.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([marketId, a]) => ({
        marketId,
        buys: a.buys,
        sells: a.sells,
        boughtSize: toPlain(a.bought),
        soldSize: toPlain(a.sold),
        notional: amt(a.buyCost.add(a.sellValue)),
        vwapBuy: a.bought.isZero() ? null : amt(a.buyCost.div(a.bought)),
        vwapSell: a.sold.isZero() ? null : amt(a.sellValue.div(a.sold)),
      })),
    recent: f.slice(0, limit),
    first: f.length ? f[f.length - 1]!.time : null,
    last: f.length ? f[0]!.time : null,
  };
}
