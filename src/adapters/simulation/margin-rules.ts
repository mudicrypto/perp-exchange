import { constantRateIsolatedLiquidationPrice, dec, ruleUnavailable, type VenueMarginRules } from "@/core/risk";
import { PAPER_FEES } from "./paper-engine";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

const SOURCE = "Nova simulator rules (src/adapters/simulation/paper-engine.ts)";

/**
 * The simulated venue's own rules — exactly what `PaperEngine` enforces:
 * isolated margin only, initial margin = notional / leverage, a constant
 * maintenance margin rate per market (no tiers), liquidation at the mark
 * once equity reaches maintenance margin, fixed paper fees, no funding.
 */
export const simulationMarginRules: VenueMarginRules = {
  venueId: SIMULATION_VENUE_ID,
  venueName: "Simulator",
  source: SOURCE,
  initialMargin: ({ notional, leverage }) =>
    leverage.lte(0)
      ? ruleUnavailable("Leverage must be positive", ["Leverage"])
      : { ok: true, value: notional.abs().div(leverage), kind: "calculated", method: "notional / leverage (simulator rule)", assumptions: [] },
  maintenanceMargin: ({ market, notional }) => ({
    ok: true,
    value: notional.abs().mul(dec(market.maintenanceMarginRate)),
    kind: "calculated",
    method: `notional × ${market.maintenanceMarginRate} (simulator's constant maintenance rate for ${market.id})`,
    assumptions: [],
  }),
  liquidationPrice: ({ market, side, size, entryPrice, collateral, marginMode }) => {
    if (marginMode !== "isolated") return ruleUnavailable("The simulator supports isolated margin only");
    const price = constantRateIsolatedLiquidationPrice({ side, size, entryPrice, collateral, maintenanceMarginRate: dec(market.maintenanceMarginRate) });
    if (price === null) return ruleUnavailable("The position cannot be liquidated by price alone (collateral covers the full notional)");
    return {
      ok: true,
      value: price,
      kind: "estimate",
      method: `Isolated, constant maintenance rate ${market.maintenanceMarginRate}: long P = (q·E − C) / (q·(1 − m)), short P = (q·E + C) / (q·(1 + m))`,
      assumptions: ["The simulator liquidates at the mark when it crosses this level; fees are not included."],
    };
  },
  feeRates: () => ({
    ok: true,
    value: { taker: dec(PAPER_FEES.taker), maker: dec(PAPER_FEES.maker) },
    kind: "calculated",
    method: "Simulator paper fee schedule",
    assumptions: [],
  }),
  funding: { charged: false, reason: "The simulated venue does not charge funding" },
};
