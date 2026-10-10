import {
  defineCapabilities,
  notImplemented,
  supported,
  venueUnsupported,
} from "@/core/domain";
import type { VenueExecutionCapabilities } from "@/core/ports";
import type { VenueCapabilities } from "@/core/trading";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

/** What the simulator publishes. It declares the most conservative visibility. */
export const simulationVisibility: VenueExecutionCapabilities = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  restingOrderVisibility: "public-book",
  fillVisibility: "public-tape",
  publicAccountAttribution: false,
  supportedPrivateModes: [],
  notes: ["Simulated venue: orders are matched in this browser against simulated data; nothing is sent anywhere."],
};

const SIM = "Simulated";

/**
 * Capabilities the paper-trading simulator actually implements. Anything
 * else is declared unsupported — the simulator never fakes an order type by
 * substituting another.
 */
export const simulationCapabilities: VenueCapabilities = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  origin: "simulated",
  visibility: simulationVisibility,
  capabilities: defineCapabilities({
    "order.limit": supported(SIM),
    "order.market": supported(`${SIM}; IOC against the simulated book with a slippage limit`),
    "order.stop-market": supported(`${SIM}; triggers on the simulated mark price`),
    "order.take-profit-market": supported(`${SIM}; triggers on the simulated mark price`),
    "order.stop-limit": notImplemented("Stop-limit orders are not implemented in the simulator."),
    "order.take-profit-limit": notImplemented("Take-profit-limit orders are not implemented in the simulator."),
    "order.iceberg": venueUnsupported("The simulator shows every resting order in full; iceberg orders are not offered."),
    "order.hidden": venueUnsupported("The simulator publishes all resting orders; hidden orders are not offered."),
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
    "execution.rfq": venueUnsupported("The simulator has no request-for-quote mechanism."),
    "execution.batch-auction": venueUnsupported("The simulator matches continuously; batch auctions are not offered."),
    "margin.isolated": supported(),
    "margin.cross": notImplemented("The simulator models isolated margin only."),
  }),
};
