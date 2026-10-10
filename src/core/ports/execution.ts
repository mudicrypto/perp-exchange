import type { OrderIntent, OrderStatus } from "../domain";

export type ExecutionMode = "disabled";

export type SubmitResult =
  | { ok: true; clientOrderId: string; status: OrderStatus }
  | { ok: false; code: "execution-disabled" | "validation-failed" | "venue-rejected"; message: string };

/**
 * Routes order intents to a venue (external venue or Nova's own engine).
 * In Milestone 1 only `DisabledExecutionAdapter` exists.
 */
export interface ExecutionAdapter {
  readonly venueId: string;
  readonly mode: ExecutionMode;
  submit(intent: OrderIntent): Promise<SubmitResult>;
  cancel(clientOrderId: string): Promise<SubmitResult>;
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
