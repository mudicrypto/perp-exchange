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
  /** Venue-reported liquidation price, if any. */
  liquidationPrice: z.number().positive().nullable(),
});
export type Position = z.infer<typeof PositionSchema>;

export const AccountSnapshotSchema = z.object({
  /** Total account equity (quote units). */
  equity: z.number(),
  /** Collateral available for new positions (quote units). */
  available: z.number(),
  maintenanceMargin: z.number().nonnegative(),
  positions: z.array(PositionSchema),
  observedAt: z.number().int().nonnegative(),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;
