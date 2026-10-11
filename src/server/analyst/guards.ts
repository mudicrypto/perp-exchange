import type { ToolEvidence } from "./evidence";

const ORDER_ACTION =
  /\b(?:(?:please|pls)\s+)?(?:(?:can|could|would|will)\s+you\s+|go\s+ahead\s+and\s+|i\s+want\s+you\s+to\s+)?(?:buy|sell|short|long|close|cancel|place|submit|modify|amend|open|flatten|liquidate|hedge)\b(?=[^.?!]*\b(?:order|orders|position|positions|my|\d|alpha|beta|gamma|perp|all)\b)/i;

/**
 * Detects requests to act on orders. The analyst is read-only; this check runs
 * before any model is called so such requests are never interpreted as tasks.
 * Questions *about* activity ("why did my close fill at…") are not matched
 * unless phrased as an instruction.
 */
export function isOrderInstruction(question: string): boolean {
  const q = question.trim();
  if (/^(why|what|how|when|which|who|did|was|were|is|are|show|summari[sz]e|explain|list)\b/i.test(q)) return false;
  return ORDER_ACTION.test(q);
}

export const ORDER_REFUSAL =
  "I can't place, cancel or modify orders — the analyst only reads your account data. Use the order ticket on the Trade page if you want to trade. I can explain your positions, fees, funding, exposure or a hypothetical scenario instead.";

// Affirmative guarantees only ("not a guarantee" is a disclaimer, not a promise).
const GUARANTEE = /\b(guaranteed|guarantees? (?:you |a |an )?(?:profit|return|gain)s?|risk[- ]free|sure profit|can(?:not|'t) lose|will (?:definitely|certainly|surely) (?:rise|fall|go up|go down|profit|make)|certain to (?:rise|fall|profit))\b/i;

export function containsGuaranteeLanguage(text: string): boolean {
  return GUARANTEE.test(text);
}

/** Numbers that appear in text, excluding dates, times and ISO timestamps. */
export function extractNumbers(text: string): string[] {
  const stripped = text
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b[A-Z]{2,}-PERP\b/g, " ")
    .replace(/\b\d+(?:h|d)\b/g, " ");
  return [...stripped.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")).filter((n) => n !== "" && n !== "-");
}

function decimalsOf(n: string): number {
  return n.split(".")[1]?.length ?? 0;
}

/**
 * Figures in the model's answer that match no verified value (tool evidence,
 * the user's own question). A figure matches if it equals a verified value
 * rounded to the figure's precision, as a magnitude, or as a percentage of a
 * fraction. Small integers (≤ 10) are ignored: they are usually counts or list markers.
 */
export function unverifiedNumbers(answer: string, evidence: readonly ToolEvidence[], question: string): string[] {
  const verified: number[] = [];
  const add = (s: string | null | undefined) => {
    if (!s) return;
    for (const n of extractNumbers(s)) {
      const v = Number(n);
      if (Number.isFinite(v)) verified.push(v, Math.abs(v), v * 100, Math.abs(v * 100));
    }
  };
  for (const e of evidence) {
    for (const i of e.items) {
      add(i.value);
      add(i.display);
      add(i.label);
      add(i.note);
    }
    for (const a of e.assumptions) add(a);
    add(e.title);
  }
  add(question);
  const out: string[] = [];
  for (const n of extractNumbers(answer)) {
    const v = Number(n);
    if (!Number.isFinite(v) || (Number.isInteger(v) && Math.abs(v) <= 10)) continue;
    const tolerance = 0.5 * 10 ** -decimalsOf(n) + 1e-12;
    if (!verified.some((x) => Math.abs(Math.abs(x) - Math.abs(v)) <= tolerance)) out.push(n);
  }
  return [...new Set(out)];
}

export const ANALYST_DISCLAIMER =
  "AI-generated explanation of fictitious mock account data. Figures come from the verified tool results shown with each answer. Not financial advice: scenarios are hypothetical, estimates are not guarantees, and nothing here predicts profit.";
