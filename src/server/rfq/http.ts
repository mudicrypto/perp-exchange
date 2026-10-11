import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import type { RfqDesk, RfqResult } from "@/core/rfq";
import { errorResponse, jsonError } from "../api-response";
import { auditRfq } from "./audit-log";
import { limiters, pick } from "../security/limits";
import { clientKey, rateLimited, readJson } from "../security/request";
import { counterpartyFromRequest, getRfqState, requesterSession, sameOrigin } from "./rfq-service";

const MAX_BODY_BYTES = 4_096;
const NO_STORE = { "cache-control": "no-store" };

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const unavailable = () => jsonError(404, "not-found", "Not found.");

/** Size-capped JSON body parsing (never buffers more than MAX_BODY_BYTES). */
export function parseBody<T>(request: NextRequest, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  return readJson(request, schema, MAX_BODY_BYTES);
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
    if (options.mutation) {
      const limited = rateLimited(limiters().rfqMutation, sessionId);
      if (limited) return limited;
    }
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
    // Brute-force guard: a client with too many failed attempts is refused before any token check.
    const client = clientKey(request);
    const failures = limiters().counterpartyAuthFailure;
    if (pick(failures, client).isBlocked(client)) return rateLimited(failures, client)!;
    const counterpartyId = counterpartyFromRequest(request);
    if (!counterpartyId) {
      pick(failures, client).take(client);
      auditRfq("rfq.denied", { reason: "counterparty-auth" });
      return jsonError(401, "unauthenticated", "Counterparty credentials required.");
    }
    return await handler(state.desk, counterpartyId);
  } catch (error) {
    return errorResponse(error);
  }
}
