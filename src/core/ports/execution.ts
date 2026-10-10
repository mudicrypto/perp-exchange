import type { Order, OrderIntent, OrderStatus } from "../domain";

/**
 * - "disabled": every request is rejected (live venues in this milestone).
 * - "paper": orders are matched by a local simulator against simulated books.
 *   Nothing is sent to any real venue.
 */
export type ExecutionMode = "disabled" | "paper";

export type SubmitErrorCode =
  | "execution-disabled"
  | "validation-failed"
  | "insufficient-margin"
  | "no-liquidity"
  | "would-take-liquidity"
  | "reduce-only-invalid"
  | "feed-unavailable"
  | "not-found"
  | "venue-rejected";

export type SubmitResult =
  | { ok: true; order: Order }
  | { ok: false; code: SubmitErrorCode; message: string; order: Order | null };

/**
 * Routes order intents to a venue (external venue, Nova's own engine, or the
 * paper simulator). Results reflect what the venue actually did.
 */
export interface ExecutionAdapter {
  readonly venueId: string;
  readonly mode: ExecutionMode;
  submit(intent: OrderIntent): Promise<SubmitResult>;
  cancel(orderId: string): Promise<SubmitResult>;
  cancelAll(): Promise<number>;
}

/** A venue-confirmed event used by order reconciliation (planned M3). */
export interface OrderEvent {
  clientOrderId: string;
  venueOrderId: string | null;
  status: OrderStatus;
  filledSize: number;
  /** Monotonic per-order sequence for de-duplication / ordering. */
  sequence: number;
  venueTime: number;
}
