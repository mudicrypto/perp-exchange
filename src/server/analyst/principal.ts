/** The authenticated caller. `accountIds` is the complete set of accounts they may read. */
export interface AnalystPrincipal {
  userId: string;
  accountIds: readonly string[];
}

export class AuthorizationError extends Error {
  constructor(readonly accountId: string) {
    // Deliberately does not reveal whether the account exists.
    super("Not authorized for this account");
    this.name = "AuthorizationError";
  }
}

/** Account-level authorization, called by every tool before any data is loaded. */
export function authorize(principal: AnalystPrincipal, accountId: string): void {
  if (!principal.accountIds.includes(accountId)) throw new AuthorizationError(accountId);
}
