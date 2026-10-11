"use client";

import { useMemo } from "react";
import type { Market, MarketId } from "@/core/domain";
import { assessPortfolio, type FundingObservation, type Observed, type PortfolioRiskReport } from "@/core/risk";
import { useNow } from "../hooks/use-market-data";
import { useTerminal } from "../terminal-context";

/**
 * Portfolio risk for the active account, recomputed each second and on
 * every account update. Marks come from the execution venue's own state;
 * market summaries fill in marks and funding where the venue has none.
 */
export function usePortfolioRisk(): PortfolioRiskReport | null {
  const { accountState, risk, markets, execution } = useTerminal();
  const tick = useNow(1_000);
  return useMemo(() => {
    if (!accountState) return null;
    const snapshot = accountState.snapshot;
    const now = Math.max(tick, snapshot.observedAt);
    const venue = risk.snapshot(snapshot.positions[0]?.marketId ?? "");
    const marketMap = new Map<MarketId, Market>(markets.map((m) => [m.market.id, m.market]));
    const marks = new Map(venue.marks);
    const funding = new Map<MarketId, Observed<FundingObservation>>();
    for (const { market, stats } of markets) {
      if (!stats) continue;
      if (!marks.has(market.id)) marks.set(market.id, { value: stats.markPrice, observedAt: stats.observedAt, source: "market summary" });
      funding.set(market.id, {
        value: { rate: stats.fundingRate, intervalHours: stats.fundingIntervalHours, oraclePrice: stats.oraclePrice },
        observedAt: stats.observedAt,
        source: "market summary",
      });
    }
    return assessPortfolio({
      now,
      venue: risk.rules,
      account: { value: snapshot, observedAt: snapshot.observedAt, source: execution.origin === "simulated" ? "simulated paper account" : "venue account" },
      markets: marketMap,
      marks,
      funding,
      fills: accountState.fills ? { value: accountState.fills, observedAt: snapshot.observedAt, source: execution.origin === "simulated" ? "simulated fill history (complete since reset)" : "venue fills" } : null,
    });
  }, [accountState, risk, markets, execution, tick]);
}
