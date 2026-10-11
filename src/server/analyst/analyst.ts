import type { AnalystEngine, AnalystRequest } from "./engine";
import type { ToolEvidence } from "./evidence";
import type { ToolAuditEntry } from "./executor";
import { ANALYST_DISCLAIMER, containsGuaranteeLanguage, isOrderInstruction, ORDER_REFUSAL, unverifiedNumbers } from "./guards";
import { authorize, AuthorizationError } from "./principal";
import type { ToolContext } from "./tools";

export interface AnalystAnswer {
  answer: string;
  engine: AnalystEngine["name"];
  engineLabel: string;
  /** Verified tool results. The UI renders these as the authoritative figures. */
  evidence: ToolEvidence[];
  /** Tool calls that were refused or failed (e.g. not authorized). */
  toolErrors: { tool: string; error: string; message: string }[];
  warnings: string[];
  refused: boolean;
  disclaimer: string;
  asOf: number;
}

export const MAX_QUESTION_LENGTH = 500;

/**
 * Answers one question. Order instructions are refused before any engine runs;
 * the selected account is authorized up front (tools authorize again per call);
 * the answer is checked for figures that match no verified data and for
 * guarantee language.
 */
export async function askAnalyst(engine: AnalystEngine, ctx: ToolContext, request: AnalystRequest, audit: (e: ToolAuditEntry) => void = () => {}): Promise<AnalystAnswer> {
  const base = { engine: engine.name, engineLabel: engine.label, disclaimer: ANALYST_DISCLAIMER, asOf: ctx.now };
  const question = request.question.trim().slice(0, MAX_QUESTION_LENGTH);
  if (isOrderInstruction(question)) {
    return { ...base, answer: ORDER_REFUSAL, evidence: [], toolErrors: [], warnings: [], refused: true };
  }
  if (request.accountId) {
    try {
      authorize(ctx.principal, request.accountId);
    } catch (error) {
      if (error instanceof AuthorizationError) return { ...base, answer: "You are not authorized to read that account.", evidence: [], toolErrors: [], warnings: [], refused: true };
      throw error;
    }
  }

  const result = await engine.answer(ctx, { ...request, question }, audit);
  const warnings: string[] = [];
  const unverified = unverifiedNumbers(result.text, result.evidence, question);
  if (unverified.length) {
    warnings.push(`The written answer contains figures that do not match the verified data (${unverified.join(", ")}). Rely on the verified figures shown below.`);
  }
  if (containsGuaranteeLanguage(result.text)) {
    warnings.push("The written answer uses language that sounds like a guarantee. Nothing here guarantees a price move or a profit.");
  }
  if (result.toolErrors.some((e) => e.error === "not-authorized")) {
    warnings.push("A request for data outside your authorized accounts was refused; no such data was read.");
  }
  if (result.evidence.some((e) => e.unavailable.length > 0)) {
    warnings.push("Some figures are unavailable; they are listed with the reason instead of being estimated.");
  }
  return { ...base, answer: result.text, evidence: result.evidence, toolErrors: result.toolErrors, warnings, refused: Boolean(result.declined) };
}
