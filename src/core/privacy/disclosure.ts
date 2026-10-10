import type { CapabilityMap, CapabilityStatus } from "../domain";
import { MODE_CAPABILITY, venueOffersMode } from "./consistency";
import {
  DATA_LABEL,
  PARTY_LABEL,
  PRIVACY_DATA,
  PRIVACY_PARTIES,
  type ExecutionMode,
  type ExposureCell,
  type PrivacyData,
  type PrivacyParty,
  type PrivacyProfile,
  type VenuePrivacy,
} from "./model";

export type VisibilityLevel = "public" | "partially-displayed" | "pre-trade-private" | "private" | "unavailable";

export interface DisclosureRow {
  party: PrivacyParty;
  partyLabel: string;
  data: PrivacyData;
  dataLabel: string;
  cell: ExposureCell;
}

export interface ExecutionDisclosure {
  mode: ExecutionMode;
  venueName: string;
  capability: CapabilityStatus;
  /** Can the user place this mode through Nova right now? */
  executable: boolean;
  level: VisibilityLevel;
  headline: string;
  /** Short statements for compact UIs (e.g. the order ticket). */
  details: string[];
  /** Full party × data matrix; empty when the mode is unavailable. */
  rows: DisclosureRow[];
  profile: PrivacyProfile | null;
}

function levelOf(profile: PrivacyProfile): Exclude<VisibilityLevel, "unavailable"> {
  const pub = profile["public-observers"];
  const order = pub["order-details"].exposure;
  if (order === "visible") return "public";
  if (order === "partial") return "partially-displayed";
  const exec = pub["execution-details"].exposure;
  return exec === "not-visible" ? "private" : "pre-trade-private";
}

const HEADLINE: Record<Exclude<VisibilityLevel, "unavailable">, (venue: string) => string> = {
  public: (v) => `Public order on ${v}`,
  "partially-displayed": (v) => `Partially displayed on ${v}: only the shown quantity is public`,
  "pre-trade-private": (v) => `Not shown in ${v}'s public book; executions are still public`,
  private: (v) => `Private on ${v}: neither the order nor its execution is public`,
};

/**
 * Derives what a user is told about an execution mode on a venue. The result
 * depends only on the venue's capabilities and privacy profiles, never on UI
 * state — so the UI cannot present an order as more private than it is.
 */
export function describeExecution(capabilities: CapabilityMap, privacy: VenuePrivacy, mode: ExecutionMode): ExecutionDisclosure {
  const capability = capabilities[MODE_CAPABILITY[mode]];
  const profile = venueOffersMode(capabilities, mode) ? (privacy.profiles[mode] ?? null) : null;
  if (!profile) {
    const reason = capability.status === "unsupported" ? capability.reason : "No privacy profile declared";
    return {
      mode,
      venueName: privacy.venueName,
      capability,
      executable: false,
      level: "unavailable",
      headline: `Unavailable on ${privacy.venueName}`,
      details: [reason],
      rows: [],
      profile: null,
    };
  }

  const rows: DisclosureRow[] = [];
  for (const party of PRIVACY_PARTIES) {
    for (const data of PRIVACY_DATA) {
      rows.push({ party, partyLabel: PARTY_LABEL[party], data, dataLabel: DATA_LABEL[data], cell: profile[party][data] });
    }
  }
  const level = levelOf(profile);
  const pub = profile["public-observers"];
  const details = [
    pub["order-details"].note ?? `Public observers: order details ${pub["order-details"].exposure.replace("-", " ")}.`,
    pub["execution-details"].note ?? `Public observers: executions ${pub["execution-details"].exposure.replace("-", " ")}.`,
    pub["account-identity"].exposure === "visible"
      ? `Trades are publicly attributable to your account${pub["account-identity"].note ? ` (${pub["account-identity"].note})` : ""}.`
      : `Public observers cannot attribute trades to your account.`,
    ...privacy.notes,
  ];
  return {
    mode,
    venueName: privacy.venueName,
    capability,
    executable: capability.status === "supported",
    level,
    headline: HEADLINE[level](privacy.venueName),
    details,
    rows,
    profile,
  };
}
