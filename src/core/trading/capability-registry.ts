import {
  CAPABILITY_IDS,
  MARGIN_CAPABILITY,
  ORDER_TYPE_CAPABILITY,
  TIF_CAPABILITY,
  requestTimeInForce,
  type CapabilityId,
  type CapabilityMap,
  type CapabilityStatus,
  type OrderRequest,
  type TradingError,
} from "../domain";
import type { VenueExecutionCapabilities } from "../ports/private-execution";

export interface VenueCapabilities {
  venueId: string;
  venueName: string;
  /** "simulated" venues never touch real funds or real order books. */
  origin: "simulated" | "venue";
  capabilities: CapabilityMap;
  /** What the venue publishes about orders and fills (drives privacy disclosures). */
  visibility: VenueExecutionCapabilities;
}

const UNKNOWN_VENUE = (venueId: string): CapabilityStatus => ({
  status: "unsupported",
  scope: "nova",
  reason: `Venue "${venueId}" is not registered`,
});

/** Lookup service the UI uses to decide what to offer for each venue. */
export class CapabilityRegistry {
  private readonly venues = new Map<string, VenueCapabilities>();

  register(venue: VenueCapabilities): void {
    for (const id of CAPABILITY_IDS) {
      if (!venue.capabilities[id]) throw new Error(`${venue.venueId} does not declare capability ${id}`);
    }
    this.venues.set(venue.venueId, venue);
  }

  venue(venueId: string): VenueCapabilities | undefined {
    return this.venues.get(venueId);
  }

  check(venueId: string, capability: CapabilityId): CapabilityStatus {
    const venue = this.venues.get(venueId);
    if (!venue) return UNKNOWN_VENUE(venueId);
    return venue.capabilities[capability];
  }

  supports(venueId: string, capability: CapabilityId): boolean {
    return this.check(venueId, capability).status === "supported";
  }

  /** All capabilities with their status, for documentation and settings UIs. */
  list(venueId: string): { id: CapabilityId; status: CapabilityStatus }[] {
    return CAPABILITY_IDS.map((id) => ({ id, status: this.check(venueId, id) }));
  }
}

export function isSupported(map: CapabilityMap, capability: CapabilityId): boolean {
  return map[capability].status === "supported";
}

export function unsupportedError(capability: CapabilityId, status: CapabilityStatus): TradingError | null {
  if (status.status === "supported") return null;
  return { code: "unsupported", capability, scope: status.scope, message: status.reason };
}

/** Capabilities an order request depends on (excluding the submit action itself). */
export function requiredCapabilities(request: OrderRequest): CapabilityId[] {
  const required: CapabilityId[] = [ORDER_TYPE_CAPABILITY[request.type], MARGIN_CAPABILITY[request.marginMode]];
  const tif = requestTimeInForce(request);
  if (tif) required.push(TIF_CAPABILITY[tif]);
  if (request.reduceOnly) required.push("order.reduce-only");
  return required;
}

/** First unsupported capability the request needs, as an explicit error. */
export function checkRequestCapabilities(request: OrderRequest, map: CapabilityMap): TradingError | null {
  for (const capability of requiredCapabilities(request)) {
    const error = unsupportedError(capability, map[capability]);
    if (error) return error;
  }
  return null;
}
