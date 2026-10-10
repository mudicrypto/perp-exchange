import { connection, type NextRequest } from "next/server";
import { RfqAcceptSchema } from "@/core/rfq";
import { auditRfq } from "@/server/rfq/audit-log";
import { asRequester, deskResponse, parseBody } from "@/server/rfq/http";

/** Accepts one quote. The side is disclosed to the server now if it was not revealed before. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  const { id } = await ctx.params;
  return asRequester(
    request,
    async (desk, sessionId) => {
      const body = await parseBody(request, RfqAcceptSchema);
      if (!body.ok) return body.response;
      const result = desk.accept(sessionId, id, body.value);
      if (result.ok) auditRfq("rfq.accepted", { rfqId: id, status: result.value.status, quoteCount: result.value.quotes.length });
      return deskResponse(result);
    },
    { mutation: true },
  );
}
