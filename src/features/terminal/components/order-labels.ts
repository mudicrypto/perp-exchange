import type { OrderType } from "@/core/domain";

export const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  limit: "Limit",
  market: "Market",
  "stop-market": "Stop market",
  "stop-limit": "Stop limit",
  "take-profit-market": "Take-profit market",
  "take-profit-limit": "Take-profit limit",
  iceberg: "Iceberg",
  hidden: "Hidden",
  rfq: "RFQ trade",
};
