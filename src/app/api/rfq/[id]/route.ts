import { connection, type NextRequest } from "next/server";
import { asRequester, deskResponse } from "@/server/rfq/http";

/** Requester view of one RFQ; 404 for anyone but its requester. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  const { id } = await ctx.params;
  return asRequester(request, (desk, sessionId) => deskResponse(desk.getForRequester(sessionId, id)), { mutation: false });
}
