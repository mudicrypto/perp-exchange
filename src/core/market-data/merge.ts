import type { MarketStats, MarketSummary } from "../domain";

/**
 * Returns whichever stats observation is newer. Used wherever a REST
 * snapshot and a websocket update can race: a slow snapshot must never
 * overwrite a newer streamed value.
 */
export function newerStats(current: MarketStats | null, incoming: MarketStats | null): MarketStats | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.observedAt >= current.observedAt ? incoming : current;
}

/**
 * Merges a refreshed market list into the previous one. Market metadata
 * comes from the refresh (markets can be added or delisted); stats keep the
 * newer observation per market.
 */
export function mergeMarketSummaries(
  previous: readonly MarketSummary[],
  next: readonly MarketSummary[],
): MarketSummary[] {
  const before = new Map(previous.map((s) => [s.market.id, s]));
  return next.map((summary) => ({
    market: summary.market,
    stats: newerStats(before.get(summary.market.id)?.stats ?? null, summary.stats),
  }));
}
