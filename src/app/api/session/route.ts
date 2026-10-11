import { connection, type NextRequest } from "next/server";
import { errorResponse, jsonError } from "@/server/api-response";
import { auditRfq } from "@/server/rfq/audit-log";
import { json } from "@/server/rfq/http";
import { limiters } from "@/server/security/limits";
import { clientKey, isHttps, rateLimited } from "@/server/security/request";
import { createSession, getRfqState, requesterSession, sameOrigin, SESSION_COOKIE } from "@/server/rfq/rfq-service";

/**
 * Issues an anonymous RFQ session: a random id in an HttpOnly, SameSite=Strict
 * cookie. No account, wallet or personal data is collected. Simulation only.
 */
export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  try {
    const state = getRfqState();
    if (!state) return jsonError(404, "not-found", "Not found.");
    if (!sameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
    if (requesterSession(state, request)) return json({ session: "active" });
    const limited = rateLimited(limiters().sessionCreate, clientKey(request));
    if (limited) return limited;
    const id = createSession(state);
    auditRfq("session.created");
    const response = json({ session: "created" }, 201);
    response.cookies.set(SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "strict",
      secure: isHttps(request),
      path: "/api",
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
