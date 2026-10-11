import type { CapabilityId } from "./capabilities";
import type { OrderStatus } from "./order";

export interface FieldIssue {
  field: string;
  message: string;
}

/** Every failure an execution adapter can report. `message` is user-facing. */
export type TradingError =
  | { code: "unsupported"; capability: CapabilityId; scope: "venue" | "nova"; message: string }
  | { code: "validation"; issues: FieldIssue[]; message: string }
  | { code: "insufficient-margin"; required: number; available: number; message: string }
  | { code: "no-liquidity"; message: string }
  | { code: "would-take-liquidity"; message: string }
  | { code: "reduce-only-invalid"; message: string }
  | { code: "duplicate-client-order-id"; clientOrderId: string; message: string }
  | { code: "order-not-found"; message: string }
  | { code: "order-not-cancellable"; status: OrderStatus; message: string }
  | { code: "feed-unavailable"; message: string }
  | { code: "account-required"; message: string }
  /** A rejection injected by simulation configuration (never a real venue response). */
  | { code: "simulated-rejection"; message: string }
  | { code: "venue-rejected"; message: string }
  /** Refused by Nova's pre-trade risk limits before reaching the venue. */
  | { code: "risk-limit"; limits: string[]; message: string }
  | { code: "network" | "rate-limited" | "invalid-response"; message: string };

export type TradingErrorCode = TradingError["code"];

export type Result<T, E = TradingError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
