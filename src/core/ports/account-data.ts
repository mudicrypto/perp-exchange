import type { AccountSnapshot, Fill, Order } from "../domain";
import type { Unsubscribe } from "./market-data";

export type AccountConnection =
  | { status: "disconnected" }
  /** Simulated paper account: fictitious collateral, fills only against simulated books. */
  | { status: "paper"; label: string }
  | { status: "watch-only"; address: string }
  | { status: "error"; message: string };

export interface AccountState {
  snapshot: AccountSnapshot;
  /** Newest first. */
  openOrders: readonly Order[];
  /** Terminal orders (filled / cancelled / rejected), newest first. */
  orderHistory: readonly Order[];
  /** Newest first. */
  fills: readonly Fill[];
}

/**
 * Read access to an account's state. Never requires or accepts private keys
 * or seed phrases: watch-only access uses a public address, and signing (M4+)
 * will happen in the user's wallet, not in Nova.
 */
export interface AccountDataSource {
  readonly connection: AccountConnection;
  /** Emits null when no account is available. */
  subscribeAccount(listener: (state: AccountState | null) => void): Unsubscribe;
  dispose(): void;
}
