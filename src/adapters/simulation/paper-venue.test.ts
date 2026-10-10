import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, AccountState } from "@/core/ports";
import { PaperVenue } from "./paper-venue";
import { SimulatedMarketDataSource } from "./simulated-market-data-source";

const NOW = 1_700_000_000_000;

describe("PaperVenue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const venue = new PaperVenue(source, () => NOW);
    const states: AccountState[] = [];
    venue.subscribeAccount((s) => s && states.push(s));
    return { source, venue, states };
  }

  it("declares paper mode and a simulated account", () => {
    const { venue } = setup();
    expect(venue.mode).toBe("paper");
    expect(venue.connection).toMatchObject({ status: "paper" });
  });

  it("emits the seeded demo account and marks positions from the simulated feed", async () => {
    const { states } = setup();
    expect(states[0]!.snapshot.positions.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    const latest = states.at(-1)!;
    expect(latest.snapshot.positions.every((p) => p.markPrice !== null)).toBe(true);
  });

  it("executes a market order against the simulated book", async () => {
    const { venue } = setup();
    vi.advanceTimersByTime(100);
    const result = await venue.submit({
      marketId: "GAMMA-PERP",
      side: "buy",
      type: "market",
      size: 100,
      limitPrice: null,
      timeInForce: "ioc",
      reduceOnly: false,
      leverage: 3,
      marginMode: "isolated",
    });
    expect(result.ok && result.order.status).toBe("filled");
  });

  it("pauses order entry while the feed is disconnected and resumes after recovery", async () => {
    const { source, venue } = setup();
    const connection: ConnectionState[] = [];
    source.subscribeConnection((s) => connection.push(s));
    vi.advanceTimersByTime(100);
    source.simulateOutage(1_000);
    expect(connection.at(-1)?.status).toBe("reconnecting");
    const intent = {
      marketId: "GAMMA-PERP" as const,
      side: "buy" as const,
      type: "market" as const,
      size: 100,
      limitPrice: null,
      timeInForce: "ioc" as const,
      reduceOnly: false,
      leverage: 3,
      marginMode: "isolated" as const,
    };
    expect(await venue.submit(intent)).toMatchObject({ ok: false, code: "feed-unavailable" });
    vi.advanceTimersByTime(1_000);
    expect(connection.at(-1)?.status).toBe("open");
    vi.advanceTimersByTime(100);
    expect((await venue.submit(intent)).ok).toBe(true);
  });

  it("cancels orders and resets to the fixture state", async () => {
    const { venue, states } = setup();
    expect(await venue.cancelAll()).toBe(2);
    expect(states.at(-1)!.openOrders).toHaveLength(0);
    venue.reset();
    expect(states.at(-1)!.openOrders).toHaveLength(2);
  });
});

describe("SimulatedMarketDataSource demo controls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops streaming during an outage and signals resets on recovery", () => {
    const source = new SimulatedMarketDataSource({ now: () => NOW, tickMs: 100 });
    const onData = vi.fn();
    const onReset = vi.fn();
    source.subscribeOrderBook("ALPHA-PERP", { onData, onReset });
    source.simulateOutage(500);
    vi.advanceTimersByTime(400);
    expect(onData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalled();
    source.dispose();
  });

  it("fails the next candle request once", async () => {
    const source = new SimulatedMarketDataSource({ now: () => NOW });
    source.failNextCandleRequest();
    await expect(source.getCandles("ALPHA-PERP", "1m")).rejects.toThrow(/Simulated/);
    await expect(source.getCandles("ALPHA-PERP", "1m")).resolves.toHaveLength(300);
  });
});
