import {
  defineCapabilities,
  notImplemented,
  supported,
  venueUnsupported,
  type CapabilityMap,
} from "@/core/domain";
import { allData, cell, type VenuePrivacy } from "@/core/privacy";
import type { VenueCapabilities } from "@/core/trading";
import { HYPERLIQUID_VENUE_ID } from "./constants";

const SUBMISSION_DISABLED =
  "Hyperliquid offers this, but Nova's order signing and submission are disabled until a separate security-reviewed milestone.";
const NOT_A_VENUE_TYPE =
  "Not one of Hyperliquid's order types (official SDK: limit with Gtc/Ioc/Alo, and trigger tp/sl orders). Resting orders are public in the L2 book.";
const ENCRYPTED_PLANNED =
  "Planned. Encrypted orders need a protocol-level design (e.g. threshold-encrypted order flow) that does not exist in Nova; it is not a UI setting.";

/**
 * Hyperliquid is a transparent venue: resting orders appear in the public L2
 * book, and trades are published with buyer and seller addresses (official
 * SDK `Trade.users`). Only the public-limit mode exists there.
 */
export const hyperliquidPrivacy: VenuePrivacy = {
  venueId: HYPERLIQUID_VENUE_ID,
  venueName: "Hyperliquid",
  notes: ["Nova cannot hide orders that Hyperliquid publishes. Private modes require a venue that supports them."],
  profiles: {
    "public-limit": {
      "public-observers": {
        "order-details": cell("visible", "Price and size are published in Hyperliquid's public L2 book."),
        "account-identity": cell("visible", "trades carry buyer and seller addresses"),
        "execution-details": cell("visible", "Fills are published on the public trade feed and ledger."),
        "subsequent-trades": cell("visible", "Your address's trade history is public and linkable."),
      },
      "matching-engine": allData("visible"),
      "venue-operator": allData("visible"),
      "rfq-counterparties": allData("not-applicable"),
      "nova-backend": {
        "order-details": cell("not-applicable", "Nova does not relay Hyperliquid orders in this milestone."),
        "account-identity": cell("partial", "Only an address you look up through the read-only account endpoint; not stored."),
        "execution-details": cell("not-applicable"),
        "subsequent-trades": cell("not-applicable"),
      },
      "other-nova-users": allData("visible", "Other Nova users are public observers too."),
    },
  },
};

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
  "execution.encrypted": notImplemented(ENCRYPTED_PLANNED),
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
  privacy: hyperliquidPrivacy,
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
    "execution.encrypted": notImplemented(ENCRYPTED_PLANNED),
    "margin.isolated": notImplemented(SUBMISSION_DISABLED),
    "margin.cross": notImplemented(SUBMISSION_DISABLED),
  }),
};
