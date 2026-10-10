import type { ExecutionMode, Exposure, VisibilityLevel } from "@/core/privacy";

export const MODE_LABEL: Record<ExecutionMode, string> = {
  "public-limit": "Public limit order",
  hidden: "Hidden order",
  iceberg: "Iceberg order",
  rfq: "Private RFQ",
  encrypted: "Encrypted order",
};

export const MODE_SUMMARY: Record<ExecutionMode, string> = {
  "public-limit": "Rests in the public order book.",
  hidden: "Rests at the venue without being shown in the public book. Fills are still public.",
  iceberg: "An execution algorithm: only a displayed slice is shown and refilled. Not anonymity.",
  rfq: "Ask selected counterparties for a quote instead of using the public book.",
  encrypted: "Orders encrypted until matching. Planned; requires a protocol that does not exist yet.",
};

export const EXPOSURE_LABEL: Record<Exposure, string> = {
  visible: "Sees",
  partial: "Partly",
  "not-visible": "Cannot see",
  "not-applicable": "N/A",
};

export const LEVEL_LABEL: Record<VisibilityLevel, string> = {
  public: "Public",
  "partially-displayed": "Partially displayed",
  "pre-trade-private": "Pre-trade private",
  private: "Private",
  unavailable: "Unavailable",
};
