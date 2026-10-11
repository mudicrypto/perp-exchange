import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { getVenueAccountGateway } from "@/server/account-gateway";
import { limiters } from "@/server/security/limits";
import { clientKey, rateLimited } from "@/server/security/request";
import { errorResponse, jsonError } from "@/server/api-response";

const QuerySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/**
 * Read-only account lookup by public address. Never accepts keys or
 * signatures; there is no write counterpart in this milestone.
 */
export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  const limited = rateLimited(limiters().accountLookup, clientKey(request));
  if (limited) return limited;
  const query = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return jsonError(400, "bad-request", "A 42-character hex address is required.");
  const gateway = getVenueAccountGateway();
  if (!gateway) return jsonError(404, "unsupported", "The active data source has no venue account API.");
  try {
    const readout = await gateway.getAccount(query.data.address);
    return Response.json(readout, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
