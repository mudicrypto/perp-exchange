import { z } from "zod";
import { MarketIdSchema } from "./market";
import { SideSchema } from "./market-data";
import { MarginModeSchema } from "./account";

export const OrderTypeSchema = z.enum(["market", "limit"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const TimeInForceSchema = z.enum(["gtc", "ioc", "post-only"]);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

/**
 * What the user wants to do, before any venue-specific encoding.
 * Validation of venue constraints (tick size, size decimals) happens in
 * `core/execution/order-intent.ts` against a `Market`.
 */
export const OrderIntentSchema = z
  .object({
    marketId: MarketIdSchema,
    side: SideSchema,
    type: OrderTypeSchema,
    size: z.number().positive(),
    /** Required for limit orders. */
    limitPrice: z.number().positive().nullable(),
    timeInForce: TimeInForceSchema,
    reduceOnly: z.boolean(),
    leverage: z.number().positive(),
    marginMode: MarginModeSchema,
  })
  .superRefine((intent, ctx) => {
    if (intent.type === "limit" && intent.limitPrice === null) {
      ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "Limit price is required" });
    }
    if (intent.type === "market" && intent.timeInForce === "post-only") {
      ctx.addIssue({ code: "custom", path: ["timeInForce"], message: "Market orders cannot be post-only" });
    }
  });
export type OrderIntent = z.infer<typeof OrderIntentSchema>;

/**
 * Order lifecycle states. Reconciliation (M3) moves orders between these
 * states only on venue-confirmed events.
 */
export const ORDER_STATUSES = [
  "draft",
  "pending-submit",
  "open",
  "partially-filled",
  "filled",
  "cancel-pending",
  "cancelled",
  "rejected",
  "unknown",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OrderStatusSchema = z.enum(ORDER_STATUSES);

/** Terminal states: the order can no longer change. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return status === "filled" || status === "cancelled" || status === "rejected";
}

export const OrderSchema = z.object({
  id: z.string().min(1),
  marketId: MarketIdSchema,
  side: SideSchema,
  type: OrderTypeSchema,
  /** Limit price; null for market orders. */
  price: z.number().positive().nullable(),
  size: z.number().positive(),
  filledSize: z.number().nonnegative(),
  /** Volume-weighted fill price; null until something fills. */
  averageFillPrice: z.number().positive().nullable(),
  status: OrderStatusSchema,
  timeInForce: TimeInForceSchema,
  reduceOnly: z.boolean(),
  leverage: z.number().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Why the order was rejected or why its remainder was cancelled. */
  statusReason: z.string().nullable(),
});
export type Order = z.infer<typeof OrderSchema>;

export const LiquiditySchema = z.enum(["maker", "taker", "liquidation"]);
export type Liquidity = z.infer<typeof LiquiditySchema>;

export const FillSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().nullable(),
  marketId: MarketIdSchema,
  side: SideSchema,
  price: z.number().positive(),
  size: z.number().positive(),
  /** Fee paid in quote units (negative = rebate). */
  fee: z.number(),
  liquidity: LiquiditySchema,
  /** PnL realised by this fill (closing part only). */
  realizedPnl: z.number(),
  time: z.number().int().nonnegative(),
});
export type Fill = z.infer<typeof FillSchema>;
