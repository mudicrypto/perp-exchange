import { z } from "zod";
import { MarketIdSchema } from "./market";

export const MarginModeSchema = z.enum(["cross", "isolated"]);
export type MarginMode = z.infer<typeof MarginModeSchema>;

export const PositionSchema = z.object({
  marketId: MarketIdSchema,
  /** Signed size in base units: positive = long, negative = short. */
  size: z.number().refine((n) => n !== 0, "Position size cannot be zero"),
  entryPrice: z.number().positive(),
  leverage: z.number().positive(),
  marginMode: MarginModeSchema,
  /** Margin allocated to this position (quote units). */
  marginUsed: z.number().nonnegative(),
  /** Liquidation price as reported (or, for the simulator, enforced) by the venue. */
  liquidationPrice: z.number().positive().nullable(),
  /** Latest mark price used for the PnL figures below, if known. */
  markPrice: z.number().positive().nullable(),
  unrealizedPnl: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

export const BalanceSchema = z.object({
  asset: z.string().min(1),
  total: z.number(),
  /** Amount usable as new margin. */
  available: z.number(),
});
export type Balance = z.infer<typeof BalanceSchema>;

export const AccountSnapshotSchema = z.object({
  /** "simulated" for the paper account; "venue" for data read from a real venue. */
  origin: z.enum(["simulated", "venue"]),
  /** Collateral currency, e.g. "USDC" or "SIMUSD" for the simulator. */
  currency: z.string().min(1),
  balances: z.array(BalanceSchema),
  /*
   * Fields a venue does not report are null — never derived or guessed.
   */
  /** Cash balance: deposits + realised PnL − fees (quote units). */
  balance: z.number().nullable(),
  /** Account value including unrealised PnL. */
  equity: z.number(),
  unrealizedPnl: z.number(),
  realizedPnl: z.number().nullable(),
  feesPaid: z.number().nonnegative().nullable(),
  /** Margin locked by open positions. */
  marginUsed: z.number().nonnegative(),
  /** Margin reserved by resting orders. */
  orderMargin: z.number().nonnegative().nullable(),
  /** Collateral available for new positions / withdrawal (quote units). */
  available: z.number(),
  maintenanceMargin: z.number().nonnegative().nullable(),
  positions: z.array(PositionSchema),
  observedAt: z.number().int().nonnegative(),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;
