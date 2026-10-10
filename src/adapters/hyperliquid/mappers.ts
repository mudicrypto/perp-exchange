import {
  AccountSnapshotSchema,
  OrderSchema,
  PositionSchema,
  type AccountSnapshot,
  type Order,
  type OrderType,
  type Position,
  type TimeInForce,
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
  HlClearinghouseState,
  HlFrontendOpenOrder,
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

// ------------------------------------------------------------------ account reads

/**
 * Hyperliquid's frontend `orderType` strings Nova can map. Any other value
 * is reported as unmapped (the order is skipped, never guessed).
 */
const HL_ORDER_TYPES: Record<string, OrderType> = {
  Limit: "limit",
  Market: "market",
  "Stop Market": "stop-market",
  "Stop Limit": "stop-limit",
  "Take Profit Market": "take-profit-market",
  "Take Profit Limit": "take-profit-limit",
};

const HL_TIF: Record<string, TimeInForce> = { Gtc: "gtc", Ioc: "ioc", Alo: "post-only" };

export function mapFrontendOpenOrder(order: HlFrontendOpenOrder): Order | null {
  const type = HL_ORDER_TYPES[order.orderType];
  if (!type || !isSupportedCoin(order.coin)) return null;
  const size = num(order.origSz);
  const remaining = num(order.sz);
  const filled = Math.max(0, size - remaining);
  const trigger = num(order.triggerPx);
  const limitStyle = type === "limit" || type === "stop-limit" || type === "take-profit-limit";
  return OrderSchema.parse({
    id: `hl-${order.oid}`,
    // Hyperliquid's `cloid` is not part of the documented frontendOpenOrders shape.
    clientOrderId: `hl-${order.oid}`,
    venueOrderId: String(order.oid),
    marketId: marketIdFromBase(order.coin),
    side: order.side === "B" ? "buy" : "sell",
    type,
    price: limitStyle ? num(order.limitPx) : null,
    triggerPrice: order.isTrigger && trigger > 0 ? trigger : null,
    triggeredAt: null,
    size,
    filledSize: filled,
    averageFillPrice: null,
    status: order.isTrigger ? "waiting-trigger" : filled > 0 ? "partially-filled" : "open",
    timeInForce: order.tif ? (HL_TIF[order.tif] ?? null) : null,
    reduceOnly: order.reduceOnly,
    leverage: null,
    marginMode: null,
    createdAt: order.timestamp,
    updatedAt: order.timestamp,
    statusReason: null,
    lastSequence: null,
    origin: "venue",
  });
}

export function mapClearinghouseState(
  state: HlClearinghouseState,
  observedAt: number,
): { snapshot: AccountSnapshot; skippedPositions: number } {
  const positions: Position[] = [];
  let skippedPositions = 0;
  let unrealized = 0;
  for (const { position: p } of state.assetPositions) {
    const size = num(p.szi);
    if (size === 0) continue;
    if (!isSupportedCoin(p.coin) || !p.entryPx) {
      skippedPositions += 1;
      continue;
    }
    const pnl = num(p.unrealizedPnl);
    unrealized += pnl;
    positions.push(
      PositionSchema.parse({
        marketId: marketIdFromBase(p.coin),
        size,
        entryPrice: num(p.entryPx),
        leverage: p.leverage.value,
        marginMode: p.leverage.type,
        marginUsed: num(p.marginUsed),
        liquidationPrice: positiveOrNull(p.liquidationPx),
        // Not documented in clearinghouseState; Nova does not derive it.
        markPrice: null,
        unrealizedPnl: pnl,
      }),
    );
  }
  const equity = num(state.marginSummary.accountValue);
  const available = num(state.withdrawable);
  const snapshot = AccountSnapshotSchema.parse({
    origin: "venue",
    currency: HYPERLIQUID_QUOTE,
    balances: [{ asset: HYPERLIQUID_QUOTE, total: equity, available }],
    // Fields Hyperliquid's documented response does not provide stay null.
    balance: null,
    equity,
    unrealizedPnl: unrealized,
    realizedPnl: null,
    feesPaid: null,
    marginUsed: num(state.marginSummary.totalMarginUsed),
    orderMargin: null,
    available,
    maintenanceMargin: null,
    positions,
    observedAt,
  });
  return { snapshot, skippedPositions };
}
