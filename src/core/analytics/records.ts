import { z } from "zod";
import { MarketIdSchema } from "../domain";

/** A funding payment on a position. `amount` is in quote units: positive = received, negative = paid. */
export const FundingPaymentSchema = z.object({
  id: z.string().min(1),
  marketId: MarketIdSchema,
  time: z.number().int().nonnegative(),
  amount: z.number(),
  /** Fraction per interval that was applied. */
  rate: z.number(),
  /** Signed position size the payment was computed on. */
  positionSize: z.number(),
});
export type FundingPayment = z.infer<typeof FundingPaymentSchema>;

/** Collateral moved in (positive, deposit) or out (negative, withdrawal), in quote units. */
export const TransferSchema = z.object({
  id: z.string().min(1),
  time: z.number().int().nonnegative(),
  amount: z.number(),
});
export type Transfer = z.infer<typeof TransferSchema>;

/** Account equity as recorded at a point in time. */
export const EquityObservationSchema = z.object({
  time: z.number().int().nonnegative(),
  equity: z.number(),
  unrealizedPnl: z.number(),
  source: z.string(),
});
export type EquityObservation = z.infer<typeof EquityObservationSchema>;

/** A half-open time window (from, to] in ms since epoch, with a human label. */
export interface TimeWindow {
  from: number;
  to: number;
  label: string;
}

export const PERIODS = ["today", "24h", "7d"] as const;
export type Period = (typeof PERIODS)[number];

/** Windows are in UTC; "today" starts at 00:00 UTC. */
export function periodWindow(period: Period, now: number): TimeWindow {
  switch (period) {
    case "today": {
      const d = new Date(now);
      const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      return { from, to: now, label: "today (since 00:00 UTC)" };
    }
    case "24h":
      return { from: now - 24 * 3_600_000, to: now, label: "the last 24 hours" };
    case "7d":
      return { from: now - 7 * 24 * 3_600_000, to: now, label: "the last 7 days" };
  }
}

export const inWindow = (time: number, w: TimeWindow) => time > w.from && time <= w.to;
