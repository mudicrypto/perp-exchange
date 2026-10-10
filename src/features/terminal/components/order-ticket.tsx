"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Eye, LockKeyhole, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { EstimateHint, SummaryRow } from "@/components/trading/values";
import {
  ORDER_TYPE_CAPABILITY,
  OrderRequestSchema,
  isTriggerType,
  type CapabilityStatus,
  type Market,
  type MarketStats,
  type Order,
  type OrderRequest,
  type OrderType,
  type Result,
  type Side,
  type TimeInForce,
} from "@/core/domain";
import type { OrderBookView } from "@/core/market-data";
import { describeExecutionVisibility } from "@/core/private-execution";
import type { PreTradeRisk, RiskWarning } from "@/core/ports";
import { DefaultRiskEngine } from "@/core/risk";
import { checkRequestCapabilities } from "@/core/trading";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice, formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { newClientOrderId } from "../client-order-id";
import { useTerminal } from "../terminal-context";
import { ORDER_TYPE_LABEL } from "./order-labels";
import { OrderReviewDialog } from "./order-review-dialog";
import { PrivateExecutionDialog } from "./private-execution-dialog";

const riskEngine = new DefaultRiskEngine();
const SIZE_PRESETS = [0.25, 0.5, 0.75, 1] as const;
const MAX_SLIPPAGE = 0.05;


const TRIGGER_TYPES: readonly OrderType[] = ["stop-market", "take-profit-market", "stop-limit", "take-profit-limit"];
const ADVANCED_TYPES: readonly OrderType[] = ["iceberg", "hidden"];

/** How the ticket treats an order type, derived only from the capability status. */
export type TypeAvailability = "available" | "preview-only" | "unavailable";
export function availabilityOf(status: CapabilityStatus): TypeAvailability {
  if (status.status === "supported") return "available";
  // The venue offers it but Nova does not (yet): allow validation and risk preview, never submission.
  return status.scope === "nova" ? "preview-only" : "unavailable";
}

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


const hasLimitPrice = (type: OrderType) => !(type === "market" || type === "stop-market" || type === "take-profit-market");

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
  const instrument = useMemo(() => execution.describeInstrument(market), [execution, market]);
  const caps = capabilities.capabilities;
  const position = accountState?.snapshot.positions.find((p) => p.marketId === market.id) ?? null;

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [size, setSize] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [tif, setTif] = useState<TimeInForce>("gtc");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [leverageState, setLeverage] = useState(() => Math.min(10, market.maxLeverage));
  const [reviewing, setReviewing] = useState<OrderRequest | null>(null);
  const [result, setResult] = useState<Result<Order> | null>(null);

  const leverage = position && !reduceOnly ? position.leverage : leverageState;
  const leverageLocked = position !== null && !reduceOnly;
  const decimals = displayPriceDecimals(stats?.markPrice ?? book?.mid, market.priceDecimals);
  const typeStatus = caps[ORDER_TYPE_CAPABILITY[type]];
  const typeAvailability = availabilityOf(typeStatus);

  // ---- build the request the venue adapter will see
  const base = {
    clientOrderId: "draft",
    marketId: market.id,
    side,
    size: Number(size),
    reduceOnly,
    leverage,
    marginMode: "isolated" as const,
  };
  const priceValue = price === "" ? Number.NaN : Number(price);
  const triggerValue = triggerPrice === "" ? Number.NaN : Number(triggerPrice);
  const input: Record<string, unknown> = { ...base, type };
  if (hasLimitPrice(type)) Object.assign(input, { price: priceValue, timeInForce: tif });
  if (!hasLimitPrice(type)) input.maxSlippage = MAX_SLIPPAGE;
  if (isTriggerType(type)) input.triggerPrice = triggerValue;

  const touched = size !== "";
  const validation = touched ? execution.validateOrder(input, instrument, { referencePrice: stats?.markPrice }) : null;
  // A request can be well-formed but not submittable through Nova (preview-only types).
  const parsed = validation?.ok ? validation.value : touched ? (OrderRequestSchema.safeParse(input).data ?? null) : null;
  const risk: PreTradeRisk | null =
    parsed && !(validation && !validation.ok && validation.error.code === "validation")
      ? riskEngine.preTrade({ request: parsed, market, stats, book: book ? { bids: book.bids, asks: book.asks } : null, dataIsStale })
      : null;

  const submitBlocker = (() => {
    const submit = caps["action.submit"];
    if (submit.status !== "supported") return submit.reason;
    if (parsed) return checkRequestCapabilities(parsed, caps)?.message ?? null;
    return typeStatus.status === "supported" ? null : typeStatus.reason;
  })();
  const canSubmit = submitBlocker === null && validation?.ok === true;

  const disclosure = useMemo(() => describeExecutionVisibility(capabilities.visibility, null), [capabilities]);
  const reasonId = `${ids}-reason`;
  const simulated = capabilities.origin === "simulated";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    if (canSubmit && validation?.ok) setReviewing({ ...validation.value, clientOrderId: newClientOrderId() });
  };

  const confirm = async (request: OrderRequest) => {
    const outcome = await execution.submitOrder(request, instrument);
    setReviewing(null);
    setResult(outcome);
    if (outcome.ok) setSize("");
  };

  const sideLabel = side === "buy" ? "Buy / Long" : "Sell / Short";
  const issues = validation && !validation.ok && validation.error.code === "validation" ? validation.error.issues : [];
  const unsupportedMessage = validation && !validation.ok && validation.error.code === "unsupported" ? validation.error.message : null;

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
              side === s ? (s === "buy" ? "bg-buy text-black" : "bg-sell text-black") : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s === "buy" ? "Buy / Long" : "Sell / Short"}
          </button>
        ))}
      </div>

      <OrderTypePicker type={type} onChange={setType} />

      {isTriggerType(type) && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-trigger`} className="text-xs">Trigger price ({market.quote}, mark)</Label>
          <Input
            id={`${ids}-trigger`}
            data-testid="input-trigger"
            inputMode="decimal"
            autoComplete="off"
            className="tabular"
            placeholder={stats ? formatPrice(stats.markPrice, decimals).replaceAll(",", "") : "0.00"}
            value={triggerPrice}
            onChange={(e) => setTriggerPrice(e.target.value)}
          />
        </div>
      )}

      {hasLimitPrice(type) && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor={`${ids}-price`} className="text-xs">{isTriggerType(type) ? "Limit price" : "Price"} ({market.quote})</Label>
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

      <QuantityField
        id={`${ids}-size`}
        market={market}
        size={size}
        onSize={setSize}
        invalid={issues.some((i) => i.field === "size")}
        maxSize={(() => {
          const available = accountState?.snapshot.available ?? null;
          const ref = hasLimitPrice(type) && priceValue > 0 ? priceValue : isTriggerType(type) && triggerValue > 0 ? triggerValue : side === "buy" ? book?.bestAsk : book?.bestBid;
          return available !== null && ref ? floorTo(Math.max(0, (available * leverage) / (ref * (1 + leverage * 0.001))), market.sizeDecimals) : null;
        })()}
      />

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
        {leverageLocked && <p className="text-2xs text-muted-foreground">Locked to the open position&apos;s {position.leverage}x.</p>}
      </div>

      <div className="flex items-center justify-between gap-2">
        {hasLimitPrice(type) ? (
          <Select value={tif} onValueChange={(v) => setTif(v as TimeInForce)}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Time in force" data-testid="select-tif">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["gtc", "ioc", "post-only"] as const).map((value) => {
                const status = caps[`tif.${value}` as const];
                return (
                  <SelectItem key={value} value={value} disabled={availabilityOf(status) === "unavailable"}>
                    {{ gtc: "Good till cancel", ioc: "Immediate or cancel", "post-only": "Post only" }[value]}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-2xs text-muted-foreground">Max slippage {formatPercent(MAX_SLIPPAGE, 0)} from best price</span>
        )}
        <div className="flex items-center gap-1.5">
          <Checkbox
            id={`${ids}-ro`}
            checked={reduceOnly}
            onCheckedChange={(v) => setReduceOnly(v === true)}
            disabled={availabilityOf(caps["order.reduce-only"]) === "unavailable"}
            data-testid="reduce-only"
          />
          <Label htmlFor={`${ids}-ro`} className="text-xs font-normal">Reduce only</Label>
        </div>
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1 text-xs text-sell" data-testid="ticket-errors" role="alert">
          {issues.map((issue) => (
            <li key={`${issue.field}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      <section className="rounded-md border bg-background/40 p-2.5" aria-label="Risk preview" data-testid="risk-preview">
        <h3 className="mb-1 flex items-center justify-between text-xs font-semibold">
          Order preview
          <EstimateHint>
            Assumes an isolated position funded with exactly the initial margin. Market orders use visible book depth
            only; trigger orders use the trigger price. Excludes fees, funding and tiered margin requirements.
          </EstimateHint>
        </h3>
        {risk ? (
          <dl>
            <SummaryRow label={type === "market" ? "Est. avg fill" : isTriggerType(type) && !hasLimitPrice(type) ? "Trigger price" : "Limit price"}>
              {formatPrice(risk.referencePrice, decimals)}
            </SummaryRow>
            <SummaryRow label="Order value" testId="risk-notional">{formatAmount(risk.notional)} {market.quote}</SummaryRow>
            <SummaryRow label="Initial margin" testId="risk-margin">
              <span className="font-semibold">{formatAmount(risk.initialMargin)}</span> {market.quote}
            </SummaryRow>
            <SummaryRow label="Est. liquidation price" testId="risk-liq">
              <span className="font-semibold">{formatPrice(risk.estimatedLiquidationPrice, decimals)}</span>
            </SummaryRow>
            <SummaryRow label="Distance to liquidation">{formatPercent(risk.liquidationDistance, 2)}</SummaryRow>
            {risk.bookImpact && <SummaryRow label="Est. price impact" testId="risk-impact">{formatPercent(risk.bookImpact.priceImpact, 3)}</SummaryRow>}
            {accountState && <SummaryRow label="Available margin" testId="risk-available">{formatAmount(accountState.snapshot.available)} {market.quote}</SummaryRow>}
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
            Enter a quantity{hasLimitPrice(type) ? " and price" : ""}
            {isTriggerType(type) ? " and trigger price" : ""} to preview margin and liquidation risk.
          </p>
        )}
      </section>

      <section aria-label="Execution visibility" data-testid="execution-visibility" data-level={disclosure.level} className="flex items-start justify-between gap-2 rounded-md border p-2.5">
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
        {typeAvailability !== "available" && (
          <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-2xs text-warning" data-testid="type-unsupported" role="status">
            {ORDER_TYPE_LABEL[type]} orders: {typeStatus.status === "unsupported" ? typeStatus.reason : ""}
            {typeAvailability === "preview-only" ? " Preview only." : ""}
          </p>
        )}
        {unsupportedMessage && typeAvailability === "available" && <p className="text-2xs text-warning">{unsupportedMessage}</p>}
        <Button
          type="submit"
          className={cn("w-full font-semibold", canSubmit && (side === "buy" ? "bg-buy text-black hover:bg-buy/90" : "bg-sell text-black hover:bg-sell/90"))}
          disabled={!canSubmit}
          aria-describedby={reasonId}
          data-testid="submit-order"
        >
          {submitBlocker === null ? `Review ${sideLabel}` : sideLabel} {market.base}
        </Button>
        <p id={reasonId} className="text-center text-2xs text-muted-foreground" data-testid="submit-reason">
          {submitBlocker ?? (simulated ? "Simulated venue: matched locally against simulated data. Nothing is sent to a real venue." : "")}
        </p>
      </div>

      {reviewing && risk && (
        <OrderReviewDialog
          request={reviewing}
          market={market}
          risk={risk}
          disclosure={disclosure}
          simulated={simulated}
          onCancel={() => setReviewing(null)}
          onConfirm={() => confirm(reviewing)}
        />
      )}
    </form>
  );
}

function OrderTypePicker({ type, onChange }: { type: OrderType; onChange: (type: OrderType) => void }) {
  const { capabilities } = useTerminal();
  const caps = capabilities.capabilities;
  const option = (t: OrderType) => {
    const status = caps[ORDER_TYPE_CAPABILITY[t]];
    const availability = availabilityOf(status);
    return { t, availability, reason: status.status === "unsupported" ? status.reason : null };
  };
  const primary = (["limit", "market"] as const).map(option);
  const trigger = TRIGGER_TYPES.map(option);
  const advanced = ADVANCED_TYPES.map(option);
  const triggerActive = TRIGGER_TYPES.includes(type);

  return (
    <div className="grid gap-1.5">
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1" role="group" aria-label="Order type">
        {primary.map(({ t, availability, reason }) => (
          <button
            key={t}
            type="button"
            aria-pressed={type === t}
            disabled={availability === "unavailable"}
            title={reason ?? undefined}
            data-testid={`type-${t}`}
            data-availability={availability}
            onClick={() => onChange(t)}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
              type === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {ORDER_TYPE_LABEL[t]}
          </button>
        ))}
        <Select
          value={triggerActive ? type : ""}
          onValueChange={(v) => onChange(v as OrderType)}
        >
          <SelectTrigger
            size="sm"
            className={cn("h-7 border-0 px-2 text-xs shadow-none", triggerActive ? "bg-background" : "bg-transparent text-muted-foreground")}
            aria-label="Trigger order type"
            data-testid="type-trigger"
          >
            {/* Explicit children: show only the label, not the item's description. */}
            <SelectValue placeholder="Trigger">{triggerActive ? ORDER_TYPE_LABEL[type] : undefined}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {trigger.map(({ t, availability, reason }) => (
              <SelectItem key={t} value={t} disabled={availability === "unavailable"} data-testid={`type-option-${t}`} data-availability={availability}>
                <span className="flex flex-col">
                  <span>{ORDER_TYPE_LABEL[t]}{availability === "preview-only" ? " · preview only" : ""}</span>
                  {reason && availability !== "available" && <span className="max-w-60 text-2xs whitespace-normal text-muted-foreground">{reason}</span>}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <details className="text-2xs text-muted-foreground" data-testid="advanced-types">
        <summary className="cursor-pointer select-none hover:text-foreground">Other order types &amp; execution styles</summary>
        <ul className="mt-1 space-y-1">
          {advanced.map(({ t, availability, reason }) => (
            <li key={t} data-testid={`advanced-${t}`} data-availability={availability}>
              <span className="font-medium text-foreground">{ORDER_TYPE_LABEL[t]}:</span> {availability === "available" ? "supported" : reason}
            </li>
          ))}
          {(["execution.rfq", "order.twap"] as const).map((cap) => {
            const status = caps[cap];
            return (
              <li key={cap} data-testid={`advanced-${cap}`} data-availability={availabilityOf(status)}>
                <span className="font-medium text-foreground">{cap === "execution.rfq" ? "RFQ" : "TWAP"}:</span>{" "}
                {status.status === "supported" ? "supported" : status.reason}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

function QuantityField({
  id,
  market,
  size,
  onSize,
  invalid,
  maxSize,
}: {
  id: string;
  market: Market;
  size: string;
  onSize: (value: string) => void;
  invalid: boolean;
  maxSize: number | null;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs">Quantity ({market.base})</Label>
        {maxSize !== null && <span className="tabular text-2xs text-muted-foreground">Max ≈ {formatSize(maxSize, market.sizeDecimals)}</span>}
      </div>
      <Input id={id} data-testid="input-size" inputMode="decimal" autoComplete="off" className="tabular" placeholder="0" value={size} onChange={(e) => onSize(e.target.value)} aria-invalid={invalid} />
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
            onClick={() => maxSize !== null && onSize(String(floorTo(maxSize * fraction, market.sizeDecimals)))}
          >
            {fraction * 100}%
          </Button>
        ))}
      </div>
    </div>
  );
}

function SubmitResultBanner({ result, market, onDismiss }: { result: Result<Order>; market: Market; onDismiss: () => void }) {
  let tone: "ok" | "info" | "bad" = "bad";
  let text: string;
  if (!result.ok) {
    text = result.error.code === "unsupported" ? `Not supported: ${result.error.message}` : `Rejected: ${result.error.message}`;
  } else {
    const o = result.value;
    const prefix = o.origin === "simulated" ? "Simulated " : "";
    const decimals = displayPriceDecimals(o.averageFillPrice ?? o.price ?? o.triggerPrice, market.priceDecimals);
    const filled = formatSize(o.filledSize, market.sizeDecimals);
    const avg = formatPrice(o.averageFillPrice, decimals);
    switch (o.status) {
      case "filled":
        tone = "ok";
        text = `${prefix}fill: ${filled} ${market.base} @ ${avg}.`;
        break;
      case "open":
      case "partially-filled":
        tone = "info";
        text =
          o.filledSize > 0
            ? `${prefix}fill ${filled} ${market.base} @ ${avg}; rest is resting at ${formatPrice(o.price, decimals)}.`
            : `Order resting at ${formatPrice(o.price, decimals)}${o.origin === "simulated" ? " (simulated book)" : ""}.`;
        break;
      case "waiting-trigger":
        tone = "info";
        text = `${ORDER_TYPE_LABEL[o.type]} order waiting for trigger at ${formatPrice(o.triggerPrice, decimals)}${o.origin === "simulated" ? " (simulated mark)" : ""}.`;
        break;
      case "pending-new":
        tone = "info";
        text = "Order submitted; waiting for the venue to acknowledge.";
        break;
      default:
        tone = o.filledSize > 0 ? "info" : "bad";
        text = `${o.filledSize > 0 ? `${prefix}fill ${filled} ${market.base} @ ${avg}. ` : ""}${o.statusReason ?? o.status}.`;
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
