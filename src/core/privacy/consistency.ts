import type { CapabilityId, CapabilityMap } from "../domain";
import { EXECUTION_MODES, PRIVACY_DATA, PRIVACY_PARTIES, type ExecutionMode, type PrivacyProfile, type VenuePrivacy } from "./model";

export const MODE_CAPABILITY: Record<ExecutionMode, CapabilityId> = {
  "public-limit": "order.limit",
  hidden: "order.hidden",
  iceberg: "order.iceberg",
  rfq: "execution.rfq",
  encrypted: "execution.encrypted",
};

/** The venue offers the mode (whether or not Nova implements it yet). */
export function venueOffersMode(capabilities: CapabilityMap, mode: ExecutionMode): boolean {
  const status = capabilities[MODE_CAPABILITY[mode]];
  return status.status === "supported" || status.scope === "nova";
}

export interface PrivacyIssue {
  mode: ExecutionMode | null;
  message: string;
}

const visibleOrPartial = (e: string) => e === "visible" || e === "partial";

/**
 * Checks that a venue's privacy profiles are complete, consistent with its
 * capabilities, and consistent with what each mode can honestly promise.
 * The capability registry refuses venues with any issue.
 */
export function validateVenuePrivacy(capabilities: CapabilityMap, privacy: VenuePrivacy): PrivacyIssue[] {
  const issues: PrivacyIssue[] = [];
  const push = (mode: ExecutionMode | null, message: string) => issues.push({ mode, message });

  // Encrypted execution has no protocol: it can only be "planned".
  if (capabilities["execution.encrypted"].status === "supported") {
    push("encrypted", "Encrypted execution cannot be declared supported: no protocol-level implementation exists");
  }
  if (privacy.profiles.encrypted) push("encrypted", "No venue may publish a privacy profile for encrypted execution yet");

  for (const mode of EXECUTION_MODES) {
    if (mode === "encrypted") continue;
    const offered = venueOffersMode(capabilities, mode);
    const profile = privacy.profiles[mode];
    if (offered && !profile) push(mode, `Mode is offered but has no privacy profile`);
    if (!offered && profile) push(mode, `Mode is not offered by the venue but has a privacy profile`);
    if (profile) issues.push(...checkProfile(mode, profile));
  }
  return issues;
}

function checkProfile(mode: ExecutionMode, profile: PrivacyProfile): PrivacyIssue[] {
  const issues: PrivacyIssue[] = [];
  const push = (message: string) => issues.push({ mode, message });

  for (const party of PRIVACY_PARTIES) {
    for (const data of PRIVACY_DATA) {
      if (!profile[party]?.[data]) push(`Missing cell ${party} × ${data}`);
    }
  }
  if (issues.length > 0) return issues;

  const pub = profile["public-observers"];
  // Without encryption, whoever matches and runs the venue sees the order.
  if (profile["matching-engine"]["order-details"].exposure !== "visible") push("The matching engine must see order details");
  if (profile["venue-operator"]["order-details"].exposure !== "visible") push("The venue operator must be disclosed as seeing order details");

  switch (mode) {
    case "public-limit":
      if (!visibleOrPartial(pub["order-details"].exposure)) push("Public limit orders are visible to public observers");
      break;
    case "hidden":
      if (pub["order-details"].exposure !== "not-visible") push("A hidden order must not be visible to public observers");
      if (profile["other-nova-users"]["order-details"].exposure !== "not-visible") push("A hidden order must not be visible to other Nova users");
      break;
    case "iceberg":
      // An iceberg is an execution algorithm, not anonymity: the displayed slice is public.
      if (pub["order-details"].exposure !== "partial") push("An iceberg's displayed slice is public: order details must be 'partial'");
      if (!visibleOrPartial(pub["execution-details"].exposure)) push("Iceberg executions are public and must be disclosed");
      break;
    case "rfq":
      if (!visibleOrPartial(profile["rfq-counterparties"]["order-details"].exposure)) push("Selected counterparties see the request");
      if (pub["order-details"].exposure !== "not-visible") push("RFQ requests must not be visible to public observers");
      break;
    case "encrypted":
      break;
  }
  if (mode !== "rfq") {
    for (const data of PRIVACY_DATA) {
      if (profile["rfq-counterparties"][data].exposure !== "not-applicable") push("RFQ counterparties play no role outside RFQ");
    }
  }
  return issues;
}
