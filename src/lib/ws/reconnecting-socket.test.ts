import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "@/core/ports";
import { fakeSocketFactory } from "@/test/fake-socket";
import { ReconnectingSocket, backoffDelay } from "./reconnecting-socket";

describe("backoffDelay", () => {
  const options = { initialMs: 500, maxMs: 10_000, factor: 2, jitter: 0 };
  it("grows exponentially and caps at maxMs", () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, options, () => 0.5))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(20, options, () => 0.5)).toBe(10_000);
  });
  it("applies bounded jitter", () => {
    const jittered = { ...options, jitter: 0.5 };
    expect(backoffDelay(1, jittered, () => 0)).toBe(250);
    expect(backoffDelay(1, jittered, () => 1)).toBe(750);
  });
});

describe("ReconnectingSocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(heartbeat = false) {
    const sockets = fakeSocketFactory();
    const states: ConnectionState[] = [];
    const rs = new ReconnectingSocket({
      url: "wss://example.test/ws",
      createSocket: sockets.factory,
      random: () => 0.5,
      backoff: { initialMs: 100, maxMs: 1_000, factor: 2, jitter: 0 },
      heartbeat: heartbeat ? { intervalMs: 1_000, timeoutMs: 500, pingPayload: "ping" } : null,
    });
    rs.onState((s) => states.push(s));
    return { rs, sockets, states };
  }

  it("connects, reports open and runs open hooks", () => {
    const { rs, sockets, states } = setup();
    const onOpen = vi.fn();
    rs.onOpen(onOpen);
    rs.start();
    expect(states.at(-1)?.status).toBe("connecting");
    sockets.last.open();
    expect(states.at(-1)?.status).toBe("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("reconnects with backoff after an unexpected close", () => {
    const { rs, sockets, states } = setup();
    rs.start();
    sockets.last.open();
    sockets.last.serverClose(1006, "network");
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", attempt: 1, reason: "network" });
    expect(sockets.sockets).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(sockets.sockets).toHaveLength(2);
    // Second failure without opening backs off further.
    sockets.last.serverClose();
    vi.advanceTimersByTime(150);
    expect(sockets.sockets).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(sockets.sockets).toHaveLength(3);
  });

  it("does not reconnect after stop()", () => {
    const { rs, sockets, states } = setup();
    rs.start();
    sockets.last.open();
    rs.stop();
    expect(states.at(-1)?.status).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(sockets.sockets).toHaveLength(1);
  });

  it("only delivers string messages from the current socket", () => {
    const { rs, sockets } = setup();
    const onMessage = vi.fn();
    rs.onMessage(onMessage);
    rs.start();
    const first = sockets.last;
    first.open();
    first.receive("hello");
    first.serverClose();
    vi.advanceTimersByTime(100);
    first.onmessage?.({ data: "late message from old socket" });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith("hello");
  });

  it("send() refuses when not open", () => {
    const { rs, sockets } = setup();
    rs.start();
    expect(rs.send("x")).toBe(false);
    sockets.last.open();
    expect(rs.send("x")).toBe(true);
  });

  it("forces a reconnect when the heartbeat is not answered", () => {
    const { rs, sockets, states } = setup(true);
    rs.start();
    sockets.last.open();
    vi.advanceTimersByTime(1_000);
    expect(sockets.last.sent).toEqual(["ping"]);
    vi.advanceTimersByTime(500);
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", reason: "heartbeat timeout" });
    expect(sockets.sockets[0]!.closed).not.toBeNull();
  });

  it("keeps the connection when any message arrives after a ping", () => {
    const { rs, sockets, states } = setup(true);
    rs.start();
    sockets.last.open();
    vi.advanceTimersByTime(1_000);
    sockets.last.receive({ channel: "pong" });
    vi.advanceTimersByTime(600);
    expect(states.at(-1)?.status).toBe("open");
  });
});
