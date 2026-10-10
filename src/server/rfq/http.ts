import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import type { RfqDesk, RfqResult } from "@/core/rfq";
import { errorResponse, jsonError } from "../api-response";
import { auditRfq } from "./audit-log";
import { counterpartyFromRequest, getRfqState, requesterSession, sameOrigin } from "./rfq-service";

const MAX_BODY_BYTES = 4_096;
const NO_STORE = { "cache-control": "no-store" };

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const unavailable = () => jsonError(404, "not-found", "Not found.");

export async function parseBody<T>(request: NextRequest, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: jsonError(413, "too-large", "Request body too large.") };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError(400, "bad-request", "Body must be JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: jsonError(400, "bad-request", parsed.error.issues[0]?.message ?? "Invalid request.") };
  return { ok: true, value: parsed.data };
}

/** Maps desk results; "not-found" also covers "not yours" (no existence oracle). */
export function deskResponse<T>(result: RfqResult<T>, status = 200): Response {
  if (result.ok) return json(result.value, status);
  const code = { "not-found": 404, invalid: 400, closed: 409 }[result.error.code];
  return jsonError(code, result.error.code, result.error.message);
}

/**
 * Runs a handler for the requester identified by the session cookie.
 * Mutations additionally require a same-origin request.
 */
export async function asRequester(
  request: NextRequest,
  handler: (desk: RfqDesk, sessionId: string) => Promise<Response> | Response,
  options: { mutation: boolean },
): Promise<Response> {
  try {
    const state = getRfqState();
    if (!state) return unavailable();
    if (options.mutation && !sameOrigin(request)) {
      auditRfq("rfq.denied", { reason: "cross-origin", route: request.nextUrl.pathname.split("/").slice(0, 3).join("/") });
      return jsonError(403, "forbidden", "Cross-origin request refused.");
    }
    const sessionId = requesterSession(state, request);
    if (!sessionId) return jsonError(401, "unauthenticated", "Start a session first.");
    return await handler(state.desk, sessionId);
  } catch (error) {
    return errorResponse(error);
  }
}

/** Runs a handler for a counterparty authenticated by bearer token. */
export async function asCounterparty(request: NextRequest, handler: (desk: RfqDesk, counterpartyId: string) => Promise<Response> | Response): Promise<Response> {
  try {
    const state = getRfqState();
    if (!state) return unavailable();
    const counterpartyId = counterpartyFromRequest(request);
    if (!counterpartyId) {
      auditRfq("rfq.denied", { reason: "counterparty-auth" });
      return jsonError(401, "unauthenticated", "Counterparty credentials required.");
    }
    return await handler(state.desk, counterpartyId);
  } catch (error) {
    return errorResponse(error);
  }
}
