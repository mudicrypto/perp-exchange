"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Panel } from "@/components/trading/panel";
import { CANDLE_INTERVALS, CandleIntervalSchema, type CandleInterval, type MarketId, type MarketSummary } from "@/core/domain";
import { STALE_AFTER_MS, streamStatus } from "@/core/market-data";
import type { MarketDataSource } from "@/core/ports";
import { displayPriceDecimals } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PortfolioSummary, RiskSummary } from "./components/account-summary";
import { AccountTables } from "./components/account-tables";
import { MarketHeader } from "./components/market-header";
import { MarketRiskFacts } from "./components/market-risk-facts";
import { MarketSelector } from "./components/market-selector";
import { MarketSidebar } from "./components/market-sidebar";
import { OrderBook } from "./components/order-book";
import { OrderTicket } from "./components/order-ticket";
import { PriceChart } from "./components/price-chart";
import { TradesTape } from "./components/trades-tape";
import { useCandles, useMarketStats, useNow, useOrderBook, useTrades } from "./hooks/use-market-data";
import { STORE_KEYS, useTerminal } from "./terminal-context";

/**
 * Grid areas
 *   < lg : single scrolling column
 *   lg   : chart | book | ticket  /  tables | trades | account
 *   xl   : adds the market sidebar on the left
 */
const GRID = cn(
  // In the stacked mobile column, panels keep their content height instead of shrinking.
  "flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5 [&>*]:shrink-0 lg:[&>*]:shrink",
  "lg:grid lg:overflow-hidden lg:grid-cols-[minmax(0,1fr)_272px_320px] lg:grid-rows-[minmax(0,1fr)_250px]",
  "lg:[grid-template-areas:'chart_book_ticket'_'tables_trades_account']",
  "xl:grid-cols-[232px_minmax(0,1fr)_272px_320px]",
  "xl:[grid-template-areas:'side_chart_book_ticket'_'side_tables_trades_account']",
);

export function TradeWorkspace() {
  const { markets, marketsStatus, marketsError, retryMarkets, selected, marketData } = useTerminal();

  if (!selected) {
    if (marketsStatus === "error") {
      return (
        <div className="flex flex-1 items-center justify-center p-6" role="alert" data-testid="markets-error">
          <div className="max-w-sm space-y-2 text-center">
            <p className="text-sm font-medium">Could not load markets from {marketData.descriptor.label}.</p>
            <p className="text-xs text-muted-foreground">{marketsError}</p>
            <Button size="sm" variant="outline" onClick={retryMarkets}>Retry</Button>
          </div>
        </div>
      );
    }
    return <WorkspaceSkeleton empty={marketsStatus === "ready" && markets.length === 0} />;
  }
  return <MarketWorkspace key={selected.market.id} summary={selected} />;
}

function WorkspaceSkeleton({ empty }: { empty: boolean }) {
  return (
    <div className={GRID} aria-busy={!empty} data-testid="workspace-loading">
      {empty ? (
        <p className="p-6 text-sm text-muted-foreground">No markets are available from this source.</p>
      ) : (
        <>
          <Skeleton className="hidden xl:block xl:[grid-area:side]" />
          <Skeleton className="min-h-80 lg:[grid-area:chart]" />
          <Skeleton className="hidden lg:block lg:[grid-area:book]" />
          <Skeleton className="min-h-80 lg:[grid-area:ticket]" />
          <Skeleton className="hidden lg:block lg:[grid-area:tables]" />
          <Skeleton className="hidden lg:block lg:[grid-area:trades]" />
          <Skeleton className="hidden lg:block lg:[grid-area:account]" />
        </>
      )}
    </div>
  );
}

function MarketWorkspace({ summary }: { summary: MarketSummary }) {
  const { marketData, connection, store, markets, selectMarket, mids } = useTerminal();
  const { market } = summary;
  const now = useNow(1_000);
  const { stats, lastUpdateAt: statsUpdatedAt, error: statsError } = useMarketStats(marketData, market.id, summary.stats);
  const { view: book, lastUpdateAt: bookUpdatedAt, error: bookError } = useOrderBook(marketData, market.id);
  const { trades, lastUpdateAt: tradesUpdatedAt, error: tradesError } = useTrades(marketData, market.id);
  const [price, setPrice] = useState("");
  const [activityView, setActivityView] = useState<"account" | "market">("account");
  const [interval, setIntervalState] = useState<CandleInterval>(() => {
    const parsed = CandleIntervalSchema.safeParse(store.get(STORE_KEYS.interval));
    return parsed.success ? parsed.data : "15m";
  });

  const connected = connection.status === "open";
  const bookStream = {
    status: streamStatus({ connected, lastUpdateAt: bookUpdatedAt, now, staleAfterMs: STALE_AFTER_MS.book, error: bookError }),
    lastUpdateAt: bookUpdatedAt,
    now,
  };
  // Trades are event-driven: a quiet market is not stale, only a dropped connection is.
  const tradesStream = {
    status: streamStatus({ connected, lastUpdateAt: tradesUpdatedAt, now, staleAfterMs: STALE_AFTER_MS.trades, error: tradesError }),
    lastUpdateAt: tradesUpdatedAt,
    now,
  };
  const statsStream = {
    status: streamStatus({ connected, lastUpdateAt: statsUpdatedAt, now, staleAfterMs: STALE_AFTER_MS.stats, error: statsError }),
    lastUpdateAt: statsUpdatedAt,
    now,
  };
  const priceDecimals = displayPriceDecimals(stats?.markPrice, market.priceDecimals);

  const chooseInterval = (value: CandleInterval) => {
    setIntervalState(value);
    store.set(STORE_KEYS.interval, value);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-4 border-b bg-surface/60 px-3">
        <div className="xl:hidden">
          <MarketSelector markets={markets} selected={summary} onSelect={(id: MarketId) => selectMarket(id)} mids={mids?.mids} />
        </div>
        <h1 className="hidden shrink-0 text-base font-semibold xl:block" data-testid="market-title">
          {market.id}
        </h1>
        <MarketHeader market={market} stats={stats} stream={statsStream} />
      </div>

      <main className={GRID} id="main">
        <MarketSidebar className="hidden rounded-md border xl:flex xl:[grid-area:side]" />

        <Panel
          title="Chart"
          testId="chart-panel"
          className="order-1 min-h-[380px] lg:order-none lg:min-h-0 lg:[grid-area:chart]"
          stream={connected ? undefined : { status: "disconnected" }}
          actions={
            <div className="flex gap-0.5" role="group" aria-label="Chart timeframe">
              {CANDLE_INTERVALS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={interval === value}
                  data-testid={`interval-${value}`}
                  onClick={() => chooseInterval(value)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    interval === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          }
        >
          <ChartBody key={interval} source={marketData} marketId={market.id} interval={interval} priceDecimals={priceDecimals} />
        </Panel>

        <Panel title="Order book" testId="book-panel" stream={bookStream} className="order-3 min-h-[460px] lg:order-none lg:min-h-0 lg:[grid-area:book]">
          <OrderBook market={market} view={book} onPriceSelect={(p) => setPrice(p.toFixed(market.priceDecimals))} />
        </Panel>

        <Panel title="Recent trades" testId="trades-panel" stream={tradesStream} className="order-4 min-h-[240px] lg:order-none lg:min-h-0 lg:[grid-area:trades]">
          <TradesTape market={market} trades={trades} />
        </Panel>

        <Panel title="Order entry" testId="ticket-panel" className="order-2 lg:order-none lg:[grid-area:ticket]">
          <OrderTicket
            market={market}
            stats={stats}
            book={book}
            dataIsStale={bookStream.status !== "live"}
            price={price}
            onPriceChange={setPrice}
          />
        </Panel>

        <Panel title="Account" testId="account-panel" className="order-5 min-h-[250px] lg:order-none lg:min-h-0 lg:[grid-area:account]">
          <Tabs defaultValue="portfolio" className="flex h-full flex-col gap-0">
            <div className="border-b px-2 py-1">
              <TabsList className="h-7">
                <TabsTrigger value="portfolio" className="text-xs">Portfolio</TabsTrigger>
                <TabsTrigger value="risk" className="text-xs" data-testid="tab-risk">Risk</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="portfolio" className="overflow-y-auto p-3">
              <PortfolioSummary />
            </TabsContent>
            <TabsContent value="risk" className="overflow-y-auto p-3">
              <RiskSummary />
            </TabsContent>
          </Tabs>
        </Panel>

        <Panel
          title={activityView === "account" ? "Activity" : "Market risk"}
          testId="portfolio-panel"
          className="order-6 min-h-[300px] lg:order-none lg:min-h-0 lg:[grid-area:tables]"
          actions={
            <div className="flex gap-0.5" role="group" aria-label="Panel view">
              {(["account", "market"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={activityView === v}
                  data-testid={`view-${v}`}
                  onClick={() => setActivityView(v)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    activityView === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "account" ? "Account" : "Market info"}
                </button>
              ))}
            </div>
          }
        >
          {activityView === "account" ? <AccountTables /> : <MarketRiskFacts market={market} stats={stats} />}
        </Panel>
      </main>
    </div>
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
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/60" aria-busy="true" data-testid="chart-loading">
          <p className="text-xs text-muted-foreground">Loading candles…</p>
        </div>
      )}
      {state.status === "error" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface/80" role="alert" data-testid="chart-error">
          <p className="text-sm">Candle data unavailable.</p>
          {state.error && <p className="max-w-xs text-center text-2xs text-muted-foreground">{state.error}</p>}
          <Button size="sm" variant="outline" onClick={state.retry} data-testid="chart-retry">Retry</Button>
        </div>
      )}
    </>
  );
}
