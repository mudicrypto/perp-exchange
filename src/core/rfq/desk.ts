import type { MarketId, Side } from "../domain";
import {
  RFQ_QUOTE_WINDOW_MS,
  RFQ_RETENTION_MS,
  type RfqAccept,
  type RfqCounterparty,
  type RfqCounterpartyView,
  type RfqCreate,
  type RfqExecution,
  type RfqQuoteInput,
  type RfqRequesterView,
  type RfqStatus,
} from "./model";

export type RfqError =
  /** Also returned when the caller is not authorized: existence is never revealed. */
  | { code: "not-found"; message: string }
  | { code: "invalid"; message: string }
  | { code: "closed"; message: string };

export type RfqResult<T> = { ok: true; value: T } | { ok: false; error: RfqError };

interface StoredQuote {
  id: string;
  counterpartyId: string;
  bid: number | null;
  ask: number | null;
  createdAt: number;
}

interface StoredRfq {
  id: string;
  /** Opaque session id of the requester. Never included in any view. */
  requesterId: string;
  marketId: MarketId;
  size: number;
  side: Side | null;
  counterpartyIds: string[];
  createdAt: number;
  expiresAt: number;
  status: RfqStatus;
  completedAt: number | null;
  quotes: StoredQuote[];
  execution: RfqExecution | null;
}

export interface RfqDeskOptions {
  now?: () => number;
  /** Unguessable id generator (cryptographically random in production). */
  randomId: () => string;
  quoteWindowMs?: number;
  retentionMs?: number;
  /** Rounds a quoted price to the market's tick; null if the market is unknown. */
  roundPrice: (marketId: MarketId, price: number) => number | null;
}

const notFound: RfqResult<never> = { ok: false, error: { code: "not-found", message: "RFQ not found" } };
const invalid = (message: string): RfqResult<never> => ({ ok: false, error: { code: "invalid", message } });
const closed = (message: string): RfqResult<never> => ({ ok: false, error: { code: "closed", message } });

/**
 * Framework-free RFQ desk. Authorization lives here, so it holds no matter
 * which transport calls it: a request is readable only by its requester and,
 * in redacted form, by the counterparties the requester selected.
 * Data minimization: no limit price, no account, no wallet; records are
 * deleted `retentionMs` after completion.
 */
export class RfqDesk {
  private readonly records = new Map<string, StoredRfq>();
  private readonly counterparties: ReadonlyMap<string, RfqCounterparty>;
  private readonly now: () => number;
  private readonly quoteWindowMs: number;
  private readonly retentionMs: number;

  constructor(
    counterparties: readonly RfqCounterparty[],
    private readonly options: RfqDeskOptions,
  ) {
    this.counterparties = new Map(counterparties.map((c) => [c.id, c]));
    this.now = options.now ?? Date.now;
    this.quoteWindowMs = options.quoteWindowMs ?? RFQ_QUOTE_WINDOW_MS;
    this.retentionMs = options.retentionMs ?? RFQ_RETENTION_MS;
  }

  listCounterparties(): { id: string; name: string }[] {
    return [...this.counterparties.values()].map(({ id, name }) => ({ id, name }));
  }

  /** Number of stored records (for retention tests). */
  get size(): number {
    this.sweep();
    return this.records.size;
  }

  create(requesterId: string, input: RfqCreate): RfqResult<RfqRequesterView> {
    this.sweep();
    if (this.options.roundPrice(input.marketId, input.referencePrice) === null) return invalid("Unknown market");
    for (const id of input.counterpartyIds) {
      if (!this.counterparties.has(id)) return invalid("Unknown counterparty");
    }
    const now = this.now();
    const rfq: StoredRfq = {
      id: this.options.randomId(),
      requesterId,
      marketId: input.marketId,
      size: input.size,
      side: input.side,
      counterpartyIds: [...input.counterpartyIds],
      createdAt: now,
      expiresAt: now + this.quoteWindowMs,
      status: "open",
      completedAt: null,
      quotes: [],
      execution: null,
    };
    this.records.set(rfq.id, rfq);
    // Simulated desks answer immediately with a two-way quote around the
    // requester's public reference price (they never see the limit price).
    for (const id of rfq.counterpartyIds) {
      const spread = this.counterparties.get(id)!.autoQuoteSpreadBps;
      if (spread === null) continue;
      const bid = this.options.roundPrice(rfq.marketId, input.referencePrice * (1 - spread / 10_000));
      const ask = this.options.roundPrice(rfq.marketId, input.referencePrice * (1 + spread / 10_000));
      if (bid !== null && ask !== null && bid < ask) this.addQuote(rfq, id, { bid, ask });
    }
    return { ok: true, value: this.requesterView(rfq) };
  }

  getForRequester(requesterId: string, id: string): RfqResult<RfqRequesterView> {
    const rfq = this.find(id);
    if (!rfq || rfq.requesterId !== requesterId) return notFound;
    return { ok: true, value: this.requesterView(rfq) };
  }

  listForRequester(requesterId: string): RfqRequesterView[] {
    this.sweep();
    return [...this.records.values()].filter((r) => r.requesterId === requesterId).map((r) => this.requesterView(r));
  }

  cancel(requesterId: string, id: string): RfqResult<RfqRequesterView> {
    const rfq = this.find(id);
    if (!rfq || rfq.requesterId !== requesterId) return notFound;
    if (rfq.status !== "open") return closed(`RFQ is already ${rfq.status}`);
    this.complete(rfq, "cancelled");
    return { ok: true, value: this.requesterView(rfq) };
  }

  /**
   * Accepts one quote. The requester states its side only now (if it was not
   * revealed): buying takes the counterparty's ask, selling hits its bid.
   */
  accept(requesterId: string, id: string, input: RfqAccept): RfqResult<RfqRequesterView> {
    const rfq = this.find(id);
    if (!rfq || rfq.requesterId !== requesterId) return notFound;
    if (rfq.status !== "open") return closed(`RFQ is already ${rfq.status}`);
    if (rfq.side !== null && rfq.side !== input.side) return invalid("Side differs from the side revealed in the request");
    const quote = rfq.quotes.find((q) => q.id === input.quoteId);
    if (!quote) return invalid("Unknown quote");
    const price = input.side === "buy" ? quote.ask : quote.bid;
    if (price === null) return invalid(`The quote has no ${input.side === "buy" ? "ask" : "bid"}`);
    rfq.execution = {
      quoteId: quote.id,
      counterpartyId: quote.counterpartyId,
      counterpartyName: this.counterparties.get(quote.counterpartyId)!.name,
      side: input.side,
      price,
      size: rfq.size,
      time: this.now(),
    };
    this.complete(rfq, "accepted");
    return { ok: true, value: this.requesterView(rfq) };
  }

  /** Requests addressed to this counterparty, redacted. */
  inbox(counterpartyId: string): RfqCounterpartyView[] {
    this.sweep();
    if (!this.counterparties.has(counterpartyId)) return [];
    return [...this.records.values()]
      .filter((r) => r.counterpartyIds.includes(counterpartyId))
      .map((r) => counterpartyView(r, counterpartyId));
  }

  quote(counterpartyId: string, id: string, input: RfqQuoteInput): RfqResult<RfqCounterpartyView> {
    const rfq = this.find(id);
    if (!rfq || !rfq.counterpartyIds.includes(counterpartyId)) return notFound;
    if (rfq.status !== "open") return closed("RFQ is closed");
    const bid = input.bid === null ? null : this.options.roundPrice(rfq.marketId, input.bid);
    const ask = input.ask === null ? null : this.options.roundPrice(rfq.marketId, input.ask);
    if ((input.bid !== null && bid !== input.bid) || (input.ask !== null && ask !== input.ask)) return invalid("Price is not on the market's tick");
    // One live quote per counterparty: a new quote replaces the previous one.
    rfq.quotes = rfq.quotes.filter((q) => q.counterpartyId !== counterpartyId);
    this.addQuote(rfq, counterpartyId, { bid, ask });
    return { ok: true, value: counterpartyView(rfq, counterpartyId) };
  }

  /** Expires open requests past their window and deletes old completed ones. */
  sweep(): void {
    const now = this.now();
    for (const rfq of this.records.values()) {
      if (rfq.status === "open" && now >= rfq.expiresAt) this.complete(rfq, "expired", rfq.expiresAt);
      if (rfq.completedAt !== null && now - rfq.completedAt >= this.retentionMs) this.records.delete(rfq.id);
    }
  }

  private find(id: string): StoredRfq | undefined {
    this.sweep();
    return this.records.get(id);
  }

  private addQuote(rfq: StoredRfq, counterpartyId: string, prices: { bid: number | null; ask: number | null }): void {
    rfq.quotes.push({ id: this.options.randomId(), counterpartyId, ...prices, createdAt: this.now() });
  }

  private complete(rfq: StoredRfq, status: Exclude<RfqStatus, "open">, at = this.now()): void {
    rfq.status = status;
    rfq.completedAt = at;
  }

  private requesterView(rfq: StoredRfq): RfqRequesterView {
    const name = (id: string) => this.counterparties.get(id)?.name ?? id;
    return {
      id: rfq.id,
      marketId: rfq.marketId,
      size: rfq.size,
      side: rfq.side,
      status: rfq.status,
      createdAt: rfq.createdAt,
      expiresAt: rfq.expiresAt,
      counterparties: rfq.counterpartyIds.map((id) => ({ id, name: name(id) })),
      quotes: rfq.quotes.map((q) => ({ ...q, counterpartyName: name(q.counterpartyId), size: rfq.size })),
      execution: rfq.execution ? { ...rfq.execution } : null,
    };
  }
}

/**
 * The redacted record a counterparty receives. Exported so the privacy
 * disclosure can be checked against what the service actually sends.
 */
export function counterpartyView(
  rfq: Pick<StoredRfq, "id" | "marketId" | "size" | "side" | "status" | "createdAt" | "expiresAt" | "quotes" | "execution">,
  counterpartyId: string,
): RfqCounterpartyView {
  const mine = rfq.quotes.find((q) => q.counterpartyId === counterpartyId) ?? null;
  const tradedWithYou = rfq.execution !== null && rfq.execution.counterpartyId === counterpartyId;
  return {
    requestId: rfq.id,
    marketId: rfq.marketId,
    size: rfq.size,
    requesterSide: tradedWithYou ? rfq.execution!.side : rfq.side,
    status: tradedWithYou ? "traded-with-you" : rfq.status === "open" ? "open" : "closed",
    createdAt: rfq.createdAt,
    expiresAt: rfq.expiresAt,
    yourQuote: mine ? { bid: mine.bid, ask: mine.ask } : null,
    execution: tradedWithYou ? { requesterSide: rfq.execution!.side, price: rfq.execution!.price, size: rfq.execution!.size } : null,
  };
}
