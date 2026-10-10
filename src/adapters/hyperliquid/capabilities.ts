import type { VenueExecutionCapabilities } from "@/core/ports";
import { HYPERLIQUID_VENUE_ID } from "./constants";

/**
 * Hyperliquid is a transparent venue: resting orders appear in the public L2
 * book and trades settle on its public L1, attributable to account addresses.
 * Nova must therefore present orders routed here as public.
 */
export const hyperliquidCapabilities: VenueExecutionCapabilities = {
  venueId: HYPERLIQUID_VENUE_ID,
  venueName: "Hyperliquid",
  restingOrderVisibility: "public-book",
  fillVisibility: "public-ledger",
  publicAccountAttribution: true,
  supportedPrivateModes: [],
  notes: [
    "Nova cannot hide orders that Hyperliquid publishes. Private execution modes will require Nova's own venue.",
  ],
};
