import { connection, type NextRequest } from "next/server";
import { getCatalogGateway } from "@/server/catalog-gateway";
import { limiters } from "@/server/security/limits";
import { clientKey, rateLimited } from "@/server/security/request";
import { errorResponse } from "@/server/api-response";

export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  const limited = rateLimited(limiters().venueRead, clientKey(request));
  if (limited) return limited;
  try {
    const gateway = getCatalogGateway();
    const markets = await gateway.listMarkets();
    const { id, kind, label } = gateway.descriptor;
    return Response.json(
      { source: { id, kind, label }, markets },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
