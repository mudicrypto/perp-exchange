import { dayChangeFraction, type Market, type MarketStats } from "@/core/domain";
import { displayPriceDecimals, formatPercent, formatPrice, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ label, value, className, testId }: { label: string; value: string; className?: string; testId?: string }) {
  return (
    <div className="flex shrink-0 flex-col whitespace-nowrap">
      <span className="text-[10px] text-muted-foreground uppercase">{label}</span>
      <span data-testid={testId} className={cn("tabular text-xs font-medium", className)}>
        {value}
      </span>
    </div>
  );
}

export function MarketHeader({ market, stats }: { market: Market; stats: MarketStats | null }) {
  const decimals = displayPriceDecimals(stats?.markPrice, market.priceDecimals);
  const change = stats ? dayChangeFraction(stats) : null;
  const annualizedFunding = stats ? stats.fundingRate * (24 / stats.fundingIntervalHours) * 365 : null;
  return (
    <div className="flex min-w-0 items-center gap-6 overflow-x-auto" data-testid="market-header">
      <Stat label="Mark" testId="mark-price" value={formatPrice(stats?.markPrice, decimals)} className="text-sm" />
      <Stat label="Oracle" value={formatPrice(stats?.oraclePrice, decimals)} />
      <Stat
        label="24h change"
        value={formatPercent(change, 2, true)}
        className={change === null ? undefined : change >= 0 ? "text-buy" : "text-sell"}
      />
      <Stat label="24h volume" value={formatUsd(stats?.dayNotionalVolume, { compact: true })} />
      <Stat
        label="Open interest"
        value={stats ? formatUsd(stats.openInterest * stats.markPrice, { compact: true }) : "—"}
      />
      <Stat
        label={`Funding / ${stats?.fundingIntervalHours ?? 1}h`}
        value={`${formatPercent(stats?.fundingRate, 4, true)} (${formatPercent(annualizedFunding, 1, true)} APR)`}
        className={stats ? (stats.fundingRate >= 0 ? "text-buy" : "text-sell") : undefined}
      />
      <Stat label="Max leverage" value={`${market.maxLeverage}x`} />
      <Stat label="Size step" value={(10 ** -market.sizeDecimals).toFixed(market.sizeDecimals)} />
    </div>
  );
}
