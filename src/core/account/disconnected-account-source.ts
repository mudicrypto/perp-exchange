import type { AccountConnection, AccountDataSource, Unsubscribe } from "../ports";

/** No account is connected in Milestone 1; the UI shows an explicit empty state. */
export class DisconnectedAccountDataSource implements AccountDataSource {
  readonly connection: AccountConnection = { status: "disconnected" };

  subscribeAccount(listener: (snapshot: null) => void): Unsubscribe {
    listener(null);
    return () => {};
  }

  dispose(): void {}
}
