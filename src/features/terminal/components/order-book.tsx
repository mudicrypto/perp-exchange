import type { Market } from "@/core/domain";
import { withCumulativeDepth, type DepthRow, type OrderBookView } from "@/core/market-data";
import { displayPriceDecimals, formatPercent, formatPrice, formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";

const ROWS = 12;

function Row({
  row,
  maxCumulative,
  side,
  priceDecimals,
  sizeDecimals,
}: {
  row: DepthRow;
  maxCumulative: number;
  side: "bid" | "ask";
  priceDecimals: number;
  sizeDecimals: number;
}) {
  const depth = maxCumulative > 0 ? (row.cumulative / maxCumulative) * 100 : 0;
  return (
    <div className="relative grid h-5 grid-cols-3 items-center px-3 text-xs" data-testid={`book-${side}`}>
      <div
        aria-hidden
        className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-buy/12" : "bg-sell/12")}
        style={{ width: `${depth}%` }}
      />
      <span className={cn("tabular relative", side === "bid" ? "text-buy" : "text-sell")}>
        {formatPrice(row.price, priceDecimals)}
      </span>
      <span className="tabular relative text-right">{formatSize(row.size, sizeDecimals)}</span>
      <span className="tabular relative text-right text-muted-foreground">{formatSize(row.cumulative, sizeDecimals)}</span>
    </div>
  );
}

export function OrderBook({ market, view }: { market: Market; view: OrderBookView | null }) {
  if (!view) {
    return <p className="p-3 text-xs text-muted-foreground">Waiting for order book…</p>;
  }
  const priceDecimals = displayPriceDecimals(view.mid, market.priceDecimals);
  const asks = withCumulativeDepth(view.asks, ROWS);
  const bids = withCumulativeDepth(view.bids, ROWS);
  const maxCumulative = Math.max(asks.at(-1)?.cumulative ?? 0, bids.at(-1)?.cumulative ?? 0);
  const spreadFraction = view.spread !== null && view.mid ? view.spread / view.mid : null;

  return (
    <div className="flex h-full flex-col" data-testid="order-book">
      <div className="grid grid-cols-3 px-3 py-1 text-[10px] text-muted-foreground uppercase">
        <span>Price</span>
        <span className="text-right">Size ({market.base})</span>
        <span className="text-right">Total</span>
      </div>
      <div className="flex flex-1 flex-col-reverse overflow-hidden">
        {asks.map((row) => (
          <Row key={`a${row.price}`} row={row} maxCumulative={maxCumulative} side="ask" priceDecimals={priceDecimals} sizeDecimals={market.sizeDecimals} />
        ))}
      </div>
      <div className="flex items-center justify-between border-y bg-muted/40 px-3 py-1 text-xs" data-testid="book-spread">
        <span className="text-muted-foreground">Spread</span>
        <span className="tabular">
          {formatPrice(view.spread, priceDecimals)} ({formatPercent(spreadFraction, 3)})
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        {bids.map((row) => (
          <Row key={`b${row.price}`} row={row} maxCumulative={maxCumulative} side="bid" priceDecimals={priceDecimals} sizeDecimals={market.sizeDecimals} />
        ))}
      </div>
    </div>
  );
}
