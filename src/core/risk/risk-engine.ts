import type { AccountSnapshot } from "../domain";
import type {
  PortfolioRisk,
  PreTradeInput,
  PreTradeRisk,
  RiskEngine,
  RiskWarning,
} from "../ports";
import { estimateBookImpact, estimateIsolatedLiquidationPrice, initialMargin } from "./risk-math";

export interface RiskThresholds {
  /** Warn when estimated price impact exceeds this fraction. */
  highImpact: number;
  /** Warn when liquidation is closer than this fraction of price. */
  nearLiquidation: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  highImpact: 0.005,
  nearLiquidation: 0.05,
};

export class DefaultRiskEngine implements RiskEngine {
  constructor(private readonly thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS) {}

  preTrade({ intent, market, stats, book, dataIsStale }: PreTradeInput): PreTradeRisk | null {
    const warnings: RiskWarning[] = [];
    const consumed = book ? (intent.side === "buy" ? book.asks : book.bids) : null;
    const bookImpact =
      intent.type === "market" && consumed ? estimateBookImpact(consumed, intent.size) : null;

    const referencePrice =
      intent.type === "limit"
        ? intent.limitPrice
        : (bookImpact?.averagePrice ?? stats?.markPrice ?? null);
    if (referencePrice === null || referencePrice === undefined) return null;

    const notional = intent.size * referencePrice;
    const margin = initialMargin(notional, intent.leverage);
    const liquidation = estimateIsolatedLiquidationPrice({
      side: intent.side,
      entryPrice: referencePrice,
      size: intent.size,
      collateral: margin,
      maintenanceMarginRate: market.maintenanceMarginRate,
    });
    const liquidationDistance =
      liquidation === null ? null : Math.abs(referencePrice - liquidation) / referencePrice;

    if (intent.leverage > market.maxLeverage) {
      warnings.push({ code: "exceeds-max-leverage", maxLeverage: market.maxLeverage });
    }
    if (bookImpact?.exceedsVisibleDepth) warnings.push({ code: "exceeds-visible-depth" });
    if (bookImpact?.priceImpact != null && bookImpact.priceImpact > this.thresholds.highImpact) {
      warnings.push({ code: "high-price-impact", impact: bookImpact.priceImpact });
    }
    if (liquidationDistance !== null && liquidationDistance < this.thresholds.nearLiquidation) {
      warnings.push({ code: "liquidation-near", distance: liquidationDistance });
    }
    if (dataIsStale) warnings.push({ code: "stale-market-data" });
    if (intent.type === "limit" && intent.limitPrice !== null && book) {
      const bestAsk = book.asks[0]?.price;
      const bestBid = book.bids[0]?.price;
      const crosses =
        intent.side === "buy"
          ? bestAsk !== undefined && intent.limitPrice >= bestAsk
          : bestBid !== undefined && intent.limitPrice <= bestBid;
      if (crosses) warnings.push({ code: "limit-crosses-book" });
    }

    return {
      referencePrice,
      notional,
      initialMargin: margin,
      estimatedLiquidationPrice: liquidation,
      liquidationDistance,
      maintenanceMarginRate: market.maintenanceMarginRate,
      bookImpact,
      warnings,
    };
  }

  portfolio(account: AccountSnapshot): PortfolioRisk {
    let long = 0;
    let short = 0;
    let unrealized = 0;
    let closest: PortfolioRisk["closestLiquidation"] = null;
    for (const position of account.positions) {
      const mark = position.markPrice ?? position.entryPrice;
      const exposure = position.size * mark;
      if (exposure >= 0) long += exposure;
      else short += -exposure;
      unrealized += position.size * (mark - position.entryPrice);
      if (position.liquidationPrice !== null) {
        const distance = Math.abs(mark - position.liquidationPrice) / mark;
        if (!closest || distance < closest.distance) closest = { marketId: position.marketId, distance };
      }
    }
    const gross = long + short;
    const positiveEquity = account.equity > 0;
    return {
      grossExposure: gross,
      netExposure: long - short,
      longExposure: long,
      shortExposure: short,
      effectiveLeverage: positiveEquity ? gross / account.equity : null,
      marginUtilization: positiveEquity ? account.maintenanceMargin / account.equity : null,
      unrealizedPnl: unrealized,
      closestLiquidation: closest,
    };
  }
}
