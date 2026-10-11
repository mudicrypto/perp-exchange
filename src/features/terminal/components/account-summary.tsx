"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { EstimateHint, SignedAmount, SummaryRow } from "@/components/trading/values";
import { dec, isAvailable, type AvailableValue } from "@/core/risk";
import { formatAmount, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTerminal } from "../terminal-context";
import { CalculationDetails, RiskValueText } from "../risk/risk-value";
import { usePortfolioRisk } from "../risk/use-portfolio-risk";

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
  const { account } = useTerminal();
  const report = usePortfolioRisk();
  const utilisation = report && isAvailable(report.margin.maintenanceUtilization) ? Number(report.margin.maintenanceUtilization.value) : null;
  const closest = report?.positions
    .filter((p) => isAvailable(p.liquidationDistance))
    .sort((a, b) => dec((a.liquidationDistance as AvailableValue).value).cmp(dec((b.liquidationDistance as AvailableValue).value)))[0];
  return (
    <section aria-labelledby="risk-summary-title" className={className} data-testid="risk-summary">
      <h3 id="risk-summary-title" className="mb-1 flex items-center justify-between text-xs font-semibold">
        Risk
        <EstimateHint>
          Exposure is notional at current mark prices — not collateral and not a maximum loss. Liquidation figures use
          {report?.venueName ? ` ${report.venueName}` : " the venue's"} rules and are estimates, not guarantees.
        </EstimateHint>
      </h3>
      {account.connection.status === "disconnected" ? (
        <NoAccount />
      ) : !report ? (
        <Loading />
      ) : (
        <>
          <dl>
            <SummaryRow label="Gross exposure" testId="risk-gross">
              <RiskValueText value={report.exposure.gross} />
            </SummaryRow>
            <SummaryRow label="Net exposure">
              <RiskValueText value={report.exposure.net} signed />
            </SummaryRow>
            <SummaryRow label="Effective leverage" testId="risk-leverage">
              <RiskValueText value={report.margin.effectiveLeverage} />
            </SummaryRow>
            <SummaryRow label="Maintenance / equity" testId="risk-maintenance">
              <span className={cn(utilisation !== null && utilisation > 0.5 && "text-warning", utilisation !== null && utilisation > 0.8 && "text-sell")}>
                <RiskValueText value={report.margin.maintenanceUtilization} />
              </span>
            </SummaryRow>
            <SummaryRow label="Largest concentration" testId="risk-concentration">
              {report.concentration.largestMarketId ? `${report.concentration.largestMarketId} · ` : ""}
              <RiskValueText value={report.concentration.largestShare} />
            </SummaryRow>
            <SummaryRow label="Closest liquidation" testId="risk-closest-liq">
              {closest ? `${closest.marketId} · ${formatPercent(Number((closest.liquidationDistance as AvailableValue).value), 1)} away (estimate)` : report.positions.length === 0 ? "No positions" : "Unavailable"}
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
          <div className="mt-1.5">
            <CalculationDetails
              testId="risk-summary-details"
              items={[
                { label: "Gross exposure", value: report.exposure.gross },
                { label: "Net exposure", value: report.exposure.net },
                { label: "Effective leverage", value: report.margin.effectiveLeverage },
                { label: "Maintenance margin", value: report.margin.maintenanceMargin },
                { label: "Maintenance / equity", value: report.margin.maintenanceUtilization },
              ]}
            />
          </div>
        </>
      )}
    </section>
  );
}
