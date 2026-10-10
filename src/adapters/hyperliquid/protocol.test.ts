import { describe, expect, it } from "vitest";
import wsFixture from "./__fixtures__/ws-messages.json";
import { parseWsMessage, subscribeMessage, subscriptionKey, unsubscribeMessage } from "./protocol";

const raw = (value: unknown) => JSON.stringify(value);

describe("subscription identity", () => {
  it("builds canonical keys per subscription type", () => {
    expect(subscriptionKey({ type: "l2Book", coin: "BTC" })).toBe("l2Book:BTC");
    expect(subscriptionKey({ type: "trades", coin: "ETH" })).toBe("trades:ETH");
    expect(subscriptionKey({ type: "candle", coin: "BTC", interval: "1m" })).toBe("candle:BTC:1m");
    expect(subscriptionKey({ type: "activeAssetCtx", coin: "SOL" })).toBe("activeAssetCtx:SOL");
    expect(subscriptionKey({ type: "allMids" })).toBe("allMids");
  });

  it("serialises subscribe / unsubscribe requests in the documented envelope", () => {
    expect(JSON.parse(subscribeMessage({ type: "l2Book", coin: "BTC" }))).toEqual({
      method: "subscribe",
      subscription: { type: "l2Book", coin: "BTC" },
    });
    expect(JSON.parse(unsubscribeMessage({ type: "allMids" }))).toEqual({
      method: "unsubscribe",
      subscription: { type: "allMids" },
    });
  });
});

describe("parseWsMessage — data channels", () => {
  it("parses l2Book and routes by coin", () => {
    const m = parseWsMessage(raw(wsFixture.l2Book));
    expect(m).toMatchObject({ kind: "l2Book", key: "l2Book:BTC" });
  });

  it("parses trades and routes by the batch coin", () => {
    const m = parseWsMessage(raw(wsFixture.trades));
    expect(m.kind).toBe("trades");
    if (m.kind === "trades") {
      expect(m.key).toBe("trades:BTC");
      expect(m.data).toHaveLength(2);
    }
  });

  it("parses candles and routes by coin + interval", () => {
    expect(parseWsMessage(raw(wsFixture.candle))).toMatchObject({ kind: "candle", key: "candle:BTC:1m" });
  });

  it("parses activeAssetCtx", () => {
    expect(parseWsMessage(raw(wsFixture.activeAssetCtx))).toMatchObject({ kind: "activeAssetCtx", key: "activeAssetCtx:BTC" });
  });

  it("parses allMids", () => {
    const m = parseWsMessage(raw({ channel: "allMids", data: { mids: { BTC: "61000.5", "@107": "1.2" } } }));
    expect(m).toMatchObject({ kind: "allMids", key: "allMids" });
  });

  it("treats an empty trades batch as nothing to route", () => {
    expect(parseWsMessage(raw({ channel: "trades", data: [] }))).toEqual({ kind: "ignored", channel: "trades" });
  });

  it("rejects a trades batch that mixes coins", () => {
    const mixed = structuredClone(wsFixture.trades);
    mixed.data[1]!.coin = "ETH";
    expect(parseWsMessage(raw(mixed))).toMatchObject({ kind: "invalid", reason: "mixed coins in trades batch" });
  });
});

describe("parseWsMessage — control and malformed frames", () => {
  it("recognises pong and subscription acknowledgements", () => {
    expect(parseWsMessage(raw(wsFixture.pong))).toEqual({ kind: "pong" });
    expect(parseWsMessage(raw(wsFixture.subscriptionResponse))).toEqual({ kind: "subscriptionResponse" });
  });

  it("classifies venue errors and recovers the echoed subscription", () => {
    expect(parseWsMessage(raw({ channel: "error", data: 'Invalid subscription {"type":"l2Book","coin":"NOPE"}' }))).toEqual({
      kind: "error",
      message: 'Invalid subscription {"type":"l2Book","coin":"NOPE"}',
      subscriptionKey: "l2Book:NOPE",
      errorKind: "invalid-subscription",
    });
    expect(
      parseWsMessage(raw({ channel: "error", data: 'Already subscribed {"method":"subscribe","subscription":{"type":"candle","coin":"BTC","interval":"1m"}}' })),
    ).toMatchObject({ errorKind: "already-subscribed", subscriptionKey: "candle:BTC:1m" });
    expect(parseWsMessage(raw(wsFixture.error))).toMatchObject({ kind: "error", errorKind: "invalid-subscription", subscriptionKey: null });
    expect(parseWsMessage(raw({ channel: "error", data: "Something else" }))).toMatchObject({ errorKind: "other", subscriptionKey: null });
    expect(parseWsMessage(raw({ channel: "error", data: "Invalid subscription {not json" }))).toMatchObject({ subscriptionKey: null });
  });

  it("never throws on malformed input", () => {
    expect(parseWsMessage("{not json")).toEqual({ kind: "invalid", reason: "not JSON", channel: null });
    expect(parseWsMessage(raw({ data: 1 }))).toEqual({ kind: "invalid", reason: "missing channel", channel: null });
    expect(parseWsMessage(raw(null))).toMatchObject({ kind: "invalid" });
    expect(parseWsMessage(raw([1, 2, 3]))).toMatchObject({ kind: "invalid" });
  });

  it("reports which field failed validation", () => {
    const badBook = { channel: "l2Book", data: { coin: "BTC", time: 1, levels: [[{ px: "abc", sz: "1", n: 1 }], []] } };
    const m = parseWsMessage(raw(badBook));
    expect(m.kind).toBe("invalid");
    if (m.kind === "invalid") {
      expect(m.channel).toBe("l2Book");
      expect(m.reason).toContain("levels.0.0.px");
    }
    expect(parseWsMessage(raw({ channel: "candle", data: { ...wsFixture.candle.data, t: "soon" } }))).toMatchObject({ kind: "invalid", channel: "candle" });
    expect(parseWsMessage(raw({ channel: "allMids", data: { mids: "nope" } }))).toMatchObject({ kind: "invalid", channel: "allMids" });
  });

  it("ignores channels Nova does not subscribe to", () => {
    expect(parseWsMessage(raw({ channel: "userFills", data: {} }))).toEqual({ kind: "ignored", channel: "userFills" });
  });
});
