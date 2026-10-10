import {
  defineCapabilities,
  notImplemented,
  supported,
  venueUnsupported,
  type CapabilityMap,
} from "@/core/domain";
import type { VenueExecutionCapabilities } from "@/core/ports";
import type { VenueCapabilities } from "@/core/trading";
import { HYPERLIQUID_VENUE_ID } from "./constants";

/**
 * Hyperliquid is a transparent venue: resting orders appear in the public L2
 * book and trades settle on its public L1, attributable to account addresses.
 */
export const hyperliquidVisibility: VenueExecutionCapabilities = {
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

const SUBMISSION_DISABLED =
  "Hyperliquid offers this, but Nova's order signing and submission are disabled until a separate security-reviewed milestone.";
const NOT_A_VENUE_TYPE =
  "Not one of Hyperliquid's order types (official SDK: limit with Gtc/Ioc/Alo, and trigger tp/sl orders). Resting orders are public in the L2 book.";

/**
 * Hyperliquid's own order model, as defined by the official Python SDK
 * (`hyperliquid/utils/signing.py`: `OrderType = {limit: {tif: Alo|Ioc|Gtc}} |
 * {trigger: {triggerPx, isMarket, tpsl: tp|sl}}`, plus `reduceOnly` and
 * `cloid`). Used only to *validate* requests against venue rules.
 */
export const HYPERLIQUID_ORDER_MODEL: CapabilityMap = defineCapabilities({
  "order.limit": supported(),
  "order.market": supported("Sent as an aggressive IOC limit order with a slippage bound (SDK market_open)"),
  "order.stop-market": supported("trigger tpsl=sl, isMarket=true"),
  "order.stop-limit": supported("trigger tpsl=sl, isMarket=false"),
  "order.take-profit-market": supported("trigger tpsl=tp, isMarket=true"),
  "order.take-profit-limit": supported("trigger tpsl=tp, isMarket=false"),
  "order.iceberg": venueUnsupported(NOT_A_VENUE_TYPE),
  "order.hidden": venueUnsupported(NOT_A_VENUE_TYPE),
  "order.twap": notImplemented("Not modelled by Nova."),
  "tif.gtc": supported("Gtc"),
  "tif.ioc": supported("Ioc"),
  "tif.post-only": supported("Alo (add liquidity only)"),
  "order.reduce-only": supported(),
  "action.submit": supported(),
  "action.cancel": supported(),
  "action.cancel-all": supported(),
  "read.open-orders": supported(),
  "read.positions": supported(),
  "read.account": supported(),
  "stream.order-updates": supported(),
  "stream.fills": supported(),
  "execution.rfq": venueUnsupported("Hyperliquid has no request-for-quote order flow."),
  "execution.batch-auction": venueUnsupported("Hyperliquid matches continuously in a central limit order book."),
  "margin.isolated": supported(),
  "margin.cross": supported(),
});

/**
 * What Nova actually implements for Hyperliquid today: read-only access.
 * Every trading action is explicitly unsupported (never emulated).
 */
export const hyperliquidCapabilities: VenueCapabilities = {
  venueId: HYPERLIQUID_VENUE_ID,
  venueName: "Hyperliquid",
  origin: "venue",
  visibility: hyperliquidVisibility,
  capabilities: defineCapabilities({
    "order.limit": notImplemented(SUBMISSION_DISABLED),
    "order.market": notImplemented(SUBMISSION_DISABLED),
    "order.stop-market": notImplemented(SUBMISSION_DISABLED),
    "order.stop-limit": notImplemented(SUBMISSION_DISABLED),
    "order.take-profit-market": notImplemented(SUBMISSION_DISABLED),
    "order.take-profit-limit": notImplemented(SUBMISSION_DISABLED),
    "order.iceberg": venueUnsupported(NOT_A_VENUE_TYPE),
    "order.hidden": venueUnsupported(NOT_A_VENUE_TYPE),
    "order.twap": notImplemented("Not implemented in Nova; venue support not verified in this build."),
    "tif.gtc": notImplemented(SUBMISSION_DISABLED),
    "tif.ioc": notImplemented(SUBMISSION_DISABLED),
    "tif.post-only": notImplemented(SUBMISSION_DISABLED),
    "order.reduce-only": notImplemented(SUBMISSION_DISABLED),
    "action.submit": notImplemented(SUBMISSION_DISABLED),
    "action.cancel": notImplemented(SUBMISSION_DISABLED),
    "action.cancel-all": notImplemented(SUBMISSION_DISABLED),
    "read.open-orders": supported("Read-only, by public address (info: openOrders)"),
    "read.positions": supported("Read-only, by public address (info: clearinghouseState)"),
    "read.account": supported("Read-only, by public address (info: clearinghouseState)"),
    "stream.order-updates": notImplemented("Not implemented yet (Hyperliquid offers an orderUpdates subscription)."),
    "stream.fills": notImplemented("Not implemented yet (Hyperliquid offers a userFills subscription)."),
    "execution.rfq": venueUnsupported("Hyperliquid has no request-for-quote order flow."),
    "execution.batch-auction": venueUnsupported("Hyperliquid matches continuously in a central limit order book."),
    "margin.isolated": notImplemented(SUBMISSION_DISABLED),
    "margin.cross": notImplemented(SUBMISSION_DISABLED),
  }),
};
