import { describe, expect, it, vi } from "vitest";
import { AccountSnapshotSchema, OrderSchema } from "@/core/domain";
import { ApiError, NovaApiClient } from "@/adapters/http/nova-api-client";
import clearinghouse from "./__fixtures__/clearinghouse-state.json";
import openOrders from "./__fixtures__/frontend-open-orders.json";
import { HyperliquidAdapter } from "./hyperliquid-adapter";
import { HyperliquidInfoClient } from "./info-client";
import { mapClearinghouseState, mapFrontendOpenOrder } from "./mappers";
import { HlClearinghouseStateSchema, HlFrontendOpenOrdersSchema } from "./wire-schemas";

const ADDRESS = "0x00000000000000000000000000000000000000Ab";

describe("clearinghouseState normalisation", () => {
  const { snapshot, skippedPositions } = mapClearinghouseState(HlClearinghouseStateSchema.parse(clearinghouse), 123);

  it("maps positions with signed size, leverage and margin mode; skips flat and unsupported ones", () => {
    expect(snapshot.positions.map((p) => [p.marketId, p.size, p.leverage, p.marginMode])).toEqual([
      ["BTC-PERP", 0.1, 10, "cross"],
      ["ETH-PERP", -1, 5, "isolated"],
    ]);
    expect(snapshot.positions[0]!.liquidationPrice).toBe(54321);
    expect(snapshot.positions[1]!.liquidationPrice).toBeNull();
    expect(skippedPositions).toBe(1); // xyz:TSLA (HIP-3) is not supported; SOL is flat
  });

  it("is labelled as venue data and leaves unreported fields null rather than derived", () => {
    AccountSnapshotSchema.parse(snapshot);
    expect(snapshot).toMatchObject({
      origin: "venue",
      currency: "USDC",
      equity: 10200,
      available: 9010,
      marginUsed: 1190,
      unrealizedPnl: 200,
      balance: null,
      realizedPnl: null,
      feesPaid: null,
      orderMargin: null,
      maintenanceMargin: null,
      observedAt: 123,
    });
    expect(snapshot.positions.every((p) => p.markPrice === null)).toBe(true);
  });

  it("rejects malformed responses", () => {
    expect(HlClearinghouseStateSchema.safeParse({ ...clearinghouse, withdrawable: 5 }).success).toBe(false);
  });
});

describe("frontendOpenOrders normalisation", () => {
  const parsed = HlFrontendOpenOrdersSchema.parse(openOrders);

  it("maps limit orders, including partial fills and Alo → post-only", () => {
    const order = mapFrontendOpenOrder(parsed[0]!)!;
    OrderSchema.parse(order);
    expect(order).toMatchObject({
      id: "hl-9001",
      venueOrderId: "9001",
      marketId: "BTC-PERP",
      side: "buy",
      type: "limit",
      price: 59000,
      size: 0.2,
      status: "partially-filled",
      timeInForce: "post-only",
      origin: "venue",
      leverage: null,
    });
    expect(order.filledSize).toBeCloseTo(0.05);
  });

  it("maps trigger orders as waiting for their trigger", () => {
    expect(mapFrontendOpenOrder(parsed[1]!)).toMatchObject({ type: "stop-market", status: "waiting-trigger", triggerPrice: 3300, price: null, reduceOnly: true, timeInForce: null });
  });

  it("skips order types it cannot map instead of guessing", () => {
    expect(mapFrontendOpenOrder(parsed[2]!)).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HyperliquidInfoClient.getAccount", () => {
  it("requests clearinghouseState and frontendOpenOrders for the lower-cased address and reports skips", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse(body.type === "clearinghouseState" ? clearinghouse : openOrders);
    });
    const client = new HyperliquidInfoClient({ network: "mainnet", fetchImpl: fetchImpl as typeof fetch, sleep: async () => {} });
    const readout = await client.getAccount(ADDRESS);
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));
    expect(bodies).toEqual(
      expect.arrayContaining([
        { type: "clearinghouseState", user: ADDRESS.toLowerCase() },
        { type: "frontendOpenOrders", user: ADDRESS.toLowerCase() },
      ]),
    );
    expect(readout.openOrders.map((o) => o.id)).toEqual(["hl-9002", "hl-9001"]);
    expect(readout.skipped).toEqual({ positions: 1, orders: 1 });
    expect(client.weightUsed()).toBe(22);
  });

  it("refuses malformed addresses before any request", async () => {
    const fetchImpl = vi.fn();
    const client = new HyperliquidInfoClient({ network: "mainnet", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getAccount("not-an-address")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("HyperliquidAdapter account reads through Nova's API", () => {
  const readout = (() => {
    const { snapshot } = mapClearinghouseState(HlClearinghouseStateSchema.parse(clearinghouse), 1);
    const orders = HlFrontendOpenOrdersSchema.parse(openOrders).map(mapFrontendOpenOrder).filter((o) => o !== null);
    return { snapshot, openOrders: orders, skipped: { positions: 1, orders: 1 } };
  })();

  it("returns positions, open orders and account state, with history and fills marked unavailable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(readout));
    const adapter = new HyperliquidAdapter(new NovaApiClient("", fetchImpl as unknown as typeof fetch));
    const account = { kind: "address" as const, address: ADDRESS };
    expect(await adapter.fetchPositions(account)).toMatchObject({ ok: true, value: [{ marketId: "BTC-PERP" }, { marketId: "ETH-PERP" }] });
    expect((await adapter.fetchOpenOrders(account)).ok).toBe(true);
    const state = await adapter.fetchAccountState(account);
    expect(state).toMatchObject({ ok: true, value: { orderHistory: null, fills: null, snapshot: { origin: "venue" } } });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/venue/account?address=${ADDRESS}`, expect.anything());
  });

  it("maps API failures to typed trading errors", async () => {
    const rateLimited = new HyperliquidAdapter({ getVenueAccount: async () => { throw new ApiError("venue-rate-limited", "slow down", 503); } });
    expect(await rateLimited.fetchPositions({ kind: "address", address: ADDRESS })).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    const broken = new HyperliquidAdapter({ getVenueAccount: async () => { throw new ApiError("invalid-response", "bad", 200); } });
    expect(await broken.fetchPositions({ kind: "address", address: ADDRESS })).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("rejects simulated data arriving on the venue account endpoint", async () => {
    const simulated = { ...readout, snapshot: { ...readout.snapshot, origin: "simulated" } };
    const client = new NovaApiClient("", vi.fn(async () => jsonResponse(simulated)) as unknown as typeof fetch);
    await expect(client.getVenueAccount(ADDRESS)).rejects.toMatchObject({ code: "source-mismatch" });
  });
});
