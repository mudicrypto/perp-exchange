import { isTerminalStatus, type Fill, type Order } from "../domain";
import { transitionOrder, type OrderEvent, type TransitionError } from "./order-lifecycle";

export type ApplyOutcome =
  | { kind: "applied"; order: Order }
  /** Same eventId (or same fill id) seen before: ignored. */
  | { kind: "duplicate" }
  /** Sequence older than the last applied one: ignored. */
  | { kind: "stale" }
  | { kind: "unknown-order" }
  | { kind: "rejected"; error: TransitionError };

export interface OrderStoreChange {
  order: Order;
  fill: Fill | null;
}

const HISTORY_LIMIT = 200;
const FILL_LIMIT = 500;
const SEEN_EVENT_LIMIT = 5_000;

/**
 * Reconciliation core: holds orders and fills and applies lifecycle events
 * idempotently.
 *  - duplicate events (same eventId) and duplicate fills (same fill id) are dropped
 *  - events with a sequence ≤ the order's last applied sequence are dropped
 *  - invalid transitions are reported, never forced
 */
export class OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly byClientId = new Map<string, string>();
  private readonly seenEvents = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly fillIds = new Set<string>();
  private fills: Fill[] = [];
  private readonly listeners = new Set<(change: OrderStoreChange) => void>();

  /** Registers a new order (status must be pending-new). Returns false on duplicate ids. */
  add(order: Order): boolean {
    if (this.orders.has(order.id) || this.byClientId.has(order.clientOrderId)) return false;
    this.orders.set(order.id, order);
    this.byClientId.set(order.clientOrderId, order.id);
    this.notify({ order, fill: null });
    return true;
  }

  hasClientOrderId(clientOrderId: string): boolean {
    return this.byClientId.has(clientOrderId);
  }

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  getByClientOrderId(clientOrderId: string): Order | undefined {
    const id = this.byClientId.get(clientOrderId);
    return id ? this.orders.get(id) : undefined;
  }

  apply(event: OrderEvent): ApplyOutcome {
    if (this.seenEvents.has(event.eventId)) return { kind: "duplicate" };
    const order = this.orders.get(event.orderId);
    if (!order) return { kind: "unknown-order" };
    if (event.sequence !== undefined && order.lastSequence !== null && event.sequence <= order.lastSequence) {
      this.remember(event.eventId);
      return { kind: "stale" };
    }
    if (event.type === "fill" && this.fillIds.has(event.fill.id)) {
      this.remember(event.eventId);
      return { kind: "duplicate" };
    }

    const result = transitionOrder(order, event);
    if (!result.ok) return { kind: "rejected", error: result.error };

    this.remember(event.eventId);
    this.orders.set(order.id, result.order);
    let fill: Fill | null = null;
    if (event.type === "fill") {
      fill = event.fill;
      this.fillIds.add(fill.id);
      this.fills = [fill, ...this.fills].slice(0, FILL_LIMIT);
    }
    this.notify({ order: result.order, fill });
    return { kind: "applied", order: result.order };
  }

  /** Records a fill that has no order (e.g. a liquidation), de-duplicated by id. */
  recordStandaloneFill(fill: Fill): boolean {
    if (this.fillIds.has(fill.id)) return false;
    this.fillIds.add(fill.id);
    this.fills = [fill, ...this.fills].slice(0, FILL_LIMIT);
    return true;
  }

  /** Working orders (not terminal), newest first. */
  openOrders(): Order[] {
    return [...this.orders.values()].filter((o) => !isTerminalStatus(o.status)).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Terminal orders, most recently updated first. */
  history(): Order[] {
    return [...this.orders.values()]
      .filter((o) => isTerminalStatus(o.status))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .slice(0, HISTORY_LIMIT);
  }

  allFills(): readonly Fill[] {
    return this.fills;
  }

  subscribe(listener: (change: OrderStoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private remember(eventId: string): void {
    this.seenEvents.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length > SEEN_EVENT_LIMIT) {
      const evicted = this.seenEventOrder.shift();
      if (evicted) this.seenEvents.delete(evicted);
    }
  }

  private notify(change: OrderStoreChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
