/** Default maximum age before a stream is considered stale (ms). */
export const DEFAULT_STALE_AFTER_MS = 15_000;

/**
 * Per-stream staleness thresholds. Snapshot-style streams (book, stats, mids)
 * are expected to update continuously on an active market; event-driven
 * streams (trades, candles) can legitimately be quiet, so they are only
 * stale when the connection is down.
 */
export const STALE_AFTER_MS = {
  book: 10_000,
  stats: 30_000,
  mids: 30_000,
  trades: null,
  candles: null,
} as const satisfies Record<string, number | null>;

export type Freshness = "fresh" | "stale" | "no-data";

export function freshness(
  lastUpdateAt: number | null,
  now: number,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): Freshness {
  if (lastUpdateAt === null) return "no-data";
  return now - lastUpdateAt > staleAfterMs ? "stale" : "fresh";
}

export type StreamStatus = "waiting" | "live" | "stale" | "disconnected" | "error";

export interface StreamStatusInput {
  connected: boolean;
  lastUpdateAt: number | null;
  now: number;
  /** null = event-driven stream (never stale while connected). */
  staleAfterMs: number | null;
  error?: string | null;
}

/**
 * Single source of truth for what a panel shows about its data:
 *  - error:        the venue rejected the stream
 *  - disconnected: connection is down (any data shown is from before)
 *  - waiting:      connected but nothing received yet
 *  - stale:        connected, but no update within the threshold
 *  - live:         receiving updates
 */
export function streamStatus({ connected, lastUpdateAt, now, staleAfterMs, error }: StreamStatusInput): StreamStatus {
  if (error) return "error";
  if (!connected) return "disconnected";
  if (lastUpdateAt === null) return "waiting";
  if (staleAfterMs !== null && now - lastUpdateAt > staleAfterMs) return "stale";
  return "live";
}

/** Maps a stream status to the coarse freshness used for styling. */
export function freshnessOf(status: StreamStatus): Freshness {
  if (status === "live") return "fresh";
  if (status === "waiting") return "no-data";
  return "stale";
}
