export type Permission = "market-data:read" | "account:read" | "orders:submit";

export interface Session {
  kind: "anonymous" | "wallet";
  /** Public wallet address for wallet sessions; never a private key. */
  address: string | null;
  permissions: ReadonlySet<Permission>;
}

export interface SessionProvider {
  current(): Session;
  can(permission: Permission): boolean;
}
