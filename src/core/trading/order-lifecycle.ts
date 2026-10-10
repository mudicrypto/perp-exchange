import { isTerminalStatus, isTriggerType, type Fill, type Order, type OrderStatus } from "../domain";

/**
 * Venue-confirmed events that move an order through its lifecycle. Adapters
 * translate venue messages (or simulator decisions) into these; nothing else
 * may change an order's status.
 */
export type OrderEventBody =
  | { type: "accepted" }
  | { type: "rejected"; reason: string }
  | { type: "triggered" }
  /** `reason` is recorded if this fill completes the order (e.g. a liquidation). */
  | { type: "fill"; fill: Fill; reason?: string }
  | { type: "cancel-requested" }
  | { type: "cancelled"; reason: string }
  | { type: "cancel-rejected"; reason: string }
  | { type: "expired"; reason: string };

export type OrderEvent = OrderEventBody & {
  /** Unique per event; used to drop duplicate deliveries. */
  eventId: string;
  orderId: string;
  time: number;
  /** Venue sequence number if available; older sequences are ignored. */
  sequence?: number;
};

export type TransitionError =
  | { code: "invalid-transition"; from: OrderStatus; event: OrderEventBody["type"] }
  | { code: "overfill"; filled: number; size: number }
  | { code: "order-mismatch"; message: string };

export type TransitionResult = { ok: true; order: Order } | { ok: false; error: TransitionError };

const SIZE_EPSILON = 1e-9;

/** Statuses an event may be applied from. */
const ALLOWED_FROM: Record<OrderEventBody["type"], readonly OrderStatus[]> = {
  accepted: ["pending-new"],
  rejected: ["pending-new"],
  triggered: ["waiting-trigger"],
  // A venue can report a fill before (or instead of) the acknowledgement, and
  // while a cancel is in flight.
  fill: ["pending-new", "open", "partially-filled", "cancel-pending"],
  "cancel-requested": ["open", "partially-filled", "waiting-trigger"],
  cancelled: ["pending-new", "open", "partially-filled", "waiting-trigger", "cancel-pending"],
  "cancel-rejected": ["cancel-pending"],
  expired: ["open", "partially-filled", "waiting-trigger", "cancel-pending"],
};

export function canApply(status: OrderStatus, event: OrderEventBody["type"]): boolean {
  return ALLOWED_FROM[event].includes(status);
}

/** Status an order returns to when a cancel is rejected. */
function workingStatus(order: Order): OrderStatus {
  if (isTriggerType(order.type) && order.triggeredAt === null) return "waiting-trigger";
  return order.filledSize > SIZE_EPSILON ? "partially-filled" : "open";
}

/**
 * Pure transition function. Returns a new order or a typed error; never
 * mutates its input. Duplicate/stale detection is the OrderStore's job.
 */
export function transitionOrder(order: Order, event: OrderEvent): TransitionResult {
  if (event.orderId !== order.id) {
    return { ok: false, error: { code: "order-mismatch", message: `Event for ${event.orderId} applied to ${order.id}` } };
  }
  if (!canApply(order.status, event.type)) {
    return { ok: false, error: { code: "invalid-transition", from: order.status, event: event.type } };
  }
  const base: Order = {
    ...order,
    updatedAt: Math.max(order.updatedAt, event.time),
    lastSequence: event.sequence ?? order.lastSequence,
  };

  switch (event.type) {
    case "accepted":
      return { ok: true, order: { ...base, status: isTriggerType(order.type) ? "waiting-trigger" : "open" } };
    case "rejected":
      return { ok: true, order: { ...base, status: "rejected", statusReason: event.reason } };
    case "triggered":
      return { ok: true, order: { ...base, status: "open", triggeredAt: event.time } };
    case "fill": {
      const { fill } = event;
      if (fill.marketId !== order.marketId || fill.side !== order.side) {
        return { ok: false, error: { code: "order-mismatch", message: "Fill market/side does not match order" } };
      }
      const filled = order.filledSize + fill.size;
      if (filled > order.size + SIZE_EPSILON) {
        return { ok: false, error: { code: "overfill", filled, size: order.size } };
      }
      const notional = (order.averageFillPrice ?? 0) * order.filledSize + fill.price * fill.size;
      const complete = filled >= order.size - SIZE_EPSILON;
      // A fill during cancel-pending keeps the order cancel-pending unless it completes it.
      const status: OrderStatus = complete ? "filled" : order.status === "cancel-pending" ? "cancel-pending" : "partially-filled";
      return {
        ok: true,
        order: {
          ...base,
          filledSize: complete ? order.size : filled,
          averageFillPrice: notional / filled,
          status,
          statusReason: complete ? (event.reason ?? null) : order.statusReason,
        },
      };
    }
    case "cancel-requested":
      return { ok: true, order: { ...base, status: "cancel-pending" } };
    case "cancelled":
      return { ok: true, order: { ...base, status: "cancelled", statusReason: event.reason } };
    case "cancel-rejected":
      return { ok: true, order: { ...base, status: workingStatus(order), statusReason: event.reason } };
    case "expired":
      return { ok: true, order: { ...base, status: "expired", statusReason: event.reason } };
  }
}

export { isTerminalStatus };
