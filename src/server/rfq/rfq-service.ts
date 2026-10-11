import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { roundSimulatedPrice, SIMULATED_RFQ_COUNTERPARTIES } from "@/adapters/simulation/rfq-counterparties";
import { rfqCounterpartyTokens } from "@/config/parse-server-env";
import { getServerEnv } from "@/config/server-env";
import { RfqDesk } from "@/core/rfq";
import { BoundedSessionMap } from "../security/rate-limit";

export const SESSION_COOKIE = "nova_rfq_session";
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 10_000;
export const MAX_OPEN_RFQS_PER_SESSION = 10;

const randomId = () => randomBytes(18).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();

interface RfqServerState {
  desk: RfqDesk;
  /** Only ids issued by POST /api/session are valid. Full → least recently seen session is evicted. */
  sessions: BoundedSessionMap<{ lastSeen: number }>;
}

const globalState = globalThis as typeof globalThis & { __novaRfq?: RfqServerState };

/**
 * The RFQ service exists only for the simulated venue. Returns null in live
 * mode, where every RFQ route answers 404.
 */
export function getRfqState(): RfqServerState | null {
  if (getServerEnv().NOVA_MARKET_DATA_SOURCE !== "simulation") return null;
  globalState.__novaRfq ??= {
    desk: new RfqDesk(SIMULATED_RFQ_COUNTERPARTIES, { randomId, roundPrice: roundSimulatedPrice }),
    sessions: new BoundedSessionMap(MAX_SESSIONS, SESSION_IDLE_MS),
  };
  return globalState.__novaRfq;
}

export function createSession(state: RfqServerState): string {
  const id = randomBytes(32).toString("base64url");
  state.sessions.set(id, { lastSeen: Date.now() });
  return id;
}

/** The caller's session id, if its cookie names a session this server issued. */
export function requesterSession(state: RfqServerState, request: NextRequest): string | null {
  const id = request.cookies.get(SESSION_COOKIE)?.value;
  if (!id) return null;
  return state.sessions.get(id) ? id : null;
}

/** Counterparty authenticated by a bearer token configured on the server. */
export function counterpartyFromRequest(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]{24,})$/);
  if (!match) return null;
  const presented = digest(match[1]!);
  for (const [id, token] of rfqCounterpartyTokens(getServerEnv())) {
    if (timingSafeEqual(presented, digest(token))) return id;
  }
  return null;
}

/**
 * Cookie-authenticated mutations must come from this origin (defence in
 * depth on top of SameSite=Strict).
 */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  // Compare with the Host the browser addressed (Next may normalise nextUrl's host).
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
