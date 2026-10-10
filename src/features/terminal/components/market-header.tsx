import { Stat, SignedPercent } from "@/components/trading/values";
import { dayChangeFraction, type Market, type MarketStats } from "@/core/domain";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Streaming stats strip for the selected market. Amounts are in the market's quote currency. */
export function MarketHeader({ market, stats }: { market: Market; stats: MarketStats | null }) {
  const decimals = displayPriceDecimals(stats?.markPrice, market.priceDecimals);
  const change = stats ? dayChangeFraction(stats) : null;
  const annualizedFunding = stats ? stats.fundingRate * (24 / stats.fundingIntervalHours) * 365 : null;
  return (
    <div className="flex min-w-0 items-center gap-5 overflow-x-auto" data-testid="market-header">
      <div className="flex shrink-0 flex-col">
        <span className="text-2xs text-muted-foreground uppercase">Mark ({market.quote})</span>
        <span data-testid="mark-price" className="tabular text-base leading-tight font-semibold">
          {formatPrice(stats?.markPrice, decimals)}
        </span>
      </div>
      <Stat label="Oracle" className="shrink-0">{formatPrice(stats?.oraclePrice, decimals)}</Stat>
      <Stat label="24h change" className="shrink-0">
        <SignedPercent value={change} />
      </Stat>
      <Stat label="24h volume" className="shrink-0">
        {formatAmount(stats?.dayNotionalVolume, { compact: true })} {market.quote}
      </Stat>
      <Stat label="Open interest" className="shrink-0">
        {stats ? `${formatAmount(stats.openInterest * stats.markPrice, { compact: true })} ${market.quote}` : "—"}
      </Stat>
      <Stat label={`Funding / ${stats?.fundingIntervalHours ?? 1}h`} className="shrink-0">
        <span className={cn(stats && (stats.fundingRate >= 0 ? "text-buy" : "text-sell"))}>
          {formatPercent(stats?.fundingRate, 4, true)}
        </span>{" "}
        <span className="text-muted-foreground">({formatPercent(annualizedFunding, 1, true)} APR)</span>
      </Stat>
      <Stat label="Max leverage" className="shrink-0">{market.maxLeverage}x</Stat>
    </div>
  );
}
