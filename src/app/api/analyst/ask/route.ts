import Anthropic from "@anthropic-ai/sdk";
import { connection, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { MarketIdSchema } from "@/core/domain";
import { askAnalyst, MAX_QUESTION_LENGTH } from "@/server/analyst/analyst";
import { allowQuestion, auditTool, getAnalystState, principalOf, sessionFromRequest, toolContext } from "@/server/analyst/service";
import { errorResponse, jsonError } from "@/server/api-response";
import { readJson } from "@/server/security/request";
import { sameOrigin } from "@/server/rfq/rfq-service";

const AskSchema = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
    accountId: z.string().min(1).max(64).nullable(),
    marketId: MarketIdSchema.nullable(),
  })
  .strict();

/**
 * Answers a question about the signed-in user's own accounts. Authorization is
 * enforced here (selected account) and again inside every tool call.
 */
export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  try {
    const state = getAnalystState();
    if (!state) return jsonError(404, "not-found", "Not found.");
    if (!sameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
    const current = sessionFromRequest(state, request);
    if (!current) return jsonError(401, "unauthenticated", "Sign in first.");
    const body = await readJson(request, AskSchema);
    if (!body.ok) return body.response;
    const principal = principalOf(current.session);
    if (body.value.accountId && !principal.accountIds.includes(body.value.accountId)) return jsonError(404, "not-found", "Account not found.");
    if (!allowQuestion(current.session)) return jsonError(429, "rate-limited", "Too many questions; wait a minute.");
    try {
      const answer = await askAnalyst(state.engine, toolContext(state, principal), { question: body.value.question, accountId: body.value.accountId, contextMarketId: body.value.marketId }, auditTool);
      return NextResponse.json(answer, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        console.warn(`Analyst model error (${error.status ?? "network"})`);
        return jsonError(503, "model-unavailable", "The AI model is unavailable right now. No answer was generated.");
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
