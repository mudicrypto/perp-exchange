import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Market, MarketStats } from "@/core/domain";
import { formatPercent } from "@/lib/format";
import { EmptyState } from "./panel";

const NO_ACCOUNT =
  "No account is connected. Read-only account monitoring arrives in the next milestone. Nova will never ask for your seed phrase or private key.";

/**
 * Positions / orders / account / risk tabs. In Milestone 1 no account data
 * source exists, so these render explicit empty states — never placeholder
 * balances.
 */
export function AccountPanels({ market, stats }: { market: Market; stats: MarketStats | null }) {
  return (
    <Tabs defaultValue="positions" className="flex h-full flex-col gap-0" data-testid="account-panels">
      <div className="border-b px-2 py-1">
        <TabsList className="h-8">
          <TabsTrigger value="positions" className="text-xs">Positions</TabsTrigger>
          <TabsTrigger value="orders" className="text-xs">Open orders</TabsTrigger>
          <TabsTrigger value="account" className="text-xs">Account</TabsTrigger>
          <TabsTrigger value="risk" className="text-xs">Market risk</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="positions" className="min-h-0 flex-1">
        <EmptyState title="No positions to show">{NO_ACCOUNT}</EmptyState>
      </TabsContent>
      <TabsContent value="orders" className="min-h-0 flex-1">
        <EmptyState title="No open orders">{NO_ACCOUNT}</EmptyState>
      </TabsContent>
      <TabsContent value="account" className="min-h-0 flex-1">
        <EmptyState title="Account not connected">{NO_ACCOUNT}</EmptyState>
      </TabsContent>
      <TabsContent value="risk" className="min-h-0 flex-1 overflow-y-auto p-3">
        <MarketRiskFacts market={market} stats={stats} />
      </TabsContent>
    </Tabs>
  );
}

function MarketRiskFacts({ market, stats }: { market: Market; stats: MarketStats | null }) {
  const annualizedFunding = stats ? stats.fundingRate * (24 / stats.fundingIntervalHours) * 365 : null;
  const basis =
    stats?.oraclePrice ? (stats.markPrice - stats.oraclePrice) / stats.oraclePrice : null;
  const facts: [string, string][] = [
    ["Max leverage", `${market.maxLeverage}x`],
    ["Initial margin at max leverage", formatPercent(1 / market.maxLeverage, 2)],
    ["Maintenance margin rate (base tier)", formatPercent(market.maintenanceMarginRate, 2)],
    ["Margin modes", market.isolatedOnly ? "Isolated only" : "Cross and isolated"],
    ["Funding (annualised, current rate)", formatPercent(annualizedFunding, 2, true)],
    ["Mark vs oracle basis", formatPercent(basis, 3, true)],
  ];
  return (
    <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-xs" data-testid="market-risk-facts">
      {facts.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
