"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SummaryRow } from "@/components/trading/values";
import { isTriggerType, requestTimeInForce, requestTriggerPrice, type Market, type OrderRequest } from "@/core/domain";
import type { PreTradeRisk } from "@/core/ports";
import type { ExecutionDisclosure } from "@/core/privacy";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice, formatSize } from "@/lib/format";
import { ORDER_TYPE_LABEL } from "./order-labels";

const TIF_LABEL = { gtc: "Good till cancel", ioc: "Immediate or cancel", "post-only": "Post only" } as const;

/** Explicit confirmation step before an order is sent to the execution adapter. */
export function OrderReviewDialog({
  request: intent,
  market,
  risk,
  disclosure,
  simulated,
  onConfirm,
  onCancel,
}: {
  request: OrderRequest;
  simulated: boolean;
  market: Market;
  risk: PreTradeRisk;
  disclosure: ExecutionDisclosure;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const decimals = displayPriceDecimals(risk.referencePrice, market.priceDecimals);
  const isBuy = intent.side === "buy";

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onCancel()}>
      <DialogContent data-testid="order-review">
        <DialogHeader>
          <DialogTitle>
            <span className={isBuy ? "text-buy" : "text-sell"}>{isBuy ? "Buy / Long" : "Sell / Short"}</span>{" "}
            {formatSize(intent.size, market.sizeDecimals)} {market.base}
          </DialogTitle>
          <DialogDescription className="flex items-start gap-1.5 text-warning">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {simulated
              ? `Simulated order. It is matched locally against the simulated order book using fictitious ${market.quote}. Nothing is sent to a real venue.`
              : "This order will be sent to the venue."}
          </DialogDescription>
        </DialogHeader>
        <dl className="rounded-md border p-3">
          <SummaryRow label="Market">{market.id}</SummaryRow>
          <SummaryRow label="Type">
            {ORDER_TYPE_LABEL[intent.type]}
            {requestTimeInForce(intent) ? ` · ${TIF_LABEL[requestTimeInForce(intent)!]}` : intent.type === "market" ? " (IOC)" : ""}
            {intent.reduceOnly ? " · Reduce only" : ""}
          </SummaryRow>
          {isTriggerType(intent.type) && (
            <SummaryRow label="Trigger price (mark)">{formatPrice(requestTriggerPrice(intent), decimals)}</SummaryRow>
          )}
          <SummaryRow label={intent.type === "market" ? "Est. avg fill" : "Reference price"}>{formatPrice(risk.referencePrice, decimals)}</SummaryRow>
          <SummaryRow label="Order value">{formatAmount(risk.notional)} {market.quote}</SummaryRow>
          <SummaryRow label="Leverage">{intent.leverage}x isolated</SummaryRow>
          <SummaryRow label="Initial margin">{formatAmount(risk.initialMargin)} {market.quote}</SummaryRow>
          <SummaryRow label="Est. liquidation price">
            {formatPrice(risk.estimatedLiquidationPrice, decimals)} ({formatPercent(risk.liquidationDistance, 2)} away)
          </SummaryRow>
          <SummaryRow label="Visibility">{disclosure.headline}</SummaryRow>
        </dl>
        {risk.warnings.length > 0 && (
          <p className="text-xs text-warning">{risk.warnings.length} risk warning(s) — see the order preview.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Back
          </Button>
          <Button
            data-testid="confirm-order"
            disabled={submitting}
            className={isBuy ? "bg-buy text-black hover:bg-buy/90" : "bg-sell text-black hover:bg-sell/90"}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onConfirm();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Submitting…" : simulated ? "Place simulated order" : "Place order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
