import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { OrderStatus, Side } from "@/core/domain";
import { formatAmount, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Signed amount coloured by sign (PnL, funding, changes). */
export function SignedAmount({
  value,
  decimals = 2,
  suffix,
  className,
  testId,
}: {
  value: number | null | undefined;
  decimals?: number;
  suffix?: string;
  className?: string;
  testId?: string;
}) {
  const tone = value === null || value === undefined || Math.abs(value) < 0.5 * 10 ** -decimals ? "" : value > 0 ? "text-buy" : "text-sell";
  return (
    <span data-testid={testId} className={cn("tabular", tone, className)}>
      {formatAmount(value, { decimals, signed: true })}
      {suffix && <span className="ml-0.5 text-muted-foreground">{suffix}</span>}
    </span>
  );
}

export function SignedPercent({ value, decimals = 2, className }: { value: number | null | undefined; decimals?: number; className?: string }) {
  const tone = value === null || value === undefined || value === 0 ? "" : value > 0 ? "text-buy" : "text-sell";
  return <span className={cn("tabular", tone, className)}>{formatPercent(value, decimals, true)}</span>;
}

export function SideLabel({ side, position = false }: { side: Side; position?: boolean }) {
  const label = position ? (side === "buy" ? "Long" : "Short") : side === "buy" ? "Buy" : "Sell";
  return <span className={cn("font-medium", side === "buy" ? "text-buy" : "text-sell")}>{label}</span>;
}

const STATUS_STYLE: Record<OrderStatus, string> = {
  draft: "text-muted-foreground",
  "pending-submit": "text-muted-foreground",
  open: "text-primary",
  "partially-filled": "text-primary",
  filled: "text-buy",
  "cancel-pending": "text-muted-foreground",
  cancelled: "text-muted-foreground",
  rejected: "text-sell",
  unknown: "text-warning",
};

export function OrderStatusLabel({ status }: { status: OrderStatus }) {
  return <span className={cn("capitalize", STATUS_STYLE[status])}>{status.replace("-", " ")}</span>;
}

/** Marks a number as an estimate and explains how it was derived. */
export function EstimateHint({ children, label = "Estimate" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-sm text-2xs font-medium text-warning uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={`${label}: how this is calculated`}
        >
          {label} <Info className="size-3" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs leading-snug">{children}</TooltipContent>
    </Tooltip>
  );
}

/** Label/value pair used in headers and summaries. */
export function Stat({
  label,
  children,
  className,
  testId,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <span className="text-2xs whitespace-nowrap text-muted-foreground uppercase">{label}</span>
      <span data-testid={testId} className="tabular truncate text-xs font-medium">
        {children}
      </span>
    </div>
  );
}

/** Row in a definition-style summary list. */
export function SummaryRow({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="tabular text-right">
        {children}
      </dd>
    </div>
  );
}
