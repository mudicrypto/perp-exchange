"use client";

import { useMemo } from "react";
import { DEFAULT_SCENARIO_MOVES, priceMoveScenarios, SCENARIO_ASSUMPTIONS, type PortfolioRiskReport, type RiskLimits, type RiskValue } from "@/core/risk";
import { formatPercent } from "@/lib/format";
import { useTerminal } from "../terminal-context";
import { CalculationDetails, RiskValueText } from "./risk-value";
import { usePortfolioRisk } from "./use-portfolio-risk";

const LIMIT_LABEL: Record<Exclude<keyof RiskLimits, "maxMarkAgeMs">, string> = {
  maxOrderNotional: "Max order notional",
  maxPositionNotional: "Max position notional (per instrument)",
  maxGrossExposure: "Max gross exposure",
  maxLeverage: "Max leverage",
  maxConcentration: "Max concentration (single instrument)",
  minLiquidationDistance: "Min distance to estimated liquidation",
  maxPriceDeviation: "Max limit-price deviation from mark",
};

/** Liquidation prices are already rounded to the market tick; show exactly those decimals. */
const tickDecimals = (v: RiskValue) => (v.status === "available" ? (v.value.split(".")[1]?.length ?? 0) : 2);

/** Detailed risk report: exposure by instrument, PnL components, scenarios and configured limits. */
export function RiskReport() {
  const report = usePortfolioRisk();
  const { risk } = useTerminal();
  if (!report) return <p className="p-3 text-xs text-muted-foreground">No account data.</p>;
  return (
    <div className="grid gap-4 p-3 lg:grid-cols-2" data-testid="risk-report">
      <ExposureTable report={report} />
      <PnlBreakdown report={report} />
      <Scenarios report={report} />
      <section aria-labelledby="limits-title">
        <h3 id="limits-title" className="mb-1 text-xs font-semibold">
          Pre-trade limits
        </h3>
        <p className="mb-1.5 text-2xs text-muted-foreground">
          Set on the server and enforced by the execution layer for every order. Amounts are in the account currency ({report.currency ?? "—"}).
        </p>
        <table className="w-full text-xs" data-testid="risk-limits">
          <tbody>
            {(Object.keys(LIMIT_LABEL) as (keyof typeof LIMIT_LABEL)[]).map((key) => {
              const limit = risk.limits[key];
              const isFraction = key === "maxConcentration" || key === "minLiquidationDistance" || key === "maxPriceDeviation";
              return (
                <tr key={key} className="border-b last:border-0" data-limit={key}>
                  <td className="py-1">{LIMIT_LABEL[key]}</td>
                  <td className="text-right tabular">{limit ? (isFraction ? formatPercent(Number(limit.value), 1) : key === "maxLeverage" ? `${limit.value}x` : limit.value) : "Not set"}</td>
                  <td className="pl-3 text-right text-muted-foreground">{limit ? (limit.action === "block" ? "Blocks" : "Warns") : ""}</td>
                </tr>
              );
            })}
            <tr>
              <td className="py-1">Max mark-price age</td>
              <td className="text-right tabular">{risk.limits.maxMarkAgeMs / 1000} s</td>
              <td className="pl-3 text-right text-muted-foreground">Blocks</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-1.5 text-2xs text-muted-foreground">Limits reduce some risks; they cannot prevent losses.</p>
      </section>
    </div>
  );
}

function ExposureTable({ report }: { report: PortfolioRiskReport }) {
  return (
    <section aria-labelledby="exposure-title">
      <h3 id="exposure-title" className="mb-1 text-xs font-semibold">
        Exposure by instrument
      </h3>
      {report.positions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No open positions.</p>
      ) : (
        <table className="w-full text-xs" data-testid="exposure-table">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">Instrument</th>
              <th className="font-medium">Direction</th>
              <th className="text-right font-medium">Notional</th>
              <th className="text-right font-medium">Share</th>
              <th className="text-right font-medium">Est. liquidation</th>
            </tr>
          </thead>
          <tbody>
            {report.exposure.byInstrument.map((e) => {
              const position = report.positions.find((p) => p.marketId === e.marketId)!;
              return (
                <tr key={e.marketId} className="border-b last:border-0" data-testid="exposure-row" data-market={e.marketId}>
                  <td className="py-1">{e.marketId}</td>
                  <td className={e.direction === "long" ? "text-buy" : "text-sell"}>{e.direction === "long" ? "Long" : "Short"}</td>
                  <td className="text-right">
                    <RiskValueText value={e.notional} />
                  </td>
                  <td className="text-right">
                    <RiskValueText value={e.share} />
                  </td>
                  <td className="text-right">
                    <RiskValueText value={position.liquidationPrice} priceDecimals={tickDecimals(position.liquidationPrice)} testId="exposure-liq" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 text-xs">
        <dt className="text-muted-foreground">Long / short</dt>
        <dd className="text-right">
          <RiskValueText value={report.exposure.long} /> / <RiskValueText value={report.exposure.short} />
        </dd>
        <dt className="text-muted-foreground">Concentration (HHI)</dt>
        <dd className="text-right">
          <RiskValueText value={report.concentration.hhi} testId="risk-hhi" plain />
        </dd>
      </dl>
      <p className="mt-1 text-2xs text-muted-foreground">Notional is exposure at the mark — not collateral and not a maximum loss.</p>
    </section>
  );
}

function PnlBreakdown({ report }: { report: PortfolioRiskReport }) {
  const rows = [
    { label: "Unrealised PnL", value: report.pnl.unrealized, testId: "risk-upnl" },
    { label: "Realised PnL (before fees)", value: report.pnl.realized, testId: "risk-rpnl" },
    { label: "Fees paid", value: report.pnl.fees, testId: "risk-fees" },
    { label: "Funding paid", value: report.pnl.fundingPaid, testId: "risk-funding-paid" },
    { label: "Projected funding, next interval", value: report.pnl.fundingNextInterval, testId: "risk-funding-next" },
    { label: "Collateral in use / equity", value: report.margin.initialUtilization, testId: "risk-initial-util" },
  ];
  return (
    <section aria-labelledby="pnl-title">
      <h3 id="pnl-title" className="mb-1 text-xs font-semibold">
        PnL, fees and funding
      </h3>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="text-right">
              <RiskValueText value={r.value} signed={r.value.unit.kind === "amount" && r.label !== "Fees paid"} testId={r.testId} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-1.5">
        <CalculationDetails testId="pnl-details" items={rows.map((r) => ({ label: r.label, value: r.value }))} />
      </div>
    </section>
  );
}

function Scenarios({ report }: { report: PortfolioRiskReport }) {
  const scenarios = useMemo(() => priceMoveScenarios(report, DEFAULT_SCENARIO_MOVES), [report]);
  return (
    <section aria-labelledby="scenarios-title">
      <h3 id="scenarios-title" className="mb-1 text-xs font-semibold">
        Hypothetical price moves (all marks at once)
      </h3>
      <table className="w-full text-xs" data-testid="scenario-table">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 font-medium">Move</th>
            <th className="text-right font-medium">PnL change</th>
            <th className="text-right font-medium">Equity after</th>
            <th className="pl-3 font-medium">Reaches liquidation estimate</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => {
            const reached = s.positions.filter((p) => p.reachesLiquidationEstimate === true).map((p) => p.marketId);
            const unknown = s.positions.filter((p) => p.reachesLiquidationEstimate === null).map((p) => p.marketId);
            return (
              <tr key={s.move} className="border-b last:border-0" data-testid="scenario-row" data-move={s.move}>
                <td className="py-1 tabular">{formatPercent(Number(s.move), 0, true)}</td>
                <td className="text-right">
                  <RiskValueText value={s.pnlChange} signed />
                </td>
                <td className="text-right">
                  <RiskValueText value={s.equityAfter} />
                </td>
                <td className="pl-3">
                  {reached.length > 0 ? <span className="text-sell">{reached.join(", ")}</span> : "None"}
                  {unknown.length > 0 && <span className="text-muted-foreground"> · unknown: {unknown.join(", ")}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground">
        {SCENARIO_ASSUMPTIONS.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </section>
  );
}
