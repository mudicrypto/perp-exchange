"use client";

import { unitLabel, type RiskInput, type RiskValue } from "@/core/risk";
import { formatAmount, formatPercent, formatPrice, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Display text for a risk value. Decimal strings are converted to numbers for formatting only. */
export function formatRiskValue(value: RiskValue, options: { priceDecimals?: number; signed?: boolean } = {}): string {
  if (value.status === "unavailable") return "Unavailable";
  const n = Number(value.value);
  switch (value.unit.kind) {
    case "price":
      return formatPrice(n, options.priceDecimals ?? 2);
    case "amount":
      return `${formatAmount(n, { signed: options.signed })} ${value.unit.asset}`;
    case "fraction":
      return formatPercent(n, 2, options.signed);
    case "multiple":
      return `${n.toFixed(2)}x`;
    case "quantity":
      return `${value.value} ${value.unit.asset}`;
    case "rate-per-interval":
      return `${formatPercent(n, 4)} / ${value.unit.intervalHours}h`;
    case "fee-rate":
      return formatPercent(n, 4);
  }
}

const KIND_LABEL = { calculated: null, estimate: "est.", "venue-reported": "venue" } as const;

/** A value with a small provenance tag; unavailable values show their reason on hover and to screen readers. */
export function RiskValueText({
  value,
  priceDecimals,
  signed,
  plain,
  testId,
  className,
}: {
  value: RiskValue;
  priceDecimals?: number;
  signed?: boolean;
  /** Show a dimensionless value as a number (e.g. an index) instead of a percentage. */
  plain?: boolean;
  testId?: string;
  className?: string;
}) {
  if (value.status === "unavailable") {
    return (
      <span className={cn("text-muted-foreground", className)} title={value.reason} data-testid={testId} data-status="unavailable">
        Unavailable<span className="sr-only">: {value.reason}</span>
      </span>
    );
  }
  const tag = KIND_LABEL[value.kind];
  const n = Number(value.value);
  return (
    <span
      className={cn("tabular", signed && n > 0 && "text-buy", signed && n < 0 && "text-sell", className)}
      data-testid={testId}
      data-status="available"
      data-kind={value.kind}
      data-value={value.value}
    >
      {plain ? n.toFixed(4) : formatRiskValue(value, { priceDecimals, signed })}
      {tag && <span className="ml-1 text-2xs text-muted-foreground uppercase">{tag}</span>}
    </span>
  );
}

function inputLine(input: RiskInput, now: number): string {
  const unit = input.unit ? ` ${unitLabel(input.unit)}` : "";
  const age = input.observedAt === null ? "" : `, observed ${formatTime(input.observedAt)} (${Math.max(0, Math.round((now - input.observedAt) / 1000))} s before calculation)`;
  return `${input.name}: ${input.value}${unit} — ${input.source}${age}`;
}

/**
 * Lists how each figure was obtained: method, inputs with their sources and
 * timestamps, assumptions, or the reason it is unavailable.
 */
export function CalculationDetails({ items, testId, title = "Calculation details" }: { items: { label: string; value: RiskValue }[]; testId?: string; title?: string }) {
  return (
    <details className="text-2xs text-muted-foreground" data-testid={testId}>
      <summary className="cursor-pointer select-none hover:text-foreground">{title}</summary>
      <dl className="mt-1.5 space-y-2">
        {items.map(({ label, value }) => (
          <div key={label}>
            <dt className="font-medium text-foreground">
              {label}{" "}
              <span className="font-normal text-muted-foreground">
                ({value.status === "available" ? `${value.kind}, ${unitLabel(value.unit)}` : "unavailable"}, as of {formatTime(value.asOf)})
              </span>
            </dt>
            {value.status === "available" ? (
              <dd>
                <p>Method: {value.method}</p>
                {value.inputs.length > 0 && (
                  <ul className="list-disc pl-4">
                    {dedupe(value.inputs).map((i) => (
                      <li key={`${i.name}:${i.value}:${i.source}`}>{inputLine(i, value.asOf)}</li>
                    ))}
                  </ul>
                )}
                {value.assumptions.length > 0 && (
                  <ul className="list-disc pl-4 text-warning/90">
                    {value.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
              </dd>
            ) : (
              <dd>
                {value.reason}
                {value.missing.length > 0 ? ` (missing: ${value.missing.join(", ")})` : ""}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </details>
  );
}

function dedupe(inputs: RiskInput[]): RiskInput[] {
  const seen = new Set<string>();
  return inputs.filter((i) => {
    const key = `${i.name}:${i.value}:${i.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
