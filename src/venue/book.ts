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

/** Inclusive tick range of an instrument; every resting price lies inside it (checked before resting). */
export interface PriceRange {
  readonly minPriceTicks: number;
  readonly maxPriceTicks: number;
}

/** The operations the engine uses on one side of a book. */
export interface BookSideApi {
  readonly side: Side;
  readonly depth: number;
  best(): PriceLevel | undefined;
  /** Levels best-first, hidden-only levels included. Callers must not mutate the side while iterating. */
  bestFirst(): IterableIterator<PriceLevel>;
  /** Levels with displayed quantity, best-first. Never visits a hidden-only level. */
  displayedBestFirst(): IterableIterator<PriceLevel>;
  level(priceTicks: number): PriceLevel | undefined;
  add(order: Order): void;
  remove(order: Order): void;
  reduce(order: Order, lots: number): void;
}

const FAN = 32;

/**
 * Sparse ordered set of integers in [0, size): a 32-ary tree of 32-bit occupancy words, one Map per tree
 * level, so memory is proportional to the occupied regions only. Every operation (add, delete, min, max,
 * successor, predecessor) walks at most `height` = ⌈log32 size⌉ levels (≤ 8 for the 10^11-tick ceiling),
 * independent of how many members the set holds. Word arithmetic uses division, not shifts, because offsets
 * exceed 2^32.
 */
export class PriceIndex {
  private readonly words: Map<number, number>[];
  private readonly height: number;
  size = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("price index capacity must be a positive safe integer");
    let height = 1;
    for (let reach = FAN; reach < capacity; reach *= FAN) height++;
    this.height = height;
    this.words = Array.from({ length: height }, () => new Map<number, number>());
  }

  has(i: number): boolean {
    const w = this.words[0]!.get(Math.floor(i / FAN));
    return w !== undefined && (w & (1 << (i % FAN))) !== 0;
  }

  add(i: number): void {
    if (this.has(i)) return;
    this.size++;
    for (let level = 0; level < this.height; level++) {
      const node = Math.floor(i / FAN);
      const map = this.words[level]!;
      const old = map.get(node) ?? 0;
      map.set(node, old | (1 << (i % FAN)));
      if (old !== 0) return; // the parent already marks this node
      i = node;
    }
  }

  delete(i: number): void {
    if (!this.has(i)) return;
    this.size--;
    for (let level = 0; level < this.height; level++) {
      const node = Math.floor(i / FAN);
      const map = this.words[level]!;
      const word = (map.get(node) ?? 0) & ~(1 << (i % FAN));
      if (word !== 0) {
        map.set(node, word);
        return;
      }
      map.delete(node); // node emptied: clear it in the parent too
      i = node;
    }
  }

  min(): number | undefined {
    return this.size ? this.descend(this.height - 1, 0, true) : undefined;
  }

  max(): number | undefined {
    return this.size ? this.descend(this.height - 1, 0, false) : undefined;
  }

  /** Smallest member greater than `i`. */
  next(i: number): number | undefined {
    for (let level = 0; level < this.height; level++) {
      const node = Math.floor(i / FAN);
      const bit = i % FAN;
      const word = this.words[level]!.get(node) ?? 0;
      const above = bit === FAN - 1 ? 0 : word & (-1 << (bit + 1));
      if (above !== 0) return this.descend(level - 1, node * FAN + lowestBit(above), true);
      i = node;
    }
    return undefined;
  }

  /** Largest member smaller than `i`. */
  prev(i: number): number | undefined {
    for (let level = 0; level < this.height; level++) {
      const node = Math.floor(i / FAN);
      const bit = i % FAN;
      const word = this.words[level]!.get(node) ?? 0;
      const below = bit === 0 ? 0 : word & ((1 << bit) - 1);
      if (below !== 0) return this.descend(level - 1, node * FAN + highestBit(below), false);
      i = node;
    }
    return undefined;
  }

  /** From `child` (a set bit at `level + 1`), walks down to the smallest (or largest) member below it. */
  private descend(level: number, child: number, lowest: boolean): number {
    let i = child;
    for (let l = level; l >= 0; l--) {
      const word = this.words[l]!.get(i)!;
      i = i * FAN + (lowest ? lowestBit(word) : highestBit(word));
    }
    return i;
  }
}

const lowestBit = (word: number) => 31 - Math.clz32(word & -word);
const highestBit = (word: number) => 31 - Math.clz32(word);

/**
 * One side of a book (Milestone 12). Price levels live in a `Map` and are ordered by two `PriceIndex` sets over
 * `price − minPriceTicks`: every non-empty level, and the levels with displayed quantity. Best price, insert,
 * remove and stepping to the next level cost O(log32 range), independent of how many levels exist — hidden-only
 * levels included — instead of the former sorted array's O(levels) `splice` and `indexOf` (VR-15).
 * `displayedBestFirst` walks the displayed set only, so `publicBook` never visits a hidden-only level (VR-31).
 *
 * Queues within a level are unchanged: displayed and hidden FIFO maps, insertion order = time priority.
 * `onDisplayedChange` is called whenever displayed quantity at a price changes, and never for hidden orders.
 */
export class BookSide implements BookSideApi {
  private readonly levels = new Map<number, PriceLevel>();
  private readonly any: PriceIndex;
  private readonly shown: PriceIndex;
  private readonly min: number;
  private readonly max: number;
  readonly side: Side;
  private readonly onDisplayedChange: (side: Side, priceTicks: number) => void;

  // Explicit fields, not parameter properties: Node's type stripping runs this file directly.
  constructor(side: Side, onDisplayedChange: (side: Side, priceTicks: number) => void, range: PriceRange) {
    this.side = side;
    this.onDisplayedChange = onDisplayedChange;
    this.min = range.minPriceTicks;
    this.max = range.maxPriceTicks;
    const capacity = range.maxPriceTicks - range.minPriceTicks + 1;
    this.any = new PriceIndex(capacity);
    this.shown = new PriceIndex(capacity);
  }

  private offset(priceTicks: number): number {
    if (!Number.isSafeInteger(priceTicks) || priceTicks < this.min || priceTicks > this.max) {
      throw new Error(`price ${priceTicks} outside the instrument range [${this.min}, ${this.max}]`);
    }
    return priceTicks - this.min;
  }

  private first(index: PriceIndex): number | undefined {
    return this.side === "buy" ? index.max() : index.min();
  }

  private after(index: PriceIndex, offset: number): number | undefined {
    return this.side === "buy" ? index.prev(offset) : index.next(offset);
  }

  best(): PriceLevel | undefined {
    const o = this.first(this.any);
    return o === undefined ? undefined : this.levels.get(o + this.min);
  }

  *bestFirst(): IterableIterator<PriceLevel> {
    for (let o = this.first(this.any); o !== undefined; o = this.after(this.any, o)) yield this.levels.get(o + this.min)!;
  }

  *displayedBestFirst(): IterableIterator<PriceLevel> {
    for (let o = this.first(this.shown); o !== undefined; o = this.after(this.shown, o)) yield this.levels.get(o + this.min)!;
  }

  level(priceTicks: number): PriceLevel | undefined {
    return this.levels.get(priceTicks);
  }

  get depth() {
    return this.levels.size;
  }

  add(order: Order): void {
    let level = this.levels.get(order.priceTicks);
    if (!level) {
      const o = this.offset(order.priceTicks);
      level = new PriceLevel(order.priceTicks);
      this.levels.set(order.priceTicks, level);
      this.any.add(o);
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
      this.any.delete(order.priceTicks - this.min);
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
      if (level.displayedLots > 0) this.shown.add(level.priceTicks - this.min);
      else this.shown.delete(level.priceTicks - this.min);
      if (delta !== 0) this.onDisplayedChange(this.side, level.priceTicks);
    } else {
      level.hiddenLots += delta;
    }
  }
}
