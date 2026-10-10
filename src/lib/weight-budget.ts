/**
 * Sliding-window request-weight budget (e.g. "600 weight per 60s").
 * Used server-side to keep venue REST usage below documented rate limits.
 */
export class WeightBudget {
  private readonly spent: { at: number; weight: number }[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Consumes `weight` if it fits in the window; returns false otherwise. */
  tryConsume(weight: number, now: number): boolean {
    this.evict(now);
    if (this.used(now) + weight > this.limit) return false;
    this.spent.push({ at: now, weight });
    return true;
  }

  used(now: number): number {
    this.evict(now);
    return this.spent.reduce((sum, entry) => sum + entry.weight, 0);
  }

  /** Milliseconds until at least `weight` is available again. */
  retryAfterMs(weight: number, now: number): number {
    this.evict(now);
    let available = this.limit - this.used(now);
    for (const entry of this.spent) {
      if (available >= weight) break;
      available += entry.weight;
      if (available >= weight) return Math.max(0, entry.at + this.windowMs - now);
    }
    return available >= weight ? 0 : this.windowMs;
  }

  private evict(now: number): void {
    while (this.spent.length > 0 && this.spent[0]!.at <= now - this.windowMs) this.spent.shift();
  }
}
