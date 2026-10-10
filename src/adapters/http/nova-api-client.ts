import { z } from "zod";
import {
  CandleListSchema,
  MarketSummarySchema,
  type Candle,
  type CandleInterval,
  type MarketId,
  type MarketSummary,
} from "@/core/domain";

export const ApiErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export const MarketsResponseSchema = z.object({
  source: z.object({ id: z.string(), kind: z.enum(["live", "simulation"]), label: z.string() }),
  markets: z.array(MarketSummarySchema),
});
export type MarketsResponse = z.infer<typeof MarketsResponseSchema>;

export const CandlesResponseSchema = z.object({ candles: CandleListSchema });

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Browser client for Nova's own `/api` routes. Even though our server already
 * validated venue data, responses are validated again here: the browser
 * trusts only the domain contract, not the transport.
 */
export class NovaApiClient {
  constructor(
    private readonly baseUrl = "",
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    /**
     * The data kind the UI was configured for. If the server reports a
     * different kind, the response is rejected rather than shown — live mode
     * must never silently display simulated data (or vice versa).
     */
    private readonly expectedKind: "live" | "simulation" | null = null,
  ) {}

  async listMarkets(signal?: AbortSignal): Promise<MarketSummary[]> {
    const body = await this.get("/api/markets", MarketsResponseSchema, signal);
    if (this.expectedKind && body.source.kind !== this.expectedKind) {
      throw new ApiError(
        "source-mismatch",
        `Server is serving ${body.source.kind} data but this page expects ${this.expectedKind} data`,
        200,
      );
    }
    return body.markets;
  }

  async getCandles(marketId: MarketId, interval: CandleInterval, signal?: AbortSignal): Promise<Candle[]> {
    const query = new URLSearchParams({ market: marketId, interval });
    const body = await this.get(`/api/candles?${query.toString()}`, CandlesResponseSchema, signal);
    return body.candles;
  }

  private async get<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { signal, cache: "no-store" });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError("network", "Could not reach Nova API", 0);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // handled below
    }
    if (!response.ok) {
      const parsedError = ApiErrorBodySchema.safeParse(json);
      throw parsedError.success
        ? new ApiError(parsedError.data.error.code, parsedError.data.error.message, response.status)
        : new ApiError("http", `Request failed (HTTP ${response.status})`, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError("invalid-response", "Unexpected API response", response.status);
    return parsed.data;
  }
}
