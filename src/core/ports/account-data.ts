import type { AccountSnapshot } from "../domain";
import type { Unsubscribe } from "./market-data";

export type AccountConnection =
  | { status: "disconnected" }
  | { status: "watch-only"; address: string }
  | { status: "error"; message: string };

/**
 * Read access to an account's state. Never requires or accepts private keys
 * or seed phrases: watch-only access uses a public address, and signing (M4+)
 * will happen in the user's wallet, not in Nova.
 */
export interface AccountDataSource {
  readonly connection: AccountConnection;
  subscribeAccount(listener: (snapshot: AccountSnapshot | null) => void): Unsubscribe;
  dispose(): void;
}
