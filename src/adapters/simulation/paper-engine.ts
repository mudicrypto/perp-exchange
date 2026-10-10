/**
 * Deterministic paper-trading venue for the simulated environment.
 *
 * Matches order requests against *simulated* order books and keeps a
 * fictitious SIMUSD account (isolated margin, one position per market).
 * Every order status change goes through `OrderStore` lifecycle events, so
 * the simulator obeys exactly the same state machine a real venue adapter
 * must. It never touches a wallet or a real venue.
 *
 * Determinism: given the same configuration, books, marks and calls (with
 * the same timestamps), the engine produces identical ids, fills and states.
 */
import type {
  AccountSnapshot,
  BookLevel,
  Fill,
  Liquidity,
  Market,
  MarketId,
  Order,
  OrderRequest,
  Position,
  Result,
  Side,
  TradingError,
} from "@/core/domain";
import { isTerminalStatus, isTriggerType, requestLimitPrice, requestTimeInForce, requestTriggerPrice } from "@/core/domain";
import type { AccountState } from "@/core/ports";
import { estimateIsolatedLiquidationPrice } from "@/core/risk";
import { OrderStore, type ApplyOutcome, type OrderEventBody, type OrderStoreChange } from "@/core/trading";

export const PAPER_CURRENCY = "SIMUSD";

export interface PaperFeeSchedule {
  /** Fraction of notional, e.g. 0.00045 = 4.5 bps. */
  taker: number;
  maker: number;
}

/** Illustrative fee schedule for the simulator (not any venue's real fees). */
export const PAPER_FEES: PaperFeeSchedule = { taker: 0.00045, maker: 0.00015 };

export interface SimulationConfig {
  startingBalance: number;
  fees: PaperFeeSchedule;
  /**
   * "book": match against the simulated book (default).
   * "none": accept orders but never fill them (to exercise resting/cancel flows).
   */
  fillModel: "book" | "none";
  /** Fraction (0..1] of each visible level available to Nova; < 1 produces partial fills. */
  liquidityFraction: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  startingBalance: 25_000,
  fees: PAPER_FEES,
  fillModel: "book",
  liquidityFraction: 1,
};

/** Configurable simulated rejections (evaluated before matching). */
export type RejectionRule =
  | { kind: "next"; remaining: number; reason: string }
  | { kind: "every-nth"; n: number; reason: string }
  | { kind: "market"; marketId: MarketId; reason: string };

const EPSILON = 1e-9;

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

const fail = (error: TradingError): Result<never> => ({ ok: false, error });

/** Simulator orders always carry leverage (it comes from the request). */
function leverageOf(order: Order): number {
  if (order.leverage === null) throw new Error(`Simulator order ${order.id} has no leverage`);
  return order.leverage;
}

export class PaperEngine {
  readonly store = new OrderStore();
  private readonly config: SimulationConfig;
  private balance: number;
  private realizedPnl = 0;
  private feesPaid = 0;
  private readonly positions = new Map<MarketId, PaperPosition>();
  private readonly books = new Map<MarketId, Book>();
  private readonly marks = new Map<MarketId, number>();
  /** Per-order slippage for market-style orders (not part of the Order model). */
  private readonly slippage = new Map<string, number>();
  private rejectionRules: RejectionRule[] = [];
  private orderSeq = 0;
  private fillSeq = 0;
  private eventSeq = 0;
  private processedCount = 0;

  constructor(
    private readonly markets: ReadonlyMap<MarketId, Market>,
    config: Partial<SimulationConfig> = {},
  ) {
    this.config = { ...DEFAULT_SIMULATION_CONFIG, ...config };
    if (!(this.config.liquidityFraction > 0 && this.config.liquidityFraction <= 1)) {
      throw new RangeError("liquidityFraction must be in (0, 1]");
    }
    this.balance = this.config.startingBalance;
  }

  // ------------------------------------------------------------ configuration

  addRejectionRule(rule: RejectionRule): void {
    this.rejectionRules.push({ ...rule });
  }

  clearRejectionRules(): void {
    this.rejectionRules = [];
  }

  // ------------------------------------------------------------------ inputs

  setMark(marketId: MarketId, mark: number, now: number): void {
    this.marks.set(marketId, mark);
    this.checkTriggers(marketId, mark, now);
    this.checkLiquidation(marketId, now);
  }

  /** New book snapshot: resting limit orders that are now marketable fill as makers. */
  setBook(marketId: MarketId, book: Book, now: number): void {
    this.books.set(marketId, book);
    if (this.config.fillModel === "none") return;
    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;
    for (const order of this.store.openOrders()) {
      if (order.marketId !== marketId || order.price === null || order.status === "waiting-trigger") continue;
      const crossed = order.side === "buy" ? bestAsk !== undefined && bestAsk <= order.price : bestBid !== undefined && bestBid >= order.price;
      if (!crossed) continue;
      let remaining = order.size - order.filledSize;
      if (order.reduceOnly) {
        const reducible = this.reducibleSize(order.marketId, order.side);
        if (reducible <= EPSILON) {
          this.emit(order.id, { type: "cancelled", reason: "Reduce-only order cancelled: no position left to reduce" }, now);
          continue;
        }
        remaining = Math.min(remaining, reducible);
      }
      const fillSize = remaining * this.config.liquidityFraction;
      this.executeFill(order.id, order.price, fillSize, "maker", now);
      const after = this.store.get(order.id)!;
      if (order.reduceOnly && !isTerminalStatus(after.status) && this.reducibleSize(order.marketId, order.side) <= EPSILON) {
        this.emit(order.id, { type: "cancelled", reason: "Reduce-only remainder cancelled: position closed" }, now);
      }
    }
  }

  // ----------------------------------------------------------------- actions

  /** Registers a request as a pending-new order (no matching yet). */
  createOrder(request: OrderRequest, now: number): Result<Order> {
    if (this.store.hasClientOrderId(request.clientOrderId)) {
      return fail({
        code: "duplicate-client-order-id",
        clientOrderId: request.clientOrderId,
        message: `Client order id ${request.clientOrderId} was already used`,
      });
    }
    if (!this.markets.has(request.marketId)) {
      return fail({ code: "validation", issues: [{ field: "marketId", message: "Unknown market" }], message: "Unknown market" });
    }
    this.orderSeq += 1;
    const order: Order = {
      id: `SIM-${String(this.orderSeq).padStart(6, "0")}`,
      clientOrderId: request.clientOrderId,
      venueOrderId: null,
      marketId: request.marketId,
      side: request.side,
      type: request.type,
      price: requestLimitPrice(request),
      triggerPrice: requestTriggerPrice(request),
      triggeredAt: null,
      size: request.size,
      filledSize: 0,
      averageFillPrice: null,
      status: "pending-new",
      timeInForce: requestTimeInForce(request),
      reduceOnly: request.reduceOnly,
      leverage: request.leverage,
      marginMode: request.marginMode,
      createdAt: now,
      updatedAt: now,
      statusReason: null,
      lastSequence: null,
      origin: "simulated",
    };
    if ("maxSlippage" in request) this.slippage.set(order.id, request.maxSlippage);
    this.store.add(order);
    return { ok: true, value: order };
  }

  /** Decides a pending-new order: reject, rest, trigger-wait, or match. */
  processOrder(orderId: string, now: number): Result<Order> {
    const order = this.store.get(orderId);
    if (!order) return fail({ code: "order-not-found", message: "Order not found" });
    if (order.status !== "pending-new") return { ok: true, value: order };
    this.processedCount += 1;
    const market = this.markets.get(order.marketId)!;

    const injected = this.injectedRejection(order);
    if (injected) return this.reject(order, { code: "simulated-rejection", message: injected }, now);

    const position = this.positions.get(order.marketId);
    if (position && !order.reduceOnly && Math.abs(position.leverage - leverageOf(order)) > EPSILON) {
      const message = `Leverage must match the open position (${position.leverage}x)`;
      return this.reject(order, { code: "validation", issues: [{ field: "leverage", message }], message }, now);
    }
    if (order.reduceOnly && this.reducibleSize(order.marketId, order.side) <= EPSILON) {
      return this.reject(order, { code: "reduce-only-invalid", message: "Reduce-only order has no position to reduce" }, now);
    }
    const book = this.books.get(order.marketId);
    if (!book) return this.reject(order, { code: "feed-unavailable", message: "No order book available for this market" }, now);

    // ---- trigger orders: validate the trigger, reserve margin, then wait.
    if (isTriggerType(order.type)) {
      const mark = this.marks.get(order.marketId);
      if (mark === undefined) return this.reject(order, { code: "feed-unavailable", message: "No mark price available" }, now);
      if (this.triggerReached(order, mark)) {
        const message = `Trigger price ${order.triggerPrice} is already reached (mark ${mark})`;
        return this.reject(order, { code: "validation", issues: [{ field: "triggerPrice", message }], message }, now);
      }
      const marginError = this.checkMargin(order, order.triggerPrice!, now);
      if (marginError) return this.reject(order, marginError, now);
      return this.emitResult(order.id, { type: "accepted" }, now);
    }

    // ---- market / limit orders
    const levels = order.side === "buy" ? book.asks : book.bids;
    const best = levels[0]?.price;
    const limit =
      order.type === "limit"
        ? order.price!
        : best === undefined
          ? null
          : best * (1 + sign(order.side) * (this.slippage.get(order.id) ?? 0.05));
    const executable = this.executableSize(order);
    const takeable = limit === null || this.config.fillModel === "none" ? [] : this.takeableLevels(levels, order.side, limit, executable);
    const takeSize = takeable.reduce((sum, l) => sum + l.size, 0);

    if (order.type === "market" && takeSize <= EPSILON) {
      return this.reject(order, { code: "no-liquidity", message: "No simulated liquidity within the slippage limit" }, now);
    }
    if (order.timeInForce === "post-only" && takeSize > EPSILON) {
      return this.reject(order, { code: "would-take-liquidity", message: "Post-only order would cross the book" }, now);
    }
    const referencePrice = order.type === "limit" ? order.price! : (takeable.at(-1)?.price ?? best!);
    const marginError = this.checkMargin(order, referencePrice, now, takeSize);
    if (marginError) return this.reject(order, marginError, now);

    this.emit(order.id, { type: "accepted" }, now);
    for (const level of takeable) this.executeFill(order.id, level.price, level.size, "taker", now);
    this.finishTakerOrder(order.id, market, now);
    return { ok: true, value: this.store.get(order.id)! };
  }

  /** create + process (synchronous submit). */
  submit(request: OrderRequest, now: number): Result<Order> {
    const created = this.createOrder(request, now);
    if (!created.ok) return created;
    return this.processOrder(created.value.id, now);
  }

  cancel(orderId: string, now: number, reason = "Cancelled by user"): Result<Order> {
    const order = this.store.get(orderId);
    if (!order) return fail({ code: "order-not-found", message: "Order not found" });
    if (isTerminalStatus(order.status)) {
      return fail({ code: "order-not-cancellable", status: order.status, message: `Order is already ${order.status}` });
    }
    if (order.status === "pending-new") {
      return this.emitResult(order.id, { type: "cancelled", reason }, now);
    }
    this.emit(order.id, { type: "cancel-requested" }, now);
    return this.emitResult(order.id, { type: "cancelled", reason }, now);
  }

  cancelAll(now: number, marketId?: MarketId): number {
    let count = 0;
    for (const order of this.store.openOrders()) {
      if (marketId && order.marketId !== marketId) continue;
      if (this.cancel(order.id, now).ok) count += 1;
    }
    return count;
  }

  subscribe(listener: (change: OrderStoreChange) => void): () => void {
    return this.store.subscribe(listener);
  }

  // ---------------------------------------------------------------- fixtures

  /** Replays a historical fill through the normal lifecycle (fixture seeding). */
  seedFilledOrder(request: OrderRequest, fillPrice: number, liquidity: "maker" | "taker", time: number): Order {
    const order = this.unwrap(this.createOrder(request, time));
    this.emit(order.id, { type: "accepted" }, time);
    this.executeFill(order.id, fillPrice, request.size, liquidity, time);
    return this.store.get(order.id)!;
  }

  seedRestingOrder(request: OrderRequest, time: number): Order {
    const order = this.unwrap(this.createOrder(request, time));
    this.emit(order.id, { type: "accepted" }, time);
    return this.store.get(order.id)!;
  }

  seedTerminalOrder(request: OrderRequest, status: "cancelled" | "rejected", reason: string, time: number, closedAt: number): Order {
    const order = this.unwrap(this.createOrder(request, time));
    if (status === "rejected") {
      this.emit(order.id, { type: "rejected", reason }, closedAt);
    } else {
      this.emit(order.id, { type: "accepted" }, time);
      this.emit(order.id, { type: "cancel-requested" }, closedAt);
      this.emit(order.id, { type: "cancelled", reason }, closedAt);
    }
    return this.store.get(order.id)!;
  }

  // ----------------------------------------------------------------- outputs

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
    for (const o of this.store.openOrders()) {
      const price = o.price ?? o.triggerPrice;
      if (o.reduceOnly || price === null) continue;
      orderMargin += ((o.size - o.filledSize) * price) / leverageOf(o);
    }
    const equity = this.balance + unrealized;
    const available = equity - marginUsed - orderMargin;
    return {
      origin: "simulated",
      currency: PAPER_CURRENCY,
      balances: [{ asset: PAPER_CURRENCY, total: this.balance, available }],
      balance: this.balance,
      equity,
      unrealizedPnl: unrealized,
      realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid,
      marginUsed,
      orderMargin,
      available,
      maintenanceMargin: maintenance,
      positions: positions.sort((a, b) => a.marketId.localeCompare(b.marketId)),
      observedAt: now,
    };
  }

  state(now: number): AccountState {
    return {
      snapshot: this.snapshot(now),
      openOrders: this.store.openOrders(),
      orderHistory: this.store.history(),
      fills: [...this.store.allFills()],
    };
  }

  // --------------------------------------------------------------- internals

  private unwrap(result: Result<Order>): Order {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  private emit(orderId: string, body: OrderEventBody, time: number): ApplyOutcome {
    this.eventSeq += 1;
    const outcome = this.store.apply({ ...body, eventId: `SIM-E${this.eventSeq}`, orderId, time } as Parameters<OrderStore["apply"]>[0]);
    if (outcome.kind === "rejected") {
      // The simulator must obey the state machine; a violation is a bug.
      throw new Error(`Simulator produced an invalid transition: ${JSON.stringify(outcome.error)}`);
    }
    return outcome;
  }

  private emitResult(orderId: string, body: OrderEventBody, time: number): Result<Order> {
    this.emit(orderId, body, time);
    return { ok: true, value: this.store.get(orderId)! };
  }

  private reject(order: Order, error: TradingError, now: number): Result<Order> {
    this.emit(order.id, { type: "rejected", reason: error.message }, now);
    return { ok: false, error };
  }

  private injectedRejection(order: Order): string | null {
    for (const rule of this.rejectionRules) {
      if (rule.kind === "next" && rule.remaining > 0) {
        rule.remaining -= 1;
        return rule.reason;
      }
      if (rule.kind === "every-nth" && this.processedCount % rule.n === 0) return rule.reason;
      if (rule.kind === "market" && rule.marketId === order.marketId) return rule.reason;
    }
    return null;
  }

  private executableSize(order: Order): number {
    const remaining = order.size - order.filledSize;
    return order.reduceOnly ? Math.min(remaining, this.reducibleSize(order.marketId, order.side)) : remaining;
  }

  private finishTakerOrder(orderId: string, market: Market, now: number): void {
    const order = this.store.get(orderId)!;
    if (isTerminalStatus(order.status)) return;
    const remaining = roundTo(order.size - order.filledSize, market.sizeDecimals);
    if (remaining <= EPSILON) return;
    const ioc = order.type !== "limit" || order.timeInForce === "ioc";
    if (order.reduceOnly && this.reducibleSize(order.marketId, order.side) <= EPSILON) {
      this.emit(orderId, { type: "cancelled", reason: "Reduce-only: remainder exceeds the position; cancelled" }, now);
    } else if (ioc) {
      const reason = order.filledSize > 0 ? "Partially filled; remainder cancelled (IOC)" : "No fill; cancelled (IOC)";
      this.emit(orderId, { type: "cancelled", reason }, now);
    }
  }

  private checkMargin(order: Order, referencePrice: number, now: number, takeSize = order.size): TradingError | null {
    if (order.reduceOnly) return null;
    const increasing = Math.max(0, order.size - this.reducibleSize(order.marketId, order.side));
    const required = (increasing * referencePrice) / leverageOf(order) + Math.max(takeSize, 0) * referencePrice * this.config.fees.taker;
    const available = this.snapshot(now).available;
    if (required <= available + EPSILON) return null;
    return {
      code: "insufficient-margin",
      required,
      available,
      message: `Insufficient margin: requires ${required.toFixed(2)} ${PAPER_CURRENCY}, available ${Math.max(0, available).toFixed(2)}`,
    };
  }

  private triggerReached(order: Order, mark: number): boolean {
    const trigger = order.triggerPrice!;
    const isStop = order.type === "stop-market" || order.type === "stop-limit";
    // Stops fire when price moves against the order direction's "breakout";
    // take-profits fire when price reaches the favourable level.
    if (isStop) return order.side === "buy" ? mark >= trigger : mark <= trigger;
    return order.side === "buy" ? mark <= trigger : mark >= trigger;
  }

  private checkTriggers(marketId: MarketId, mark: number, now: number): void {
    for (const order of this.store.openOrders()) {
      if (order.marketId !== marketId || order.status !== "waiting-trigger") continue;
      if (!this.triggerReached(order, mark)) continue;
      this.emit(order.id, { type: "triggered" }, now);
      const market = this.markets.get(marketId)!;
      const book = this.books.get(marketId);
      const levels = book ? (order.side === "buy" ? book.asks : book.bids) : [];
      const best = levels[0]?.price;
      const executable = this.executableSize(order);
      const takeable =
        best === undefined || this.config.fillModel === "none" || executable <= EPSILON
          ? []
          : this.takeableLevels(levels, order.side, best * (1 + sign(order.side) * (this.slippage.get(order.id) ?? 0.05)), executable);
      for (const level of takeable) this.executeFill(order.id, level.price, level.size, "taker", now);
      const after = this.store.get(order.id)!;
      if (!isTerminalStatus(after.status) && after.filledSize === 0) {
        this.emit(order.id, { type: "cancelled", reason: "Triggered, but no simulated liquidity within the slippage limit" }, now);
      } else {
        this.finishTakerOrder(order.id, market, now);
      }
    }
  }

  private takeableLevels(levels: readonly BookLevel[], side: Side, limit: number, size: number): BookLevel[] {
    const result: BookLevel[] = [];
    let remaining = size;
    for (const level of levels) {
      if (remaining <= EPSILON) break;
      const acceptable = side === "buy" ? level.price <= limit : level.price >= limit;
      if (!acceptable) break;
      const take = Math.min(remaining, level.size * this.config.liquidityFraction);
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

  private executeFill(orderId: string, price: number, size: number, liquidity: Liquidity, now: number, reason?: string): void {
    const order = this.store.get(orderId)!;
    const market = this.markets.get(order.marketId);
    const sizeDecimals = market?.sizeDecimals ?? 8;
    const qty = Math.min(roundTo(size, sizeDecimals), roundTo(order.size - order.filledSize, sizeDecimals));
    if (qty <= 0) return;

    const realized = this.applyToPosition(order.marketId, order.side, qty, price, leverageOf(order), sizeDecimals);
    const feeRate = liquidity === "maker" ? this.config.fees.maker : this.config.fees.taker;
    const fee = qty * price * feeRate;
    this.balance += realized - fee;
    this.realizedPnl += realized;
    this.feesPaid += fee;

    this.fillSeq += 1;
    const fill: Fill = {
      id: `SIM-F${String(this.fillSeq).padStart(6, "0")}`,
      orderId: order.id,
      marketId: order.marketId,
      side: order.side,
      price,
      size: qty,
      fee,
      liquidity,
      realizedPnl: realized,
      time: now,
      origin: "simulated",
    };
    this.emit(order.id, { type: "fill", fill, ...(reason ? { reason } : {}) }, now);
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
      this.positions.set(marketId, { marketId, size: newSize, entryPrice: price, leverage, margin: (Math.abs(newSize) * price) / leverage });
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
    const created = this.createOrder(
      {
        clientOrderId: `sim-liquidation-${this.orderSeq + 1}`,
        marketId,
        side: p.size > 0 ? "sell" : "buy",
        type: "market",
        size: Math.abs(p.size),
        maxSlippage: 0.5,
        reduceOnly: true,
        leverage: p.leverage,
        marginMode: "isolated",
      },
      now,
    );
    const order = this.unwrap(created);
    this.emit(order.id, { type: "accepted" }, now);
    this.executeFill(order.id, mark, Math.abs(p.size), "liquidation", now, "Liquidated by the simulator at mark price");
    // Reduce-only orders no longer have anything to reduce.
    for (const open of this.store.openOrders()) {
      if (open.marketId === marketId && open.reduceOnly) this.cancel(open.id, now, "Position liquidated");
    }
  }
}
