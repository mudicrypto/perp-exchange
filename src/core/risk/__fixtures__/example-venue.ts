import type { AccountSnapshot, Market, Position } from "../../domain";
import { dec } from "../decimal";
import { constantRateIsolatedLiquidationPrice, ruleUnavailable, type VenueMarginRules } from "../margin-rules";

/**
 * The fictional "Example venue" used by docs/RISK.md's worked examples:
 * isolated margin, constant 2 % maintenance rate, taker 0.045 %, maker
 * 0.015 %, hourly funding on the oracle price.
 */
export const EX: Market = { id: "EX-PERP", base: "EX", quote: "USDC", sizeDecimals: 3, priceDecimals: 1, maxLeverage: 25, isolatedOnly: true, maintenanceMarginRate: 0.02 };
export const WHY: Market = { id: "WHY-PERP", base: "WHY", quote: "USDC", sizeDecimals: 2, priceDecimals: 1, maxLeverage: 20, isolatedOnly: true, maintenanceMarginRate: 0.02 };

export const exampleRules: VenueMarginRules = {
  venueId: "example",
  venueName: "Example venue",
  source: "docs/RISK.md example",
  initialMargin: ({ notional, leverage }) => ({ ok: true, value: notional.abs().div(leverage), kind: "calculated", method: "notional / leverage", assumptions: [] }),
  maintenanceMargin: ({ market, notional }) => ({ ok: true, value: notional.abs().mul(dec(market.maintenanceMarginRate)), kind: "calculated", method: "notional × rate", assumptions: [] }),
  liquidationPrice: ({ market, side, size, entryPrice, collateral, marginMode }) => {
    if (marginMode !== "isolated") return ruleUnavailable("isolated only");
    const p = constantRateIsolatedLiquidationPrice({ side, size, entryPrice, collateral, maintenanceMarginRate: dec(market.maintenanceMarginRate) });
    return p ? { ok: true, value: p, kind: "estimate", method: "constant-rate isolated", assumptions: [] } : ruleUnavailable("The position cannot be liquidated by price alone");
  },
  feeRates: () => ({ ok: true, value: { taker: dec("0.00045"), maker: dec("0.00015") }, kind: "calculated", method: "example schedule", assumptions: [] }),
  funding: { charged: true, priceBasis: "oracle", source: "example: hourly on oracle price" },
};

export const NOW = 1_700_000_000_000;

/** Example A: long 2 EX @ 1000, 10x isolated (collateral 200). */
export const longA: Position = { marketId: "EX-PERP", size: 2, entryPrice: 1000, leverage: 10, marginMode: "isolated", marginUsed: 200, liquidationPrice: null, markPrice: null, unrealizedPnl: 0 };
/** Example B: short 3 WHY @ 50, 5x isolated (collateral 30). */
export const shortB: Position = { marketId: "WHY-PERP", size: -3, entryPrice: 50, leverage: 5, marginMode: "isolated", marginUsed: 30, liquidationPrice: null, markPrice: null, unrealizedPnl: 0 };

export function account(positions: Position[], overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    origin: "simulated",
    currency: "USDC",
    balances: [],
    balance: 10_000,
    equity: 10_106,
    unrealizedPnl: 106,
    realizedPnl: null,
    feesPaid: null,
    marginUsed: 230,
    orderMargin: 0,
    available: 9_876,
    maintenanceMargin: null,
    positions,
    observedAt: NOW,
    ...overrides,
  };
}
