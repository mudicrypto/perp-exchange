import { connection, type NextRequest } from "next/server";
import { RfqCreateSchema } from "@/core/rfq";
import { jsonError } from "@/server/api-response";
import { auditRfq } from "@/server/rfq/audit-log";
import { asRequester, deskResponse, json, parseBody } from "@/server/rfq/http";
import { MAX_OPEN_RFQS_PER_SESSION } from "@/server/rfq/rfq-service";

/** The caller's own RFQs (requester view). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return asRequester(request, (desk, sessionId) => json(desk.listForRequester(sessionId)), { mutation: false });
}

/** Sends a request to the selected counterparties. The limit price is never accepted here. */
export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  return asRequester(
    request,
    async (desk, sessionId) => {
      const body = await parseBody(request, RfqCreateSchema);
      if (!body.ok) return body.response;
      if (desk.listForRequester(sessionId).filter((r) => r.status === "open").length >= MAX_OPEN_RFQS_PER_SESSION) {
        return jsonError(429, "too-many", "Too many open requests.");
      }
      const result = desk.create(sessionId, body.value);
      if (result.ok) auditRfq("rfq.created", { rfqId: result.value.id, counterpartyCount: result.value.counterparties.length, quoteCount: result.value.quotes.length });
      return deskResponse(result, 201);
    },
    { mutation: true },
  );
}
