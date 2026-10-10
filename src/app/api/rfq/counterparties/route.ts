import { connection, type NextRequest } from "next/server";
import { asRequester, json } from "@/server/rfq/http";

/** Counterparties a requester may select (simulated desks only). */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  return asRequester(request, (desk) => json(desk.listCounterparties()), { mutation: false });
}
