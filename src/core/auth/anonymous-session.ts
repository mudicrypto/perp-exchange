import type { Permission, Session, SessionProvider } from "../ports";

const ANONYMOUS_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["market-data:read"]);

/** Milestone 1: everyone is anonymous and may only read public market data. */
export class AnonymousSessionProvider implements SessionProvider {
  private readonly session: Session = {
    kind: "anonymous",
    address: null,
    permissions: ANONYMOUS_PERMISSIONS,
  };

  current(): Session {
    return this.session;
  }

  can(permission: Permission): boolean {
    return this.session.permissions.has(permission);
  }
}
