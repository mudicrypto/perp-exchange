import type { PrivateExecutionMode, VenueExecutionCapabilities } from "../ports";

export type VisibilityLevel = "public" | "partially-private" | "private";

export interface ExecutionDisclosure {
  level: VisibilityLevel;
  headline: string;
  details: string[];
  /** Private modes the user could choose on this venue (empty = none). */
  availablePrivateModes: readonly PrivateExecutionMode[];
}

/**
 * Derives the user-facing visibility disclosure for an order routed to a
 * venue. The result depends only on the venue's declared capabilities and
 * the requested mode — never on UI state — so an order cannot be presented
 * as hidden when the receiving venue publishes it.
 */
export function describeExecutionVisibility(
  capabilities: VenueExecutionCapabilities,
  requestedMode: PrivateExecutionMode | null,
): ExecutionDisclosure {
  const modeSupported =
    requestedMode !== null && capabilities.supportedPrivateModes.includes(requestedMode);

  const details: string[] = [];
  if (requestedMode !== null && !modeSupported) {
    details.push(
      `${capabilities.venueName} does not support "${requestedMode}" orders; the order would be public.`,
    );
  }

  const bookPublic = !modeSupported && capabilities.restingOrderVisibility === "public-book";
  if (bookPublic) {
    details.push(
      `Resting orders are published in ${capabilities.venueName}'s public order book (price and size).`,
    );
  }
  if (capabilities.fillVisibility === "public-ledger") {
    details.push("Fills are recorded on a public ledger.");
  } else if (capabilities.fillVisibility === "public-tape") {
    details.push("Fills appear on the public trade tape.");
  }
  if (capabilities.publicAccountAttribution) {
    details.push("Trades are publicly attributable to the trading account address.");
  }
  details.push(...capabilities.notes);

  const fillsPrivate = capabilities.fillVisibility === "private" && !capabilities.publicAccountAttribution;
  const level: VisibilityLevel = bookPublic
    ? "public"
    : fillsPrivate
      ? "private"
      : "partially-private";

  const headline =
    level === "public"
      ? `Public order on ${capabilities.venueName}`
      : level === "private"
        ? `Private execution on ${capabilities.venueName}`
        : `Hidden from book, fills public on ${capabilities.venueName}`;

  return { level, headline, details, availablePrivateModes: capabilities.supportedPrivateModes };
}
