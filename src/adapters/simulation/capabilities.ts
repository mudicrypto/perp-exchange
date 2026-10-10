import type { VenueExecutionCapabilities } from "@/core/ports";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

/**
 * The simulator has no execution at all; it declares the most conservative
 * (public) visibility so the UI never implies privacy it cannot provide.
 */
export const simulationCapabilities: VenueExecutionCapabilities = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  restingOrderVisibility: "public-book",
  fillVisibility: "public-tape",
  publicAccountAttribution: false,
  supportedPrivateModes: [],
  notes: ["Simulated venue: no orders are sent anywhere."],
};
