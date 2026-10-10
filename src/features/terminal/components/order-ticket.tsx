"use client";

import { useId, useMemo, useState } from "react";
import { Eye, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Market, MarketStats, OrderType, Side } from "@/core/domain";
import { EXECUTION_DISABLED_MESSAGE, validateOrderIntent } from "@/core/execution";
import type { OrderBookView } from "@/core/market-data";
import { describeExecutionVisibility } from "@/core/private-execution";
import { DefaultRiskEngine } from "@/core/risk";
import type { PreTradeRisk, RiskWarning, VenueExecutionCapabilities } from "@/core/ports";
import { displayPriceDecimals, formatPercent, formatPrice, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const riskEngine = new DefaultRiskEngine();

function warningText(warning: RiskWarning): string {
  switch (warning.code) {
    case "exceeds-max-leverage":
      return `Leverage exceeds this market's maximum of ${warning.maxLeverage}x.`;
    case "exceeds-visible-depth":
      return "Order is larger than the visible order book; actual fill price could be much worse.";
    case "high-price-impact":
      return `Estimated price impact is ${formatPercent(warning.impact, 2)}.`;
    case "liquidation-near":
      return `Estimated liquidation is only ${formatPercent(warning.distance, 2)} away.`;
    case "stale-market-data":
      return "Market data is stale; estimates may be wrong.";
    case "limit-crosses-book":
      return "Limit price crosses the book and would execute immediately as a taker.";
  }
}

function Row({ label, value, testId, emphasis }: { label: string; value: string; testId?: string; emphasis?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span data-testid={testId} className={cn("tabular", emphasis && "font-semibold")}>
        {value}
      </span>
    </div>
  );
}

export function OrderTicket({
  market,
  stats,
  book,
  dataIsStale,
  capabilities,
}: {
  market: Market;
  stats: MarketStats | null;
  book: OrderBookView | null;
  dataIsStale: boolean;
  capabilities: VenueExecutionCapabilities;
}) {
  const ids = useId();
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [leverage, setLeverage] = useState(() => String(Math.min(5, market.maxLeverage)));

  const intentInput = {
    marketId: market.id,
    side,
    type,
    size: Number(size),
    limitPrice: type === "limit" ? (price === "" ? null : Number(price)) : null,
    timeInForce: type === "market" ? "ioc" : "gtc",
    reduceOnly: false,
    leverage: Number(leverage),
    marginMode: "isolated",
  } as const;

  const touched = size !== "";
  const validation = touched ? validateOrderIntent(intentInput, market) : null;
  const risk: PreTradeRisk | null =
    validation?.ok === true
      ? riskEngine.preTrade({
          intent: validation.intent,
          market,
          stats,
          book: book ? { bids: book.bids, asks: book.asks } : null,
          dataIsStale,
        })
      : null;

  const disclosure = useMemo(() => describeExecutionVisibility(capabilities, null), [capabilities]);
  const decimals = displayPriceDecimals(stats?.markPrice, market.priceDecimals);
  const reasonId = `${ids}-disabled-reason`;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="order-ticket">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label="Side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            data-testid={`side-${s}`}
            onClick={() => setSide(s)}
            className={cn(
              "rounded px-2 py-1.5 text-sm font-semibold capitalize transition-colors",
              side === s
                ? s === "buy"
                  ? "bg-buy text-black"
                  : "bg-sell text-black"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "buy" ? "Buy / Long" : "Sell / Short"}
          </button>
        ))}
      </div>

      <Tabs value={type} onValueChange={(v) => setType(v as OrderType)}>
        <TabsList className="w-full">
          <TabsTrigger value="limit" data-testid="type-limit">Limit</TabsTrigger>
          <TabsTrigger value="market" data-testid="type-market">Market</TabsTrigger>
        </TabsList>
      </Tabs>

      {type === "limit" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-price`} className="text-xs">Limit price ({market.quote})</Label>
          <Input
            id={`${ids}-price`}
            data-testid="input-price"
            inputMode="decimal"
            placeholder={stats ? formatPrice(stats.markPrice, decimals).replaceAll(",", "") : "0.00"}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-size`} className="text-xs">Size ({market.base})</Label>
        <Input
          id={`${ids}-size`}
          data-testid="input-size"
          inputMode="decimal"
          placeholder="0"
          value={size}
          onChange={(e) => setSize(e.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-lev`} className="text-xs">
          Leverage (isolated) — max {market.maxLeverage}x
        </Label>
        <div className="flex items-center gap-2">
          <input
            id={`${ids}-lev`}
            type="range"
            min={1}
            max={market.maxLeverage}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
            className="flex-1 accent-primary"
            aria-label="Leverage"
          />
          <Input
            data-testid="input-leverage"
            aria-label="Leverage value"
            className="w-16"
            inputMode="numeric"
            value={leverage}
            onChange={(e) => setLeverage(e.target.value)}
          />
        </div>
      </div>

      {validation?.ok === false && (
        <ul className="space-y-1 text-xs text-sell" data-testid="ticket-errors">
          {validation.issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <section className="space-y-1.5 rounded-md border p-2.5" aria-label="Risk preview" data-testid="risk-preview">
        <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
          <ShieldAlert className="size-3.5" aria-hidden /> Risk preview <span className="font-normal text-muted-foreground">(estimate)</span>
        </h3>
        {risk ? (
          <>
            <Row label={type === "market" ? "Est. avg fill" : "Limit price"} value={formatPrice(risk.referencePrice, decimals)} />
            <Row label="Notional" testId="risk-notional" value={formatUsd(risk.notional)} />
            <Row label="Initial margin" testId="risk-margin" value={formatUsd(risk.initialMargin)} emphasis />
            <Row label="Est. liquidation price" testId="risk-liq" value={formatPrice(risk.estimatedLiquidationPrice, decimals)} emphasis />
            <Row label="Distance to liquidation" value={formatPercent(risk.liquidationDistance, 2)} />
            <Row label="Maintenance margin rate" value={formatPercent(risk.maintenanceMarginRate, 2)} />
            {risk.bookImpact && (
              <>
                <Row label="Price impact" testId="risk-impact" value={formatPercent(risk.bookImpact.priceImpact, 3)} />
                <Row label="Book levels used" value={String(risk.bookImpact.levelsConsumed)} />
              </>
            )}
            {risk.warnings.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-xs text-warning" data-testid="risk-warnings">
                {risk.warnings.map((w) => (
                  <li key={w.code}>⚠ {warningText(w)}</li>
                ))}
              </ul>
            )}
            <p className="pt-1 text-[10px] leading-snug text-muted-foreground">
              Assumes an isolated position funded with exactly the initial margin. Excludes fees, funding and tiered margin requirements.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Enter a size{type === "limit" ? " and price" : ""} to preview margin and liquidation risk.</p>
        )}
      </section>

      <section
        aria-label="Execution visibility"
        data-testid="execution-visibility"
        data-level={disclosure.level}
        className="space-y-1 rounded-md border p-2.5"
      >
        <h3 className="flex items-center gap-1.5 text-xs font-semibold">
          {disclosure.level === "public" ? <Eye className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
          {disclosure.headline}
        </h3>
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
          {disclosure.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </section>

      <div className="mt-auto space-y-1.5">
        <Button
          className="w-full"
          disabled
          aria-describedby={reasonId}
          data-testid="submit-order"
        >
          {side === "buy" ? "Buy / Long" : "Sell / Short"} {market.base}
        </Button>
        <p id={reasonId} className="text-center text-[11px] text-muted-foreground">
          {EXECUTION_DISABLED_MESSAGE}
        </p>
      </div>
    </div>
  );
}
