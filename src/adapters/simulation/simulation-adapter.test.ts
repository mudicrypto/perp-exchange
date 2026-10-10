import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fill, Order, OrderRequest } from "@/core/domain";
import type { AccountState, ConnectionState } from "@/core/ports";
import { SimulationAdapter } from "./simulation-adapter";
import { SimulatedMarketDataSource } from "./simulated-market-data-source";

const NOW = 1_700_000_000_000;

let cid = 0;
const marketOrder = (o: Partial<OrderRequest> = {}): OrderRequest =>
  ({
    clientOrderId: `t${++cid}`,
    marketId: "GAMMA-PERP",
    side: "buy",
    type: "market",
    maxSlippage: 0.05,
    size: 100,
    reduceOnly: false,
    leverage: 3,
    marginMode: "isolated",
    ...o,
  }) as OrderRequest;

describe("SimulationAdapter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(options: ConstructorParameters<typeof SimulationAdapter>[1] = {}) {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const adapter = new SimulationAdapter(source, { now: () => NOW, ...options });
    const states: AccountState[] = [];
    adapter.subscribeAccount((s) => s && states.push(s));
    vi.advanceTimersByTime(100); // first book + mark for every market
    const gamma = adapter.describeInstrument([...source.markets.values()].find((m) => m.id === "GAMMA-PERP")!.market);
    return { source, adapter, states, gamma };
  }

  it("declares a simulated origin and a paper account", () => {
    const { adapter } = setup();
    expect(adapter.origin).toBe("simulated");
    expect(adapter.getCapabilities().origin).toBe("simulated");
    expect(adapter.connection).toMatchObject({ status: "paper" });
  });

  it("submits a market order against the simulated book", async () => {
    const { adapter, gamma } = setup();
    const result = await adapter.submitOrder(marketOrder(), gamma);
    expect(result).toMatchObject({ ok: true, value: { status: "filled", origin: "simulated" } });
  });

  it("validates before submitting and returns explicit unsupported errors", async () => {
    const { adapter, gamma } = setup();
    const hidden = { ...marketOrder(), type: "hidden", price: 0.8, timeInForce: "gtc" } as unknown as OrderRequest;
    expect(await adapter.submitOrder(hidden, gamma)).toMatchObject({ ok: false, error: { code: "unsupported", capability: "order.hidden", scope: "venue" } });
    const stopLimit = { ...marketOrder(), type: "stop-limit", triggerPrice: 0.9, price: 0.91, timeInForce: "gtc" } as unknown as OrderRequest;
    expect(await adapter.submitOrder(stopLimit, gamma)).toMatchObject({ ok: false, error: { code: "unsupported", scope: "nova" } });
    expect(await adapter.submitOrder(marketOrder({ marginMode: "cross" }), gamma)).toMatchObject({ ok: false, error: { capability: "margin.cross" } });
    expect(await adapter.submitOrder(marketOrder({ size: 0.5 }), gamma)).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("emits pending-new before the simulated venue decides when ack latency is configured", async () => {
    const { adapter, gamma } = setup({ ackLatencyMs: 200 });
    const updates: Order[] = [];
    const sub = adapter.subscribeOrderUpdates({ kind: "simulated" }, (o) => updates.push(o));
    expect(sub.ok).toBe(true);
    const pending = adapter.submitOrder(marketOrder(), gamma);
    await Promise.resolve();
    expect(updates.at(-1)!.status).toBe("pending-new");
    await vi.advanceTimersByTimeAsync(200);
    expect((await pending).ok).toBe(true);
    expect(updates.map((o) => o.status)).toEqual(["pending-new", "open", "filled"]);
  });

  it("streams fills and supports cancel by client order id", async () => {
    const { adapter, gamma } = setup();
    const fills: Fill[] = [];
    adapter.subscribeFills({ kind: "simulated" }, (f) => fills.push(f));
    await adapter.submitOrder(marketOrder(), gamma);
    expect(fills.length).toBeGreaterThan(0);
    const resting = marketOrder({ type: "limit", price: 0.5, timeInForce: "gtc" } as Partial<OrderRequest>);
    delete (resting as { maxSlippage?: number }).maxSlippage;
    await adapter.submitOrder(resting, gamma);
    expect(await adapter.cancelOrder({ clientOrderId: resting.clientOrderId })).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await adapter.cancelOrder({ clientOrderId: "nope" })).toMatchObject({ ok: false, error: { code: "order-not-found" } });
  });

  it("applies configured simulated rejections", async () => {
    const { adapter, gamma } = setup();
    adapter.rejectNextOrders("Simulated venue rejection");
    expect(await adapter.submitOrder(marketOrder(), gamma)).toMatchObject({ ok: false, error: { code: "simulated-rejection" } });
    expect((await adapter.submitOrder(marketOrder(), gamma)).ok).toBe(true);
  });

  it("can be configured to never fill", async () => {
    const { adapter, gamma } = setup({ config: { fillModel: "none" } });
    const limit = { ...marketOrder(), type: "limit", price: 0.9, timeInForce: "gtc" } as unknown as OrderRequest;
    expect(await adapter.submitOrder(limit, gamma)).toMatchObject({ ok: true, value: { status: "open", filledSize: 0 } });
  });

  it("pauses order entry while the feed is disconnected", async () => {
    const { source, adapter, gamma } = setup();
    const connection: ConnectionState[] = [];
    source.subscribeConnection((s) => connection.push(s));
    source.simulateOutage(1_000);
    expect(await adapter.submitOrder(marketOrder(), gamma)).toMatchObject({ ok: false, error: { code: "feed-unavailable" } });
    vi.advanceTimersByTime(1_100);
    expect((await adapter.submitOrder(marketOrder(), gamma)).ok).toBe(true);
  });

  it("reads only its own simulated account", async () => {
    const { adapter } = setup();
    expect(await adapter.fetchOpenOrders({ kind: "simulated" })).toMatchObject({ ok: true });
    expect((await adapter.fetchPositions({ kind: "simulated" })).ok).toBe(true);
    const state = await adapter.fetchAccountState({ kind: "simulated" });
    expect(state.ok && state.value.snapshot.origin).toBe("simulated");
    const external = await adapter.fetchAccountState({ kind: "address", address: "0x0000000000000000000000000000000000000001" });
    expect(external).toMatchObject({ ok: false, error: { code: "unsupported", scope: "venue" } });
  });

  it("cancels all and resets to the fixture state (streams survive the reset)", async () => {
    const { adapter, states } = setup();
    const updates: Order[] = [];
    adapter.subscribeOrderUpdates({ kind: "simulated" }, (o) => updates.push(o));
    expect(await adapter.cancelAllOrders()).toMatchObject({ ok: true, value: 2 });
    expect(states.at(-1)!.openOrders).toHaveLength(0);
    adapter.reset();
    expect(states.at(-1)!.openOrders).toHaveLength(2);
    updates.length = 0;
    await adapter.cancelAllOrders();
    expect(updates.length).toBeGreaterThan(0);
  });
});
