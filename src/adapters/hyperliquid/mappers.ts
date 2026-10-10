import {
  CandleSchema,
  MarketSchema,
  MarketStatsSchema,
  OrderBookSnapshotSchema,
  TradeSchema,
  marketIdFromBase,
  type BookLevel,
  type Candle,
  type MarketStats,
  type MarketSummary,
  type MidPrices,
  type OrderBookSnapshot,
  type Trade,
} from "@/core/domain";
import {
  HYPERLIQUID_FUNDING_INTERVAL_HOURS,
  HYPERLIQUID_PERP_MAX_DECIMALS,
  HYPERLIQUID_QUOTE,
} from "./constants";
import type {
  HlAllMids,
  HlCandle,
  HlL2Book,
  HlMetaAndAssetCtxs,
  HlPerpAssetCtx,
  HlTrade,
  HlUniverseAsset,
} from "./wire-schemas";

const COIN_PATTERN = /^[A-Z0-9]{1,20}$/;

/** Only plain main-dex coins map to Nova market ids (no HIP-3 "dex:COIN" names in M1). */
export function isSupportedCoin(coin: string): boolean {
  return COIN_PATTERN.test(coin);
}

function num(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Non-finite decimal: ${value}`);
  return parsed;
}

function positiveOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = num(value);
  return parsed > 0 ? parsed : null;
}

export function mapMarket(asset: HlUniverseAsset) {
  return MarketSchema.parse({
    id: marketIdFromBase(asset.name),
    base: asset.name,
    quote: HYPERLIQUID_QUOTE,
    sizeDecimals: asset.szDecimals,
    priceDecimals: Math.max(0, HYPERLIQUID_PERP_MAX_DECIMALS - asset.szDecimals),
    maxLeverage: asset.maxLeverage,
    isolatedOnly: asset.onlyIsolated === true,
    // Hyperliquid: maintenance margin is half the initial margin at max leverage
    // (base tier; tiered margin tables are not modelled yet).
    maintenanceMarginRate: 1 / (2 * asset.maxLeverage),
  });
}

export function mapAssetCtx(coin: string, ctx: HlPerpAssetCtx, observedAt: number): MarketStats {
  return MarketStatsSchema.parse({
    marketId: marketIdFromBase(coin),
    markPrice: num(ctx.markPx),
    oraclePrice: positiveOrNull(ctx.oraclePx),
    midPrice: positiveOrNull(ctx.midPx),
    fundingRate: num(ctx.funding),
    fundingIntervalHours: HYPERLIQUID_FUNDING_INTERVAL_HOURS,
    openInterest: num(ctx.openInterest),
    dayNotionalVolume: num(ctx.dayNtlVlm),
    prevDayPrice: positiveOrNull(ctx.prevDayPx),
    observedAt,
  });
}

/**
 * `metaAndAssetCtxs` returns the universe and contexts as parallel arrays.
 * Delisted and unsupported names are skipped. A context that fails to map
 * yields `stats: null` rather than invented numbers.
 */
export function mapMetaAndAssetCtxs(
  [meta, ctxs]: HlMetaAndAssetCtxs,
  observedAt: number,
): MarketSummary[] {
  const summaries: MarketSummary[] = [];
  meta.universe.forEach((asset, index) => {
    if (asset.isDelisted || !isSupportedCoin(asset.name)) return;
    const ctx = ctxs[index];
    let stats: MarketStats | null = null;
    if (ctx) {
      try {
        stats = mapAssetCtx(asset.name, ctx, observedAt);
      } catch {
        stats = null;
      }
    }
    summaries.push({ market: mapMarket(asset), stats });
  });
  return summaries;
}

export function mapCandle(candle: HlCandle): Candle {
  return CandleSchema.parse({
    openTime: candle.t,
    open: num(candle.o),
    high: num(candle.h),
    low: num(candle.l),
    close: num(candle.c),
    volume: num(candle.v),
  });
}

function mapLevels(levels: HlL2Book["levels"][number]): BookLevel[] {
  return levels
    .map((level) => ({ price: num(level.px), size: num(level.sz), orders: level.n }))
    .filter((level) => level.price > 0 && level.size > 0);
}

export function mapL2Book(book: HlL2Book): OrderBookSnapshot {
  return OrderBookSnapshotSchema.parse({
    marketId: marketIdFromBase(book.coin),
    bids: mapLevels(book.levels[0]),
    asks: mapLevels(book.levels[1]),
    venueTime: book.time,
  });
}

export function mapTrade(trade: HlTrade): Trade {
  return TradeSchema.parse({
    marketId: marketIdFromBase(trade.coin),
    // tid is the venue trade id; the hash disambiguates if tid ever loses precision.
    id: `${trade.tid}:${trade.hash}`,
    // Hyperliquid reports the taker side: "B" = buy (bid), "A" = sell (ask).
    side: trade.side === "B" ? "buy" : "sell",
    price: num(trade.px),
    size: num(trade.sz),
    venueTime: trade.time,
  });
}

const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Maps `allMids` to Nova market ids. Spot (`@123`, `PURR/USDC`) and other
 * non-perp keys are skipped; so are entries whose value is not a positive
 * decimal. `known` restricts output to markets in the current catalog.
 */
export function mapAllMids(
  data: HlAllMids,
  observedAt: number,
  known?: ReadonlySet<string>,
): { prices: MidPrices; skipped: number } {
  const mids = new Map<string, number>();
  let skipped = 0;
  for (const [coin, px] of Object.entries(data.mids)) {
    if (!isSupportedCoin(coin)) continue;
    const id = `${coin}-PERP`;
    if (known && !known.has(id)) continue;
    const value = Number(px);
    if (!POSITIVE_DECIMAL.test(px) || !(value > 0)) {
      skipped += 1;
      continue;
    }
    mids.set(id, value);
  }
  return { prices: { mids, observedAt }, skipped };
}
