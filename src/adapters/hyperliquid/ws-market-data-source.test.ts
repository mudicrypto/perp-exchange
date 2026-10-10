import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderBookSnapshot, Trade } from "@/core/domain";
import { fakeSocketFactory } from "@/test/fake-socket";
import wsFixture from "./__fixtures__/ws-messages.json";
import { HyperliquidMarketDataSource } from "./ws-market-data-source";

class FakeOnlineTarget {
  listeners = new Set<() => void>();
  addEventListener(_: "online", l: () => void) {
    this.listeners.add(l);
  }
  removeEventListener(_: "online", l: () => void) {
    this.listeners.delete(l);
  }
  fire() {
    for (const l of this.listeners) l();
  }
}

function setup() {
  const sockets = fakeSocketFactory();
  const catalog = { listMarkets: vi.fn(async () => []), getCandles: vi.fn(async () => []) };
  const online = new FakeOnlineTarget();
  const source = new HyperliquidMarketDataSource({
    network: "mainnet",
    catalog,
    createSocket: sockets.factory,
    random: () => 0.5,
    onlineEvents: online,
  });
  return { source, sockets, catalog, online };
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

  it("streams allMids as Nova market ids", () => {
    const { source, sockets } = setup();
    const onData = vi.fn();
    source.subscribeAllMids({ onData });
    sockets.last.open();
    expect(sockets.last.sentJson()).toEqual([{ method: "subscribe", subscription: { type: "allMids" } }]);
    sockets.last.receive({ channel: "allMids", data: { mids: { BTC: "61000.5", "@1": "2", BAD: "x" } } });
    const prices = onData.mock.calls[0]![0];
    expect([...prices.mids.entries()]).toEqual([["BTC-PERP", 61000.5]]);
    expect(source.getDiagnostics().lastInvalidReason).toMatch(/allMids: 1 malformed/);
  });

  it("routes an invalid-subscription error to that stream only and does not replay it", () => {
    const { source, sockets } = setup();
    const badError = vi.fn();
    const goodError = vi.fn();
    source.subscribeOrderBook("NOPE-PERP", { onData: () => {}, onError: badError });
    source.subscribeOrderBook("BTC-PERP", { onData: () => {}, onError: goodError });
    sockets.last.open();
    sockets.last.receive({ channel: "error", data: 'Invalid subscription {"type":"l2Book","coin":"NOPE"}' });
    expect(badError).toHaveBeenCalledWith(expect.stringContaining("Invalid subscription"));
    expect(goodError).not.toHaveBeenCalled();

    sockets.last.serverClose(1006, "drop");
    vi.advanceTimersByTime(1_000);
    sockets.last.open();
    expect(sockets.last.sentJson()).toEqual([{ method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } }]);

    // A later subscriber to the rejected stream learns about the error immediately.
    const lateError = vi.fn();
    source.subscribeOrderBook("NOPE-PERP", { onData: () => {}, onError: lateError });
    expect(lateError).toHaveBeenCalledTimes(1);
  });

  it("ignores 'Already subscribed' errors", () => {
    const { source, sockets } = setup();
    const onError = vi.fn();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {}, onError });
    sockets.last.open();
    sockets.last.receive({ channel: "error", data: 'Already subscribed {"type":"l2Book","coin":"BTC"}' });
    expect(onError).not.toHaveBeenCalled();
    expect(source.getDiagnostics().lastVenueError).toMatch(/Already subscribed/);
  });

  it("never sends a duplicate subscribe for the same stream", () => {
    const { source, sockets } = setup();
    source.subscribeTrades("BTC-PERP", { onData: () => {} });
    source.subscribeTrades("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    source.subscribeTrades("BTC-PERP", { onData: () => {} });
    const subscribes = sockets.last.sentJson().filter((m) => (m as { method: string }).method === "subscribe");
    expect(subscribes).toHaveLength(1);
  });

  it("re-subscribes cleanly after leaving and rejoining a stream", () => {
    const { source, sockets } = setup();
    const off = source.subscribeTrades("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    off();
    source.subscribeTrades("BTC-PERP", { onData: () => {} });
    expect(sockets.last.sentJson().map((m) => (m as { method: string }).method)).toEqual(["subscribe", "unsubscribe", "subscribe"]);
  });

  it("drops late messages for streams that were unsubscribed", () => {
    const { source, sockets } = setup();
    const onData = vi.fn();
    const off = source.subscribeOrderBook("BTC-PERP", { onData });
    sockets.last.open();
    off();
    sockets.last.receive(wsFixture.l2Book);
    expect(onData).not.toHaveBeenCalled();
    expect(source.getDiagnostics().invalidMessages).toBe(0);
  });

  it("reconnects immediately when the browser comes back online", () => {
    const { source, sockets, online } = setup();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    sockets.last.serverClose(1006, "network down");
    expect(sockets.sockets).toHaveLength(1);
    online.fire();
    expect(sockets.sockets).toHaveLength(2);
    sockets.last.open();
    expect(source.getDiagnostics().reconnects).toBe(1);
  });

  it("does not reconnect on 'online' while the connection is healthy", () => {
    const { source, sockets, online } = setup();
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    sockets.last.open();
    online.fire();
    expect(sockets.sockets).toHaveLength(1);
  });

  it("caps the number of venue subscriptions", () => {
    const { source } = setup();
    for (let i = 0; i < 100; i += 1) source.subscribeOrderBook(`C${i}-PERP`, { onData: () => {} });
    const onError = vi.fn();
    source.subscribeOrderBook("ONEMORE-PERP", { onData: () => {}, onError });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Subscription limit/));
    expect(source.getDiagnostics().activeSubscriptions).toBe(100);
  });

  it("tracks last message time and cleans up timers and listeners on dispose", () => {
    let now = 1_000;
    const sockets = fakeSocketFactory();
    const online = new FakeOnlineTarget();
    const source = new HyperliquidMarketDataSource({
      network: "testnet",
      catalog: { listMarkets: async () => [], getCandles: async () => [] },
      createSocket: sockets.factory,
      now: () => now,
      onlineEvents: online,
    });
    source.subscribeOrderBook("BTC-PERP", { onData: () => {} });
    expect(sockets.last.url).toBe("wss://api.hyperliquid-testnet.xyz/ws");
    sockets.last.open();
    now = 5_000;
    sockets.last.receive(wsFixture.l2Book);
    expect(source.getDiagnostics().lastMessageAt).toBe(5_000);

    source.dispose();
    expect(online.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(sockets.last.closed).not.toBeNull();
  });

  it("isolates a throwing consumer from other streams", () => {
    const { source, sockets } = setup();
    const ok = vi.fn();
    source.subscribeOrderBook("BTC-PERP", {
      onData: () => {
        throw new Error("UI bug");
      },
    });
    source.subscribeTrades("BTC-PERP", { onData: ok });
    sockets.last.open();
    sockets.last.receive(wsFixture.l2Book);
    sockets.last.receive(wsFixture.trades);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(source.getDiagnostics().lastInvalidReason).toMatch(/UI bug/);
  });
});
