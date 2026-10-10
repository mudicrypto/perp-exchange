"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { EstimateHint, SignedAmount, SummaryRow } from "@/components/trading/values";
import { DefaultRiskEngine } from "@/core/risk";
import { formatAmount, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTerminal } from "../terminal-context";

const riskEngine = new DefaultRiskEngine();

function NoAccount() {
  return (
    <p className="text-xs text-muted-foreground">
      No account connected. Balances are never shown without a real or clearly-labelled simulated account.
    </p>
  );
}

function Loading() {
  return (
    <div className="space-y-1.5" aria-busy="true">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

export function PortfolioSummary({ className }: { className?: string }) {
  const { account, accountState } = useTerminal();
  const s = accountState?.snapshot;
  return (
    <section aria-labelledby="portfolio-summary-title" className={className} data-testid="portfolio-summary">
      <h3 id="portfolio-summary-title" className="mb-1 flex items-center justify-between text-xs font-semibold">
        Portfolio
        {account.connection.status === "paper" && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">SIMULATED · {s?.currency ?? "SIMUSD"}</span>
        )}
      </h3>
      {account.connection.status === "disconnected" ? (
        <NoAccount />
      ) : !s ? (
        <Loading />
      ) : (
        <dl>
          <SummaryRow label="Equity" testId="summary-equity">
            <span className="text-sm font-semibold">{formatAmount(s.equity)}</span>
          </SummaryRow>
          <SummaryRow label="Available margin" testId="summary-available">{formatAmount(s.available)}</SummaryRow>
          <SummaryRow label="Margin in positions">{formatAmount(s.marginUsed)}</SummaryRow>
          <SummaryRow label="Margin in orders">{formatAmount(s.orderMargin)}</SummaryRow>
          <SummaryRow label="Unrealized PnL" testId="summary-upnl"><SignedAmount value={s.unrealizedPnl} /></SummaryRow>
          <SummaryRow label="Realized PnL" testId="summary-rpnl"><SignedAmount value={s.realizedPnl} /></SummaryRow>
          <SummaryRow label="Fees paid">{formatAmount(s.feesPaid)}</SummaryRow>
        </dl>
      )}
    </section>
  );
}

export function RiskSummary({ className }: { className?: string }) {
  const { account, accountState } = useTerminal();
  const s = accountState?.snapshot;
  const risk = s ? riskEngine.portfolio(s) : null;
  const utilisation = risk?.marginUtilization ?? null;
  return (
    <section aria-labelledby="risk-summary-title" className={className} data-testid="risk-summary">
      <h3 id="risk-summary-title" className="mb-1 flex items-center justify-between text-xs font-semibold">
        Risk
        <EstimateHint>
          Exposure uses current mark prices. Liquidation distances use the simulator&apos;s isolated-margin rule
          (base-tier maintenance margin). Figures change with prices and are not guarantees.
        </EstimateHint>
      </h3>
      {account.connection.status === "disconnected" ? (
        <NoAccount />
      ) : !risk || !s ? (
        <Loading />
      ) : (
        <dl>
          <SummaryRow label="Gross exposure" testId="risk-gross">{formatAmount(risk.grossExposure)}</SummaryRow>
          <SummaryRow label="Net exposure">
            <SignedAmount value={risk.netExposure} />
          </SummaryRow>
          <SummaryRow label="Long / short">
            {formatAmount(risk.longExposure, { compact: true })} / {formatAmount(risk.shortExposure, { compact: true })}
          </SummaryRow>
          <SummaryRow label="Effective leverage" testId="risk-leverage">
            {risk.effectiveLeverage === null ? "—" : `${risk.effectiveLeverage.toFixed(2)}x`}
          </SummaryRow>
          <SummaryRow label="Maintenance / equity">
            <span className={cn(utilisation !== null && utilisation > 0.5 && "text-warning", utilisation !== null && utilisation > 0.8 && "text-sell")}>
              {formatPercent(utilisation, 1)}
            </span>
          </SummaryRow>
          <SummaryRow label="Closest liquidation" testId="risk-closest-liq">
            {risk.closestLiquidation
              ? `${risk.closestLiquidation.marketId} · ${formatPercent(risk.closestLiquidation.distance, 1)} away`
              : "—"}
          </SummaryRow>
          {utilisation !== null && (
            <div className="mt-1.5" aria-hidden>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full", utilisation > 0.8 ? "bg-sell" : utilisation > 0.5 ? "bg-warning" : "bg-buy")}
                  style={{ width: `${Math.min(100, utilisation * 100)}%` }}
                />
              </div>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
