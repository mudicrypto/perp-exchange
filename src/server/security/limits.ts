import "server-only";
import { SlidingWindowLimiter } from "./rate-limit";

/**
 * A per-client limit plus a separate, larger limit for the "shared" key used
 * when the client cannot be identified (no trusted proxy header): one
 * anonymous client must not be able to lock out everyone, and the server
 * still has an overall ceiling.
 */
export interface LimiterPair {
  client: SlidingWindowLimiter;
  shared: SlidingWindowLimiter;
}

const pair = (perClient: number, shared: number, windowMs = 60_000): LimiterPair => ({
  client: new SlidingWindowLimiter(perClient, windowMs),
  shared: new SlidingWindowLimiter(shared, windowMs),
});

export const pick = (p: LimiterPair, key: string) => (key === "shared" ? p.shared : p.client);

function create() {
  return {
    /** New anonymous / mock sessions. */
    sessionCreate: pair(20, 600),
    /** Failed counterparty bearer-token attempts (brute-force guard). */
    counterpartyAuthFailure: pair(10, 100),
    /** Venue-backed reads (the venue weight budget is shared by everyone). */
    venueRead: pair(120, 2_000),
    /** Account lookups by address. */
    accountLookup: pair(20, 300),
    /** RFQ mutations per session (keys are session ids, never "shared"). */
    rfqMutation: pair(60, 60),
  };
}

const g = globalThis as typeof globalThis & { __novaLimiters?: ReturnType<typeof create> };

export function limiters() {
  g.__novaLimiters ??= create();
  return g.__novaLimiters;
}
