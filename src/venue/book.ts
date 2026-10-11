import type { OrderStatus, Side, StpMode, TimeInForce, Visibility } from "./types.ts";

/** Mutable engine-internal order record. Never handed to clients directly. */
export interface Order {
  readonly orderId: string;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly instrumentId: string;
  readonly side: Side;
  readonly visibility: Visibility;
  readonly tif: TimeInForce;
  readonly postOnly: boolean;
  readonly stp: StpMode;
  priceTicks: number;
  qtyLots: number;
  filledLots: number;
  status: OrderStatus;
  /** Sequence number at which the order last obtained time priority. */
  priority: number;
}

export const leaves = (o: Order) => o.qtyLots - o.filledLots;

/**
 * One price level. Displayed and hidden orders queue separately; each Map
 * iterates in insertion order, which is time priority. Losing priority means
 * delete + re-insert (moves to the back).
 */
export class PriceLevel {
  readonly displayed = new Map<string, Order>();
  readonly hidden = new Map<string, Order>();
  displayedLots = 0;
  hiddenLots = 0;
  readonly priceTicks: number;
  constructor(priceTicks: number) {
    this.priceTicks = priceTicks;
  }

  get empty() {
    return this.displayed.size === 0 && this.hidden.size === 0;
  }

  queue(visibility: Visibility) {
    return visibility === "displayed" ? this.displayed : this.hidden;
  }
}

/**
 * One side of a book: price levels kept sorted best-first (bids descending,
 * asks ascending) with binary-search insertion. `onDisplayedChange` is called
 * whenever displayed quantity at a price changes, and never for hidden orders.
 */
export class BookSide {
  private readonly levels = new Map<number, PriceLevel>();
  private readonly prices: number[] = [];
  readonly side: Side;
  private readonly onDisplayedChange: (side: Side, priceTicks: number) => void;

  // Explicit fields, not parameter properties: Node's type stripping runs this file directly.
  constructor(side: Side, onDisplayedChange: (side: Side, priceTicks: number) => void) {
    this.side = side;
    this.onDisplayedChange = onDisplayedChange;
  }

  /** True if `a` is a better price than `b` on this side. */
  private better(a: number, b: number) {
    return this.side === "buy" ? a > b : a < b;
  }

  best(): PriceLevel | undefined {
    const p = this.prices[0];
    return p === undefined ? undefined : this.levels.get(p);
  }

  /** Levels best-first. Callers must not mutate the side while iterating. */
  *bestFirst(): IterableIterator<PriceLevel> {
    for (const p of this.prices) yield this.levels.get(p)!;
  }

  level(priceTicks: number): PriceLevel | undefined {
    return this.levels.get(priceTicks);
  }

  get depth() {
    return this.prices.length;
  }

  add(order: Order): void {
    let level = this.levels.get(order.priceTicks);
    if (!level) {
      level = new PriceLevel(order.priceTicks);
      this.levels.set(order.priceTicks, level);
      let lo = 0;
      let hi = this.prices.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.better(this.prices[mid]!, order.priceTicks)) lo = mid + 1;
        else hi = mid;
      }
      this.prices.splice(lo, 0, order.priceTicks);
    }
    level.queue(order.visibility).set(order.orderId, order);
    this.adjust(level, order.visibility, leaves(order));
  }

  remove(order: Order): void {
    const level = this.levels.get(order.priceTicks);
    if (!level || !level.queue(order.visibility).delete(order.orderId)) throw new Error(`order ${order.orderId} not in book`);
    this.adjust(level, order.visibility, -leaves(order));
    if (level.empty) {
      this.levels.delete(order.priceTicks);
      this.prices.splice(this.prices.indexOf(order.priceTicks), 1);
    }
  }

  /** Records a change of resting quantity for an order that stays in place (fill or reduce). */
  reduce(order: Order, lots: number): void {
    const level = this.levels.get(order.priceTicks);
    if (!level || !level.queue(order.visibility).has(order.orderId)) throw new Error(`order ${order.orderId} not in book`);
    this.adjust(level, order.visibility, -lots);
  }

  private adjust(level: PriceLevel, visibility: Visibility, delta: number) {
    if (visibility === "displayed") {
      level.displayedLots += delta;
      if (delta !== 0) this.onDisplayedChange(this.side, level.priceTicks);
    } else {
      level.hiddenLots += delta;
    }
  }
}
