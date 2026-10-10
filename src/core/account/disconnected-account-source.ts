import type { AccountConnection, AccountDataSource, AccountState, Unsubscribe } from "../ports";

/** No account is connected (live venues in Milestone 1); the UI shows explicit empty states. */
export class DisconnectedAccountDataSource implements AccountDataSource {
  readonly connection: AccountConnection = { status: "disconnected" };

  subscribeAccount(listener: (state: AccountState | null) => void): Unsubscribe {
    listener(null);
    return () => {};
  }

  dispose(): void {}
}
