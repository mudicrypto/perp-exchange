import type { Market, MarketStats } from "@/core/domain";
import { formatPercent } from "@/lib/format";
import { SummaryRow } from "@/components/trading/values";

/** Static and live risk parameters of the selected market. */
export function MarketRiskFacts({ market, stats }: { market: Market; stats: MarketStats | null }) {
  const annualizedFunding = stats ? stats.fundingRate * (24 / stats.fundingIntervalHours) * 365 : null;
  const basis = stats?.oraclePrice ? (stats.markPrice - stats.oraclePrice) / stats.oraclePrice : null;
  return (
    <dl className="max-w-xl p-3" data-testid="market-risk-facts">
      <SummaryRow label="Max leverage">{market.maxLeverage}x</SummaryRow>
      <SummaryRow label="Initial margin at max leverage">{formatPercent(1 / market.maxLeverage, 2)}</SummaryRow>
      <SummaryRow label="Maintenance margin rate (base tier)">{formatPercent(market.maintenanceMarginRate, 2)}</SummaryRow>
      <SummaryRow label="Margin modes">{market.isolatedOnly ? "Isolated only" : "Cross and isolated (Nova preview: isolated)"}</SummaryRow>
      <SummaryRow label="Funding (annualised at current rate)">{formatPercent(annualizedFunding, 2, true)}</SummaryRow>
      <SummaryRow label="Mark vs oracle basis">{formatPercent(basis, 3, true)}</SummaryRow>
      <SummaryRow label="Size step / price decimals">
        {(10 ** -market.sizeDecimals).toFixed(market.sizeDecimals)} / {market.priceDecimals}
      </SummaryRow>
    </dl>
  );
}
