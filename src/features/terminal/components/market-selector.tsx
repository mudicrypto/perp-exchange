"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dayChangeFraction, type MarketId, type MarketSummary } from "@/core/domain";
import { displayPriceDecimals, formatCompact, formatPercent, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export function MarketSelector({
  markets,
  selected,
  onSelect,
  mids,
}: {
  markets: readonly MarketSummary[];
  selected: MarketSummary | null;
  onSelect: (id: MarketId) => void;
  /** Live mid prices; falls back to snapshot mark prices. */
  mids?: ReadonlyMap<string, number> | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return [...markets]
      .filter((m) => q === "" || m.market.base.includes(q))
      .sort((a, b) => (b.stats?.dayNotionalVolume ?? 0) - (a.stats?.dayNotionalVolume ?? 0));
  }, [markets, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2 text-base font-semibold" data-testid="market-selector">
          {selected ? selected.market.id : "Select market"}
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" aria-hidden />
          <Input
            autoFocus
            aria-label="Search markets"
            placeholder="Search markets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-1.5 text-[10px] text-muted-foreground uppercase">
          <span>Market</span>
          <span className="text-right">{mids ? "Mid" : "Mark"}</span>
          <span className="text-right">24h</span>
          <span className="text-right">Volume</span>
        </div>
        <ul className="max-h-80 overflow-y-auto pb-1" role="listbox" aria-label="Markets">
          {filtered.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground">No markets match.</li>}
          {filtered.map(({ market, stats }) => {
            const change = stats ? dayChangeFraction(stats) : null;
            return (
              <li key={market.id} role="option" aria-selected={selected?.market.id === market.id}>
                <button
                  type="button"
                  data-testid={`market-option-${market.id}`}
                  onClick={() => {
                    onSelect(market.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={cn(
                    "grid w-full grid-cols-[1fr_auto_auto_auto] gap-x-4 px-3 py-1.5 text-left text-sm hover:bg-accent",
                    selected?.market.id === market.id && "bg-accent/60",
                  )}
                >
                  <span className="font-medium">
                    {market.base}
                    <span className="ml-1.5 text-[10px] text-muted-foreground">{market.maxLeverage}x</span>
                  </span>
                  <span className="tabular text-right">
                    {formatPrice(mids?.get(market.id) ?? stats?.markPrice, displayPriceDecimals(mids?.get(market.id) ?? stats?.markPrice, market.priceDecimals))}
                  </span>
                  <span className={cn("tabular text-right", change !== null && (change >= 0 ? "text-buy" : "text-sell"))}>
                    {formatPercent(change, 2, true)}
                  </span>
                  <span className="tabular text-right text-muted-foreground">{formatCompact(stats?.dayNotionalVolume)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
