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
