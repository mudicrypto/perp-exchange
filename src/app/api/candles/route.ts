import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { CANDLE_INTERVAL_MS, CandleIntervalSchema, MarketIdSchema } from "@/core/domain";
import { MAX_CANDLES } from "@/adapters/hyperliquid/info-client";
import { getCatalogGateway } from "@/server/catalog-gateway";
import { errorResponse, jsonError } from "@/server/api-response";

const QuerySchema = z.object({
  market: MarketIdSchema,
  interval: CandleIntervalSchema,
});

export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  const query = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return jsonError(400, "bad-request", "Invalid market or interval.");

  try {
    const { market, interval } = query.data;
    const endTime = Date.now();
    const startTime = endTime - CANDLE_INTERVAL_MS[interval] * MAX_CANDLES;
    const candles = await getCatalogGateway().getCandles(market, interval, { startTime, endTime });
    return Response.json({ candles }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
