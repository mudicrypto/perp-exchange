import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS, type ClientMessage } from "./gateway";
import { createLocalVenue } from "./synthetic";
import { ALPHA } from "./test-helpers";

/**
 * Milestone 11, WP4: budget on unfilled FOK orders (VR-08, MATCHING-RULES H-7 and M-8).
 *
 * A FOK that cannot fill reveals "less than Q available at or better than P, hidden included" without an
 * execution. Every unfilled FOK now counts toward a separate per-account budget (default 20 per 60 s);
 * beyond it, FOK orders are refused before journaling. Counting depends only on the client's own visible
 * outcome, so the throttle itself reveals nothing about hidden liquidity. Identical retries answered from
 * the idempotency ledger are not throttled (A-4).
 *
 * Written before the implementation and run first against 9812049 + WP1–WP3
 * (docs/venue/verification/m11/wp4-tests-before-implementation.log).
 */

const ACCOUNTS = ["syn-maker", "syn-probe", "syn-other"];
const hiddenAsk: ClientMessage = { op: "new", clientOrderId: "h", instrumentId: ALPHA, side: "sell", type: "limit", price: "2000.50", quantity: "0.500", visibility: "hidden" };
const fok = (clientOrderId: string, o: Partial<Extract<ClientMessage, { op: "new" }>> = {}): ClientMessage => ({
  op: "new",
  clientOrderId,
  instrumentId: ALPHA,
  side: "buy",
  type: "limit",
  price: "2000.50",
  quantity: "0.600",
  timeInForce: "fok",
  ...o,
});
const outcome = (r: ReturnType<ReturnType<typeof createLocalVenue>["gateway"]["handle"]>) =>
  r.ok ? ((r.events.at(-1) as { reason?: string }).reason ?? r.events.at(-1)!.kind) : r.error.code;

function world(limit = 3) {
  const lv = createLocalVenue({ accounts: ACCOUNTS, gateway: { fokUnfilled: { limit, windowMs: 60_000 } } });
  lv.gateway.handle(lv.tokens.get("syn-maker")!, hiddenAsk);
  return lv;
}

describe("H-7 / VR-08 unfilled FOK budget", () => {
  it("H-7 every unfilled FOK counts toward a per-account budget; beyond it FOK orders are refused before journaling", () => {
    const { gateway, tokens, venue } = world(3);
    const t = tokens.get("syn-probe")!;
    expect([1, 2, 3].map((i) => outcome(gateway.handle(t, fok(`f${i}`))))).toEqual(["fok-unfilled", "fok-unfilled", "fok-unfilled"]);
    const seq = venue.journal.lastSeq;
    expect(gateway.handle(t, fok("f4"))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    // A FOK that would fill is refused too while the budget is exhausted (the check comes before the sequencer).
    expect(gateway.handle(t, fok("f5", { quantity: "0.100" }))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    expect(venue.journal.lastSeq).toBe(seq);
    expect(venue.executions).toHaveLength(0);
    // Other order types are unaffected, and the post-only budget is separate.
    expect(outcome(gateway.handle(t, fok("g1", { timeInForce: "gtc", price: "1990.00", quantity: "0.010" })))).toBe("accepted");
    expect(outcome(gateway.handle(t, fok("g2", { timeInForce: "ioc", quantity: "0.010" })))).not.toBe("rate-limited");
    expect(outcome(gateway.handle(t, fok("g3", { timeInForce: "gtc", price: "1990.00", quantity: "0.010", postOnly: true })))).toBe("accepted");
    expect(gateway.refusalCounts.get("rate-limited")).toBe(2);
  });

  it("H-7 the budget is per account, survives reconnects, and frees up when the window passes", () => {
    const { gateway, tokens, clock } = world(2);
    const t = tokens.get("syn-probe")!;
    gateway.handle(t, fok("f1"));
    gateway.handle(t, fok("f2"));
    expect(gateway.handle(gateway.openSession("syn-probe"), fok("f3"))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    expect(outcome(gateway.handle(tokens.get("syn-other")!, fok("o1")))).toBe("fok-unfilled");
    clock.advance(60_001);
    expect(outcome(gateway.handle(t, fok("f4")))).toBe("fok-unfilled");
  });

  it("M-8 a FOK that fills does not count; unfilled market FOKs do", () => {
    const { gateway, tokens } = world(2);
    const t = tokens.get("syn-probe")!;
    expect(outcome(gateway.handle(t, fok("fill", { quantity: "0.100" })))).toBe("fill");
    expect(outcome(gateway.handle(t, fok("m1", { type: "market", price: undefined, quantity: "9.000" })))).toBe("fok-unfilled");
    expect(outcome(gateway.handle(t, fok("m2", { type: "market", price: undefined, quantity: "9.000" })))).toBe("fok-unfilled");
    expect(gateway.handle(t, fok("m3", { type: "market", price: undefined, quantity: "0.100" }))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
  });

  it("A-4 an identical retry of an accepted FOK is answered from the ledger even when the budget is exhausted; a conflicting one is still refused as a conflict", () => {
    const { gateway, tokens, venue } = world(1);
    const t = tokens.get("syn-probe")!;
    const first = gateway.handle(t, fok("f1"));
    expect(outcome(first)).toBe("fok-unfilled");
    const seq = venue.journal.lastSeq;
    const retry = gateway.handle(t, fok("f1"));
    expect(retry).toEqual({ ...first, replayed: true });
    expect(gateway.handle(t, fok("f1", { quantity: "0.700" }))).toMatchObject({ ok: false, error: { code: "idempotency-conflict" } });
    expect(venue.journal.lastSeq).toBe(seq);
  });

  it("H-7 counting depends only on the caller's own outcome: hidden liquidity or an empty book exhaust the budget identically", () => {
    // syn-probe faces resting hidden liquidity (insufficient); syn-other probes a side with nothing at all.
    const { gateway, tokens } = world(2);
    const run = (token: string, side: "buy" | "sell", price: string) => [1, 2, 3].map((i) => outcome(gateway.handle(token, fok(`${side}${i}`, { side, price }))));
    expect(run(tokens.get("syn-probe")!, "buy", "2000.50")).toEqual(["fok-unfilled", "fok-unfilled", "rate-limited"]);
    expect(run(tokens.get("syn-other")!, "sell", "1990.00")).toEqual(["fok-unfilled", "fok-unfilled", "rate-limited"]);
  });

  it("H-7 the default budget is 20 unfilled FOK orders per account per 60 s", () => {
    expect(DEFAULT_GATEWAY_LIMITS.fokUnfilled).toEqual({ limit: 20, windowMs: 60_000 });
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    const t = lv.tokens.get("syn-probe")!;
    const outcomes = Array.from({ length: 21 }, (_, i) => outcome(lv.gateway.handle(t, fok(`d${i}`))));
    expect(outcomes.slice(0, 20).every((o) => o === "fok-unfilled")).toBe(true);
    expect(outcomes[20]).toBe("rate-limited");
  });
});
