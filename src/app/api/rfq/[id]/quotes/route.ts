import { connection, type NextRequest } from "next/server";
import { RfqQuoteInputSchema } from "@/core/rfq";
import { auditRfq } from "@/server/rfq/audit-log";
import { asCounterparty, deskResponse, parseBody } from "@/server/rfq/http";

/** A selected counterparty quotes; any other caller gets 404. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  await connection();
  const { id } = await ctx.params;
  return asCounterparty(request, async (desk, counterpartyId) => {
    const body = await parseBody(request, RfqQuoteInputSchema);
    if (!body.ok) return body.response;
    const result = desk.quote(counterpartyId, id, body.value);
    auditRfq(result.ok ? "rfq.quoted" : "rfq.denied", { rfqId: id, reason: result.ok ? undefined : result.error.code });
    return deskResponse(result, 201);
  });
}
