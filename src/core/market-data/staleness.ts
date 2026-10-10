/** Default maximum age before a stream is considered stale (ms). */
export const DEFAULT_STALE_AFTER_MS = 15_000;

export type Freshness = "fresh" | "stale" | "no-data";

export function freshness(
  lastUpdateAt: number | null,
  now: number,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): Freshness {
  if (lastUpdateAt === null) return "no-data";
  return now - lastUpdateAt > staleAfterMs ? "stale" : "fresh";
}
