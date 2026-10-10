// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Panel } from "@/components/trading/panel";
import { STALE_AFTER_MS, streamStatus } from "@/core/market-data";
import type { OrderBookSnapshot } from "@/core/domain";
import type { ConnectionState, MarketDataSource, StreamHandlers } from "@/core/ports";
import { useConnectionState, useNow, useOrderBook } from "./use-market-data";

/** Minimal controllable source: tests push books and connection changes. */
function fakeSource() {
  let book: StreamHandlers<OrderBookSnapshot> | null = null;
  let connection: ((s: ConnectionState) => void) | null = null;
  const source = {
    subscribeOrderBook: (_: string, h: StreamHandlers<OrderBookSnapshot>) => {
      book = h;
      return () => (book = null);
    },
    subscribeConnection: (l: (s: ConnectionState) => void) => {
      connection = l;
      l({ status: "open", since: Date.now() });
      return () => (connection = null);
    },
  } as unknown as MarketDataSource;
  return {
    source,
    pushBook: (venueTime: number, bid = 100) =>
      book?.onData({
        marketId: "BTC-PERP",
        venueTime,
        bids: [{ price: bid, size: 1, orders: 1 }],
        asks: [{ price: bid + 1, size: 1, orders: 1 }],
      }),
    reset: () => book?.onReset?.(),
    reject: (message: string) => book?.onError?.(message),
    setConnection: (s: ConnectionState) => connection?.(s),
  };
}

function BookPanel({ source }: { source: MarketDataSource }) {
  const now = useNow(1_000);
  const connection = useConnectionState(source);
  const { view, lastUpdateAt, error } = useOrderBook(source, "BTC-PERP");
  const status = streamStatus({ connected: connection.status === "open", lastUpdateAt, now, staleAfterMs: STALE_AFTER_MS.book, error });
  return (
    <Panel title="Order book" testId="panel" stream={{ status, lastUpdateAt, now }}>
      <span data-testid="best-bid">{view?.bestBid ?? "none"}</span>
    </Panel>
  );
}

describe("stale-data indicators (hooks + Panel)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("goes waiting → live → stale → disconnected → live", () => {
    const fake = fakeSource();
    render(<BookPanel source={fake.source} />);
    const panel = screen.getByTestId("panel");
    expect(panel.dataset.streamStatus).toBe("waiting");
    expect(screen.getByTestId("stream-badge").textContent).toBe("Waiting for data");

    act(() => fake.pushBook(1));
    expect(panel.dataset.streamStatus).toBe("live");
    expect(screen.queryByTestId("stream-badge")).toBeNull();

    act(() => vi.advanceTimersByTime(STALE_AFTER_MS.book + 1_000));
    expect(panel.dataset.streamStatus).toBe("stale");
    expect(screen.getByTestId("stream-badge").textContent).toBe("Stale · 11s");

    act(() => fake.setConnection({ status: "reconnecting", attempt: 1, nextRetryAt: Date.now() + 500, reason: "drop" }));
    expect(panel.dataset.streamStatus).toBe("disconnected");
    expect(screen.getByTestId("stream-badge").textContent).toMatch(/^Disconnected · last \d+s ago$/);

    act(() => {
      fake.setConnection({ status: "open", since: Date.now() });
      fake.reset();
    });
    expect(panel.dataset.streamStatus).toBe("waiting");
    act(() => fake.pushBook(2));
    expect(panel.dataset.streamStatus).toBe("live");
  });

  it("never lets an older book replace a newer one", () => {
    const fake = fakeSource();
    render(<BookPanel source={fake.source} />);
    act(() => fake.pushBook(10, 200));
    act(() => fake.pushBook(5, 100));
    expect(screen.getByTestId("best-bid").textContent).toBe("200");
  });

  it("shows a venue rejection as an error", () => {
    const fake = fakeSource();
    render(<BookPanel source={fake.source} />);
    act(() => fake.reject("Invalid subscription"));
    expect(screen.getByTestId("panel").dataset.streamStatus).toBe("error");
  });
});
