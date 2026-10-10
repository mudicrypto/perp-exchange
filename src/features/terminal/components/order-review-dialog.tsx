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
import type { Market, OrderIntent } from "@/core/domain";
import type { PreTradeRisk } from "@/core/ports";
import type { ExecutionDisclosure } from "@/core/private-execution";
import { displayPriceDecimals, formatAmount, formatPercent, formatPrice, formatSize } from "@/lib/format";

const TIF_LABEL = { gtc: "Good till cancel", ioc: "Immediate or cancel", "post-only": "Post only" } as const;

/** Explicit confirmation step before a (paper) order is sent to the venue adapter. */
export function OrderReviewDialog({
  intent,
  market,
  risk,
  disclosure,
  onConfirm,
  onCancel,
}: {
  intent: OrderIntent;
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
            Simulated paper order. It is matched locally against the simulated order book using fictitious{" "}
            {market.quote}. Nothing is sent to a real venue.
          </DialogDescription>
        </DialogHeader>
        <dl className="rounded-md border p-3">
          <SummaryRow label="Market">{market.id}</SummaryRow>
          <SummaryRow label="Type">
            {intent.type === "limit" ? `Limit · ${TIF_LABEL[intent.timeInForce]}` : "Market (IOC)"}
            {intent.reduceOnly ? " · Reduce only" : ""}
          </SummaryRow>
          <SummaryRow label={intent.type === "limit" ? "Limit price" : "Est. avg fill"}>{formatPrice(risk.referencePrice, decimals)}</SummaryRow>
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
            {submitting ? "Submitting…" : "Place paper order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
