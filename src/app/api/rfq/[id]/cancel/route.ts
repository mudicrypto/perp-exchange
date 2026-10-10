import { connection, type NextRequest } from "next/server";
import { auditRfq } from "@/server/rfq/audit-log";
import { asRequester, deskResponse } from "@/server/rfq/http";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  const { id } = await ctx.params;
  return asRequester(
    request,
    (desk, sessionId) => {
      const result = desk.cancel(sessionId, id);
      if (result.ok) auditRfq("rfq.cancelled", { rfqId: id, status: result.value.status });
      return deskResponse(result);
    },
    { mutation: true },
  );
}
