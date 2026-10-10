/**
 * Paper-trading engine for the simulated venue.
 *
 * It matches order intents against *simulated* order books and keeps a
 * fictitious account in SIMUSD. It is deliberately simple (isolated margin,
 * one position per market, visible-depth matching) and is never connected to
 * a real venue: it exists so the demo terminal is fully interactive without
 * pretending that any real-world order was executed.
 */
import {
  isTerminalStatus,
  type AccountSnapshot,
  type BookLevel,
  type Fill,
  type Liquidity,
  type Market,
  type MarketId,
  type Order,
  type OrderIntent,
  type Position,
  type Side,
} from "@/core/domain";
import { validateOrderIntent } from "@/core/execution";
import type { AccountState, SubmitErrorCode, SubmitResult } from "@/core/ports";
import { estimateIsolatedLiquidationPrice } from "@/core/risk";

export const PAPER_CURRENCY = "SIMUSD";

export interface PaperFeeSchedule {
  /** Fraction of notional, e.g. 0.00045 = 4.5 bps. */
  taker: number;
  maker: number;
}

/** Illustrative fee schedule for the simulator (not any venue's real fees). */
export const PAPER_FEES: PaperFeeSchedule = { taker: 0.00045, maker: 0.00015 };

/** Market orders will not walk the book further than this from the best price. */
export const MARKET_ORDER_MAX_SLIPPAGE = 0.05;

const EPSILON = 1e-9;
const HISTORY_LIMIT = 200;
const FILL_LIMIT = 500;

interface PaperPosition {
  marketId: MarketId;
  size: number;
  entryPrice: number;
  leverage: number;
  margin: number;
}

interface Book {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sign(side: Side): 1 | -1 {
  return side === "buy" ? 1 : -1;
}

export class PaperEngine {
  private balance: number;
  private realizedPnl = 0;
  private feesPaid = 0;
  private readonly positions = new Map<MarketId, PaperPosition>();
  private readonly openOrders = new Map<string, Order>();
  private history: Order[] = [];
  private fills: Fill[] = [];
  private readonly books = new Map<MarketId, Book>();
  private readonly marks = new Map<MarketId, number>();
  private orderSeq = 0;
  private fillSeq = 0;

  constructor(
    private readonly markets: ReadonlyMap<MarketId, Market>,
    startingBalance: number,
    private readonly fees: PaperFeeSchedule = PAPER_FEES,
  ) {
    this.balance = startingBalance;
  }

  // ---------------------------------------------------------------- inputs

  setMark(marketId: MarketId, mark: number, now: number): void {
    this.marks.set(marketId, mark);
    this.checkLiquidation(marketId, now);
  }

  /** New book snapshot: resting orders that are now marketable fill as makers. */
  setBook(marketId: MarketId, book: Book, now: number): void {
    this.books.set(marketId, book);
    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;
    for (const order of [...this.openOrders.values()]) {
      if (order.marketId !== marketId || order.price === null) continue;
      const crossed =
        order.side === "buy"
          ? bestAsk !== undefined && bestAsk <= order.price
          : bestBid !== undefined && bestBid >= order.price;
      if (!crossed) continue;
      let remaining = order.size - order.filledSize;
      if (order.reduceOnly) {
        remaining = Math.min(remaining, this.reducibleSize(order.marketId, order.side));
        if (remaining <= EPSILON) {
          this.finish(order, "cancelled", "Reduce-only order cancelled: no position left to reduce", now);
          continue;
        }
      }
      this.executeFill(order, order.price, remaining, "maker", now);
      this.finish(order, order.filledSize >= order.size - EPSILON ? "filled" : "cancelled",
        order.filledSize >= order.size - EPSILON ? null : "Reduce-only remainder cancelled", now);
    }
  }

  // --------------------------------------------------------------- actions

  submit(intent: OrderIntent, now: number): SubmitResult {
    const market = this.markets.get(intent.marketId);
    const order = this.newOrder(intent, now);
    if (!market) return this.reject(order, "validation-failed", "Unknown market", now);

    const validation = validateOrderIntent(intent, market);
    if (!validation.ok) {
      return this.reject(order, "validation-failed", validation.issues.map((i) => i.message).join("; "), now);
    }

    const position = this.positions.get(intent.marketId);
    if (position && Math.abs(position.leverage - intent.leverage) > EPSILON && !intent.reduceOnly) {
      return this.reject(
        order,
        "validation-failed",
        `Leverage must match the open position (${position.leverage}x)`,
        now,
      );
    }

    let size = intent.size;
    if (intent.reduceOnly) {
      const reducible = this.reducibleSize(intent.marketId, intent.side);
      if (reducible <= EPSILON) {
        return this.reject(order, "reduce-only-invalid", "Reduce-only order has no position to reduce", now);
      }
      size = Math.min(size, roundTo(reducible, market.sizeDecimals));
      order.size = size;
    }

    const book = this.books.get(intent.marketId);
    if (!book) return this.reject(order, "feed-unavailable", "No order book available for this market", now);

    const levels = intent.side === "buy" ? book.asks : book.bids;
    const best = levels[0]?.price;
    const limit =
      intent.type === "limit"
        ? intent.limitPrice!
        : best === undefined
          ? null
          : best * (1 + sign(intent.side) * MARKET_ORDER_MAX_SLIPPAGE);
    const takeable = limit === null ? [] : this.takeableLevels(levels, intent.side, limit, size);
    const takeSize = takeable.reduce((sum, l) => sum + l.size, 0);

    if (intent.type === "market" && takeSize <= EPSILON) {
      return this.reject(order, "no-liquidity", "No liquidity within 5% of the best price", now);
    }
    if (intent.timeInForce === "post-only" && takeSize > EPSILON) {
      return this.reject(order, "would-take-liquidity", "Post-only order would cross the book", now);
    }

    // Margin check on the exposure-increasing part of the order.
    const referencePrice = intent.type === "limit" ? intent.limitPrice! : (takeable.at(-1)?.price ?? best!);
    const increasing = intent.reduceOnly ? 0 : this.increasingSize(intent.marketId, intent.side, size);
    const required = (increasing * referencePrice) / intent.leverage + size * referencePrice * this.fees.taker;
    const available = this.snapshot(now).available;
    if (required > available + EPSILON) {
      return this.reject(
        order,
        "insufficient-margin",
        `Insufficient margin: requires ${required.toFixed(2)} ${PAPER_CURRENCY}, available ${Math.max(0, available).toFixed(2)}`,
        now,
      );
    }

    for (const level of takeable) this.executeFill(order, level.price, level.size, "taker", now);

    const remaining = order.size - order.filledSize;
    if (remaining <= EPSILON) {
      this.finish(order, "filled", null, now);
    } else if (intent.type === "market" || intent.timeInForce === "ioc") {
      this.finish(
        order,
        "cancelled",
        order.filledSize > 0 ? "Partially filled; remainder cancelled (IOC)" : "No fill; cancelled (IOC)",
        now,
      );
    } else {
      order.status = order.filledSize > 0 ? "partially-filled" : "open";
      order.updatedAt = now;
      this.openOrders.set(order.id, order);
    }
    return { ok: true, order: { ...order } };
  }

  cancel(orderId: string, now: number): SubmitResult {
    const order = this.openOrders.get(orderId);
    if (!order) return { ok: false, code: "not-found", message: "Order is not open", order: null };
    this.finish(order, "cancelled", "Cancelled by user", now);
    return { ok: true, order: { ...order } };
  }

  cancelAll(now: number): number {
    const ids = [...this.openOrders.keys()];
    for (const id of ids) this.cancel(id, now);
    return ids.length;
  }

  // ------------------------------------------------------------ fixtures

  /**
   * Replays a historical fill through the same accounting path as live fills
   * (used to seed the demo account so fixtures are internally consistent).
   */
  seedFilledOrder(
    intent: OrderIntent,
    fillPrice: number,
    liquidity: Exclude<Liquidity, "liquidation">,
    time: number,
  ): Order {
    const order = this.newOrder(intent, time);
    this.executeFill(order, fillPrice, intent.size, liquidity, time);
    this.finish(order, "filled", null, time);
    return order;
  }

  seedRestingOrder(intent: OrderIntent, time: number): Order {
    const order = this.newOrder(intent, time);
    order.status = "open";
    this.openOrders.set(order.id, order);
    return order;
  }

  seedTerminalOrder(intent: OrderIntent, status: "cancelled" | "rejected", reason: string, time: number, closedAt: number): Order {
    const order = this.newOrder(intent, time);
    this.finish(order, status, reason, closedAt);
    return order;
  }

  // -------------------------------------------------------------- outputs

  snapshot(now: number): AccountSnapshot {
    const positions: Position[] = [];
    let unrealized = 0;
    let marginUsed = 0;
    let maintenance = 0;
    for (const p of this.positions.values()) {
      const market = this.markets.get(p.marketId);
      const mark = this.marks.get(p.marketId) ?? null;
      const pnl = mark === null ? 0 : p.size * (mark - p.entryPrice);
      unrealized += pnl;
      marginUsed += p.margin;
      maintenance += Math.abs(p.size) * (mark ?? p.entryPrice) * (market?.maintenanceMarginRate ?? 0);
      positions.push({
        marketId: p.marketId,
        size: p.size,
        entryPrice: p.entryPrice,
        leverage: p.leverage,
        marginMode: "isolated",
        marginUsed: p.margin,
        liquidationPrice: this.liquidationPrice(p),
        markPrice: mark,
        unrealizedPnl: pnl,
      });
    }
    let orderMargin = 0;
    for (const o of this.openOrders.values()) {
      if (o.reduceOnly || o.price === null) continue;
      orderMargin += ((o.size - o.filledSize) * o.price) / o.leverage;
    }
    const equity = this.balance + unrealized;
    return {
      currency: PAPER_CURRENCY,
      balance: this.balance,
      equity,
      unrealizedPnl: unrealized,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      marginUsed,
      orderMargin,
      available: equity - marginUsed - orderMargin,
      maintenanceMargin: maintenance,
      positions: positions.sort((a, b) => a.marketId.localeCompare(b.marketId)),
      observedAt: now,
    };
  }

  state(now: number): AccountState {
    return {
      snapshot: this.snapshot(now),
      openOrders: [...this.openOrders.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((o) => ({ ...o })),
      orderHistory: this.history.map((o) => ({ ...o })),
      fills: [...this.fills],
    };
  }

  // ------------------------------------------------------------ internals

  private newOrder(intent: OrderIntent, now: number): Order {
    this.orderSeq += 1;
    return {
      id: `P-${String(this.orderSeq).padStart(6, "0")}`,
      marketId: intent.marketId,
      side: intent.side,
      type: intent.type,
      price: intent.type === "limit" ? intent.limitPrice : null,
      size: intent.size,
      filledSize: 0,
      averageFillPrice: null,
      status: "pending-submit",
      timeInForce: intent.timeInForce,
      reduceOnly: intent.reduceOnly,
      leverage: intent.leverage,
      createdAt: now,
      updatedAt: now,
      statusReason: null,
    };
  }

  private reject(order: Order, code: SubmitErrorCode, message: string, now: number): SubmitResult {
    this.finish(order, "rejected", message, now);
    return { ok: false, code, message, order: { ...order } };
  }

  private finish(order: Order, status: "filled" | "cancelled" | "rejected", reason: string | null, now: number): void {
    order.status = status;
    order.statusReason = reason;
    order.updatedAt = now;
    this.openOrders.delete(order.id);
    if (isTerminalStatus(status)) {
      this.history = [{ ...order }, ...this.history].slice(0, HISTORY_LIMIT);
    }
  }

  private takeableLevels(levels: readonly BookLevel[], side: Side, limit: number, size: number): BookLevel[] {
    const result: BookLevel[] = [];
    let remaining = size;
    for (const level of levels) {
      if (remaining <= EPSILON) break;
      const acceptable = side === "buy" ? level.price <= limit : level.price >= limit;
      if (!acceptable) break;
      const take = Math.min(remaining, level.size);
      result.push({ price: level.price, size: take, orders: level.orders });
      remaining -= take;
    }
    return result;
  }

  private reducibleSize(marketId: MarketId, side: Side): number {
    const position = this.positions.get(marketId);
    if (!position) return 0;
    return Math.sign(position.size) === -sign(side) ? Math.abs(position.size) : 0;
  }

  private increasingSize(marketId: MarketId, side: Side, size: number): number {
    return Math.max(0, size - this.reducibleSize(marketId, side));
  }

  private executeFill(order: Order, price: number, size: number, liquidity: Liquidity, now: number): void {
    const market = this.markets.get(order.marketId);
    const sizeDecimals = market?.sizeDecimals ?? 8;
    const qty = roundTo(size, sizeDecimals);
    if (qty <= 0) return;

    const realized = this.applyToPosition(order.marketId, order.side, qty, price, order.leverage, sizeDecimals);
    const feeRate = liquidity === "maker" ? this.fees.maker : this.fees.taker;
    const fee = qty * price * feeRate;
    this.balance += realized - fee;
    this.realizedPnl += realized;
    this.feesPaid += fee;

    const previousNotional = (order.averageFillPrice ?? 0) * order.filledSize;
    order.filledSize = roundTo(order.filledSize + qty, sizeDecimals);
    order.averageFillPrice = (previousNotional + qty * price) / order.filledSize;
    order.updatedAt = now;

    this.fillSeq += 1;
    this.fills = [
      {
        id: `F-${String(this.fillSeq).padStart(6, "0")}`,
        orderId: liquidity === "liquidation" ? null : order.id,
        marketId: order.marketId,
        side: order.side,
        price,
        size: qty,
        fee,
        liquidity,
        realizedPnl: realized,
        time: now,
      },
      ...this.fills,
    ].slice(0, FILL_LIMIT);
  }

  /** Updates the position and returns realised PnL for the closing part. */
  private applyToPosition(marketId: MarketId, side: Side, qty: number, price: number, leverage: number, sizeDecimals: number): number {
    const signed = sign(side) * qty;
    const current = this.positions.get(marketId);
    if (!current) {
      this.positions.set(marketId, { marketId, size: signed, entryPrice: price, leverage, margin: (qty * price) / leverage });
      return 0;
    }
    if (Math.sign(current.size) === Math.sign(signed)) {
      const total = Math.abs(current.size) + qty;
      current.entryPrice = (Math.abs(current.size) * current.entryPrice + qty * price) / total;
      current.size = roundTo(current.size + signed, sizeDecimals);
      current.margin = (Math.abs(current.size) * current.entryPrice) / current.leverage;
      return 0;
    }
    const closing = Math.min(qty, Math.abs(current.size));
    const realized = closing * (price - current.entryPrice) * Math.sign(current.size);
    const newSize = roundTo(current.size + signed, sizeDecimals);
    if (Math.abs(newSize) <= EPSILON) {
      this.positions.delete(marketId);
    } else if (Math.sign(newSize) !== Math.sign(current.size)) {
      // Flipped: the remainder opens a new position at the fill price.
      this.positions.set(marketId, {
        marketId,
        size: newSize,
        entryPrice: price,
        leverage,
        margin: (Math.abs(newSize) * price) / leverage,
      });
    } else {
      current.size = newSize;
      current.margin = (Math.abs(newSize) * current.entryPrice) / current.leverage;
    }
    return realized;
  }

  private liquidationPrice(p: PaperPosition): number | null {
    const market = this.markets.get(p.marketId);
    if (!market) return null;
    return estimateIsolatedLiquidationPrice({
      side: p.size > 0 ? "buy" : "sell",
      entryPrice: p.entryPrice,
      size: Math.abs(p.size),
      collateral: p.margin,
      maintenanceMarginRate: market.maintenanceMarginRate,
    });
  }

  /** The simulator enforces its own liquidation price at the mark. */
  private checkLiquidation(marketId: MarketId, now: number): void {
    const p = this.positions.get(marketId);
    const mark = this.marks.get(marketId);
    if (!p || mark === undefined) return;
    const liq = this.liquidationPrice(p);
    if (liq === null) return;
    const breached = p.size > 0 ? mark <= liq : mark >= liq;
    if (!breached) return;
    const closeSide: Side = p.size > 0 ? "sell" : "buy";
    const liquidationOrder = this.newOrder(
      {
        marketId,
        side: closeSide,
        type: "market",
        size: Math.abs(p.size),
        limitPrice: null,
        timeInForce: "ioc",
        reduceOnly: true,
        leverage: p.leverage,
        marginMode: "isolated",
      },
      now,
    );
    this.executeFill(liquidationOrder, mark, Math.abs(p.size), "liquidation", now);
    this.finish(liquidationOrder, "filled", "Liquidated by the simulator at mark price", now);
    // Cancel reduce-only orders that no longer have anything to reduce.
    for (const order of [...this.openOrders.values()]) {
      if (order.marketId === marketId && order.reduceOnly) {
        this.finish(order, "cancelled", "Position liquidated", now);
      }
    }
  }
}
