"use client";

import { useEffect, useState } from "react";
import type {
  Candle,
  CandleInterval,
  MarketId,
  MarketStats,
  MarketSummary,
  Trade,
} from "@/core/domain";
import { CandleSeries, OrderBookState, TradeBuffer, type OrderBookView } from "@/core/market-data";
import type { ConnectionState, MarketDataSource } from "@/core/ports";

export type LoadStatus = "loading" | "ready" | "error";

/** Re-renders every `intervalMs` so freshness indicators stay current. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useConnectionState(source: MarketDataSource): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ status: "idle" });
  useEffect(() => source.subscribeConnection(setState), [source]);
  return state;
}

const MARKET_REFRESH_MS = 10_000;

export function useMarkets(source: MarketDataSource) {
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      source
        .listMarkets(controller.signal)
        .then((list) => {
          setMarkets(list);
          setStatus("ready");
          setError(null);
          setUpdatedAt(Date.now());
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Failed to load markets");
          // Keep previously loaded markets visible; only show the error state if we have none.
          setStatus((current) => (current === "ready" ? "ready" : "error"));
        });
    void load();
    const timer = setInterval(() => void load(), MARKET_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [source, reloadToken]);

  return { markets, status, error, updatedAt, retry: () => setReloadToken((t) => t + 1) };
}

/** Components using this hook should be keyed by market id so state resets on switch. */
export function useOrderBook(source: MarketDataSource, marketId: MarketId) {
  const [state] = useState(() => new OrderBookState(marketId));
  const [view, setView] = useState<OrderBookView | null>(null);

  useEffect(
    () =>
      source.subscribeOrderBook(marketId, {
        onData: (snapshot) => {
          if (state.apply(snapshot, Date.now()) === "applied") setView(state.current());
        },
        onReset: () => {
          state.reset();
          setView(null);
        },
      }),
    [source, marketId, state],
  );

  return view;
}

export function useTrades(source: MarketDataSource, marketId: MarketId) {
  const [buffer] = useState(() => new TradeBuffer(60));
  const [trades, setTrades] = useState<readonly Trade[]>([]);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);

  useEffect(
    () =>
      source.subscribeTrades(marketId, {
        onData: (incoming) => {
          const fresh = buffer.add(incoming);
          if (fresh.length > 0) {
            setTrades(buffer.list());
            setLastUpdateAt(Date.now());
          }
        },
      }),
    [source, marketId, buffer],
  );

  return { trades, lastUpdateAt };
}

export function useMarketStats(
  source: MarketDataSource,
  marketId: MarketId,
  initial: MarketStats | null,
) {
  const [live, setLive] = useState<MarketStats | null>(null);
  useEffect(() => source.subscribeMarketStats(marketId, { onData: setLive }), [source, marketId]);
  return live ?? initial;
}

export interface CandleState {
  status: LoadStatus;
  candles: readonly Candle[];
  /** Increments whenever the full history is (re)loaded. */
  historyVersion: number;
  latest: Candle | null;
  retry: () => void;
}

/**
 * Loads candle history and merges live updates. Updates that arrive before
 * history are buffered and replayed. A stream reset (reconnect) reloads
 * history so gaps are filled. Key the consumer by `${marketId}:${interval}`.
 */
export function useCandles(source: MarketDataSource, marketId: MarketId, interval: CandleInterval): CandleState {
  const [series] = useState(() => new CandleSeries());
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [historyVersion, setHistoryVersion] = useState(0);
  const [latest, setLatest] = useState<Candle | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let historyLoaded = false;
    const pending: Candle[] = [];

    const unsubscribe = source.subscribeCandles(marketId, interval, {
      onData: (candle) => {
        if (!historyLoaded) {
          pending.push(candle);
          return;
        }
        if (series.update(candle) !== "ignored-stale") setLatest(candle);
      },
      onReset: () => setReloadToken((token) => token + 1),
    });

    source
      .getCandles(marketId, interval, controller.signal)
      .then((history) => {
        series.setHistory(history);
        for (const candle of pending) series.update(candle);
        historyLoaded = true;
        setStatus("ready");
        setHistoryVersion((version) => version + 1);
        setLatest(series.latest());
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [source, marketId, interval, series, reloadToken]);

  return {
    status,
    candles: series.list(),
    historyVersion,
    latest,
    retry: () => setReloadToken((token) => token + 1),
  };
}
