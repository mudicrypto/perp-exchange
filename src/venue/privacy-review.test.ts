import { describe, expect, it } from "vitest";
import { sha256 } from "./journal";
import { VenueGateway } from "./gateway";
import { createLocalVenue } from "./synthetic";
import { ALPHA, harness } from "./test-helpers";
import type { PublicMessage } from "./types";

/**
 * Phase D: what each adversary class can learn about hidden orders.
 * docs/venue/PRIVACY-REVIEW.md maps every test here to a threat model (A–E)
 * and states whether the channel is closed, reduced, or open.
 */

const ACCOUNTS = ["syn-maker", "syn-probe", "syn-other"];
const hiddenAsk = { op: "new", clientOrderId: "h", instrumentId: ALPHA, side: "sell", type: "limit", price: "2000.50", quantity: "0.500", visibility: "hidden" } as const;
const msg = (o: Record<string, unknown>) => ({ op: "new", instrumentId: ALPHA, side: "buy", type: "limit", quantity: "0.010", ...o });

describe("A — unauthenticated public observer", () => {
  it("H-1 add, replace and cancel of a hidden order produce no public message in either publication mode", () => {
    for (const publication of ["immediate", "batched"] as const) {
      const h = harness({ accounts: ACCOUNTS, publication });
      h.venue.submit({ type: "publish" });
      const before = h.venue.publicTape.length;
      h.order("syn-maker", { side: "sell", priceTicks: 4_200, qtyLots: 300, visibility: "hidden", clientOrderId: "h" });
      h.venue.submit({ type: "replace", accountId: "syn-maker", ref: { clientOrderId: "h" }, priceTicks: 4_150, qtyLots: 500 });
      h.venue.submit({ type: "replace", accountId: "syn-maker", ref: { clientOrderId: "h" }, priceTicks: 4_150, qtyLots: 200 });
      h.venue.submit({ type: "cancel", accountId: "syn-maker", ref: { clientOrderId: "h" } });
      h.venue.submit({ type: "publish" });
      expect(h.venue.publicTape.length).toBe(before);
    }
  });

  it("H-5 residual: a print at a price with no displayed level reveals that hidden liquidity existed there (documented, not eliminated)", () => {
    const h = harness({ accounts: ACCOUNTS });
    h.order("syn-maker", { side: "sell", priceTicks: 4_005, qtyLots: 150, visibility: "hidden" });
    const r = h.order("syn-probe", { priceTicks: 4_010, qtyLots: 1, tif: "ioc" });
    const pub = r.public as PublicMessage[];
    expect(pub.map((m) => m.kind)).toEqual(["trade"]);
    expect(h.venue.engine.publicBook(ALPHA)!.asks).toEqual([]); // the observer saw no ask at 4005, yet a trade printed there
  });
});

describe("B — authenticated trader", () => {
  it("VR-03 replacing a post-only order into the spread counts toward the probe throttle and is then refused", () => {
    const { gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS, gateway: { postOnlyRejects: { limit: 3, windowMs: 60_000 } } });
    gateway.handle(tokens.get("syn-maker")!, hiddenAsk);
    const t = tokens.get("syn-probe")!;
    gateway.handle(t, msg({ clientOrderId: "p", price: "1990.00", postOnly: true }));
    const outcomes = Array.from({ length: 8 }, (_, i) => {
      const r = gateway.handle(t, { op: "replace", ref: { clientOrderId: "p" }, price: i % 2 ? "2000.50" : "2000.00", quantity: "0.010" });
      return r.ok ? ((r.events[0] as { reason?: string }).reason ?? r.events[0]!.kind) : r.error.code;
    });
    expect(outcomes.filter((o) => o === "post-only-would-take")).toHaveLength(3);
    expect(outcomes.slice(-2)).toEqual(["rate-limited", "rate-limited"]);
    // New post-only orders share the same budget.
    expect(gateway.handle(t, msg({ clientOrderId: "p2", price: "1990.00", postOnly: true }))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    // Reconnecting does not reset it (keyed by account).
    expect(gateway.handle(gateway.openSession("syn-probe"), msg({ clientOrderId: "p3", price: "1990.00", postOnly: true }))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
  });

  // Since Milestone 11 every unfilled FOK counts toward a per-account budget (fok-budget.test.ts); within the
  // budget the first probe below is still free, which is what this test pins.
  it("VR-08 within the budget: a failing FOK reveals 'not enough liquidity at or better than P' without any execution", () => {
    const { gateway, tokens, venue } = createLocalVenue({ accounts: ACCOUNTS });
    gateway.handle(tokens.get("syn-maker")!, hiddenAsk);
    const probe = (quantity: string) => {
      const r = gateway.handle(tokens.get("syn-probe")!, msg({ clientOrderId: `f${quantity.replace(".", "_")}`, price: "2000.50", quantity, timeInForce: "fok" }));
      return r.ok && r.events.at(-1)!.kind === "cancelled";
    };
    expect(probe("0.600")).toBe(true); // free answer: < 0.600 available
    expect(venue.executions).toHaveLength(0);
    expect(probe("0.500")).toBe(false); // a positive answer costs a real execution
    expect(venue.executions).toHaveLength(1);
  });

  it("A-1 / P-1 every private query and error is identical for a foreign hidden order and a non-existent one", () => {
    const { gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS });
    const placed = gateway.handle(tokens.get("syn-maker")!, hiddenAsk);
    const id = placed.ok && placed.events[0]!.kind === "accepted" ? placed.events[0]!.order.orderId : "";
    const t = tokens.get("syn-probe")!;
    const norm = (r: ReturnType<typeof gateway.handle>) => (r.ok ? r.events.map((e) => ({ ...e, accountSeq: 0, ts: 0, ref: null })) : r);
    for (const ref of [{ orderId: id }, { clientOrderId: "h" }]) {
      const missing = "orderId" in ref ? { orderId: "o0000000000000000" } : { clientOrderId: "nope" };
      expect(gateway.order(t, ref)).toEqual(gateway.order(t, missing));
      expect(norm(gateway.handle(t, { op: "cancel", ref }))).toEqual(norm(gateway.handle(t, { op: "cancel", ref: missing })));
      expect(norm(gateway.handle(t, { op: "replace", ref, price: "abc", quantity: "1" }))).toEqual(norm(gateway.handle(t, { op: "replace", ref: missing, price: "abc", quantity: "1" })));
    }
  });

  it("H-8 the trader's own ids, sequences and timestamps are identical whether or not others placed hidden orders in between", () => {
    const run = (noise: number) => {
      const { gateway, tokens, clock } = createLocalVenue({ accounts: ACCOUNTS });
      const out = [];
      for (let i = 0; i < 5; i++) {
        clock.advance(10);
        const r = gateway.handle(tokens.get("syn-probe")!, msg({ clientOrderId: `m${i}`, price: "1990.00" }));
        for (let j = 0; j < noise; j++) gateway.handle(tokens.get("syn-maker")!, { ...hiddenAsk, clientOrderId: `n${i}-${j}`, price: "2100.00" });
        out.push(r.ok ? r.events.map((e) => ({ ...e, order: e.kind === "accepted" ? { ...e.order, orderId: "-" } : undefined })) : r);
      }
      return out;
    };
    expect(run(7)).toEqual(run(0));
  });

  it("VR-14 the opacity of ids rests on the id key: whoever knows it can recover global sequence numbers", () => {
    const h = harness({ accounts: ACCOUNTS });
    const r = h.order("syn-probe", { priceTicks: 3_990 });
    const id = r.private[0]!.kind === "accepted" ? r.private[0]!.order.orderId : "";
    const recovered = Array.from({ length: 50 }, (_, n) => n).find((n) => `o${sha256(`local-prototype-key:o:${n}`).slice(0, 16)}` === id);
    expect(recovered).toBe(r.seq); // with the fixture key the "opaque" id is a sequence number
    expect(Array.from({ length: 50 }, (_, n) => n).find((n) => `o${sha256(`guess:o:${n}`).slice(0, 16)}` === id)).toBeUndefined();
  });

  it("subscription: private events are only reachable through the owner's session; a closed session reads nothing", () => {
    const { gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS });
    gateway.handle(tokens.get("syn-maker")!, hiddenAsk);
    expect(gateway.events(tokens.get("syn-probe")!)).toEqual([]);
    expect(gateway.events("forged")).toBeNull();
    gateway.closeSession(tokens.get("syn-maker")!);
    expect(gateway.events(tokens.get("syn-maker")!)).toBeNull();
    expect(gateway.openOrders(tokens.get("syn-maker")!)).toBeNull();
  });

  it("diagnostics: the session-facing gateway API offers no operator or cross-account view", () => {
    const methods = Object.getOwnPropertyNames(VenueGateway.prototype).filter((m) => m !== "constructor" && !m.startsWith("_"));
    const sessionFacing = methods.filter((m) => ["handle", "order", "openOrders", "events", "openSession", "closeSession"].includes(m));
    expect(sessionFacing.sort()).toEqual(["closeSession", "events", "handle", "openOrders", "openSession", "order"]);
    // Everything else is internal; none of it returns book, execution or other-account data to a token holder.
    expect(methods.filter((m) => !sessionFacing.includes(m)).every((m) => !/inspect|execution|book|journal|snapshot/i.test(m))).toBe(true);
  });

  it("logs: gateway refusal records carry no payload fields", () => {
    const { gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS, gateway: { messages: { limit: 1, windowMs: 1_000 } } });
    gateway.handle(tokens.get("syn-probe")!, { op: "mass-cancel" });
    gateway.handle(tokens.get("syn-probe")!, { ...hiddenAsk, clientOrderId: "secret-client-id", price: "2000.50" });
    expect(JSON.stringify(gateway.refusals)).not.toMatch(/secret|2000|hidden/);
  });
});

describe("C — compromised application service (same process)", () => {
  it("open: TypeScript `private` is not isolation; code holding the gateway can reach every hidden order", () => {
    const { gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS });
    gateway.handle(tokens.get("syn-maker")!, hiddenAsk);
    const venue = (gateway as unknown as { venue: { engine: { inspectBook(id: string): { hidden: { accountId: string }[] }[] } } }).venue;
    expect(venue.engine.inspectBook(ALPHA)[0]!.hidden[0]!.accountId).toBe("syn-maker");
  });
});

describe("D — privileged operator", () => {
  it("open by design: the operator view and audit records show hidden orders, owners and maker visibility", () => {
    const h = harness({ accounts: ACCOUNTS });
    h.order("syn-maker", { side: "sell", priceTicks: 4_005, qtyLots: 150, visibility: "hidden" });
    h.order("syn-probe", { priceTicks: 4_005, qtyLots: 5, tif: "ioc" });
    expect(h.venue.executions[0]).toMatchObject({ makerAccountId: "syn-maker", makerVisibility: "hidden" });
    expect(h.venue.transitions.length).toBeGreaterThan(0);
  });
});

describe("E — access to logs or persistent storage", () => {
  it("open: the journal and snapshots hold hidden orders in plaintext (no encryption at rest)", () => {
    const h = harness({ accounts: ACCOUNTS });
    h.order("syn-maker", { side: "sell", priceTicks: 4_005, qtyLots: 150, visibility: "hidden", clientOrderId: "plain" });
    const journal = h.venue.journal.toJsonl();
    expect(journal).toMatch(/"clientOrderId":"plain".*"priceTicks":4005.*"visibility":"hidden"/);
    expect(JSON.stringify(h.venue.snapshot())).toContain('"visibility":"hidden"');
  });
});
