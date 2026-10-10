import type { Instrument, Order, OrderRequest, Result, TradingError } from "../domain";
import type { ExecutionAdapter } from "../ports";
import {
  describeExecution,
  MODE_CAPABILITY,
  validateVenuePrivacy,
  type ExecutionDisclosure,
  type ExecutionMode,
  type VisibilityLevel,
} from "../privacy";
import type { VenueCapabilities } from "./capability-registry";

/** Modes that go through an execution adapter's order book. */
export type BookPrivateMode = Extract<ExecutionMode, "hidden" | "iceberg">;

const MODE_ORDER_TYPE: Record<BookPrivateMode, OrderRequest["type"]> = { hidden: "hidden", iceberg: "iceberg" };

/**
 * What the user confirmed. It must match the disclosure Nova derives from
 * the venue at submission time, so a stale or tampered confirmation (e.g. a
 * UI showing "private" for a venue that publishes orders) is refused.
 */
export interface PrivacyAcknowledgement {
  mode: ExecutionMode;
  venueId: string;
  level: VisibilityLevel;
}

const fail = (error: TradingError): Result<never> => ({ ok: false, error });

/**
 * Checks that a mode can honestly be executed on a venue: its privacy
 * declarations are consistent and the mode's capability is supported.
 * Returns the disclosure the user must be shown, or the reason it cannot run.
 */
export function checkPrivateMode(venue: VenueCapabilities, mode: ExecutionMode): Result<ExecutionDisclosure> {
  const issues = validateVenuePrivacy(venue.capabilities, venue.privacy);
  if (issues.length > 0) {
    return fail({
      code: "unsupported",
      capability: MODE_CAPABILITY[mode],
      scope: "nova",
      message: `${venue.venueName}'s privacy declarations are inconsistent; private execution is disabled.`,
    });
  }
  const disclosure = describeExecution(venue.capabilities, venue.privacy, mode);
  if (!disclosure.executable) {
    const status = disclosure.capability;
    return fail({
      code: "unsupported",
      capability: MODE_CAPABILITY[mode],
      scope: status.status === "unsupported" ? status.scope : "nova",
      message: status.status === "unsupported" ? status.reason : `${mode} is not available on ${venue.venueName}`,
    });
  }
  return { ok: true, value: disclosure };
}

/**
 * Routes hidden and iceberg orders. The adapter is only called when the
 * venue itself supports the mode; Nova never sends a "hidden" order to a
 * venue that would publish it, and never substitutes another order type.
 * RFQ is not an order-book mode (see the RFQ service), and encrypted
 * execution is planned only: both are refused here.
 */
export class PrivateExecutionService {
  constructor(private readonly adapter: ExecutionAdapter) {}

  disclosure(mode: ExecutionMode): ExecutionDisclosure {
    const venue = this.adapter.getCapabilities();
    return describeExecution(venue.capabilities, venue.privacy, mode);
  }

  async submit(mode: ExecutionMode, input: unknown, instrument: Instrument, acknowledgement: PrivacyAcknowledgement | null): Promise<Result<Order>> {
    const venue = this.adapter.getCapabilities();
    if (mode !== "hidden" && mode !== "iceberg") {
      const check = checkPrivateMode(venue, mode);
      if (!check.ok) return check;
      return fail({
        code: "unsupported",
        capability: MODE_CAPABILITY[mode],
        scope: "nova",
        message: mode === "rfq" ? "RFQ trades are requested through the RFQ desk, not submitted as orders." : "Use the order ticket for public orders.",
      });
    }
    const check = checkPrivateMode(venue, mode);
    if (!check.ok) return check;
    const disclosure = check.value;
    if (!acknowledgement || acknowledgement.mode !== mode || acknowledgement.venueId !== venue.venueId || acknowledgement.level !== disclosure.level) {
      return fail({
        code: "validation",
        issues: [{ field: "acknowledgement", message: "Confirm the privacy disclosure for this venue and mode" }],
        message: "The privacy disclosure must be confirmed before submitting",
      });
    }
    const validated = this.adapter.validateOrder(input, instrument);
    if (!validated.ok) return validated;
    if (validated.value.type !== MODE_ORDER_TYPE[mode]) {
      return fail({
        code: "validation",
        issues: [{ field: "type", message: `A ${mode} submission must be a ${MODE_ORDER_TYPE[mode]} order` }],
        message: `Order type does not match the ${mode} mode`,
      });
    }
    return this.adapter.submitOrder(validated.value, instrument);
  }
}
