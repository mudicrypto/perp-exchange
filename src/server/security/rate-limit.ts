/**
 * Sliding-window rate limiter with a bounded number of tracked keys (the
 * least recently used key is evicted), so the limiter itself cannot be used
 * to exhaust memory. In-memory and per-process: a multi-instance deployment
 * needs a shared store (documented in docs/SECURITY.md).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {
    if (!(limit > 0 && windowMs > 0)) throw new RangeError("limit and windowMs must be positive");
  }

  /** Records a hit for `key` if allowed; otherwise returns how long to wait. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.delete(key);
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert to mark as most recently used
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return { ok: true };
  }

  /** True when `key` has used its whole window (without recording a hit). */
  isBlocked(key: string, now = Date.now()): boolean {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.limit;
  }

  get trackedKeys(): number {
    return this.hits.size;
  }
}

/** A session map that evicts the least recently seen entry instead of refusing new sessions when full. */
export class BoundedSessionMap<V extends { lastSeen: number }> {
  private readonly map = new Map<string, V>();

  constructor(
    private readonly maxEntries: number,
    private readonly idleMs: number,
  ) {}

  get(id: string, now = Date.now()): V | undefined {
    const value = this.map.get(id);
    if (!value) return undefined;
    if (now - value.lastSeen > this.idleMs) {
      this.map.delete(id);
      return undefined;
    }
    value.lastSeen = now;
    this.map.delete(id);
    this.map.set(id, value);
    return value;
  }

  set(id: string, value: V): void {
    this.map.delete(id);
    this.map.set(id, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  get size(): number {
    return this.map.size;
  }
}
