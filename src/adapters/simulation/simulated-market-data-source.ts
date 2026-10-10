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
}

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

  constructor(options: SimulatedSourceOptions = {}) {
    this.engine = new SimulationEngine(options.seed ?? 42);
    this.now = options.now ?? Date.now;
    this.tickMs = options.tickMs ?? 500;
  }

  async listMarkets(): Promise<MarketSummary[]> {
    return this.engine.summaries(this.now());
  }

  async getCandles(marketId: MarketId, interval: CandleInterval): Promise<Candle[]> {
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
    return this.add(this.trades, marketId, handlers);
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
    listener({ status: "open", since: this.now() });
    return () => this.connectionListeners.delete(listener);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.books.clear();
    this.trades.clear();
    this.stats.clear();
    this.candles.clear();
    this.connectionListeners.clear();
  }

  /** Advance the simulation one tick (public for deterministic tests). */
  tick(): void {
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
