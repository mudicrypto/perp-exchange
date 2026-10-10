import type { z } from "zod";
import {
  CANDLE_INTERVAL_MS,
  baseFromMarketId,
  type Candle,
  type CandleInterval,
  type MarketId,
  type MarketSummary,
} from "@/core/domain";
import type { DataSourceDescriptor, MarketCatalogGateway } from "@/core/ports";
import { WeightBudget } from "@/lib/weight-budget";
import {
  HYPERLIQUID_ENDPOINTS,
  HYPERLIQUID_INFO_WEIGHT,
  HYPERLIQUID_INTERVALS,
  HYPERLIQUID_VENUE_ID,
  NOVA_INFO_WEIGHT_BUDGET_PER_MINUTE,
  type HyperliquidNetwork,
} from "./constants";
import { mapCandle, mapMetaAndAssetCtxs } from "./mappers";
import { HlCandleSnapshotSchema, HlMetaAndAssetCtxsSchema } from "./wire-schemas";

export type VenueErrorCode = "network" | "timeout" | "http" | "invalid-response" | "rate-limited";

export class VenueError extends Error {
  constructor(
    readonly code: VenueErrorCode,
    message: string,
    readonly status?: number,
    /** For rate-limited errors: suggested wait before retrying. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "VenueError";
  }
}

export interface InfoClientOptions {
  network: HyperliquidNetwork;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries for network errors / timeouts / 5xx (never for 429 or invalid responses). */
  retries?: number;
  /** Nova's own REST weight budget per minute (defaults below the venue limit). */
  weightBudgetPerMinute?: number;
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Max candles requested per call (Hyperliquid serves at most 5000). */
export const MAX_CANDLES = 500;

/**
 * Server-side client for Hyperliquid's public `/info` endpoint. Responses are
 * validated with Zod, mapped to domain types and briefly cached to stay well
 * within the venue's rate limits.
 */
export class HyperliquidInfoClient implements MarketCatalogGateway {
  readonly descriptor: DataSourceDescriptor;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly budget: WeightBudget;

  constructor(private readonly options: InfoClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.retries = options.retries ?? 1;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.budget = new WeightBudget(options.weightBudgetPerMinute ?? NOVA_INFO_WEIGHT_BUDGET_PER_MINUTE);
    this.descriptor = {
      id: `hyperliquid-${options.network}`,
      kind: "live",
      label: `Hyperliquid ${options.network} (public API)`,
      venueId: HYPERLIQUID_VENUE_ID,
    };
  }

  async listMarkets(signal?: AbortSignal): Promise<MarketSummary[]> {
    const raw = await this.cachedPost(
      "metaAndAssetCtxs",
      { type: "metaAndAssetCtxs" },
      HlMetaAndAssetCtxsSchema,
      HYPERLIQUID_INFO_WEIGHT.metaAndAssetCtxs,
      signal,
    );
    return mapMetaAndAssetCtxs(raw, this.now());
  }

  async getCandles(
    marketId: MarketId,
    interval: CandleInterval,
    range: { startTime: number; endTime: number },
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    const step = CANDLE_INTERVAL_MS[interval];
    const startTime = Math.max(range.startTime, range.endTime - step * MAX_CANDLES);
    // Align to interval boundaries so the cache key is stable within a candle.
    const req = {
      coin: baseFromMarketId(marketId),
      interval: HYPERLIQUID_INTERVALS[interval],
      startTime: Math.floor(startTime / step) * step,
      endTime: Math.ceil(range.endTime / step) * step,
    };
    const expectedItems = Math.ceil((req.endTime - req.startTime) / step);
    const weight =
      HYPERLIQUID_INFO_WEIGHT.candleSnapshot +
      Math.ceil(expectedItems / 60) * HYPERLIQUID_INFO_WEIGHT.candleSnapshotPer60Items;
    const raw = await this.cachedPost(
      `candles:${JSON.stringify(req)}`,
      { type: "candleSnapshot", req },
      HlCandleSnapshotSchema,
      weight,
      signal,
    );
    return raw.map(mapCandle).sort((a, b) => a.openTime - b.openTime);
  }

  /** Weight consumed in the current window (exposed for health/diagnostics). */
  weightUsed(): number {
    return this.budget.used(this.now());
  }

  private cachedPost<S extends z.ZodType>(
    key: string,
    body: unknown,
    schema: S,
    weight: number,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    const now = this.now();
    const hit = this.cache.get(key);
    // Identical in-flight or recent requests share one venue call (no extra weight).
    if (hit && hit.expires > now) return hit.value as Promise<z.infer<S>>;
    if (!this.budget.tryConsume(weight, now)) {
      return Promise.reject(
        new VenueError("rate-limited", "Nova's venue request budget is exhausted; try again shortly", 429, this.budget.retryAfterMs(weight, now)),
      );
    }
    const value = this.post(body, schema, signal);
    this.cache.set(key, { expires: now + this.cacheTtlMs, value });
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > 200) this.evictExpired(now);
    return value;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.cache) if (entry.expires <= now) this.cache.delete(key);
  }

  private async post<S extends z.ZodType>(body: unknown, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    let lastError: VenueError | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.sleep(250 * 2 ** (attempt - 1));
      try {
        return await this.postOnce(body, schema, signal);
      } catch (error) {
        if (!(error instanceof VenueError)) throw error;
        lastError = error;
        // 429s are not retried: retrying would only add load against the venue's limit.
        const retryable =
          error.code === "network" || error.code === "timeout" || (error.code === "http" && (error.status ?? 0) >= 500);
        if (!retryable || signal?.aborted) throw error;
      }
    }
    throw lastError ?? new VenueError("network", "Request failed");
  }

  private async postOnce<S extends z.ZodType>(body: unknown, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(HYPERLIQUID_ENDPOINTS[this.options.network].info, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
        cache: "no-store",
      });
    } catch (error) {
      if (timeout.aborted) throw new VenueError("timeout", "Hyperliquid request timed out");
      throw new VenueError("network", error instanceof Error ? error.message : "Network error");
    }
    if (response.status === 429) {
      throw new VenueError("rate-limited", "Hyperliquid rate limit reached (HTTP 429)", 429);
    }
    if (!response.ok) {
      throw new VenueError("http", `Hyperliquid responded with HTTP ${response.status}`, response.status);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new VenueError("invalid-response", "Hyperliquid returned non-JSON response");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new VenueError("invalid-response", `Unexpected Hyperliquid response: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    return parsed.data;
  }
}
