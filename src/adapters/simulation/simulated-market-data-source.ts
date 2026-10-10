import {
  CANDLE_INTERVAL_MS,
  type Candle,
  type CandleInterval,
  type MarketId,
  type MarketStats,
  type MarketSummary,
  type OrderBookSnapshot,
  type Trade,
} from "@/core/domain";
import type {
  ConnectionState,
  DataSourceDescriptor,
  MarketDataSource,
  StreamHandlers,
  Unsubscribe,
} from "@/core/ports";
import { SIMULATION_VENUE_ID, SimulationEngine, type SimulatedMarket } from "./simulation-engine";

export const SIMULATION_DESCRIPTOR: DataSourceDescriptor = {
  id: "simulation",
  kind: "simulation",
  label: "Simulated market data (not real prices)",
  venueId: SIMULATION_VENUE_ID,
};

export const SIM_HISTORY_LENGTH = 300;

export interface SimulatedSourceOptions {
  seed?: number;
  tickMs?: number;
  now?: () => number;
  /** Artificial request latency so loading states are exercised (default 0). */
  latencyMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Listener<T> = StreamHandlers<T>;

/**
 * In-browser simulated market data. Same interface as the live source, so
 * the terminal exercises identical code paths, but the descriptor kind is
 * "simulation" and the UI shows a persistent banner.
 */
export class SimulatedMarketDataSource implements MarketDataSource {
  readonly descriptor = SIMULATION_DESCRIPTOR;
  private readonly engine: SimulationEngine;
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly books = new Map<MarketId, Set<Listener<OrderBookSnapshot>>>();
  private readonly trades = new Map<MarketId, Set<Listener<Trade[]>>>();
  private readonly stats = new Map<MarketId, Set<Listener<MarketStats>>>();
  private readonly candles = new Map<string, { marketId: MarketId; interval: CandleInterval; current: Candle | null; listeners: Set<Listener<Candle>> }>();
  private readonly lastHistoryCandle = new Map<string, Candle | null>();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private readonly latencyMs: number;
  private connection: ConnectionState;
  private outageTimer: ReturnType<typeof setTimeout> | null = null;
  private failNextCandles = false;

  constructor(options: SimulatedSourceOptions = {}) {
    this.engine = new SimulationEngine(options.seed ?? 42);
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 500;
    this.latencyMs = options.latencyMs ?? 0;
    this.connection = { status: "open", since: this.now() };
  }

  /** Static market definitions (used by the paper venue). */
  get markets(): ReadonlyMap<MarketId, SimulatedMarket> {
    return this.engine.markets;
  }

  get connectionState(): ConnectionState {
    return this.connection;
  }

  async listMarkets(): Promise<MarketSummary[]> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    return this.engine.summaries(this.now());
  }

  async getCandles(marketId: MarketId, interval: CandleInterval): Promise<Candle[]> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.failNextCandles) {
      this.failNextCandles = false;
      throw new Error("Simulated candle request failure");
    }
    const market = this.requireMarket(marketId);
    const history = market.history(interval, this.now(), SIM_HISTORY_LENGTH);
    const key = `${marketId}:${interval}`;
    const last = history.at(-1) ?? null;
    this.lastHistoryCandle.set(key, last);
    const entry = this.candles.get(key);
    if (entry) entry.current = last;
    return history;
  }

  subscribeOrderBook(marketId: MarketId, handlers: StreamHandlers<OrderBookSnapshot>): Unsubscribe {
    return this.add(this.books, marketId, handlers);
  }

  subscribeTrades(marketId: MarketId, handlers: StreamHandlers<Trade[]>): Unsubscribe {
    const unsubscribe = this.add(this.trades, marketId, handlers);
    // Like real venues, start with a snapshot of recent trades (delivered async).
    const snapshot = this.requireMarket(marketId).recentTrades(this.now(), 30);
    const timer = setTimeout(() => {
      if (this.trades.get(marketId)?.has(handlers)) handlers.onData(snapshot);
    }, 0);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }

  subscribeMarketStats(marketId: MarketId, handlers: StreamHandlers<MarketStats>): Unsubscribe {
    return this.add(this.stats, marketId, handlers);
  }

  subscribeCandles(marketId: MarketId, interval: CandleInterval, handlers: StreamHandlers<Candle>): Unsubscribe {
    this.requireMarket(marketId);
    const key = `${marketId}:${interval}`;
    let entry = this.candles.get(key);
    if (!entry) {
      entry = { marketId, interval, current: this.lastHistoryCandle.get(key) ?? null, listeners: new Set() };
      this.candles.set(key, entry);
    }
    entry.listeners.add(handlers);
    this.ensureRunning();
    return () => {
      entry.listeners.delete(handlers);
      if (entry.listeners.size === 0) this.candles.delete(key);
    };
  }

  subscribeConnection(listener: (state: ConnectionState) => void): Unsubscribe {
    this.connectionListeners.add(listener);
    listener(this.connection);
    return () => this.connectionListeners.delete(listener);
  }

  // ---- demo controls (simulation only) ----

  /**
   * Simulates a dropped feed: streams stop, the connection reports
   * reconnecting, then recovers and signals a reset to every stream
   * (exactly what the live adapter does after a real reconnect).
   */
  simulateOutage(durationMs: number): void {
    if (this.outageTimer) return;
    const reconnectAt = this.now() + durationMs;
    this.setConnection({ status: "reconnecting", attempt: 1, nextRetryAt: reconnectAt, reason: "Simulated connection loss" });
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      this.setConnection({ status: "open", since: this.now() });
      for (const set of [...this.books.values(), ...this.trades.values(), ...this.stats.values()]) {
        for (const handlers of set) handlers.onReset?.();
      }
      for (const entry of this.candles.values()) for (const handlers of entry.listeners) handlers.onReset?.();
    }, durationMs);
  }

  /**
   * Makes the next candle history request fail and asks current chart
   * subscribers to reload, so the error + retry UI can be exercised.
   */
  failNextCandleRequest(): void {
    this.failNextCandles = true;
    for (const entry of this.candles.values()) for (const handlers of entry.listeners) handlers.onReset?.();
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.outageTimer) clearTimeout(this.outageTimer);
    this.outageTimer = null;
    this.connection = { status: "open", since: this.now() };
    this.books.clear();
    this.trades.clear();
    this.stats.clear();
    this.candles.clear();
    this.connectionListeners.clear();
  }

  /** Advance the simulation one tick (public for deterministic tests). */
  tick(): void {
    if (this.connection.status !== "open") return;
    const time = this.now();
    const active = new Set<MarketId>([...this.books.keys(), ...this.trades.keys(), ...this.stats.keys()]);
    for (const entry of this.candles.values()) active.add(entry.marketId);

    for (const marketId of active) {
      const market = this.engine.get(marketId);
      if (!market) continue;
      market.step();
      const book = market.book(time);
      for (const l of this.books.get(marketId) ?? []) l.onData(book);
      const trades = market.maybeTrades(time);
      if (trades.length > 0) for (const l of this.trades.get(marketId) ?? []) l.onData(trades);
      const stats = market.stats(time);
      for (const l of this.stats.get(marketId) ?? []) l.onData(stats);
      this.updateCandles(market, time, trades);
    }
  }

  private updateCandles(market: SimulatedMarket, time: number, trades: Trade[]): void {
    for (const entry of this.candles.values()) {
      if (entry.marketId !== market.id) continue;
      const step = CANDLE_INTERVAL_MS[entry.interval];
      const openTime = Math.floor(time / step) * step;
      const price = Number(market.mid.toFixed(market.market.priceDecimals));
      const volume = trades.reduce((sum, trade) => sum + trade.size, 0);
      const current = entry.current;
      const next: Candle =
        current && current.openTime === openTime
          ? {
              ...current,
              high: Math.max(current.high, price),
              low: Math.min(current.low, price),
              close: price,
              volume: current.volume + volume,
            }
          : { openTime, open: current?.close ?? price, high: price, low: price, close: price, volume };
      next.high = Math.max(next.high, next.open);
      next.low = Math.min(next.low, next.open);
      entry.current = next;
      for (const l of entry.listeners) l.onData(next);
    }
  }

  private add<T>(map: Map<MarketId, Set<Listener<T>>>, marketId: MarketId, handlers: Listener<T>): Unsubscribe {
    this.requireMarket(marketId);
    let set = map.get(marketId);
    if (!set) {
      set = new Set();
      map.set(marketId, set);
    }
    set.add(handlers);
    this.ensureRunning();
    return () => {
      set.delete(handlers);
      if (set.size === 0) map.delete(marketId);
    };
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private requireMarket(marketId: MarketId): SimulatedMarket {
    const market = this.engine.get(marketId);
    if (!market) throw new Error(`Unknown simulated market ${marketId}`);
    return market;
  }
}
