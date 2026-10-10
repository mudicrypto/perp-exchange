import { describe, expect, it, vi } from "vitest";
import { SimulationEngine } from "@/adapters/simulation/simulation-engine";
import { ApiError, NovaApiClient } from "./nova-api-client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NovaApiClient", () => {
  it("returns validated markets", async () => {
    const markets = new SimulationEngine().summaries(0);
    const fetchImpl = vi.fn(async () => json({ source: { id: "simulation", kind: "simulation", label: "x" }, markets }));
    const result = await new NovaApiClient("", fetchImpl).listMarkets();
    expect(result).toEqual(markets);
    expect(fetchImpl).toHaveBeenCalledWith("/api/markets", expect.anything());
  });

  it("rejects responses that do not match the domain contract", async () => {
    const fetchImpl = vi.fn(async () => json({ source: { id: "x", kind: "live", label: "x" }, markets: [{ market: { id: "bad" } }] }));
    await expect(new NovaApiClient("", fetchImpl).listMarkets()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("propagates structured API errors", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "venue-timeout", message: "slow" } }, 504));
    const error = await new NovaApiClient("", fetchImpl).getCandles("BTC-PERP", "1m").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "venue-timeout", status: 504 });
  });

  it("maps network failures to a network ApiError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(new NovaApiClient("", fetchImpl).listMarkets()).rejects.toMatchObject({ code: "network" });
  });

  it("encodes candle query parameters", async () => {
    const fetchImpl = vi.fn(async () => json({ candles: [] }));
    await new NovaApiClient("", fetchImpl).getCandles("BTC-PERP", "15m");
    expect(fetchImpl).toHaveBeenCalledWith("/api/candles?market=BTC-PERP&interval=15m", expect.anything());
  });
});
