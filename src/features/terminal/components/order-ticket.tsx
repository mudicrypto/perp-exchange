"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Eye, LockKeyhole, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EstimateHint, SummaryRow } from "@/components/trading/values";
import type { Market, MarketStats, OrderIntent, OrderType, Side, TimeInForce } from "@/core/domain";
import { EXECUTION_DISABLED_MESSAGE, validateOrderIntent } from "@/core/execution";
import type { OrderBookView } from "@/core/market-data";
import { describeExecutionVisibility } from "@/core/private-execution";
import type { PreTradeRisk, RiskWarning, SubmitResult } from "@/core/ports";
import { DefaultRiskEngine } from "@/core/risk";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice, formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTerminal } from "../terminal-context";
import { OrderReviewDialog } from "./order-review-dialog";
import { PrivateExecutionDialog } from "./private-execution-dialog";

const riskEngine = new DefaultRiskEngine();
const SIZE_PRESETS = [0.25, 0.5, 0.75, 1] as const;

export function warningText(warning: RiskWarning): string {
  switch (warning.code) {
    case "exceeds-max-leverage":
      return `Leverage exceeds this market's maximum of ${warning.maxLeverage}x.`;
    case "exceeds-visible-depth":
      return "Order is larger than the visible order book; the fill price could be much worse.";
    case "high-price-impact":
      return `Estimated price impact is ${formatPercent(warning.impact, 2)}.`;
    case "liquidation-near":
      return `Estimated liquidation is only ${formatPercent(warning.distance, 2)} away.`;
    case "stale-market-data":
      return "Market data is stale or disconnected; estimates may be wrong.";
    case "limit-crosses-book":
      return "Limit price crosses the book and would execute immediately as a taker.";
  }
}

function floorTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

export interface OrderTicketProps {
  market: Market;
  stats: MarketStats | null;
  book: OrderBookView | null;
  dataIsStale: boolean;
  /** Limit price is lifted so the order book can fill it on click. */
  price: string;
  onPriceChange: (price: string) => void;
}

export function OrderTicket({ market, stats, book, dataIsStale, price, onPriceChange }: OrderTicketProps) {
  const { execution, capabilities, accountState } = useTerminal();
  const ids = useId();
  const position = accountState?.snapshot.positions.find((p) => p.marketId === market.id) ?? null;
  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [size, setSize] = useState("");
  const [tif, setTif] = useState<TimeInForce>("gtc");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverageState, setLeverage] = useState(() => Math.min(10, market.maxLeverage));
  const [reviewing, setReviewing] = useState<OrderIntent | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  // An open position fixes the leverage for this market (isolated margin).
  const leverage = position && !reduceOnly ? position.leverage : leverageState;
  const leverageLocked = position !== null && !reduceOnly;
  const paper = execution.mode === "paper";
  const decimals = displayPriceDecimals(stats?.markPrice ?? book?.mid, market.priceDecimals);

  const intentInput = {
    marketId: market.id,
    side,
    type,
    size: Number(size),
    limitPrice: type === "limit" ? (price === "" ? null : Number(price)) : null,
    timeInForce: type === "market" ? "ioc" : tif,
    reduceOnly,
    leverage,
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

  const referencePrice =
    type === "limit" && Number(price) > 0 ? Number(price) : side === "buy" ? book?.bestAsk ?? stats?.markPrice : book?.bestBid ?? stats?.markPrice;
  const available = accountState?.snapshot.available ?? null;
  const maxSize =
    available !== null && referencePrice
      ? floorTo(Math.max(0, (available * leverage) / (referencePrice * (1 + leverage * 0.001))), market.sizeDecimals)
      : null;

  const disclosure = useMemo(() => describeExecutionVisibility(capabilities, null), [capabilities]);
  const reasonId = `${ids}-reason`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    if (!paper || validation?.ok !== true) return;
    setReviewing(validation.intent);
  };

  const confirm = async (intent: OrderIntent) => {
    const outcome = await execution.submit(intent);
    setReviewing(null);
    setResult(outcome);
    if (outcome.ok) setSize("");
  };

  const sideLabel = side === "buy" ? "Buy / Long" : "Sell / Short";

  return (
    <form onSubmit={submit} className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="order-ticket" aria-label="Order entry">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1" role="group" aria-label="Side">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            data-testid={`side-${s}`}
            onClick={() => setSide(s)}
            className={cn(
              "rounded px-2 py-1.5 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
          <div className="flex items-center justify-between">
            <Label htmlFor={`${ids}-price`} className="text-xs">Price ({market.quote})</Label>
            {book?.mid != null && (
              <button
                type="button"
                className="text-2xs text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={() => onPriceChange(book.mid!.toFixed(market.priceDecimals))}
                data-testid="price-use-mid"
              >
                Use mid
              </button>
            )}
          </div>
          <Input
            id={`${ids}-price`}
            data-testid="input-price"
            inputMode="decimal"
            autoComplete="off"
            className="tabular"
            placeholder={stats ? formatPrice(stats.markPrice, decimals).replaceAll(",", "") : "0.00"}
            value={price}
            onChange={(e) => onPriceChange(e.target.value)}
          />
        </div>
      )}

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${ids}-size`} className="text-xs">Quantity ({market.base})</Label>
          {maxSize !== null && (
            <span className="tabular text-2xs text-muted-foreground">Max ≈ {formatSize(maxSize, market.sizeDecimals)}</span>
          )}
        </div>
        <Input
          id={`${ids}-size`}
          data-testid="input-size"
          inputMode="decimal"
          autoComplete="off"
          className="tabular"
          placeholder="0"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          aria-invalid={validation?.ok === false && validation.issues.some((i) => i.field === "size")}
        />
        <div className="grid grid-cols-4 gap-1" role="group" aria-label="Quantity presets">
          {SIZE_PRESETS.map((fraction) => (
            <Button
              key={fraction}
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 text-2xs"
              disabled={maxSize === null || maxSize <= 0}
              data-testid={`size-preset-${fraction * 100}`}
              onClick={() => maxSize !== null && setSize(String(floorTo(maxSize * fraction, market.sizeDecimals)))}
            >
              {fraction * 100}%
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${ids}-lev`} className="text-xs">Leverage (isolated)</Label>
          <span className="tabular text-xs font-semibold" data-testid="leverage-value">{leverage}x</span>
        </div>
        <Slider
          id={`${ids}-lev`}
          aria-label="Leverage"
          min={1}
          max={market.maxLeverage}
          step={1}
          value={[leverage]}
          disabled={leverageLocked}
          onValueChange={([v]) => v !== undefined && setLeverage(v)}
          data-testid="leverage-slider"
        />
        {leverageLocked && (
          <p className="text-2xs text-muted-foreground">Locked to the open position&apos;s {position.leverage}x.</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        {type === "limit" ? (
          <Select value={tif} onValueChange={(v) => setTif(v as TimeInForce)}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Time in force" data-testid="select-tif">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gtc">Good till cancel</SelectItem>
              <SelectItem value="ioc">Immediate or cancel</SelectItem>
              <SelectItem value="post-only">Post only</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-2xs text-muted-foreground">Max slippage 5% from best price</span>
        )}
        <div className="flex items-center gap-1.5">
          <Checkbox id={`${ids}-ro`} checked={reduceOnly} onCheckedChange={(v) => setReduceOnly(v === true)} data-testid="reduce-only" />
          <Label htmlFor={`${ids}-ro`} className="text-xs font-normal">Reduce only</Label>
        </div>
      </div>

      {validation?.ok === false && (
        <ul className="space-y-1 text-xs text-sell" data-testid="ticket-errors" role="alert">
          {validation.issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <section className="rounded-md border bg-background/40 p-2.5" aria-label="Risk preview" data-testid="risk-preview">
        <h3 className="mb-1 flex items-center justify-between text-xs font-semibold">
          Order preview
          <EstimateHint>
            Assumes an isolated position funded with exactly the initial margin. Market orders use visible book depth only.
            Excludes fees, funding and tiered margin requirements.
          </EstimateHint>
        </h3>
        {risk ? (
          <dl>
            <SummaryRow label={type === "market" ? "Est. avg fill" : "Limit price"}>{formatPrice(risk.referencePrice, decimals)}</SummaryRow>
            <SummaryRow label="Order value" testId="risk-notional">{formatAmount(risk.notional)} {market.quote}</SummaryRow>
            <SummaryRow label="Initial margin" testId="risk-margin">
              <span className="font-semibold">{formatAmount(risk.initialMargin)}</span> {market.quote}
            </SummaryRow>
            <SummaryRow label="Est. liquidation price" testId="risk-liq">
              <span className="font-semibold">{formatPrice(risk.estimatedLiquidationPrice, decimals)}</span>
            </SummaryRow>
            <SummaryRow label="Distance to liquidation">{formatPercent(risk.liquidationDistance, 2)}</SummaryRow>
            {risk.bookImpact && (
              <SummaryRow label="Est. price impact" testId="risk-impact">{formatPercent(risk.bookImpact.priceImpact, 3)}</SummaryRow>
            )}
            {available !== null && (
              <SummaryRow label="Available margin" testId="risk-available">{formatAmount(available)} {market.quote}</SummaryRow>
            )}
            {risk.warnings.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-xs text-warning" data-testid="risk-warnings">
                {risk.warnings.map((w) => (
                  <li key={w.code} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {warningText(w)}
                  </li>
                ))}
              </ul>
            )}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enter a quantity{type === "limit" ? " and price" : ""} to preview margin and liquidation risk.
          </p>
        )}
      </section>

      <section
        aria-label="Execution visibility"
        data-testid="execution-visibility"
        data-level={disclosure.level}
        className="flex items-start justify-between gap-2 rounded-md border p-2.5"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <Eye className="size-3.5" aria-hidden /> {disclosure.headline}
          </p>
          <p className="mt-0.5 text-2xs text-muted-foreground">{disclosure.details[0]}</p>
        </div>
        <PrivateExecutionDialog>
          <Button type="button" size="sm" variant="outline" className="shrink-0 border-private/40 text-private" data-testid="open-private-execution">
            <LockKeyhole aria-hidden /> Private
          </Button>
        </PrivateExecutionDialog>
      </section>

      <div className="mt-auto space-y-1.5">
        {result && <SubmitResultBanner result={result} market={market} onDismiss={() => setResult(null)} />}
        <Button
          type="submit"
          className={cn("w-full font-semibold", paper && (side === "buy" ? "bg-buy text-black hover:bg-buy/90" : "bg-sell text-black hover:bg-sell/90"))}
          disabled={!paper || validation?.ok !== true}
          aria-describedby={reasonId}
          data-testid="submit-order"
        >
          {paper ? `Review ${sideLabel}` : sideLabel} {market.base}
        </Button>
        <p id={reasonId} className="text-center text-2xs text-muted-foreground">
          {paper ? "Paper trading: matched locally against simulated data. Nothing is sent to a real venue." : EXECUTION_DISABLED_MESSAGE}
        </p>
      </div>

      {reviewing && risk && (
        <OrderReviewDialog
          intent={reviewing}
          market={market}
          risk={risk}
          disclosure={disclosure}
          onCancel={() => setReviewing(null)}
          onConfirm={() => confirm(reviewing)}
        />
      )}
    </form>
  );
}

function SubmitResultBanner({ result, market, onDismiss }: { result: SubmitResult; market: Market; onDismiss: () => void }) {
  const decimals = displayPriceDecimals(result.order?.averageFillPrice ?? result.order?.price, market.priceDecimals);
  let tone: "ok" | "info" | "bad" = "bad";
  let text: string;
  if (!result.ok) {
    text = `Rejected: ${result.message}`;
  } else {
    const o = result.order;
    const filled = formatSize(o.filledSize, market.sizeDecimals);
    const avg = formatPrice(o.averageFillPrice, decimals);
    if (o.status === "filled") {
      tone = "ok";
      text = `Simulated fill: ${filled} ${market.base} @ ${avg}.`;
    } else if (o.status === "open" || o.status === "partially-filled") {
      tone = "info";
      text =
        o.filledSize > 0
          ? `Simulated fill ${filled} ${market.base} @ ${avg}; rest is resting at ${formatPrice(o.price, decimals)}.`
          : `Order resting at ${formatPrice(o.price, decimals)} (simulated book).`;
    } else {
      tone = o.filledSize > 0 ? "info" : "bad";
      text = `${o.filledSize > 0 ? `Simulated fill ${filled} ${market.base} @ ${avg}. ` : ""}${o.statusReason ?? "Cancelled"}.`;
    }
  }
  const Icon = tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : AlertTriangle;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="submit-result"
      data-tone={tone}
      className={cn(
        "flex items-start gap-2 rounded-md border p-2 text-xs",
        tone === "ok" && "border-buy/40 bg-buy/10",
        tone === "info" && "border-primary/40 bg-primary/10",
        tone === "bad" && "border-sell/40 bg-sell/10",
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone === "ok" ? "text-buy" : tone === "bad" ? "text-sell" : "text-primary")} aria-hidden />
      <span className="flex-1">{text}</span>
      <button type="button" onClick={onDismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
