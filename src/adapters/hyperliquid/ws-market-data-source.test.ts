import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderBookSnapshot, Trade } from "@/core/domain";
import { fakeSocketFactory } from "@/test/fake-socket";
import wsFixture from "./__fixtures__/ws-messages.json";
import { HyperliquidMarketDataSource } from "./ws-market-data-source";

function setup() {
  const sockets = fakeSocketFactory();
  const catalog = { listMarkets: vi.fn(async () => []), getCandles: vi.fn(async () => []) };
  const source = new HyperliquidMarketDataSource({
    network: "mainnet",
    catalog,
    createSocket: sockets.factory,
    random: () => 0.5,
  });
  return { source, sockets, catalog };
}

describe("HyperliquidMarketDataSource", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is labelled as live public Hyperliquid data", () => {
    const { source } = setup();
    expect(source.descriptor).toMatchObject({ kind: "live", venueId: "hyperliquid" });
  });

  it("connects lazily to the mainnet socket and subscribes once open", () => {
    const { source, sockets } = setup();
    expect(sockets.sockets).toHaveLength(0);
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    expect(sockets.last.url).toBe("wss://api.hyperliquid.xyz/ws");
    sockets.last.open();
    expect(sockets.last.sentJson()).toEqual([
      { method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } },
    ]);
  });

  it("routes validated messages to the right subscribers as domain objects", () => {
    const { source, sockets } = setup();
    const books: OrderBookSnapshot[] = [];
    const ethBooks: OrderBookSnapshot[] = [];
    const trades: Trade[][] = [];
    source.subscribeOrderBook("BTC-PERP", { onData: (b) => books.push(b) });
    source.subscribeOrderBook("ETH-PERP", { onData: (b) => ethBooks.push(b) });
    source.subscribeTrades("BTC-PERP", { onData: (t) => trades.push(t) });
    sockets.last.open();
    sockets.last.receive(wsFixture.subscriptionResponse);
    sockets.last.receive(wsFixture.l2Book);
    sockets.last.receive(wsFixture.trades);
    expect(books).toHaveLength(1);
    expect(books[0]!.marketId).toBe("BTC-PERP");
    expect(ethBooks).toHaveLength(0);
    expect(trades[0]!.map((t) => t.side)).toEqual(["buy", "sell"]);
  });

  it("delivers candles and market stats", () => {
    const { source, sockets } = setup();
    const candle = vi.fn();
    const stats = vi.fn();
    source.subscribeCandles("BTC-PERP", "1m", { onData: candle });
    source.subscribeMarketStats("BTC-PERP", { onData: stats });
    sockets.last.open();
    sockets.last.receive(wsFixture.candle);
    sockets.last.receive(wsFixture.activeAssetCtx);
    expect(candle).toHaveBeenCalledWith(expect.objectContaining({ openTime: 1700000000000, close: 61003 }));
    expect(stats).toHaveBeenCalledWith(expect.objectContaining({ marketId: "BTC-PERP", markPrice: 61010 }));
  });

  it("drops malformed messages and counts them without throwing", () => {
    const { source, sockets } = setup();
    const onData = vi.fn();
    source.subscribeOrderBook("BTC-PERP", { onData });
    sockets.last.open();
    sockets.last.receive("{not json");
    sockets.last.receive({ channel: "l2Book", data: { coin: "BTC", time: 1, levels: "oops" } });
    sockets.last.receive({ nochannel: true });
    expect(onData).not.toHaveBeenCalled();
    expect(source.getDiagnostics().invalidMessages).toBe(3);
  });

  it("records venue error messages", () => {
    const { source, sockets } = setup();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    sockets.last.receive(wsFixture.error);
    expect(source.getDiagnostics().lastVenueError).toBe("Invalid subscription");
  });

  it("shares one venue subscription between subscribers and unsubscribes after the last leaves", () => {
    const { source, sockets } = setup();
    const a = source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    const b = source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    a();
    expect(sockets.last.sentJson()).toHaveLength(1);
    b();
    expect(sockets.last.sentJson().at(-1)).toEqual({
      method: "unsubscribe",
      subscription: { type: "l2Book", coin: "BTC" },
    });
  });

  it("replays subscriptions and signals resets after a reconnect", () => {
    const { source, sockets } = setup();
    const onReset = vi.fn();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {}, onReset });
    source.subscribeTrades("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    expect(onReset).not.toHaveBeenCalled();
    sockets.last.serverClose(1006, "drop");
    vi.advanceTimersByTime(1_000);
    expect(sockets.sockets).toHaveLength(2);
    sockets.last.open();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(sockets.last.sentJson()).toEqual([
      { method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } },
      { method: "subscribe", subscription: { type: "trades", coin: "BTC" } },
    ]);
  });

  it("sends keep-alive pings while connected", () => {
    const { source, sockets } = setup();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    vi.advanceTimersByTime(30_000);
    expect(sockets.last.sentJson()).toContainEqual({ method: "ping" });
  });

  it("can be reused after dispose (React strict mode remounts)", () => {
    const { source, sockets } = setup();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    source.dispose();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    expect(sockets.sockets).toHaveLength(2);
  });
});
