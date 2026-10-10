import type {
  Candle,
  CandleInterval,
  MarketId,
  MarketStats,
  MarketSummary,
  MidPrices,
  OrderBookSnapshot,
  Trade,
} from "../domain";

export type Unsubscribe = () => void;

/** Whether data is real venue data or generated locally. Always shown in the UI. */
export type DataSourceKind = "live" | "simulation";

export interface DataSourceDescriptor {
  id: string;
  kind: DataSourceKind;
  /** Human label, e.g. "Hyperliquid mainnet (public API)". */
  label: string;
  venueId: string;
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "open"; since: number }
  | { status: "reconnecting"; attempt: number; nextRetryAt: number; reason: string }
  | { status: "closed"; reason: string };

export interface StreamHandlers<T> {
  onData: (value: T) => void;
  /** Called when the stream must be considered reset (e.g. after reconnect). */
  onReset?: () => void;
  /** The venue rejected this stream (e.g. invalid subscription). */
  onError?: (message: string) => void;
}

/** Operational detail for the connection status UI. */
export interface SourceDiagnostics {
  /** Last frame of any kind received from the venue (ms), if any. */
  lastMessageAt: number | null;
  invalidMessages: number;
  lastInvalidReason: string | null;
  lastVenueError: string | null;
  activeSubscriptions: number;
  reconnects: number;
}

/**
 * Browser-side market data contract. Implementations translate venue
 * payloads into domain types and must:
 *  - validate every external payload,
 *  - replay subscriptions after reconnect,
 *  - never emit duplicated trades for the same trade id.
 */
export interface MarketDataSource {
  readonly descriptor: DataSourceDescriptor;

  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]>;
  getCandles(
    marketId: MarketId,
    interval: CandleInterval,
    signal?: AbortSignal,
  ): Promise<Candle[]>;

  subscribeOrderBook(marketId: MarketId, handlers: StreamHandlers<OrderBookSnapshot>): Unsubscribe;
  subscribeTrades(marketId: MarketId, handlers: StreamHandlers<Trade[]>): Unsubscribe;
  subscribeCandles(
    marketId: MarketId,
    interval: CandleInterval,
    handlers: StreamHandlers<Candle>,
  ): Unsubscribe;
  subscribeMarketStats(marketId: MarketId, handlers: StreamHandlers<MarketStats>): Unsubscribe;
  /** Mid prices for all markets (used by the market list). */
  subscribeAllMids(handlers: StreamHandlers<MidPrices>): Unsubscribe;
  getDiagnostics(): SourceDiagnostics;
  subscribeConnection(listener: (state: ConnectionState) => void): Unsubscribe;

  dispose(): void;
}

/**
 * Server-side request/response market data (catalog + history). Kept
 * separate from the streaming interface so it can be cached and rate
 * limited on the server.
 */
export interface MarketCatalogGateway {
  readonly descriptor: DataSourceDescriptor;
  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]>;
  getCandles(
    marketId: MarketId,
    interval: CandleInterval,
    range: { startTime: number; endTime: number },
    signal?: AbortSignal,
  ): Promise<Candle[]>;
}
