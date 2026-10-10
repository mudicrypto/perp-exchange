import {
  baseFromMarketId,
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
import { ReconnectingSocket, type SocketFactory } from "@/lib/ws/reconnecting-socket";
import {
  HYPERLIQUID_ENDPOINTS,
  HYPERLIQUID_INTERVALS,
  HYPERLIQUID_PING_INTERVAL_MS,
  HYPERLIQUID_PONG_TIMEOUT_MS,
  HYPERLIQUID_VENUE_ID,
  type HyperliquidNetwork,
} from "./constants";
import { isSupportedCoin, mapAssetCtx, mapCandle, mapL2Book, mapTrade } from "./mappers";
import {
  HlActiveAssetCtxSchema,
  HlCandleSchema,
  HlL2BookSchema,
  HlTradesSchema,
  HlWsEnvelopeSchema,
} from "./wire-schemas";

/** REST-style operations the source delegates to Nova's API (server-side venue access). */
export interface CatalogClient {
  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]>;
  getCandles(marketId: MarketId, interval: CandleInterval, signal?: AbortSignal): Promise<Candle[]>;
}

export interface HyperliquidSourceOptions {
  network: HyperliquidNetwork;
  catalog: CatalogClient;
  createSocket?: SocketFactory;
  now?: () => number;
  random?: () => number;
}

export interface SourceDiagnostics {
  invalidMessages: number;
  lastVenueError: string | null;
}

type Dispatch = (data: unknown) => void;

interface ChannelEntry {
  subscription: Record<string, string>;
  dispatchers: Set<Dispatch>;
  resets: Set<() => void>;
}

/**
 * Live Hyperliquid market data over the public websocket. One socket is
 * shared by all subscriptions; each payload is validated, mapped to domain
 * types once, then fanned out.
 */
export class HyperliquidMarketDataSource implements MarketDataSource {
  readonly descriptor: DataSourceDescriptor;
  private readonly socket: ReconnectingSocket;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly now: () => number;
  private hasOpenedBefore = false;
  private started = false;
  private diagnostics: SourceDiagnostics = { invalidMessages: 0, lastVenueError: null };

  constructor(private readonly options: HyperliquidSourceOptions) {
    this.now = options.now ?? Date.now;
    this.descriptor = {
      id: `hyperliquid-${options.network}`,
      kind: "live",
      label: `Hyperliquid ${options.network} (public API)`,
      venueId: HYPERLIQUID_VENUE_ID,
    };
    this.socket = new ReconnectingSocket({
      url: HYPERLIQUID_ENDPOINTS[options.network].ws,
      createSocket: options.createSocket,
      now: options.now,
      random: options.random,
      heartbeat: {
        intervalMs: HYPERLIQUID_PING_INTERVAL_MS,
        timeoutMs: HYPERLIQUID_PONG_TIMEOUT_MS,
        pingPayload: JSON.stringify({ method: "ping" }),
      },
    });
    this.socket.onOpen(() => this.handleOpen());
    this.socket.onMessage((raw) => this.handleMessage(raw));
  }

  getDiagnostics(): SourceDiagnostics {
    return { ...this.diagnostics };
  }

  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]> {
    return this.options.catalog.listMarkets(signal);
  }

  getCandles(marketId: MarketId, interval: CandleInterval, signal?: AbortSignal): Promise<Candle[]> {
    return this.options.catalog.getCandles(marketId, interval, signal);
  }

  subscribeOrderBook(marketId: MarketId, handlers: StreamHandlers<OrderBookSnapshot>): Unsubscribe {
    const coin = baseFromMarketId(marketId);
    return this.addChannel(`l2Book:${coin}`, { type: "l2Book", coin }, handlers, (data) => {
      const parsed = HlL2BookSchema.safeParse(data);
      if (!parsed.success) return this.invalid();
      handlers.onData(mapL2Book(parsed.data));
    });
  }

  subscribeTrades(marketId: MarketId, handlers: StreamHandlers<Trade[]>): Unsubscribe {
    const coin = baseFromMarketId(marketId);
    return this.addChannel(`trades:${coin}`, { type: "trades", coin }, handlers, (data) => {
      const parsed = HlTradesSchema.safeParse(data);
      if (!parsed.success) return this.invalid();
      const trades = parsed.data.filter((trade) => trade.coin === coin).map(mapTrade);
      if (trades.length > 0) handlers.onData(trades);
    });
  }

  subscribeCandles(
    marketId: MarketId,
    interval: CandleInterval,
    handlers: StreamHandlers<Candle>,
  ): Unsubscribe {
    const coin = baseFromMarketId(marketId);
    const hlInterval = HYPERLIQUID_INTERVALS[interval];
    return this.addChannel(
      `candle:${coin}:${hlInterval}`,
      { type: "candle", coin, interval: hlInterval },
      handlers,
      (data) => {
        const parsed = HlCandleSchema.safeParse(data);
        if (!parsed.success) return this.invalid();
        handlers.onData(mapCandle(parsed.data));
      },
    );
  }

  subscribeMarketStats(marketId: MarketId, handlers: StreamHandlers<MarketStats>): Unsubscribe {
    const coin = baseFromMarketId(marketId);
    return this.addChannel(`activeAssetCtx:${coin}`, { type: "activeAssetCtx", coin }, handlers, (data) => {
      const parsed = HlActiveAssetCtxSchema.safeParse(data);
      if (!parsed.success) return this.invalid();
      try {
        handlers.onData(mapAssetCtx(parsed.data.coin, parsed.data.ctx, this.now()));
      } catch {
        this.invalid();
      }
    });
  }

  subscribeConnection(listener: (state: ConnectionState) => void): Unsubscribe {
    return this.socket.onState(listener);
  }

  /**
   * Closes the socket and drops all subscriptions. The source can be reused:
   * a later subscription starts a fresh connection (needed for React strict
   * mode, which unmounts and remounts effects in development).
   */
  dispose(): void {
    this.channels.clear();
    this.started = false;
    this.hasOpenedBefore = false;
    this.socket.stop("disposed");
  }

  private addChannel<T>(
    key: string,
    subscription: Record<string, string>,
    handlers: StreamHandlers<T>,
    dispatch: Dispatch,
  ): Unsubscribe {
    // Wrap so a throwing UI handler cannot break the socket loop.
    const safeDispatch: Dispatch = (data) => {
      try {
        dispatch(data);
      } catch {
        this.invalid();
      }
    };
    let entry = this.channels.get(key);
    if (!entry) {
      entry = { subscription, dispatchers: new Set(), resets: new Set() };
      this.channels.set(key, entry);
      this.socket.send(JSON.stringify({ method: "subscribe", subscription }));
    }
    entry.dispatchers.add(safeDispatch);
    const reset = handlers.onReset;
    if (reset) entry.resets.add(reset);
    this.ensureStarted();

    return () => {
      const current = this.channels.get(key);
      if (!current) return;
      current.dispatchers.delete(safeDispatch);
      if (reset) current.resets.delete(reset);
      if (current.dispatchers.size === 0) {
        this.channels.delete(key);
        this.socket.send(JSON.stringify({ method: "unsubscribe", subscription }));
      }
    };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.socket.start();
  }

  private handleOpen(): void {
    const isReconnect = this.hasOpenedBefore;
    this.hasOpenedBefore = true;
    for (const entry of this.channels.values()) {
      if (isReconnect) for (const reset of entry.resets) reset();
      this.socket.send(JSON.stringify({ method: "subscribe", subscription: entry.subscription }));
    }
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.invalid();
    }
    const envelope = HlWsEnvelopeSchema.safeParse(json);
    if (!envelope.success) return this.invalid();
    const { channel, data } = envelope.data;

    switch (channel) {
      case "pong":
      case "subscriptionResponse":
        return;
      case "error":
        this.diagnostics.lastVenueError = typeof data === "string" ? data : "Unknown venue error";
        return;
      case "l2Book":
      case "activeAssetCtx":
        return this.route(`${channel}:${coinOf(data)}`, data);
      case "trades": {
        const coin = Array.isArray(data) ? coinOf(data[0]) : null;
        return this.route(`trades:${coin}`, data);
      }
      case "candle": {
        const record = isRecord(data) ? data : null;
        return this.route(`candle:${String(record?.s)}:${String(record?.i)}`, data);
      }
      default:
        return; // channels we did not subscribe to
    }
  }

  private route(key: string, data: unknown): void {
    const entry = this.channels.get(key);
    if (!entry) return;
    for (const dispatch of entry.dispatchers) dispatch(data);
  }

  private invalid(): void {
    this.diagnostics.invalidMessages += 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coinOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const coin = value.coin;
  return typeof coin === "string" && isSupportedCoin(coin) ? coin : null;
}
