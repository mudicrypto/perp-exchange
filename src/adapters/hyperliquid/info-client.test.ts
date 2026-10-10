import { describe, expect, it, vi } from "vitest";
import metaFixture from "./__fixtures__/meta-and-asset-ctxs.json";
import candlesFixture from "./__fixtures__/candle-snapshot.json";
import { HyperliquidInfoClient, VenueError } from "./info-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch, now = () => 1_700_000_100_000) {
  return new HyperliquidInfoClient({
    network: "mainnet",
    fetchImpl,
    retries: 1,
    sleep: async () => {},
    now,
  });
}

describe("HyperliquidInfoClient", () => {
  it("posts metaAndAssetCtxs to the mainnet info endpoint and maps the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metaFixture));
    const markets = await client(fetchImpl).listMarkets();
    expect(markets.map((m) => m.market.id)).toContain("BTC-PERP");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.hyperliquid.xyz/info");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ type: "metaAndAssetCtxs" });
  });

  it("caches identical requests within the TTL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metaFixture));
    const c = client(fetchImpl);
    await c.listMarkets();
    await c.listMarkets();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails with invalid-response on schema mismatch, without retrying", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    await expect(client(fetchImpl).listMarkets()).rejects.toMatchObject({ code: "invalid-response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once on HTTP 5xx and then succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(metaFixture));
    const markets = await client(fetchImpl).listMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry HTTP 4xx (other than 429)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 400));
    await expect(client(fetchImpl).listMarkets()).rejects.toMatchObject({ code: "http", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces network failures as VenueError after retries", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await client(fetchImpl).listMarkets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueError);
    expect((error as VenueError).code).toBe("network");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("requests candles with the venue coin and bounded, aligned range", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(candlesFixture));
    const end = 1_700_000_100_000;
    const candles = await client(fetchImpl).getCandles("BTC-PERP", "1m", { startTime: 0, endTime: end });
    expect(candles).toHaveLength(2);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.type).toBe("candleSnapshot");
    expect(body.req.coin).toBe("BTC");
    expect(body.req.interval).toBe("1m");
    expect(body.req.startTime % 60_000).toBe(0);
    expect(body.req.endTime - body.req.startTime).toBeLessThanOrEqual(501 * 60_000);
  });
});

describe("HyperliquidInfoClient rate limiting", () => {
  it("maps HTTP 429 to rate-limited and does not retry it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    await expect(client(fetchImpl).listMarkets()).rejects.toMatchObject({ code: "rate-limited", status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to call the venue once Nova's own weight budget is spent", async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async () => jsonResponse(metaFixture));
    const c = new HyperliquidInfoClient({
      network: "mainnet",
      fetchImpl,
      sleep: async () => {},
      now: () => now,
      cacheTtlMs: 0,
      weightBudgetPerMinute: 40, // two metaAndAssetCtxs calls (weight 20 each)
    });
    await c.listMarkets();
    now += 1;
    await c.listMarkets();
    now += 1;
    const error = await c.listMarkets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VenueError);
    expect((error as VenueError).code).toBe("rate-limited");
    expect((error as VenueError).retryAfterMs).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(c.weightUsed()).toBe(40);
  });

  it("charges candle requests by expected size", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(candlesFixture));
    const c = client(fetchImpl);
    await c.getCandles("BTC-PERP", "1m", { startTime: 0, endTime: 1_700_000_100_000 });
    // 20 base + ceil(~501 / 60) = 9
    expect(c.weightUsed()).toBe(29);
  });

  it("shares one venue call (and one weight charge) between identical concurrent requests", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metaFixture));
    const c = client(fetchImpl);
    await Promise.all([c.listMarkets(), c.listMarkets(), c.listMarkets()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.weightUsed()).toBe(20);
  });
});
