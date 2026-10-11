import { connection } from "next/server";
import { MOCK_USERS } from "@/adapters/mock-accounts/mock-accounts";
import { errorResponse, jsonError } from "@/server/api-response";
import { getAnalystState } from "@/server/analyst/service";

/** Mock identities available for the demo sign-in (names only — no accounts or data). */
export async function GET(): Promise<Response> {
  await connection();
  try {
    if (!getAnalystState()) return jsonError(404, "not-found", "Not found.");
    return Response.json(MOCK_USERS.map(({ id, name }) => ({ id, name })), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
