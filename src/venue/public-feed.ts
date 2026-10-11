import { publicMessageSchema, type PublicBook, type PublicMessage, type Side } from "./types.ts";

/**
 * Client-side reconstruction of the public displayed book from the public
 * feed, as an external market-data consumer would build it. Messages are
 * validated as untrusted input; a sequence gap or duplicate marks the mirror
 * stale until it is rebuilt from a snapshot.
 */
export class PublicBookMirror {
  private readonly books = new Map<string, Map<string, number>>();
  private lastSeq = 0;
  stale = false;
  readonly trades: Extract<PublicMessage, { kind: "trade" }>[] = [];

  apply(raw: unknown): void {
    const message = publicMessageSchema.parse(raw);
    if (message.publicSeq <= this.lastSeq) return; // duplicate delivery
    if (message.publicSeq !== this.lastSeq + 1) this.stale = true;
    this.lastSeq = message.publicSeq;
    if (message.kind === "trade") this.trades.push(message);
    if (message.kind !== "level") return;
    let book = this.books.get(message.instrumentId);
    if (!book) this.books.set(message.instrumentId, (book = new Map()));
    const key = `${message.side}:${message.priceTicks}`;
    if (message.displayedLots === 0) book.delete(key);
    else book.set(key, message.displayedLots);
  }

  get sequence() {
    return this.lastSeq;
  }

  levels(instrumentId: string): Map<string, number> {
    return new Map(this.books.get(instrumentId));
  }

  book(instrumentId: string): PublicBook {
    const bids: { priceTicks: number; displayedLots: number }[] = [];
    const asks: { priceTicks: number; displayedLots: number }[] = [];
    for (const [key, lots] of this.books.get(instrumentId) ?? []) {
      const [side, price] = key.split(":") as [Side, string];
      (side === "buy" ? bids : asks).push({ priceTicks: Number(price), displayedLots: lots });
    }
    bids.sort((a, b) => b.priceTicks - a.priceTicks);
    asks.sort((a, b) => a.priceTicks - b.priceTicks);
    return { instrumentId, bids, asks };
  }
}
