import { ruleUnavailable, type VenueMarginRules } from "@/core/risk";
import { HYPERLIQUID_VENUE_ID } from "./constants";

const TIERS_MISSING =
  "Hyperliquid sets maintenance margin per asset from margin tables (tiers by position size). Nova does not load those tables yet, so it does not compute Hyperliquid maintenance margin or liquidation prices.";

/**
 * Hyperliquid rules as far as Nova can apply them without guessing:
 * - initial margin = position value / leverage (Hyperliquid margining docs);
 * - maintenance margin and liquidation price: never computed by Nova (tiered
 *   margin tables are not loaded). For open positions the venue's own
 *   `liquidationPx` from clearinghouseState is shown, labelled venue-reported;
 * - fees depend on the account's volume tier and are not known to Nova;
 * - funding is charged hourly on the oracle price (Hyperliquid funding docs).
 * The doc-derived parts could not be re-verified against the live docs from
 * the build environment (see docs/RISK.md).
 */
export const hyperliquidMarginRules: VenueMarginRules = {
  venueId: HYPERLIQUID_VENUE_ID,
  venueName: "Hyperliquid",
  source: "Hyperliquid documentation (margining, liquidations, funding); unverified against the live docs in this build",
  initialMargin: ({ notional, leverage }) =>
    leverage.lte(0)
      ? ruleUnavailable("Leverage must be positive", ["Leverage"])
      : { ok: true, value: notional.abs().div(leverage), kind: "calculated", method: "position value / leverage (Hyperliquid)", assumptions: [] },
  maintenanceMargin: () => ruleUnavailable(TIERS_MISSING, ["Hyperliquid margin tables"]),
  liquidationPrice: ({ reportedLiquidationPrice }) =>
    reportedLiquidationPrice !== null && reportedLiquidationPrice.gt(0)
      ? { ok: true, value: reportedLiquidationPrice, kind: "venue-reported", method: "Hyperliquid clearinghouseState liquidationPx", assumptions: ["Reported by the venue; it moves with the account's margin and other positions (cross margin)."] }
      : ruleUnavailable(TIERS_MISSING, ["Hyperliquid margin tables"]),
  feeRates: () => ruleUnavailable("Hyperliquid fees depend on the account's volume tier, which Nova does not know", ["Account fee tier"]),
  funding: { charged: true, priceBasis: "oracle", source: "Hyperliquid funding: hourly, position size × oracle price × funding rate (per docs)" },
};

/** Exported for tests: the inputs Nova would need to compute Hyperliquid liquidation itself. */
export const HYPERLIQUID_MISSING_INPUTS = ["Hyperliquid margin tables"] as const;
