import { describe, expect, it } from "vitest";
import { createLocalVenue } from "./synthetic";
import { harness, ALPHA } from "./test-helpers";
import type { PrivateEvent } from "./types";

/**
 * Adversarial tests: a participant (or outsider) trying to learn about
 * hidden orders or other accounts, or to abuse the order-entry gateway.
 * Where a leakage channel is inherent, the test pins down exactly what leaks
 * so the documentation cannot overstate the protection.
 */

const accounts = ["syn-a", "syn-b", "syn-c", "syn-probe"];
const newMsg = (o: Record<string, unknown> = {}) => ({ op: "new", clientOrderId: `m${Math.random().toString(36).slice(2, 10)}`, instrumentId: ALPHA, side: "buy", type: "limit", price: "2000.00", quantity: "0.010", ...o });

describe("authentication and authorization at the gateway", () => {
  it("A-1 refuses unknown or closed sessions and takes the account only from the session", () => {
    const { gateway, tokens } = createLocalVenue({ accounts });
    expect(gateway.handle("not-a-session", newMsg())).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    const spoof = gateway.handle(tokens.get("syn-a")!, newMsg({ accountId: "syn-b" }));
    expect(spoof).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    gateway.closeSession(tokens.get("syn-c")!);
    expect(gateway.handle(tokens.get("syn-c")!, newMsg())).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });

  it("A-1 / P-1 another account's order cannot be read, cancelled or replaced, and the refusal equals the one for a non-existent order", () => {
    const { gateway, tokens } = createLocalVenue({ accounts });
    const placed = gateway.handle(tokens.get("syn-a")!, newMsg({ clientOrderId: "secret", visibility: "hidden", quantity: "0.500" }));
    const orderId = placed.ok && placed.events[0]!.kind === "accepted" ? placed.events[0]!.order.orderId : "";
    const probe = tokens.get("syn-probe")!;
    expect(gateway.order(probe, { orderId })).toBeNull();
    expect(gateway.order(probe, { clientOrderId: "secret" })).toBeNull();
    const strip = (r: ReturnType<typeof gateway.handle>) => (r.ok ? r.events.map((e) => ({ ...e, ref: null, accountSeq: 0, ts: 0 })) : r);
    for (const op of ["cancel", "replace"] as const) {
      const extra = op === "replace" ? { price: "2000.00", quantity: "1.000" } : {};
      const foreign = gateway.handle(probe, { op, ref: { orderId }, ...extra });
      const missing = gateway.handle(probe, { op, ref: { orderId: "o0123456789abcdef" }, ...extra });
      expect(foreign).toMatchObject({ ok: true, events: [{ kind: "request-rejected", reason: "unknown-order" }] });
      expect(strip(foreign)).toEqual(strip(missing));
    }
    expect(gateway.events(probe)!.every((e) => e.accountId === "syn-probe")).toBe(true);
    expect(gateway.order(tokens.get("syn-a")!, { clientOrderId: "secret" })).toMatchObject({ status: "new", visibility: "hidden" });
  });
});

describe("input validation", () => {
  it.each([
    ["exponent", "1e3"],
    ["hex", "0x10"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["negative", "-1"],
    ["explicit plus", "+1"],
    ["whitespace", " 2000.00"],
    ["thousands separator", "2,000.00"],
    ["full-width digits", "２０００"],
    ["leading zeros", "02000.00"],
    ["too many digits", "99999999999999999999"],
    ["empty", ""],
  ])("I-1 refuses a %s price without echoing it", (_label, price) => {
    const { gateway, tokens } = createLocalVenue({ accounts });
    const r = gateway.handle(tokens.get("syn-a")!, newMsg({ price }));
    expect(r).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    if (!r.ok && price.trim()) expect(r.error.message).not.toContain(price.trim());
  });

  it("I-1 distinguishes off-tick and off-lot values and refuses zero", () => {
    const { gateway, tokens } = createLocalVenue({ accounts });
    const t = tokens.get("syn-a")!;
    expect(gateway.handle(t, newMsg({ price: "2000.25" }))).toMatchObject({ error: { message: "Price is not a multiple of the tick size." } });
    expect(gateway.handle(t, newMsg({ quantity: "0.0015" }))).toMatchObject({ error: { message: "Quantity must be a plain positive decimal." } });
    expect(gateway.handle(t, newMsg({ quantity: "0.000" }))).toMatchObject({ error: { message: "Quantity must be positive." } });
    expect(gateway.handle(t, newMsg({ price: "2000.500000" }))).toMatchObject({ ok: true });
  });
});

describe("abuse controls", () => {
  it("A-3 throttles message floods per account without affecting other accounts", () => {
    const { gateway, tokens, clock } = createLocalVenue({ accounts, gateway: { messages: { limit: 5, windowMs: 1_000 } } });
    const results = Array.from({ length: 7 }, () => gateway.handle(tokens.get("syn-a")!, { op: "mass-cancel" }));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.at(-1)).toMatchObject({ ok: false, error: { code: "rate-limited", retryAfterMs: 1_000 } });
    expect(gateway.handle(tokens.get("syn-b")!, { op: "mass-cancel" })).toMatchObject({ ok: true });
    clock.advance(1_000);
    expect(gateway.handle(tokens.get("syn-a")!, { op: "mass-cancel" })).toMatchObject({ ok: true });
    expect(gateway.refusals.filter((r) => r.code === "rate-limited")).toHaveLength(2);
  });

  it("A-4 a reused client order id with a different payload is refused, not silently re-executed", () => {
    const { gateway, tokens, venue } = createLocalVenue({ accounts });
    gateway.handle(tokens.get("syn-a")!, newMsg({ clientOrderId: "dup" }));
    const before = venue.journal.lastSeq;
    expect(gateway.handle(tokens.get("syn-a")!, newMsg({ clientOrderId: "dup", price: "2001.00" }))).toMatchObject({ ok: false, error: { code: "idempotency-conflict" } });
    expect(venue.journal.lastSeq).toBe(before);
  });
});

describe("hidden-liquidity probing and leakage channels", () => {
  it("H-7 post-only probing reveals hidden liquidity inside the spread (documented leak) and is throttled per account", () => {
    const { gateway, tokens, clock } = createLocalVenue({ accounts, gateway: { postOnlyRejects: { limit: 3, windowMs: 60_000 } } });
    gateway.handle(tokens.get("syn-a")!, newMsg({ side: "sell", price: "2000.50", quantity: "1.000", visibility: "hidden" }));
    const probe = tokens.get("syn-probe")!;
    const answers = Array.from({ length: 5 }, () => gateway.handle(probe, newMsg({ price: "2000.50", postOnly: true })));
    // The first three probes learn "something rests at ≤ 2000.50"; that is the leak.
    expect(answers.slice(0, 3).map((r) => r.ok && r.events[0]!.kind === "rejected" && r.events[0]!.reason)).toEqual(Array(3).fill("post-only-would-take"));
    // Afterwards post-only orders are refused at the gateway, before they can probe.
    expect(answers.slice(3).map((r) => !r.ok && r.error.code)).toEqual(["rate-limited", "rate-limited"]);
    expect(gateway.handle(probe, newMsg({ price: "1999.00" }))).toMatchObject({ ok: true });
    clock.advance(60_000);
    expect(gateway.handle(probe, newMsg({ price: "1999.00", postOnly: true }))).toMatchObject({ ok: true, events: [{ kind: "accepted" }] });
  });

  it("H-5 the taker's private view is identical whether the liquidity it hit was hidden or displayed", () => {
    const view = (visibility: "hidden" | "displayed") => {
      const h = harness();
      h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 150, visibility });
      const events = h.order("syn-b", { priceTicks: 4_010, qtyLots: 20, tif: "ioc", clientOrderId: "probe" }).private.filter((e) => e.accountId === "syn-b");
      return {
        taker: events.map((e) => ({ ...e, orderId: "-", fillId: "-" }) as PrivateEvent),
        // Public sequence numbers differ legitimately (a displayed order was published, a hidden one not).
        prints: h.venue.publicTape.filter((m) => m.kind === "trade").map((m) => ({ ...m, publicSeq: 0 })),
      };
    };
    expect(view("hidden")).toEqual(view("displayed"));
  });

  it("H-5 one public print per aggressing order and price: maker count and visibility mix are not disclosed", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 100, visibility: "hidden" });
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 7 });
    h.order("syn-a", { side: "sell", priceTicks: 4_011, qtyLots: 3 });
    const r = h.order("syn-b", { priceTicks: 4_011, qtyLots: 115, tif: "ioc" });
    expect(r.executions).toHaveLength(4);
    expect(r.public.filter((m) => m.kind === "trade").map((m) => m.kind === "trade" && [m.priceTicks, m.qtyLots, m.aggressor])).toEqual([
      [4_010, 112, "buy"],
      [4_011, 3, "buy"],
    ]);
  });

  it("H-5 residual inference: a print larger than the displayed quantity removed reveals that hidden liquidity traded (documented)", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 100, visibility: "hidden" });
    const r = h.order("syn-b", { priceTicks: 4_010, qtyLots: 30, tif: "ioc" });
    const print = r.public.find((m) => m.kind === "trade")!;
    const level = r.public.find((m) => m.kind === "level")!;
    expect(print).toMatchObject({ qtyLots: 30 });
    expect(level).toMatchObject({ displayedLots: 0 });
    // 30 printed − 5 displayed removed = 25 lots that must have been non-displayed.
  });

  it("H-8 identifiers are opaque and the per-account sequence ignores other accounts' activity", () => {
    const run = (noise: number) => {
      const h = harness();
      const own: PrivateEvent[] = [];
      own.push(...h.order("syn-a", { priceTicks: 3_990, clientOrderId: "first" }).private);
      for (let i = 0; i < noise; i++) h.order("syn-c", { side: "sell", priceTicks: 4_200, qtyLots: 100, visibility: "hidden" });
      own.push(...h.order("syn-a", { priceTicks: 3_991, clientOrderId: "second" }).private);
      return own;
    };
    const quiet = run(0);
    const busy = run(25);
    expect(busy.map((e) => e.accountSeq)).toEqual([1, 2]);
    expect(quiet.map((e) => e.accountSeq)).toEqual([1, 2]);
    for (const e of [...quiet, ...busy]) if (e.kind === "accepted") expect(e.order.orderId).toMatch(/^o[0-9a-f]{16}$/);
    // Same key, different global sequence → unrelated-looking ids; nothing numeric to subtract.
    const ids = busy.map((e) => (e.kind === "accepted" ? e.order.orderId : ""));
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("H-8 a different id key yields different identifiers for the same flow", () => {
    const a = createLocalVenue({ accounts, idKey: "key-one" });
    const b = createLocalVenue({ accounts, idKey: "key-two" });
    const ra = a.gateway.handle(a.tokens.get("syn-a")!, newMsg({ clientOrderId: "same" }));
    const rb = b.gateway.handle(b.tokens.get("syn-a")!, newMsg({ clientOrderId: "same" }));
    const id = (r: typeof ra) => (r.ok && r.events[0]!.kind === "accepted" ? r.events[0]!.order.orderId : null);
    expect(id(ra)).not.toBeNull();
    expect(id(ra)).not.toBe(id(rb));
  });

  it("H-1 the public sequence is gap-free while hidden orders come and go", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) {
      h.order("syn-a", { side: "sell", priceTicks: 4_050 + i, qtyLots: 100 + i, visibility: i % 2 ? "hidden" : "displayed", clientOrderId: `s${i}` });
      if (i % 3 === 0) h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { clientOrderId: `s${i}` } });
    }
    h.order("syn-b", { priceTicks: 4_070, qtyLots: 1_000, tif: "ioc" });
    const seqs = h.venue.publicTape.map((m) => m.publicSeq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("H-9 batched publication conflates: an add and cancel inside one interval publishes nothing; timestamps are publication times", () => {
    const h = harness({ publication: "batched" });
    h.venue.submit({ type: "publish" });
    const before = h.venue.publicTape.length;
    h.order("syn-a", { priceTicks: 3_990, clientOrderId: "flash" });
    h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { clientOrderId: "flash" } });
    h.order("syn-a", { priceTicks: 3_980, clientOrderId: "stays" });
    h.clock.advance(250);
    const flush = h.venue.submit({ type: "publish" });
    expect(h.venue.publicTape.length - before).toBe(1);
    expect(flush.public).toEqual([expect.objectContaining({ kind: "level", priceTicks: 3_980, ts: flush.ts })]);
  });
});
