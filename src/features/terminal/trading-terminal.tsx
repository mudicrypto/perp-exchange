"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import {
  CANDLE_INTERVALS,
  CandleIntervalSchema,
  type CandleInterval,
  type MarketId,
  type MarketSummary,
} from "@/core/domain";
import { freshness } from "@/core/market-data";
import type { MarketDataSource, VenueExecutionCapabilities } from "@/core/ports";
import { displayPriceDecimals } from "@/lib/format";
import { BrowserStorageStore } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { AccountPanels } from "./components/account-panels";
import { MarketHeader } from "./components/market-header";
import { MarketSelector } from "./components/market-selector";
import { OrderBook } from "./components/order-book";
import { OrderTicket } from "./components/order-ticket";
import { Panel } from "./components/panel";
import { PriceChart } from "./components/price-chart";
import { ConnectionIndicator, DataSourceBadge, SimulationBanner } from "./components/status-indicators";
import { TradesTape } from "./components/trades-tape";
import { createMarketDataSource, executionCapabilitiesFor } from "./create-sources";
import {
  useCandles,
  useConnectionState,
  useMarketStats,
  useMarkets,
  useNow,
  useOrderBook,
  useTrades,
} from "./hooks/use-market-data";

const STORE_KEYS = { market: "market", interval: "interval" } as const;

export function TradingTerminal({ runtime }: { runtime: PublicRuntimeConfig }) {
  const [source] = useState(() => createMarketDataSource(runtime));
  const capabilities = useMemo(() => executionCapabilitiesFor(runtime), [runtime]);
  const [store] = useState(() => new BrowserStorageStore());
  const connection = useConnectionState(source);
  const { markets, status, error, retry } = useMarkets(source);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : store.get(STORE_KEYS.market),
  );

  useEffect(() => () => source.dispose(), [source]);

  const selected: MarketSummary | null = useMemo(() => {
    if (markets.length === 0) return null;
    return (
      markets.find((m) => m.market.id === selectedId) ??
      [...markets].sort((a, b) => (b.stats?.dayNotionalVolume ?? 0) - (a.stats?.dayNotionalVolume ?? 0))[0] ??
      null
    );
  }, [markets, selectedId]);

  const selectMarket = (id: MarketId) => {
    setSelectedId(id);
    store.set(STORE_KEYS.market, id);
  };

  return (
    <div className="flex h-dvh min-h-[640px] flex-col">
      {source.descriptor.kind === "simulation" && <SimulationBanner />}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-3">
        <span className="text-sm font-bold tracking-tight">
          Nova<span className="text-primary">.</span>
        </span>
        <MarketSelector markets={markets} selected={selected} onSelect={selectMarket} />
        <div className="ml-auto flex items-center gap-3">
          <DataSourceBadge descriptor={source.descriptor} />
          <ConnectionIndicator state={connection} />
        </div>
      </header>

      {status === "loading" && markets.length === 0 && (
        <p className="p-6 text-sm text-muted-foreground">Loading markets…</p>
      )}
      {status === "error" && markets.length === 0 && (
        <div className="flex flex-col items-start gap-2 p-6" role="alert" data-testid="markets-error">
          <p className="text-sm">Could not load markets from {source.descriptor.label}.</p>
          <p className="text-xs text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" onClick={retry}>Retry</Button>
        </div>
      )}
      {selected && (
        <MarketWorkspace
          key={selected.market.id}
          source={source}
          summary={selected}
          capabilities={capabilities}
          store={store}
          connected={connection.status === "open"}
        />
      )}
    </div>
  );
}

function MarketWorkspace({
  source,
  summary,
  capabilities,
  store,
  connected,
}: {
  source: MarketDataSource;
  summary: MarketSummary;
  capabilities: VenueExecutionCapabilities;
  store: BrowserStorageStore;
  connected: boolean;
}) {
  const { market } = summary;
  const now = useNow(1_000);
  const stats = useMarketStats(source, market.id, summary.stats);
  const book = useOrderBook(source, market.id);
  const { trades, lastUpdateAt: tradesUpdatedAt } = useTrades(source, market.id);
  const [interval, setIntervalState] = useState<CandleInterval>(() => {
    const parsed = CandleIntervalSchema.safeParse(store.get(STORE_KEYS.interval));
    return parsed.success ? parsed.data : "15m";
  });

  const bookFreshness = connected ? freshness(book?.receivedAt ?? null, now) : book ? "stale" : "no-data";
  // Trades are event-driven; quiet markets are not stale, so only flag on disconnect.
  const tradesFreshness = connected ? (tradesUpdatedAt ? "fresh" : "no-data") : trades.length > 0 ? "stale" : "no-data";

  const chooseInterval = (value: CandleInterval) => {
    setIntervalState(value);
    store.set(STORE_KEYS.interval, value);
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <MarketHeader market={market} stats={stats} />
      </div>
      <main className="grid min-h-0 flex-1 grid-cols-1 gap-1.5 overflow-y-auto p-1.5 lg:grid-cols-[minmax(0,1fr)_280px_310px] lg:grid-rows-[minmax(0,1fr)_230px] lg:overflow-hidden">
        <Panel
          title="Chart"
          testId="chart-panel"
          className="min-h-[360px] lg:min-h-0"
          actions={
            <div className="flex gap-0.5" role="group" aria-label="Chart interval">
              {CANDLE_INTERVALS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={interval === value}
                  data-testid={`interval-${value}`}
                  onClick={() => chooseInterval(value)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    interval === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          }
        >
          <ChartBody key={interval} source={source} marketId={market.id} interval={interval} priceDecimals={displayPriceDecimals(stats?.markPrice, market.priceDecimals)} />
        </Panel>

        <div className="flex min-h-[520px] flex-col gap-1.5 lg:row-span-2 lg:min-h-0">
          <Panel title="Order book" testId="book-panel" freshness={bookFreshness} className="flex-[3]">
            <OrderBook market={market} view={book} />
          </Panel>
          <Panel title="Trades" testId="trades-panel" freshness={tradesFreshness} className="flex-[2]">
            <TradesTape market={market} trades={trades} />
          </Panel>
        </div>

        <Panel title="Order" testId="ticket-panel" className="lg:row-span-2">
          <OrderTicket
            market={market}
            stats={stats}
            book={book}
            dataIsStale={bookFreshness !== "fresh"}
            capabilities={capabilities}
          />
        </Panel>

        <Panel title="Portfolio" testId="portfolio-panel" className="min-h-[220px] lg:min-h-0">
          <AccountPanels market={market} stats={stats} />
        </Panel>
      </main>
    </>
  );
}

function ChartBody({
  source,
  marketId,
  interval,
  priceDecimals,
}: {
  source: MarketDataSource;
  marketId: MarketId;
  interval: CandleInterval;
  priceDecimals: number;
}) {
  const state = useCandles(source, marketId, interval);
  return (
    <>
      <PriceChart state={state} priceDecimals={priceDecimals} />
      {state.status === "loading" && (
        <p className="absolute top-2 left-3 text-xs text-muted-foreground">Loading candles…</p>
      )}
      {state.status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" role="alert">
          <p className="text-sm">Candle history unavailable.</p>
          <Button size="sm" variant="outline" onClick={state.retry}>Retry</Button>
        </div>
      )}
    </>
  );
}
