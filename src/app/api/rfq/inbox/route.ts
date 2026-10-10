import { connection, type NextRequest } from "next/server";
import { asCounterparty, json } from "@/server/rfq/http";

/** Requests addressed to the authenticated counterparty, redacted (no requester identity, no limit, no competing quotes). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return asCounterparty(request, (desk, counterpartyId) => json(desk.inbox(counterpartyId)));
}
