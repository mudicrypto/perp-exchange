import { z } from "zod";
import { accountIdSchema, accountLimitsSchema, instrumentSpecSchema } from "./instrument.ts";

/**
 * Sequenced engine commands, events and public messages of the venue
 * prototype. Engine commands carry integers only (ticks, lots); decimal
 * client input is converted by the gateway.
 */

export const SIDES = ["buy", "sell"] as const;
export type Side = (typeof SIDES)[number];
export const VISIBILITIES = ["displayed", "hidden"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const TIME_IN_FORCE = ["gtc", "ioc", "fok"] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];
export const STP_MODES = ["cancel-taker", "cancel-maker", "cancel-both"] as const;
export type StpMode = (typeof STP_MODES)[number];
export const TRADING_STATUSES = ["continuous", "halted"] as const;
export type TradingStatus = (typeof TRADING_STATUSES)[number];

export const ORDER_STATUSES = ["new", "partially-filled", "filled", "cancelled", "rejected"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type CancelReason =
  | "user"
  | "mass-cancel"
  | "ioc-remainder"
  | "fok-unfilled"
  | "self-trade-prevention"
  | "account-suspended";

export type RejectReason =
  | "unknown-account"
  | "account-suspended"
  | "unknown-instrument"
  | "trading-halted"
  | "price-required"
  | "price-not-allowed"
  | "price-out-of-range"
  | "price-out-of-band"
  | "quantity-out-of-range"
  | "market-requires-ioc-or-fok"
  | "hidden-requires-gtc"
  | "hidden-below-minimum"
  | "post-only-requires-gtc"
  | "post-only-would-take"
  | "duplicate-client-order-id"
  | "max-open-orders"
  | "max-order-notional"
  | "max-position"
  | "unknown-order"
  | "order-not-modifiable"
  | "replace-quantity-below-filled"
  | "replace-no-change"
  | "invalid-command";

const int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const posInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instrumentId = z.string().min(1).max(32);
const clientOrderId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
const orderId = z.string().regex(/^o[0-9a-f]{16}$/);

export const orderRefSchema = z.union([z.object({ orderId }).strict(), z.object({ clientOrderId }).strict()]);
export type OrderRef = z.infer<typeof orderRefSchema>;

/** Every command the sequencer journals. Re-validated when a journal is read back. */
export const engineCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("new-order"),
      accountId: accountIdSchema,
      clientOrderId,
      instrumentId,
      side: z.enum(SIDES),
      orderType: z.enum(["limit", "market"]),
      priceTicks: posInt.optional(),
      qtyLots: posInt,
      tif: z.enum(TIME_IN_FORCE),
      visibility: z.enum(VISIBILITIES),
      postOnly: z.boolean(),
      stp: z.enum(STP_MODES),
    })
    .strict(),
  z.object({ type: z.literal("cancel"), accountId: accountIdSchema, ref: orderRefSchema }).strict(),
  z
    .object({ type: z.literal("replace"), accountId: accountIdSchema, ref: orderRefSchema, priceTicks: posInt, qtyLots: posInt })
    .strict(),
  z.object({ type: z.literal("mass-cancel"), accountId: accountIdSchema, instrumentId: instrumentId.optional() }).strict(),
  z.object({ type: z.literal("publish") }).strict(),
  z.object({ type: z.literal("admin.add-instrument"), spec: instrumentSpecSchema }).strict(),
  z.object({ type: z.literal("admin.add-account"), accountId: accountIdSchema, limits: accountLimitsSchema }).strict(),
  z.object({ type: z.literal("admin.set-status"), instrumentId, status: z.enum(TRADING_STATUSES) }).strict(),
  z.object({ type: z.literal("admin.suspend-account"), accountId: accountIdSchema }).strict(),
]);

export type EngineCommand = z.infer<typeof engineCommandSchema>;
export type NewOrderCommand = Extract<EngineCommand, { type: "new-order" }>;

export interface SequencedCommand {
  /** Strictly increasing, gap-free sequence number assigned by the sequencer. */
  readonly seq: number;
  /** Sequencer timestamp (ms). The engine never reads a clock. */
  readonly ts: number;
  readonly command: EngineCommand;
}

/** Order record as the owner sees it. */
export interface OrderView {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: Side;
  readonly priceTicks: number;
  readonly qtyLots: number;
  readonly filledLots: number;
  readonly leavesLots: number;
  readonly visibility: Visibility;
  readonly tif: TimeInForce;
  readonly postOnly: boolean;
  readonly status: OrderStatus;
}

/** Events delivered only to the account that owns them. */
export type PrivateEventBody =
  | { kind: "accepted"; order: OrderView }
  | { kind: "rejected"; clientOrderId: string; reason: RejectReason }
  | {
      kind: "fill";
      orderId: string;
      clientOrderId: string;
      fillId: string;
      instrumentId: string;
      side: Side;
      priceTicks: number;
      qtyLots: number;
      liquidity: "maker" | "taker";
      filledLots: number;
      leavesLots: number;
      status: OrderStatus;
    }
  | { kind: "cancelled"; orderId: string; clientOrderId: string; reason: CancelReason; filledLots: number }
  | { kind: "replaced"; order: OrderView; priorityRetained: boolean }
  | { kind: "request-rejected"; request: "cancel" | "replace"; ref: OrderRef; reason: RejectReason }
  | { kind: "mass-cancelled"; count: number };

export type PrivateEvent = PrivateEventBody & {
  readonly accountId: string;
  /** Per-account, gap-free sequence (never the global engine sequence). */
  readonly accountSeq: number;
  readonly ts: number;
};

/** Full execution record: operator/audit only, never published. */
export interface Execution {
  readonly execId: string;
  readonly seq: number;
  readonly ts: number;
  readonly instrumentId: string;
  readonly priceTicks: number;
  readonly qtyLots: number;
  readonly aggressor: Side;
  readonly makerOrderId: string;
  readonly makerAccountId: string;
  readonly makerVisibility: Visibility;
  readonly takerOrderId: string;
  readonly takerAccountId: string;
}

/** Audit record of every order status change. */
export interface Transition {
  readonly orderId: string | null;
  readonly from: OrderStatus | "received";
  readonly to: OrderStatus;
  readonly cause: "accept" | "reject" | "fill" | "cancel" | "replace";
}

/**
 * Public market data. Strict schemas: a public message that carried an
 * account, order id, client id or visibility flag would fail validation.
 */
export const publicMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("trade"),
      publicSeq: posInt,
      ts: int,
      instrumentId,
      tradeId: z.string().regex(/^T[0-9]+$/),
      priceTicks: posInt,
      qtyLots: posInt,
      aggressor: z.enum(SIDES),
    })
    .strict(),
  z
    .object({ kind: z.literal("level"), publicSeq: posInt, ts: int, instrumentId, side: z.enum(SIDES), priceTicks: posInt, displayedLots: int })
    .strict(),
  z.object({ kind: z.literal("status"), publicSeq: posInt, ts: int, instrumentId, status: z.enum(TRADING_STATUSES) }).strict(),
]);

export type PublicMessage = z.infer<typeof publicMessageSchema>;

export interface CommandResult {
  readonly seq: number;
  readonly ts: number;
  readonly private: readonly PrivateEvent[];
  readonly public: readonly PublicMessage[];
  readonly executions: readonly Execution[];
  readonly transitions: readonly Transition[];
  /** Set when an operator command was refused (unknown target, duplicate). */
  readonly adminError?: string;
}

export interface PublicLevel {
  readonly priceTicks: number;
  readonly displayedLots: number;
}

export interface PublicBook {
  readonly instrumentId: string;
  readonly bids: readonly PublicLevel[];
  readonly asks: readonly PublicLevel[];
}
