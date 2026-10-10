import {
  CANDLE_INTERVAL_MS,
  type BookLevel,
  type Candle,
  type CandleInterval,
  type MarketId,
  type MarketStats,
  type MarketSummary,
  type MidPrices,
  type OrderBookSnapshot,
  type Trade,
} from "@/core/domain";
import type {
  ConnectionState,
  DataSourceDescriptor,
  MarketDataSource,
  SourceDiagnostics,
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

/** Resting liquidity other participants of the simulated venue display. */
export type ParticipantLiquidity = (marketId: MarketId) => { bids: readonly BookLevel[]; asks: readonly BookLevel[] };

/** Adds displayed participant liquidity to a book side (best first). */
function mergeSide(levels: readonly BookLevel[], extra: readonly BookLevel[], descending: boolean): BookLevel[] {
  const merged = new Map<number, BookLevel>();
  for (const level of [...levels, ...extra]) {
    const existing = merged.get(level.price);
    merged.set(
      level.price,
      existing
        ? { price: level.price, size: existing.size + level.size, orders: existing.orders === null || level.orders === null ? null : existing.orders + level.orders }
        : { ...level },
    );
  }
  return [...merged.values()].sort((a, b) => (descending ? b.price - a.price : a.price - b.price));
}

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
  /** Raw synthetic liquidity for the paper venue's matching engine. */
  private readonly venueBooks = new Map<MarketId, Set<Listener<OrderBookSnapshot>>>();
  private participants: ParticipantLiquidity | null = null;
  private printSeq = 0;
  private readonly trades = new Map<MarketId, Set<Listener<Trade[]>>>();
  private readonly stats = new Map<MarketId, Set<Listener<MarketStats>>>();
  private readonly candles = new Map<string, { marketId: MarketId; interval: CandleInterval; current: Candle | null; listeners: Set<Listener<Candle>> }>();
  private readonly lastHistoryCandle = new Map<string, Candle | null>();
  private readonly midListeners = new Set<Listener<MidPrices>>();
  private lastTickAt: number | null = null;
  private outages = 0;
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

  /**
   * The synthetic counterparty liquidity the paper venue matches against.
   * Unlike `subscribeOrderBook` it excludes the paper account's own resting
   * orders, so the simulator never matches an account against itself.
   */
  subscribeVenueBook(marketId: MarketId, handlers: StreamHandlers<OrderBookSnapshot>): Unsubscribe {
    return this.add(this.venueBooks, marketId, handlers);
  }

  /**
   * Registers the paper venue's displayed resting orders. They are merged
   * into the *public* book exactly as the venue displays them (the paper
   * engine decides: limit in full, iceberg slice only, hidden never).
   */
  setParticipantLiquidity(provider: ParticipantLiquidity | null): void {
    this.participants = provider;
  }

  /**
   * Prints executions on the simulated public trade tape. Prints carry only
   * market, aggressor side, price, size and time; never an account or order id.
   */
  printTrade(trade: Omit<Trade, "id">): void {
    if (this.connection.status !== "open") return;
    this.printSeq += 1;
    const print: Trade = { ...trade, id: `sim-print-${this.printSeq}` };
    for (const l of this.trades.get(trade.marketId) ?? []) l.onData([print]);
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

  subscribeAllMids(handlers: StreamHandlers<MidPrices>): Unsubscribe {
    this.midListeners.add(handlers);
    this.ensureRunning();
    return () => this.midListeners.delete(handlers);
  }

  getDiagnostics(): SourceDiagnostics {
    return {
      lastMessageAt: this.lastTickAt,
      invalidMessages: 0,
      lastInvalidReason: null,
      lastVenueError: null,
      activeSubscriptions:
        this.books.size +
        this.venueBooks.size + this.trades.size + this.stats.size + this.candles.size + (this.midListeners.size > 0 ? 1 : 0),
      reconnects: this.outages,
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
      this.outages += 1;
      this.setConnection({ status: "open", since: this.now() });
      for (const set of [...this.books.values(), ...this.venueBooks.values(), ...this.trades.values(), ...this.stats.values()]) {
        for (const handlers of set) handlers.onReset?.();
      }
      for (const entry of this.candles.values()) for (const handlers of entry.listeners) handlers.onReset?.();
      for (const handlers of this.midListeners) handlers.onReset?.();
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
    this.venueBooks.clear();
    this.participants = null;
    this.trades.clear();
    this.stats.clear();
    this.candles.clear();
    this.midListeners.clear();
    this.connectionListeners.clear();
  }

  /** Advance the simulation one tick (public for deterministic tests). */
  tick(): void {
    if (this.connection.status !== "open") return;
    const time = this.now();
    this.lastTickAt = time;
    const active = new Set<MarketId>([...this.books.keys(), ...this.venueBooks.keys(), ...this.trades.keys(), ...this.stats.keys()]);
    for (const entry of this.candles.values()) active.add(entry.marketId);
    // The market list needs every market to move, not just subscribed ones.
    if (this.midListeners.size > 0) for (const id of this.engine.markets.keys()) active.add(id);

    for (const marketId of active) {
      const market = this.engine.get(marketId);
      if (!market) continue;
      market.step();
      const book = market.book(time);
      // The engine sees counterparty liquidity first; the public book then
      // reflects the account's orders as they rest after this update.
      for (const l of this.venueBooks.get(marketId) ?? []) l.onData(book);
      const listeners = this.books.get(marketId);
      if (listeners && listeners.size > 0) {
        const shown = this.participants?.(marketId);
        const publicBook = shown
          ? { ...book, bids: mergeSide(book.bids, shown.bids, true), asks: mergeSide(book.asks, shown.asks, false) }
          : book;
        for (const l of listeners) l.onData(publicBook);
      }
      const trades = market.maybeTrades(time);
      if (trades.length > 0) for (const l of this.trades.get(marketId) ?? []) l.onData(trades);
      const stats = market.stats(time);
      for (const l of this.stats.get(marketId) ?? []) l.onData(stats);
      this.updateCandles(market, time, trades);
    }
    if (this.midListeners.size > 0) {
      const mids = new Map<string, number>();
      for (const market of this.engine.markets.values()) mids.set(market.id, market.mid);
      const prices: MidPrices = { mids, observedAt: time };
      for (const l of this.midListeners) l.onData(prices);
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
