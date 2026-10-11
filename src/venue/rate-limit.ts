/**
 * Deterministic sliding-window counter for the venue gateway. Time comes from
 * the caller (the gateway clock), so tests and replays are reproducible.
 * The number of tracked keys is bounded; the least recently used key is
 * dropped first.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 100_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    this.hits.delete(key);
    if (list.length) this.hits.set(key, list);
    return list;
  }

  /** Milliseconds until the key may act again, or 0 if it may act now. */
  blockedFor(key: string, now: number): number {
    const list = this.recent(key, now);
    return list.length >= this.limit ? list[0]! + this.windowMs - now : 0;
  }

  /** Records one event. Returns false (and records nothing) if the key is over its limit. */
  take(key: string, now: number): boolean {
    if (this.blockedFor(key, now) > 0) return false;
    this.record(key, now);
    return true;
  }

  record(key: string, now: number): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }
}
