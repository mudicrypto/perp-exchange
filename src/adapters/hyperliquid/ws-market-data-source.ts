import {
  baseFromMarketId,
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
import { ReconnectingSocket, type SocketFactory } from "@/lib/ws/reconnecting-socket";
import {
  HYPERLIQUID_ENDPOINTS,
  HYPERLIQUID_INTERVALS,
  HYPERLIQUID_MAX_SUBSCRIPTIONS,
  HYPERLIQUID_PING_INTERVAL_MS,
  HYPERLIQUID_PONG_TIMEOUT_MS,
  HYPERLIQUID_VENUE_ID,
  type HyperliquidNetwork,
} from "./constants";
import { mapAllMids, mapAssetCtx, mapCandle, mapL2Book, mapTrade } from "./mappers";
import {
  PING_MESSAGE,
  parseWsMessage,
  subscribeMessage,
  subscriptionKey,
  unsubscribeMessage,
  type HlSubscription,
  type ParsedMessage,
} from "./protocol";

/** REST-style operations the source delegates to Nova's API (server-side venue access). */
export interface CatalogClient {
  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]>;
  getCandles(marketId: MarketId, interval: CandleInterval, signal?: AbortSignal): Promise<Candle[]>;
}

/** Minimal window-like target for `online` events (injectable for tests). */
export interface OnlineEventTarget {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

export interface HyperliquidSourceOptions {
  network: HyperliquidNetwork;
  catalog: CatalogClient;
  createSocket?: SocketFactory;
  now?: () => number;
  random?: () => number;
  /** Defaults to `window` in browsers; pass null to disable. */
  onlineEvents?: OnlineEventTarget | null;
}

type Dispatch = (message: ParsedMessage) => void;

interface ChannelEntry {
  subscription: HlSubscription;
  dispatchers: Set<Dispatch>;
  resets: Set<() => void>;
  errors: Set<(message: string) => void>;
  /** Set when the venue rejected this subscription; it is not replayed. */
  rejected: string | null;
}

/**
 * Live Hyperliquid market data over the public websocket.
 *
 * - One socket shared by all streams; venue subscriptions are de-duplicated
 *   by canonical key and reference counted.
 * - Every frame goes through `parseWsMessage` (Zod-validated); malformed
 *   frames are counted and dropped, never rendered.
 * - On reconnect, every stream receives `onReset` and subscriptions are
 *   replayed; order-book/candle ordering rules discard stale updates.
 */
export class HyperliquidMarketDataSource implements MarketDataSource {
  readonly descriptor: DataSourceDescriptor;
  private readonly socket: ReconnectingSocket;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly now: () => number;
  private readonly onlineEvents: OnlineEventTarget | null;
  private hasOpenedBefore = false;
  private started = false;
  private invalidMessages = 0;
  private lastInvalidReason: string | null = null;
  private lastVenueError: string | null = null;
  private readonly handleOnline = () => {
    if (this.started && !this.socket.isOpen) this.socket.reconnectNow("browser back online");
  };

  constructor(private readonly options: HyperliquidSourceOptions) {
    this.now = options.now ?? Date.now;
    this.onlineEvents =
      options.onlineEvents !== undefined ? options.onlineEvents : typeof window !== "undefined" ? window : null;
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
        pingPayload: PING_MESSAGE,
      },
    });
    this.socket.onOpen(() => this.handleOpen());
    this.socket.onMessage((raw) => this.handleMessage(raw));
  }

  getDiagnostics(): SourceDiagnostics {
    return {
      lastMessageAt: this.socket.lastMessageAt,
      invalidMessages: this.invalidMessages,
      lastInvalidReason: this.lastInvalidReason,
      lastVenueError: this.lastVenueError,
      activeSubscriptions: this.channels.size,
      reconnects: this.socket.reconnectCount,
    };
  }

  listMarkets(signal?: AbortSignal): Promise<MarketSummary[]> {
    return this.options.catalog.listMarkets(signal);
  }

  getCandles(marketId: MarketId, interval: CandleInterval, signal?: AbortSignal): Promise<Candle[]> {
    return this.options.catalog.getCandles(marketId, interval, signal);
  }

  subscribeOrderBook(marketId: MarketId, handlers: StreamHandlers<OrderBookSnapshot>): Unsubscribe {
    return this.addChannel({ type: "l2Book", coin: baseFromMarketId(marketId) }, handlers, (m) => {
      if (m.kind === "l2Book") handlers.onData(mapL2Book(m.data));
    });
  }

  subscribeTrades(marketId: MarketId, handlers: StreamHandlers<Trade[]>): Unsubscribe {
    return this.addChannel({ type: "trades", coin: baseFromMarketId(marketId) }, handlers, (m) => {
      if (m.kind === "trades") handlers.onData(m.data.map(mapTrade));
    });
  }

  subscribeCandles(marketId: MarketId, interval: CandleInterval, handlers: StreamHandlers<Candle>): Unsubscribe {
    const subscription: HlSubscription = {
      type: "candle",
      coin: baseFromMarketId(marketId),
      interval: HYPERLIQUID_INTERVALS[interval],
    };
    return this.addChannel(subscription, handlers, (m) => {
      if (m.kind === "candle") handlers.onData(mapCandle(m.data));
    });
  }

  subscribeMarketStats(marketId: MarketId, handlers: StreamHandlers<MarketStats>): Unsubscribe {
    return this.addChannel({ type: "activeAssetCtx", coin: baseFromMarketId(marketId) }, handlers, (m) => {
      if (m.kind === "activeAssetCtx") handlers.onData(mapAssetCtx(m.data.coin, m.data.ctx, this.now()));
    });
  }

  subscribeAllMids(handlers: StreamHandlers<MidPrices>): Unsubscribe {
    return this.addChannel({ type: "allMids" }, handlers, (m) => {
      if (m.kind !== "allMids") return;
      const { prices, skipped } = mapAllMids(m.data, this.now());
      if (skipped > 0) this.recordInvalid(`allMids: ${skipped} malformed price(s) skipped`);
      handlers.onData(prices);
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
    this.onlineEvents?.removeEventListener("online", this.handleOnline);
    this.socket.stop("disposed");
  }

  private addChannel<T>(subscription: HlSubscription, handlers: StreamHandlers<T>, dispatch: Dispatch): Unsubscribe {
    const key = subscriptionKey(subscription);
    let entry = this.channels.get(key);
    if (!entry) {
      if (this.channels.size >= HYPERLIQUID_MAX_SUBSCRIPTIONS) {
        handlers.onError?.(`Subscription limit reached (${HYPERLIQUID_MAX_SUBSCRIPTIONS}); not subscribing to ${key}`);
        return () => {};
      }
      entry = { subscription, dispatchers: new Set(), resets: new Set(), errors: new Set(), rejected: null };
      this.channels.set(key, entry);
      // If the socket is not open yet, the subscription is sent on open.
      this.socket.send(subscribeMessage(subscription));
    } else if (entry.rejected) {
      handlers.onError?.(entry.rejected);
    }

    // A throwing mapper or UI handler must not break the socket loop.
    const safeDispatch: Dispatch = (message) => {
      try {
        dispatch(message);
      } catch (error) {
        this.recordInvalid(`${key}: ${error instanceof Error ? error.message : "mapping failed"}`);
      }
    };
    entry.dispatchers.add(safeDispatch);
    if (handlers.onReset) entry.resets.add(handlers.onReset);
    if (handlers.onError) entry.errors.add(handlers.onError);
    this.ensureStarted();

    return () => {
      const current = this.channels.get(key);
      if (!current) return;
      current.dispatchers.delete(safeDispatch);
      if (handlers.onReset) current.resets.delete(handlers.onReset);
      if (handlers.onError) current.errors.delete(handlers.onError);
      if (current.dispatchers.size === 0) {
        this.channels.delete(key);
        if (!current.rejected) this.socket.send(unsubscribeMessage(subscription));
      }
    };
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.onlineEvents?.addEventListener("online", this.handleOnline);
    this.socket.start();
  }

  private handleOpen(): void {
    const isReconnect = this.hasOpenedBefore;
    this.hasOpenedBefore = true;
    for (const entry of this.channels.values()) {
      if (entry.rejected) continue;
      if (isReconnect) for (const reset of entry.resets) reset();
      this.socket.send(subscribeMessage(entry.subscription));
    }
  }

  private handleMessage(raw: string): void {
    const message = parseWsMessage(raw);
    switch (message.kind) {
      case "pong":
      case "subscriptionResponse":
      case "ignored":
        return;
      case "invalid":
        return this.recordInvalid(`${message.channel ?? "?"}: ${message.reason}`);
      case "error":
        return this.handleVenueError(message);
      default: {
        const entry = this.channels.get(message.key);
        if (!entry) return; // late message for a stream we already left
        for (const dispatch of entry.dispatchers) dispatch(message);
      }
    }
  }

  private handleVenueError(message: Extract<ParsedMessage, { kind: "error" }>): void {
    this.lastVenueError = message.message;
    // We never send duplicate subscribes, but the venue may still report one
    // around reconnects; it is harmless.
    if (message.errorKind === "already-subscribed" || !message.subscriptionKey) return;
    const entry = this.channels.get(message.subscriptionKey);
    if (!entry || message.errorKind !== "invalid-subscription") return;
    entry.rejected = message.message;
    for (const onError of entry.errors) onError(message.message);
  }

  private recordInvalid(reason: string): void {
    this.invalidMessages += 1;
    this.lastInvalidReason = reason;
  }
}
