import { unitLabel, type RiskValue, type Unit } from "@/core/risk";

/**
 * - fact:         recorded data, or exact arithmetic on recorded data
 * - estimate:     depends on assumptions that may not hold (e.g. a liquidation estimate)
 * - hypothetical: a what-if scenario, not something that happened or will happen
 */
export type EvidenceKind = "fact" | "estimate" | "hypothetical";

export interface EvidenceItem {
  label: string;
  /** Exact decimal string (null when unavailable). */
  value: string | null;
  unit: string | null;
  /** Human-readable value with unit, e.g. "1,234.56 MOCKUSD". */
  display: string;
  kind: EvidenceKind;
  /** When the underlying data was observed (ms since epoch). */
  asOf: number | null;
  note?: string;
}

/** Everything one tool call returned. Rendered verbatim in the UI; the model only narrates it. */
export interface ToolEvidence {
  tool: string;
  title: string;
  accountId: string | null;
  /** Calculation time. */
  asOf: number;
  dataSource: string;
  items: EvidenceItem[];
  assumptions: string[];
  /** Figures that could not be given, with reasons. */
  unavailable: { label: string; reason: string }[];
}

export function formatDecimal(value: string, unit: Unit | null): string {
  const n = Number(value);
  if (!unit) return value;
  switch (unit.kind) {
    case "amount":
      return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit.asset}`;
    case "price":
      return `${value} ${unitLabel(unit)}`;
    case "quantity":
      return `${value} ${unit.asset}`;
    case "fraction":
      return `${(n * 100).toFixed(2)}%`;
    case "multiple":
      return `${n.toFixed(2)}x`;
    case "rate-per-interval":
      return `${(n * 100).toFixed(4)}% per ${unit.intervalHours}h`;
    case "fee-rate":
      return `${(n * 100).toFixed(4)}%`;
  }
}

export function item(label: string, value: string, unit: Unit | null, kind: EvidenceKind, asOf: number | null, note?: string): EvidenceItem {
  return { label, value, unit: unit ? unitLabel(unit) : null, display: formatDecimal(value, unit), kind, asOf, ...(note ? { note } : {}) };
}

/** Maps a risk value: calculated/venue-reported → fact; estimate → estimate (or hypothetical when forced). */
export function fromRiskValue(label: string, v: RiskValue, collect: ToolEvidence, kindOverride?: EvidenceKind): void {
  if (v.status === "unavailable") {
    collect.unavailable.push({ label, reason: v.reason });
    return;
  }
  const kind: EvidenceKind = kindOverride ?? (v.kind === "estimate" ? "estimate" : "fact");
  const observed = v.inputs.map((i) => i.observedAt).filter((t): t is number => t !== null);
  collect.items.push(item(label, v.value, v.unit, kind, observed.length ? Math.min(...observed) : v.asOf));
  for (const a of v.assumptions) if (!collect.assumptions.includes(a)) collect.assumptions.push(a);
}
