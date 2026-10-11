import "server-only";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { MOCK_ACCOUNTS, MOCK_USERS, MockAccountGateway, type MockUser } from "@/adapters/mock-accounts/mock-accounts";
import { getServerEnv } from "@/config/server-env";
import { ClaudeAnalystEngine } from "./claude-engine";
import type { AnalystEngine } from "./engine";
import type { ToolAuditEntry } from "./executor";
import { OfflineAnalystEngine } from "./offline-engine";
import type { AnalystPrincipal } from "./principal";
import type { ToolContext } from "./tools";
import { BoundedSessionMap } from "../security/rate-limit";

export const ANALYST_COOKIE = "nova_analyst_session";
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 10_000;
export const QUESTIONS_PER_MINUTE = 20;

interface AnalystSession {
  user: MockUser;
  lastSeen: number;
  questionTimes: number[];
}

interface AnalystState {
  gateway: MockAccountGateway;
  engine: AnalystEngine;
  sessions: BoundedSessionMap<AnalystSession>;
}

const globalState = globalThis as typeof globalThis & { __novaAnalyst?: AnalystState };

/**
 * The analyst exists only with simulated data and mock accounts. It is never
 * connected to a live venue or real funds in this milestone (404 otherwise).
 */
export function getAnalystState(): AnalystState | null {
  const env = getServerEnv();
  if (env.NOVA_MARKET_DATA_SOURCE !== "simulation") return null;
  globalState.__novaAnalyst ??= {
    // Mock history is anchored to the server start (floored to the hour) so it stays stable while the server runs.
    gateway: new MockAccountGateway(Math.floor(Date.now() / 3_600_000) * 3_600_000),
    engine: env.NOVA_ANALYST_ENGINE === "claude" ? ClaudeAnalystEngine.fromEnvironment() : new OfflineAnalystEngine(),
    sessions: new BoundedSessionMap(MAX_SESSIONS, SESSION_IDLE_MS),
  };
  return globalState.__novaAnalyst;
}

export function signIn(state: AnalystState, userId: string): { id: string; user: MockUser } | null {
  const user = MOCK_USERS.find((u) => u.id === userId);
  if (!user) return null;
  const id = randomBytes(32).toString("base64url");
  state.sessions.set(id, { user, lastSeen: Date.now(), questionTimes: [] });
  return { id, user };
}

export function sessionFromRequest(state: AnalystState, request: NextRequest): { id: string; session: AnalystSession } | null {
  const id = request.cookies.get(ANALYST_COOKIE)?.value;
  if (!id) return null;
  const session = state.sessions.get(id);
  return session ? { id, session } : null;
}

/** Sliding one-minute rate limit per session. */
export function allowQuestion(session: AnalystSession, now = Date.now()): boolean {
  session.questionTimes = session.questionTimes.filter((t) => now - t < 60_000);
  if (session.questionTimes.length >= QUESTIONS_PER_MINUTE) return false;
  session.questionTimes.push(now);
  return true;
}

export function principalOf(session: AnalystSession): AnalystPrincipal {
  return { userId: session.user.id, accountIds: session.user.accountIds };
}

export function toolContext(state: AnalystState, principal: AnalystPrincipal, now = Date.now()): ToolContext {
  return { principal, gateway: state.gateway, accounts: MOCK_ACCOUNTS, now };
}

export function accountsOf(user: MockUser) {
  return MOCK_ACCOUNTS.filter((a) => user.accountIds.includes(a.id)).map(({ id, label, currency, origin }) => ({ id, label, currency, origin }));
}

/** Audit line per tool call: tool name, outcome and duration only — no user, account or figures. */
export function auditTool(entry: ToolAuditEntry): void {
  console.info(JSON.stringify({ audit: "analyst", ...entry }));
}
