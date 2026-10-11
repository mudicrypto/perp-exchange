/** Maximum ages (ms) after which an input is treated as stale and dependent figures become unavailable. */
export interface FreshnessPolicy {
  markPriceMs: number;
  accountMs: number;
  fundingMs: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  markPriceMs: 15_000,
  accountMs: 30_000,
  fundingMs: 5 * 60_000,
};

/** A value together with when and where it was observed. */
export interface Observed<T> {
  value: T;
  observedAt: number;
  source: string;
}

export type Freshness = { fresh: true } | { fresh: false; reason: string };

export function checkFreshness(observedAt: number, now: number, maxAgeMs: number, what: string): Freshness {
  const age = now - observedAt;
  if (age < -1_000) return { fresh: false, reason: `${what} is timestamped in the future (${-age} ms ahead)` };
  if (age > maxAgeMs) return { fresh: false, reason: `${what} is stale (${Math.round(age / 1000)} s old; limit ${Math.round(maxAgeMs / 1000)} s)` };
  return { fresh: true };
}
