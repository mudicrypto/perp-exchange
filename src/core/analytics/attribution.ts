import type { Fill } from "../domain";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal, type DecimalString } from "../risk";
import { inWindow, type EquityObservation, type FundingPayment, type TimeWindow, type Transfer } from "./records";

const amt = (d: Decimal): DecimalString => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));

export interface EquityAttribution {
  window: TimeWindow;
  start: EquityObservation;
  end: EquityObservation;
  /** end.equity − start.equity */
  change: DecimalString;
  /** Σ realised PnL of fills in the window (before fees). */
  realizedPnl: DecimalString;
  /** Σ fees paid (positive = cost). Enters the identity with a minus sign. */
  fees: DecimalString;
  /** Σ funding received (negative = paid). */
  funding: DecimalString;
  /** Σ deposits (+) and withdrawals (−). Not trading performance. */
  transfers: DecimalString;
  /** end.unrealizedPnl − start.unrealizedPnl: price moves on open positions. */
  unrealizedChange: DecimalString;
  /** change − (realised − fees + funding + transfers + unrealised change). Non-zero means the records do not fully explain the change. */
  residual: DecimalString;
  fillCount: number;
  fundingCount: number;
  transferCount: number;
}

/**
 * Decomposes an equity change using the accounting identity
 *   Δequity = realised PnL − fees + funding + transfers + Δunrealised PnL
 * from recorded fills, funding payments and transfers inside the window.
 * Any amount the records do not explain is reported as a residual — never
 * silently absorbed into another component.
 */
export function attributeEquityChange(input: {
  window: TimeWindow;
  start: EquityObservation;
  end: EquityObservation;
  fills: readonly Fill[];
  funding: readonly FundingPayment[];
  transfers: readonly Transfer[];
}): EquityAttribution {
  const { window, start, end } = input;
  if (end.time < start.time) throw new RangeError("End observation precedes the start");
  const fills = input.fills.filter((f) => inWindow(f.time, window));
  const funding = input.funding.filter((p) => inWindow(p.time, window));
  const transfers = input.transfers.filter((t) => inWindow(t.time, window));
  const realized = fills.reduce((s, f) => s.add(dec(f.realizedPnl)), ZERO);
  const fees = fills.reduce((s, f) => s.add(dec(f.fee)), ZERO);
  const fundingSum = funding.reduce((s, p) => s.add(dec(p.amount)), ZERO);
  const transferSum = transfers.reduce((s, t) => s.add(dec(t.amount)), ZERO);
  const unrealizedChange = dec(end.unrealizedPnl).sub(dec(start.unrealizedPnl));
  const change = dec(end.equity).sub(dec(start.equity));
  const explained = realized.sub(fees).add(fundingSum).add(transferSum).add(unrealizedChange);
  return {
    window,
    start,
    end,
    change: amt(change),
    realizedPnl: amt(realized),
    fees: amt(fees),
    funding: amt(fundingSum),
    transfers: amt(transferSum),
    unrealizedChange: amt(unrealizedChange),
    residual: amt(change.sub(explained)),
    fillCount: fills.length,
    fundingCount: funding.length,
    transferCount: transfers.length,
  };
}
