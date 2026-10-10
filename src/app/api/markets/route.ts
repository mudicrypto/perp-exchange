import { connection } from "next/server";
import { getCatalogGateway } from "@/server/catalog-gateway";
import { errorResponse } from "@/server/api-response";

export async function GET(): Promise<Response> {
  await connection();
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
