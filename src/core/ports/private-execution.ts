/**
 * How visible a resting order is to other market participants on a venue.
 *  - "public-book": price and size appear in the venue's public order book.
 *  - "hidden": not shown in any public book (requires venue support).
 */
export type OrderBookVisibility = "public-book" | "hidden";

/** How visible fills are after execution. */
export type FillVisibility = "public-ledger" | "public-tape" | "private";

export type PrivateExecutionMode =
  | "hidden-limit"
  | "iceberg"
  | "batch-auction"
  | "sealed-rfq";

/**
 * Declared by each venue adapter. The UI derives privacy disclosures from this
 * object only, so an order is never labelled private unless the venue that
 * receives it supports that mode.
 */
export interface VenueExecutionCapabilities {
  venueId: string;
  venueName: string;
  restingOrderVisibility: OrderBookVisibility;
  fillVisibility: FillVisibility;
  /** Whether the venue attributes fills to account addresses publicly. */
  publicAccountAttribution: boolean;
  supportedPrivateModes: readonly PrivateExecutionMode[];
  /** Plain-language notes shown to users. */
  notes: readonly string[];
}
