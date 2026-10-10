import { z } from "zod";
import { MarketIdSchema } from "./market";
import { SideSchema } from "./market-data";
import { MarginModeSchema } from "./account";

/**
 * Where a trading record came from. Simulated records must never be
 * presented as venue records; the UI labels them explicitly.
 */
export const OriginSchema = z.enum(["simulated", "venue"]);
export type Origin = z.infer<typeof OriginSchema>;

// ---------------------------------------------------------------- order types

export const ORDER_TYPES = [
  "limit",
  "market",
  "stop-market",
  "stop-limit",
  "take-profit-market",
  "take-profit-limit",
  "iceberg",
  "hidden",
  /** A bilateral trade executed from an accepted RFQ quote (never submitted as a request). */
  "rfq",
] as const;
export const OrderTypeSchema = z.enum(ORDER_TYPES);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const TimeInForceSchema = z.enum(["gtc", "ioc", "post-only"]);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export function isTriggerType(type: OrderType): boolean {
  return type === "stop-market" || type === "stop-limit" || type === "take-profit-market" || type === "take-profit-limit";
}

// ------------------------------------------------------------- order requests

const Positive = z.number().positive().finite();

const RequestBase = z.object({
  /** Caller-chosen id; adapters reject duplicates (idempotency). */
  clientOrderId: z.string().min(1).max(64),
  marketId: MarketIdSchema,
  side: SideSchema,
  /** Base-asset quantity. */
  size: Positive,
  reduceOnly: z.boolean(),
  leverage: Positive,
  marginMode: MarginModeSchema,
});

export const LimitRequestSchema = RequestBase.extend({
  type: z.literal("limit"),
  price: Positive,
  timeInForce: TimeInForceSchema,
});
export const MarketRequestSchema = RequestBase.extend({
  type: z.literal("market"),
  /** Worst acceptable price as a fraction from the best price (e.g. 0.05 = 5%). */
  maxSlippage: z.number().positive().max(0.5),
});
export const TriggerMarketRequestSchema = RequestBase.extend({
  type: z.enum(["stop-market", "take-profit-market"]),
  triggerPrice: Positive,
  maxSlippage: z.number().positive().max(0.5),
});
export const TriggerLimitRequestSchema = RequestBase.extend({
  type: z.enum(["stop-limit", "take-profit-limit"]),
  triggerPrice: Positive,
  price: Positive,
  timeInForce: TimeInForceSchema,
});
export const IcebergRequestSchema = RequestBase.extend({
  type: z.literal("iceberg"),
  price: Positive,
  displaySize: Positive,
  timeInForce: TimeInForceSchema,
});
export const HiddenRequestSchema = RequestBase.extend({
  type: z.literal("hidden"),
  price: Positive,
  timeInForce: TimeInForceSchema,
});

export const OrderRequestSchema = z
  .discriminatedUnion("type", [
    LimitRequestSchema,
    MarketRequestSchema,
    TriggerMarketRequestSchema,
    TriggerLimitRequestSchema,
    IcebergRequestSchema,
    HiddenRequestSchema,
  ])
  .superRefine((request, ctx) => {
    if (request.type === "iceberg" && request.displaySize >= request.size) {
      ctx.addIssue({ code: "custom", path: ["displaySize"], message: "Display size must be smaller than the order size" });
    }
  });
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

/** Limit price of a request, if it has one. */
export function requestLimitPrice(request: OrderRequest): number | null {
  return "price" in request ? request.price : null;
}

export function requestTriggerPrice(request: OrderRequest): number | null {
  return "triggerPrice" in request ? request.triggerPrice : null;
}

export function requestTimeInForce(request: OrderRequest): TimeInForce | null {
  return "timeInForce" in request ? request.timeInForce : null;
}

// --------------------------------------------------------------------- orders

/**
 * Order lifecycle (see core/trading/order-lifecycle.ts for transitions):
 *   pending-new → open | waiting-trigger | partially-filled | filled | rejected
 *   waiting-trigger → open (triggered) | cancel-pending | cancelled | expired
 *   open ↔ partially-filled → filled | cancel-pending | cancelled | expired
 *   cancel-pending → cancelled | open/partially-filled (cancel rejected) | filled
 */
export const ORDER_STATUSES = [
  "pending-new",
  "waiting-trigger",
  "open",
  "partially-filled",
  "cancel-pending",
  "filled",
  "cancelled",
  "rejected",
  "expired",
] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(["filled", "cancelled", "rejected", "expired"]);

/** Terminal states: the order can no longer change. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const OrderSchema = z.object({
  /** Adapter-assigned id (stable across the order's life). */
  id: z.string().min(1),
  clientOrderId: z.string().min(1),
  /** Venue's own id once known (null for simulated or not-yet-acknowledged orders). */
  venueOrderId: z.string().nullable(),
  marketId: MarketIdSchema,
  side: SideSchema,
  type: OrderTypeSchema,
  /** Limit price; null for market-style orders. */
  price: z.number().positive().nullable(),
  triggerPrice: z.number().positive().nullable(),
  /** When a trigger order's condition fired (null = not triggered / not a trigger order). */
  triggeredAt: z.number().int().nonnegative().nullable(),
  size: z.number().positive(),
  filledSize: z.number().nonnegative(),
  /** Volume-weighted fill price; null until something fills. */
  averageFillPrice: z.number().positive().nullable(),
  status: OrderStatusSchema,
  timeInForce: TimeInForceSchema.nullable(),
  reduceOnly: z.boolean(),
  /** Null when the venue does not attach leverage to orders (e.g. Hyperliquid open orders). */
  leverage: z.number().positive().nullable(),
  marginMode: MarginModeSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Why the order was rejected, expired, or why its remainder was cancelled. */
  statusReason: z.string().nullable(),
  /** Highest venue event sequence applied (for ordering), if the venue provides one. */
  lastSequence: z.number().int().nullable(),
  origin: OriginSchema,
});
export type Order = z.infer<typeof OrderSchema>;

// ---------------------------------------------------------------------- fills

export const LiquiditySchema = z.enum(["maker", "taker", "liquidation", "rfq"]);
export type Liquidity = z.infer<typeof LiquiditySchema>;

export const FillSchema = z.object({
  /** Unique per execution; used to de-duplicate fill events. */
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
  origin: OriginSchema,
});
export type Fill = z.infer<typeof FillSchema>;
