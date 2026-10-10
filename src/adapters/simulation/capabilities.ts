import {
  defineCapabilities,
  notImplemented,
  supported,
  venueUnsupported,
} from "@/core/domain";
import { allData, cell, type VenuePrivacy } from "@/core/privacy";
import type { VenueCapabilities } from "@/core/trading";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

const LOCAL = "The simulated venue runs in this browser; other people cannot see it.";
const NOT_SENT = "Simulated orders never leave your browser.";

/**
 * The simulator models a venue with native hidden and iceberg orders and a
 * private RFQ desk. Each statement below is true of the simulation and is
 * enforced in code:
 *  - the simulated public book shows your displayed resting orders (limit:
 *    full remaining size; iceberg: the displayed slice; hidden: nothing),
 *  - every fill prints on the simulated public trade tape without identity,
 *  - RFQ requests go through Nova's server-side RFQ service, which only the
 *    requester and the selected counterparties can read.
 */
export const simulationPrivacy: VenuePrivacy = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  notes: ["Simulated venue: balances and executions are fictitious (SIMUSD)."],
  profiles: {
    "public-limit": {
      "public-observers": {
        "order-details": cell("visible", "Your resting order is shown in full in the simulated public order book."),
        "account-identity": cell("not-visible", "The simulated tape and book carry no account identity."),
        "execution-details": cell("visible", "Fills print on the simulated public trade tape."),
        "subsequent-trades": cell("not-visible"),
      },
      "matching-engine": allData("visible", "The simulated matching engine in your browser."),
      "venue-operator": allData("visible", "The simulator itself."),
      "rfq-counterparties": allData("not-applicable"),
      "nova-backend": allData("not-visible", NOT_SENT),
      "other-nova-users": allData("not-visible", LOCAL),
    },
    hidden: {
      "public-observers": {
        "order-details": cell("not-visible", "Hidden orders are excluded from the simulated public order book."),
        "account-identity": cell("not-visible"),
        "execution-details": cell("visible", "Fills still print on the simulated public tape (anonymously)."),
        "subsequent-trades": cell("not-visible"),
      },
      "matching-engine": allData("visible", "The matching engine must see hidden orders to match them."),
      "venue-operator": allData("visible", "The simulator itself."),
      "rfq-counterparties": allData("not-applicable"),
      "nova-backend": allData("not-visible", NOT_SENT),
      "other-nova-users": allData("not-visible", LOCAL),
    },
    iceberg: {
      "public-observers": {
        "order-details": cell(
          "partial",
          "Only the displayed quantity is shown at your limit price. Each refill shows a new slice, so repeated refills at one price can reveal a larger order.",
        ),
        "account-identity": cell("not-visible"),
        "execution-details": cell("visible", "Every slice's fills print on the simulated public tape."),
        "subsequent-trades": cell("not-visible"),
      },
      "matching-engine": allData("visible", "The matching engine sees the full size."),
      "venue-operator": allData("visible", "The simulator itself."),
      "rfq-counterparties": allData("not-applicable"),
      "nova-backend": allData("not-visible", NOT_SENT),
      "other-nova-users": allData("not-visible", LOCAL),
    },
    rfq: {
      "public-observers": {
        "order-details": cell("not-visible", "The request goes only to the counterparties you select."),
        "account-identity": cell("not-visible"),
        "execution-details": cell("partial", "An accepted trade prints on the simulated tape after execution, without identities."),
        "subsequent-trades": cell("not-visible"),
      },
      "matching-engine": {
        "order-details": cell("visible", "Nova's RFQ service routes the request (market, size, side if revealed). There is no order book matching."),
        "account-identity": cell("partial", "A random session id only; no wallet or personal data."),
        "execution-details": cell("visible", "The accepted price and size."),
        "subsequent-trades": cell("not-visible"),
      },
      "venue-operator": {
        "order-details": cell("visible", "Nova operates the simulated RFQ service. Your limit price is never sent."),
        "account-identity": cell("partial", "A random session id only."),
        "execution-details": cell("visible", "Kept at most 5 minutes after the request ends."),
        "subsequent-trades": cell("not-visible"),
      },
      "rfq-counterparties": {
        "order-details": cell("partial", "Market and size; the side only if you reveal it. Never your limit price. Simulated auto-quoting desks also price from the public mid you saw."),
        "account-identity": cell("not-visible", "Requests carry a one-time request id, not your session or account."),
        "execution-details": cell("partial", "Only the counterparty whose quote you accept learns the execution."),
        "subsequent-trades": cell("not-visible"),
      },
      "nova-backend": {
        "order-details": cell("partial", "Market, size, the public mid you saw, side (only if revealed, or once you accept) and quotes. Never your limit price."),
        "account-identity": cell("partial", "A random session id in an HttpOnly cookie."),
        "execution-details": cell("visible", "Accepted price and size, deleted at most 5 minutes after completion."),
        "subsequent-trades": cell("not-visible", "Sessions are not linked to your positions."),
      },
      "other-nova-users": allData("not-visible", "Server-side authorization: only you and the selected counterparties can read the request."),
    },
  },
};

const SIM = "Simulated";

/**
 * Capabilities the simulator actually implements. Anything else is declared
 * unsupported — the simulator never fakes an order type by substituting another.
 */
export const simulationCapabilities: VenueCapabilities = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  origin: "simulated",
  privacy: simulationPrivacy,
  capabilities: defineCapabilities({
    "order.limit": supported(SIM),
    "order.market": supported(`${SIM}; IOC against the simulated book with a slippage limit`),
    "order.stop-market": supported(`${SIM}; triggers on the simulated mark price`),
    "order.take-profit-market": supported(`${SIM}; triggers on the simulated mark price`),
    "order.stop-limit": notImplemented("Stop-limit orders are not implemented in the simulator."),
    "order.take-profit-limit": notImplemented("Take-profit-limit orders are not implemented in the simulator."),
    "order.iceberg": supported(`${SIM}; the public book shows only the displayed slice`),
    "order.hidden": supported(`${SIM}; excluded from the simulated public book`),
    "order.twap": notImplemented("TWAP orders are not implemented in the simulator."),
    "tif.gtc": supported(),
    "tif.ioc": supported(),
    "tif.post-only": supported(),
    "order.reduce-only": supported(),
    "action.submit": supported(`${SIM} — no real order is placed`),
    "action.cancel": supported(SIM),
    "action.cancel-all": supported(SIM),
    "read.open-orders": supported(SIM),
    "read.positions": supported(SIM),
    "read.account": supported(`${SIM} SIMUSD balances`),
    "stream.order-updates": supported(SIM),
    "stream.fills": supported(SIM),
    "execution.rfq": supported(`${SIM} counterparties via Nova's RFQ service`),
    "execution.batch-auction": venueUnsupported("The simulator matches continuously; batch auctions are not offered."),
    "execution.encrypted": notImplemented(
      "Planned. Encrypted orders need a protocol-level design (e.g. threshold-encrypted order flow) that does not exist in Nova; it is not a UI setting.",
    ),
    "margin.isolated": supported(),
    "margin.cross": notImplemented("The simulator models isolated margin only."),
  }),
};
