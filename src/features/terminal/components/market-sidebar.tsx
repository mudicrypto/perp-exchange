"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SignedPercent } from "@/components/trading/values";
import { dayChangeFraction, type MarketId, type MarketSummary } from "@/core/domain";
import { displayPriceDecimals, formatCompact, formatPrice, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNow } from "../hooks/use-market-data";
import { useTerminal } from "../terminal-context";

export function sortByVolume(markets: readonly MarketSummary[]): MarketSummary[] {
  return [...markets].sort((a, b) => (b.stats?.dayNotionalVolume ?? 0) - (a.stats?.dayNotionalVolume ?? 0));
}

/**
 * Searchable market list. Arrow keys move between rows, Enter/Space selects.
 * Prices here come from the periodic catalog refresh; the selected market's
 * header shows the streaming values.
 */
export function MarketSidebar({ onSelected, className }: { onSelected?: () => void; className?: string }) {
  const { markets, marketsStatus, marketsError, marketsUpdatedAt, retryMarkets, selected, selectMarket, mids, connection } = useTerminal();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const now = useNow(5_000);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return sortByVolume(markets).filter((m) => q === "" || m.market.base.includes(q) || m.market.id.includes(q));
  }, [markets, query]);

  const choose = (id: MarketId) => {
    selectMarket(id);
    onSelected?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-market]") ?? [])];
    const index = buttons.findIndex((b) => b === document.activeElement);
    const next = event.key === "ArrowDown" ? Math.min(buttons.length - 1, index + 1) : Math.max(0, index - 1);
    buttons[next]?.focus();
  };

  return (
    <aside aria-label="Markets" className={cn("flex min-h-0 flex-col bg-surface", className)} data-testid="market-sidebar">
      <div className="border-b p-2">
        <label className="flex items-center gap-2 rounded-md border bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-3.5 text-muted-foreground" aria-hidden />
          <Input
            aria-label="Search markets"
            placeholder="Search markets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.querySelector<HTMLButtonElement>("button[data-market]")?.focus();
              }
            }}
            className="h-8 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            data-testid="market-search"
          />
        </label>
      </div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 px-3 py-1.5 text-2xs text-muted-foreground uppercase" aria-hidden>
        <span>Market / Vol</span>
        <span className="text-right">{mids ? "Mid" : "Mark"}</span>
        <span className="w-14 text-right">24h</span>
      </div>

      {marketsStatus === "loading" && markets.length === 0 && (
        <div className="space-y-2 px-3 py-2" data-testid="markets-loading" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      )}
      {marketsStatus === "error" && markets.length === 0 && (
        <div className="space-y-2 p-3" role="alert" data-testid="markets-error">
          <p className="text-xs">Markets could not be loaded.</p>
          <p className="text-2xs text-muted-foreground">{marketsError}</p>
          <Button size="sm" variant="outline" onClick={retryMarkets}>Retry</Button>
        </div>
      )}

      <ul ref={listRef} onKeyDown={onKeyDown} className="min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Market list">
        {marketsStatus === "ready" && filtered.length === 0 && (
          <li className="px-3 py-4 text-xs text-muted-foreground">No markets match “{query}”.</li>
        )}
        {filtered.map(({ market, stats }) => {
          const active = selected?.market.id === market.id;
          return (
            <li key={market.id}>
              <button
                type="button"
                data-market={market.id}
                data-testid={`market-option-${market.id}`}
                aria-current={active ? "true" : undefined}
                onClick={() => choose(market.id)}
                className={cn(
                  "grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3 border-l-2 px-3 py-1.5 text-left transition-colors focus-visible:bg-accent focus-visible:outline-none",
                  active ? "border-primary bg-accent/70" : "border-transparent hover:bg-accent/50",
                )}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {market.base}
                    <span className="rounded bg-muted px-1 text-2xs text-muted-foreground">{market.maxLeverage}x</span>
                  </span>
                  <span className="tabular block text-2xs text-muted-foreground">
                    {formatCompact(stats?.dayNotionalVolume)} vol
                  </span>
                </span>
                <span className="tabular text-right text-xs" data-testid={`list-price-${market.id}`}>
                  {(() => {
                    const price = mids?.mids.get(market.id) ?? stats?.markPrice;
                    return formatPrice(price, displayPriceDecimals(price, market.priceDecimals));
                  })()}
                </span>
                <SignedPercent className="w-14 text-right text-xs" value={stats ? dayChangeFraction(stats) : null} />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="border-t px-3 py-1 text-2xs text-muted-foreground" aria-live="off" data-testid="list-freshness">
        {mids && connection.status === "open"
          ? `Live mids · 24h stats ${marketsUpdatedAt !== null ? formatRelativeTime(marketsUpdatedAt, now) : "loading"}`
          : mids
            ? `Disconnected · mids from ${formatRelativeTime(mids.observedAt, now)}`
            : marketsUpdatedAt !== null
            ? `Snapshot prices from ${formatRelativeTime(marketsUpdatedAt, now)}`
            : "Waiting for prices"}
      </p>
    </aside>
  );
}
