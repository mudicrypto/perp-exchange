import type { AccountSnapshot, BookLevel, Market, MarketStats, OrderIntent } from "../domain";

export interface BookImpactEstimate {
  /** Volume-weighted average fill price over visible levels. Null if no liquidity. */
  averagePrice: number | null;
  /** Signed distance of averagePrice from the best price, as a fraction. */
  priceImpact: number | null;
  filledSize: number;
  levelsConsumed: number;
  /** True if visible book depth cannot fill the requested size. */
  exceedsVisibleDepth: boolean;
}

export interface PreTradeRisk {
  referencePrice: number;
  notional: number;
  initialMargin: number;
  /** Estimated liquidation price for an isolated position of this size. */
  estimatedLiquidationPrice: number | null;
  /** Fractional distance from reference price to estimated liquidation. */
  liquidationDistance: number | null;
  maintenanceMarginRate: number;
  bookImpact: BookImpactEstimate | null;
  warnings: RiskWarning[];
}

export type RiskWarning =
  | { code: "exceeds-max-leverage"; maxLeverage: number }
  | { code: "exceeds-visible-depth" }
  | { code: "high-price-impact"; impact: number }
  | { code: "liquidation-near"; distance: number }
  | { code: "stale-market-data" }
  | { code: "limit-crosses-book" };

export interface PortfolioRisk {
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;
  /** grossExposure / equity; null if equity <= 0. */
  effectiveLeverage: number | null;
  /** maintenanceMargin / equity; null if equity <= 0. */
  marginUtilization: number | null;
  unrealizedPnl: number;
  /** Position closest to its liquidation price (fractional distance from mark). */
  closestLiquidation: { marketId: string; distance: number } | null;
}

export interface PreTradeInput {
  intent: OrderIntent;
  market: Market;
  stats: MarketStats | null;
  book: { bids: BookLevel[]; asks: BookLevel[] } | null;
  dataIsStale: boolean;
}

export interface RiskEngine {
  preTrade(input: PreTradeInput): PreTradeRisk | null;
  /** Uses each position's mark price (falls back to entry price if unknown). */
  portfolio(account: AccountSnapshot): PortfolioRisk;
}
