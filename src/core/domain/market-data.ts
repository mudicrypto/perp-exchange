import { z } from "zod";
import { MarketIdSchema } from "./market";

export const SideSchema = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof SideSchema>;

export const BookLevelSchema = z.object({
  price: z.number().positive(),
  size: z.number().positive(),
  /** Number of orders at this level, when the venue reports it. */
  orders: z.number().int().nonnegative().nullable(),
});
export type BookLevel = z.infer<typeof BookLevelSchema>;

export const OrderBookSnapshotSchema = z.object({
  marketId: MarketIdSchema,
  /** Best first: highest bid first. */
  bids: z.array(BookLevelSchema),
  /** Best first: lowest ask first. */
  asks: z.array(BookLevelSchema),
  /** Venue timestamp of the snapshot (ms). Used for ordering. */
  venueTime: z.number().int().nonnegative(),
});
export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;

export const TradeSchema = z.object({
  marketId: MarketIdSchema,
  /** Venue-unique trade id, used for de-duplication. */
  id: z.string().min(1),
  /** Aggressor side. */
  side: SideSchema,
  price: z.number().positive(),
  size: z.number().positive(),
  venueTime: z.number().int().nonnegative(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export const CandleIntervalSchema = z.enum(CANDLE_INTERVALS);
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export const CandleSchema = z.object({
  /** Open time (ms). */
  openTime: z.number().int().nonnegative(),
  open: z.number().positive(),
  high: z.number().positive(),
  low: z.number().positive(),
  close: z.number().positive(),
  /** Base-unit volume. */
  volume: z.number().nonnegative(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const CandleListSchema = z.array(CandleSchema);
