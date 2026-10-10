import type { Market, Trade } from "@/core/domain";
import { displayPriceDecimals, formatPrice, formatSize, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TradesTape({ market, trades }: { market: Market; trades: readonly Trade[] }) {
  if (trades.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground" data-testid="trades-empty">Waiting for trades… (none received yet)</p>;
  }
  const decimals = displayPriceDecimals(trades[0]?.price, market.priceDecimals);
  return (
    <div className="flex h-full flex-col" data-testid="trades-tape">
      <div className="grid grid-cols-3 px-3 py-1 text-[10px] text-muted-foreground uppercase">
        <span>Price</span>
        <span className="text-right">Size ({market.base})</span>
        <span className="text-right">Time</span>
      </div>
      <ol className="flex-1 overflow-y-auto">
        {trades.map((trade) => (
          <li key={trade.id} className="grid h-5 grid-cols-3 items-center px-3 text-xs" data-testid="trade-row">
            <span className={cn("tabular", trade.side === "buy" ? "text-buy" : "text-sell")}>
              {formatPrice(trade.price, decimals)}
            </span>
            <span className="tabular text-right">{formatSize(trade.size, market.sizeDecimals)}</span>
            <span className="tabular text-right text-muted-foreground">{formatTime(trade.venueTime)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
