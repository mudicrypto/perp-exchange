import type { Trade } from "../domain";

/**
 * Bounded, newest-first trade tape with de-duplication by trade id.
 * The seen-id set is bounded separately so memory stays constant while still
 * catching duplicates replayed on reconnect (venues often resend a batch of
 * recent trades when a subscription is re-established).
 */
export class TradeBuffer {
  private trades: Trade[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(
    private readonly capacity = 100,
    private readonly seenCapacity = 2_000,
  ) {}

  /** Adds trades; returns only the trades that were new. */
  add(incoming: readonly Trade[]): Trade[] {
    const fresh: Trade[] = [];
    for (const trade of incoming) {
      if (this.seen.has(trade.id)) continue;
      this.remember(trade.id);
      fresh.push(trade);
    }
    if (fresh.length === 0) return fresh;
    this.trades = [...fresh, ...this.trades]
      .sort((a, b) => b.venueTime - a.venueTime)
      .slice(0, this.capacity);
    return fresh;
  }

  list(): readonly Trade[] {
    return this.trades;
  }

  clear(): void {
    this.trades = [];
    this.seen.clear();
    this.seenOrder.length = 0;
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.seenCapacity) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}
