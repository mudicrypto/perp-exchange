import type { MarginMode } from "./account";
import type { OrderType, TimeInForce } from "./order";

/**
 * Every execution feature the UI may ask about. A venue declares a status
 * for *each* of these; anything not declared is treated as unsupported.
 */
export const CAPABILITY_IDS = [
  // Order types
  "order.limit",
  "order.market",
  "order.stop-market",
  "order.stop-limit",
  "order.take-profit-market",
  "order.take-profit-limit",
  "order.iceberg",
  "order.hidden",
  "order.twap",
  // Time in force / flags
  "tif.gtc",
  "tif.ioc",
  "tif.post-only",
  "order.reduce-only",
  // Actions
  "action.submit",
  "action.cancel",
  "action.cancel-all",
  // Reads and streams
  "read.open-orders",
  "read.positions",
  "read.account",
  "stream.order-updates",
  "stream.fills",
  // Execution styles
  "execution.rfq",
  "execution.batch-auction",
  // Margin
  "margin.isolated",
  "margin.cross",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * - supported: Nova implements it for this venue and it works.
 * - unsupported/venue: the venue does not offer it.
 * - unsupported/nova:  the venue may offer it, but Nova does not implement
 *   (or has deliberately disabled) it. Never emulated.
 */
export type CapabilityStatus =
  | { status: "supported"; note?: string }
  | { status: "unsupported"; scope: "venue" | "nova"; reason: string };

export type CapabilityMap = Readonly<Record<CapabilityId, CapabilityStatus>>;

export const ORDER_TYPE_CAPABILITY: Record<OrderType, CapabilityId> = {
  limit: "order.limit",
  market: "order.market",
  "stop-market": "order.stop-market",
  "stop-limit": "order.stop-limit",
  "take-profit-market": "order.take-profit-market",
  "take-profit-limit": "order.take-profit-limit",
  iceberg: "order.iceberg",
  hidden: "order.hidden",
};

export const TIF_CAPABILITY: Record<TimeInForce, CapabilityId> = {
  gtc: "tif.gtc",
  ioc: "tif.ioc",
  "post-only": "tif.post-only",
};

export const MARGIN_CAPABILITY: Record<MarginMode, CapabilityId> = {
  isolated: "margin.isolated",
  cross: "margin.cross",
};

export const supported = (note?: string): CapabilityStatus => (note ? { status: "supported", note } : { status: "supported" });
export const venueUnsupported = (reason: string): CapabilityStatus => ({ status: "unsupported", scope: "venue", reason });
export const notImplemented = (reason: string): CapabilityStatus => ({ status: "unsupported", scope: "nova", reason });

/**
 * Builds a complete capability map. Every id must be listed explicitly, so a
 * new capability added to CAPABILITY_IDS forces each venue to take a position.
 */
export function defineCapabilities(map: Record<CapabilityId, CapabilityStatus>): CapabilityMap {
  return Object.freeze({ ...map });
}
