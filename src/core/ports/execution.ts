import type {
  Fill,
  Instrument,
  Market,
  MarketId,
  Order,
  OrderRequest,
  Position,
  Result,
} from "../domain";
import type { ValidationContext, VenueCapabilities } from "../trading";
import type { AccountState } from "./account-data";
import type { Unsubscribe } from "./market-data";

/** Which account an adapter should read. Never a private key. */
export type AccountRef =
  /** The adapter's own simulated paper account. */
  | { kind: "simulated" }
  /** A public on-chain address (read-only / watch-only). */
  | { kind: "address"; address: string };

export type CancelTarget = { orderId: string } | { clientOrderId: string };

/**
 * Venue-independent execution contract. Every method returns a typed
 * Result; a feature the venue (or Nova) does not support yields an
 * `unsupported` error naming the capability — adapters never emulate.
 */
export interface ExecutionAdapter {
  readonly venueId: string;
  /** "simulated" adapters never touch real funds or real order books. */
  readonly origin: "simulated" | "venue";

  /** Declared capabilities (every capability id has an explicit status). */
  getCapabilities(): VenueCapabilities;

  /** Adds this venue's trading rules to a market description. */
  describeInstrument(market: Market): Instrument;

  /** Synchronous, side-effect-free validation (also used for UI previews). */
  validateOrder(input: unknown, instrument: Instrument, context?: ValidationContext): Result<OrderRequest>;

  submitOrder(request: OrderRequest, instrument: Instrument): Promise<Result<Order>>;
  cancelOrder(target: CancelTarget): Promise<Result<Order>>;
  /** Cancels all working orders (optionally for one market); returns the count. */
  cancelAllOrders(marketId?: MarketId): Promise<Result<number>>;

  fetchOpenOrders(account: AccountRef): Promise<Result<Order[]>>;
  fetchPositions(account: AccountRef): Promise<Result<Position[]>>;
  fetchAccountState(account: AccountRef): Promise<Result<AccountState>>;

  subscribeOrderUpdates(account: AccountRef, listener: (order: Order) => void): Result<Unsubscribe>;
  subscribeFills(account: AccountRef, listener: (fill: Fill) => void): Result<Unsubscribe>;
}
