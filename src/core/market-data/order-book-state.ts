import type { BookLevel, OrderBookSnapshot } from "../domain";

export interface OrderBookView {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  venueTime: number;
  receivedAt: number;
}

export type ApplyResult = "applied" | "ignored-out-of-order" | "ignored-wrong-market" | "rejected-crossed";

/**
 * Holds the latest order book for one market. Venues like Hyperliquid send
 * full snapshots, so ordering is enforced by venue timestamp: a snapshot
 * with an older (or equal) timestamp than the current one is dropped, which
 * also discards duplicates replayed after reconnects.
 */
export class OrderBookState {
  private view: OrderBookView | null = null;

  constructor(private readonly marketId: string) {}

  apply(snapshot: OrderBookSnapshot, receivedAt: number): ApplyResult {
    if (snapshot.marketId !== this.marketId) return "ignored-wrong-market";
    if (this.view && snapshot.venueTime <= this.view.venueTime) return "ignored-out-of-order";

    const bids = [...snapshot.bids].sort((a, b) => b.price - a.price);
    const asks = [...snapshot.asks].sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) return "rejected-crossed";

    this.view = {
      bids,
      asks,
      bestBid,
      bestAsk,
      mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      venueTime: snapshot.venueTime,
      receivedAt,
    };
    return "applied";
  }

  /** Forget the current book, e.g. after reconnect, so any fresh snapshot applies. */
  reset(): void {
    this.view = null;
  }

  current(): OrderBookView | null {
    return this.view;
  }
}

export interface DepthRow extends BookLevel {
  /** Cumulative size from best price to this level. */
  cumulative: number;
}

export function withCumulativeDepth(levels: readonly BookLevel[], limit: number): DepthRow[] {
  const rows: DepthRow[] = [];
  let cumulative = 0;
  for (const level of levels.slice(0, limit)) {
    cumulative += level.size;
    rows.push({ ...level, cumulative });
  }
  return rows;
}
