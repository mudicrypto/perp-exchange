import type { AccountSnapshot, Order } from "../domain";

/** What a venue returns for a read-only account lookup. */
export interface VenueAccountReadout {
  snapshot: AccountSnapshot;
  openOrders: Order[];
  /** Records the adapter could not map (reported, never guessed). */
  skipped: { positions: number; orders: number };
}

/** Server-side, read-only account access by public address. */
export interface VenueAccountGateway {
  getAccount(address: string, signal?: AbortSignal): Promise<VenueAccountReadout>;
}
