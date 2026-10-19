import { leaves, PriceLevel, type BookSideApi, type Order, type PriceRange } from "./book.ts";
import type { Side, Visibility } from "./types.ts";

/**
 * REFERENCE ONLY — the Milestone 1–11 book side (sorted price array, `Array.splice` and `indexOf`), kept
 * verbatim apart from the `displayedBestFirst` adapter. It is used by the differential tests and the timing
 * A/B (Milestone 12) to prove that the indexed `BookSide` changes no matching outcome. The engine never uses
 * it in production.
 *
 * Its insert and remove cost grow with the number of price levels on the side, hidden-only levels included:
 * the timing channel VR-15 that the indexed book removes.
 */
/**
 * One side of a book: price levels kept sorted best-first (bids descending,
 * asks ascending) with binary-search insertion. `onDisplayedChange` is called
 * whenever displayed quantity at a price changes, and never for hidden orders.
 */
export class ReferenceBookSide implements BookSideApi {
  private readonly levels = new Map<number, PriceLevel>();
  private readonly prices: number[] = [];
  readonly side: Side;
  private readonly onDisplayedChange: (side: Side, priceTicks: number) => void;

  // Explicit fields, not parameter properties: Node's type stripping runs this file directly.
  // `range` is accepted for interface compatibility and ignored (the sorted array is unbounded).
  constructor(side: Side, onDisplayedChange: (side: Side, priceTicks: number) => void, range?: PriceRange) {
    void range;
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

  /** Levels with displayed quantity, best-first: exactly the Milestone 11 `publicBook` filter over every level. */
  *displayedBestFirst(): IterableIterator<PriceLevel> {
    for (const l of this.bestFirst()) if (l.displayedLots > 0) yield l;
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
