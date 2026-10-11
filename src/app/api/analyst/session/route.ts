import { connection, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "@/server/api-response";
import { ANALYST_COOKIE, accountsOf, getAnalystState, sessionFromRequest, signIn } from "@/server/analyst/service";
import { sameOrigin } from "@/server/rfq/rfq-service";
import { parseBody } from "@/server/rfq/http";

const NO_STORE = { "cache-control": "no-store" };
const SignInSchema = z.object({ userId: z.string().min(1).max(64) }).strict();

/** Current mock identity and the accounts it may read. */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  try {
    const state = getAnalystState();
    if (!state) return jsonError(404, "not-found", "Not found.");
    const current = sessionFromRequest(state, request);
    if (!current) return jsonError(401, "unauthenticated", "Not signed in.");
    const { user } = current.session;
    return NextResponse.json({ user: { id: user.id, name: user.name }, accounts: accountsOf(user) }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Mock sign-in (demo only): binds an HttpOnly session to one mock user. */
export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  try {
    const state = getAnalystState();
    if (!state) return jsonError(404, "not-found", "Not found.");
    if (!sameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
    const body = await parseBody(request, SignInSchema);
    if (!body.ok) return body.response;
    const created = signIn(state, body.value.userId);
    if (!created) return jsonError(400, "bad-request", "Unknown mock user.");
    const response = NextResponse.json({ user: { id: created.user.id, name: created.user.name }, accounts: accountsOf(created.user) }, { status: 201, headers: NO_STORE });
    response.cookies.set(ANALYST_COOKIE, created.id, { httpOnly: true, sameSite: "strict", secure: request.nextUrl.protocol === "https:", path: "/api/analyst" });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  await connection();
  try {
    const state = getAnalystState();
    if (!state) return jsonError(404, "not-found", "Not found.");
    if (!sameOrigin(request)) return jsonError(403, "forbidden", "Cross-origin request refused.");
    const current = sessionFromRequest(state, request);
    if (current) state.sessions.delete(current.id);
    const response = new NextResponse(null, { status: 204 });
    response.cookies.delete({ name: ANALYST_COOKIE, path: "/api/analyst" });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
