/**
 * Privacy model: who can see what, for each execution mode, on a given venue.
 *
 * A venue declares a `PrivacyProfile` for every execution mode it offers.
 * Disclosures shown to users are derived from these profiles only, and
 * `validateVenuePrivacy` rejects declarations that contradict the venue's
 * capabilities or the meaning of a mode (e.g. an iceberg claiming anonymity).
 */

export const EXECUTION_MODES = ["public-limit", "hidden", "iceberg", "rfq", "encrypted"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export type PrivateExecutionMode = Exclude<ExecutionMode, "public-limit">;
export const PRIVATE_EXECUTION_MODES: readonly PrivateExecutionMode[] = ["hidden", "iceberg", "rfq", "encrypted"];

export const PRIVACY_PARTIES = [
  "public-observers",
  "matching-engine",
  "venue-operator",
  "rfq-counterparties",
  "nova-backend",
  "other-nova-users",
] as const;
export type PrivacyParty = (typeof PRIVACY_PARTIES)[number];

export const PRIVACY_DATA = ["order-details", "account-identity", "execution-details", "subsequent-trades"] as const;
export type PrivacyData = (typeof PRIVACY_DATA)[number];

export const PARTY_LABEL: Record<PrivacyParty, string> = {
  "public-observers": "Public market observers",
  "matching-engine": "Matching engine",
  "venue-operator": "Venue operator",
  "rfq-counterparties": "Selected RFQ counterparties",
  "nova-backend": "Nova backend",
  "other-nova-users": "Other Nova users",
};

export const DATA_LABEL: Record<PrivacyData, string> = {
  "order-details": "Order details (side, size, price) before execution",
  "account-identity": "Account identity",
  "execution-details": "Execution details (price, size, time)",
  "subsequent-trades": "Linkage to your subsequent trades",
};

/**
 * - visible:        the party can see this data
 * - partial:        the party sees some of it (the note says what)
 * - not-visible:    the party cannot see it under this design
 * - not-applicable: the party plays no role in this mode
 */
export type Exposure = "visible" | "partial" | "not-visible" | "not-applicable";

export interface ExposureCell {
  exposure: Exposure;
  note?: string;
}

export type PrivacyProfile = Readonly<Record<PrivacyParty, Readonly<Record<PrivacyData, ExposureCell>>>>;

export interface VenuePrivacy {
  venueId: string;
  venueName: string;
  /** Present exactly for the modes the venue offers (supported or not yet implemented by Nova). */
  profiles: Partial<Record<ExecutionMode, PrivacyProfile>>;
  /** Plain-language notes shown with every disclosure for this venue. */
  notes: readonly string[];
}

export const cell = (exposure: Exposure, note?: string): ExposureCell => (note ? { exposure, note } : { exposure });

/** Builds a profile row where every data class has the same exposure. */
export function allData(exposure: Exposure, note?: string): Record<PrivacyData, ExposureCell> {
  return {
    "order-details": cell(exposure, note),
    "account-identity": cell(exposure, note),
    "execution-details": cell(exposure, note),
    "subsequent-trades": cell(exposure, note),
  };
}
