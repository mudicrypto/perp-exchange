/**
 * Live contract test against Hyperliquid's public API (read-only).
 * Run with `npm run test:live` where api.hyperliquid.xyz is reachable.
 * It verifies Nova's schemas and protocol assumptions; it places no orders.
 */
import { describe, expect, it } from "vitest";
import { HYPERLIQUID_ENDPOINTS } from "./constants";
import { HyperliquidInfoClient } from "./info-client";
import { mapAllMids } from "./mappers";
import { PING_MESSAGE, parseWsMessage, subscribeMessage, type HlSubscription, type ParsedMessage } from "./protocol";

const network = (process.env.NOVA_HYPERLIQUID_NETWORK as "mainnet" | "testnet" | undefined) ?? "mainnet";
const TIMEOUT = 30_000;

function collect(subscriptions: HlSubscription[], extra: string[], waitMs: number): Promise<ParsedMessage[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HYPERLIQUID_ENDPOINTS[network].ws);
    const messages: ParsedMessage[] = [];
    const timer = setTimeout(() => {
      ws.close();
      resolve(messages);
    }, waitMs);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("websocket error (is the host reachable?)"));
    };
    ws.onopen = () => {
      for (const s of subscriptions) ws.send(subscribeMessage(s));
      for (const m of extra) ws.send(m);
    };
    ws.onmessage = (event) => messages.push(parseWsMessage(String(event.data)));
  });
}

describe(`Hyperliquid ${network} live contract`, () => {
  it("metaAndAssetCtxs matches Nova's schema", { timeout: TIMEOUT }, async () => {
    const client = new HyperliquidInfoClient({ network });
    const markets = await client.listMarkets();
    expect(markets.length).toBeGreaterThan(10);
    const btc = markets.find((m) => m.market.id === "BTC-PERP");
    expect(btc?.stats?.markPrice).toBeGreaterThan(0);
  });

  it("candleSnapshot matches Nova's schema", { timeout: TIMEOUT }, async () => {
    const client = new HyperliquidInfoClient({ network });
    const now = Date.now();
    const candles = await client.getCandles("BTC-PERP", "1h", { startTime: now - 48 * 3_600_000, endTime: now });
    expect(candles.length).toBeGreaterThan(10);
  });

  it("websocket channels parse without invalid frames; ping gets pong; bad subscriptions are reported", { timeout: TIMEOUT }, async () => {
    const messages = await collect(
      [
        { type: "l2Book", coin: "BTC" },
        { type: "trades", coin: "BTC" },
        { type: "candle", coin: "BTC", interval: "1m" },
        { type: "activeAssetCtx", coin: "BTC" },
        { type: "allMids" },
        { type: "l2Book", coin: "NOVA_DOES_NOT_EXIST" },
      ],
      [PING_MESSAGE],
      15_000,
    );
    const kinds = new Set(messages.map((m) => m.kind));
    const invalid = messages.filter((m) => m.kind === "invalid");
    console.info("received kinds:", [...kinds].join(", "), "| invalid:", invalid.length);
    for (const m of messages) if (m.kind === "error") console.info("venue error:", m.message);
    expect(invalid).toEqual([]);
    for (const kind of ["l2Book", "candle", "activeAssetCtx", "allMids", "pong", "subscriptionResponse"]) {
      expect(kinds, `expected at least one ${kind} message`).toContain(kind);
    }
    const mids = messages.find((m) => m.kind === "allMids");
    if (mids?.kind === "allMids") expect(mapAllMids(mids.data, Date.now()).prices.mids.get("BTC-PERP")).toBeGreaterThan(0);
  });

  // Read-only account check against a public address you choose (no keys involved).
  it.skipIf(!process.env.NOVA_LIVE_ADDRESS)("clearinghouseState + frontendOpenOrders match Nova's schemas", { timeout: TIMEOUT }, async () => {
    const client = new HyperliquidInfoClient({ network });
    const readout = await client.getAccount(process.env.NOVA_LIVE_ADDRESS!);
    console.info("positions:", readout.snapshot.positions.length, "open orders:", readout.openOrders.length, "skipped:", readout.skipped);
    expect(readout.snapshot.origin).toBe("venue");
  });
});
