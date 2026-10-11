"use client";

import { Panel } from "@/components/trading/panel";
import { PortfolioSummary, RiskSummary } from "./components/account-summary";
import { AccountTables } from "./components/account-tables";
import { RiskReport } from "./risk/risk-report";
import { useTerminal } from "./terminal-context";

/** Account-level view: summaries plus full-width activity tables. */
export function PortfolioView() {
  const { account } = useTerminal();
  return (
    <main id="main" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5" data-testid="portfolio-page">
      <div className="flex items-baseline justify-between px-1.5 pt-1">
        <h1 className="text-lg font-semibold">Portfolio</h1>
        <p className="text-xs text-muted-foreground">
          {account.connection.status === "paper"
            ? `${account.connection.label} · resets when the page is reloaded`
            : "No account connected"}
        </p>
      </div>
      <div className="grid gap-1.5 md:grid-cols-2">
        <Panel title="Balances & PnL">
          <PortfolioSummary className="p-3" />
        </Panel>
        <Panel title="Risk">
          <RiskSummary className="p-3" />
        </Panel>
      </div>
      <Panel title="Risk report" className="shrink-0">
        <RiskReport />
      </Panel>
      <Panel title="Activity" className="min-h-[420px] flex-1">
        <AccountTables />
      </Panel>
    </main>
  );
}
