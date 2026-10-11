import type { OrderStatus, Transition } from "./types.ts";

/**
 * Order state machine (docs/venue/ORDER-STATE-MACHINE.md).
 *
 * `received` is the transient state of a command before validation; it is
 * never stored. `filled`, `cancelled` and `rejected` are terminal.
 */
export type OrderState = OrderStatus | "received";

export const TERMINAL_STATES: readonly OrderStatus[] = ["filled", "cancelled", "rejected"];

/** Every allowed (from, cause) → to edge. Anything else is an integrity error. */
export const ORDER_TRANSITIONS: readonly { from: OrderState; cause: Transition["cause"]; to: OrderStatus }[] = [
  { from: "received", cause: "reject", to: "rejected" },
  { from: "received", cause: "accept", to: "new" },
  { from: "new", cause: "fill", to: "partially-filled" },
  { from: "new", cause: "fill", to: "filled" },
  { from: "new", cause: "cancel", to: "cancelled" },
  { from: "new", cause: "replace", to: "new" },
  { from: "partially-filled", cause: "fill", to: "partially-filled" },
  { from: "partially-filled", cause: "fill", to: "filled" },
  { from: "partially-filled", cause: "cancel", to: "cancelled" },
  { from: "partially-filled", cause: "replace", to: "partially-filled" },
];

export function isAllowedTransition(from: OrderState, cause: Transition["cause"], to: OrderStatus): boolean {
  return ORDER_TRANSITIONS.some((t) => t.from === from && t.cause === cause && t.to === to);
}

export const isTerminal = (status: OrderStatus) => TERMINAL_STATES.includes(status);
export const isLive = (status: OrderStatus) => status === "new" || status === "partially-filled";
