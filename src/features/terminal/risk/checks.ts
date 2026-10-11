import type { LimitCheck, PreTradeAssessment } from "@/core/risk";

/** Limit checks that did not pass, blocking ones first. */
export function failedChecks(assessment: PreTradeAssessment | null): LimitCheck[] {
  if (!assessment) return [];
  return assessment.checks.filter((c) => c.status !== "pass").sort((a, b) => (a.action === b.action ? 0 : a.action === "block" ? -1 : 1));
}
