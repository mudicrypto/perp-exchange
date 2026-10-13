import { randomBytes } from "node:crypto";

/**
 * Order-ID key policy (MATCHING-RULES A-5, docs/venue/RECOVERY-INTEGRITY.md §3).
 *
 * Order, fill and execution ids are a keyed hash of internal counters (H-8);
 * whoever knows the key can map ids back to global sequence numbers. The key
 * must therefore be a real secret, and the deterministic keys used by tests,
 * the demo and benchmarks must never become a runtime default.
 *
 * Enforced at the `Venue` boundary (constructor and `Venue.recover`). The
 * matching engine itself takes the key unvalidated and is unchanged.
 */

/** 43 base64url characters carry 256 bits when the characters are random. */
export const MIN_ID_KEY_LENGTH = 43;
/** Heuristic against obviously non-random keys (randomness itself cannot be verified). */
export const MIN_ID_KEY_DISTINCT_CHARACTERS = 16;

/** Deterministic key for tests and the synthetic demo. Accepted only with `allowTestFixtureIdKey`. */
export const TEST_FIXTURE_ID_KEY = "local-prototype-key";
/** Deterministic key for benchmarks. Accepted only with `allowTestFixtureIdKey`. */
export const PERF_FIXTURE_ID_KEY = "perf-key";
export const TEST_FIXTURE_ID_KEYS: ReadonlySet<string> = new Set([TEST_FIXTURE_ID_KEY, PERF_FIXTURE_ID_KEY]);

export class IdKeyPolicyError extends Error {
  override readonly name = "IdKeyPolicyError";
}

/** A key that satisfies the policy: 32 random bytes, base64url (43 characters). */
export function generateIdKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Throws `IdKeyPolicyError` unless `key` satisfies the policy. A registered
 * test-fixture key passes only when `allowTestFixture` is true; the flag never
 * relaxes the policy for any other key. Messages never contain the key.
 */
export function assertIdKeyPolicy(key: unknown, allowTestFixture: boolean): void {
  if (typeof key !== "string" || key.length === 0) throw new IdKeyPolicyError("Order-ID key is required.");
  if (TEST_FIXTURE_ID_KEYS.has(key)) {
    if (allowTestFixture) return;
    throw new IdKeyPolicyError("Order-ID key is a test-fixture key; it is accepted only with allowTestFixtureIdKey (tests, demo, benchmarks).");
  }
  if (key.length < MIN_ID_KEY_LENGTH) throw new IdKeyPolicyError(`Order-ID key must be at least ${MIN_ID_KEY_LENGTH} characters (use generateIdKey()).`);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new IdKeyPolicyError("Order-ID key must use the base64url alphabet [A-Za-z0-9_-].");
  if (new Set(key).size < MIN_ID_KEY_DISTINCT_CHARACTERS) {
    throw new IdKeyPolicyError(`Order-ID key must contain at least ${MIN_ID_KEY_DISTINCT_CHARACTERS} distinct characters.`);
  }
}
