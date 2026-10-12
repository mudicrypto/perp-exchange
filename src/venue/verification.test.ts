import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BookSide } from "./book";
import { instrumentSpecSchema, SYNTHETIC_INSTRUMENTS } from "./instrument";
import { createLocalVenue } from "./synthetic";
import { ALPHA, harness } from "./test-helpers";
import { STP_MODES, type EngineCommand, type PrivateEvent } from "./types";
import { Venue } from "./venue";

/**
 * Milestone 9 independent verification: matching-engine edge cases (Phase B)
 * and gateway/sequencing behaviour (Phase E). Tests prefixed "VR-nn" are
 * regression tests for findings in docs/venue/VERIFICATION-REPORT.md; the
 * others pin behaviour that was previously only asserted in documentation.
 */

const ACCOUNTS = ["syn-a", "syn-b", "syn-c"];
const kinds = (events: readonly PrivateEvent[]) => events.map((e) => e.kind);
const newMsg = (o: Record<string, unknown> = {}) => ({ op: "new", clientOrderId: "c1", instrumentId: ALPHA, side: "buy", type: "limit", price: "1999.00", quantity: "0.010", ...o });

describe("Phase B — matching edge cases", () => {
  it("M-5 orders with identical timestamps are prioritised by sequence number", () => {
    const h = harness();
    // The harness clock advances per order; freeze it so every command shares one timestamp.
    h.clock.advance = () => {};
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "first" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "second" });
    const r = h.order("syn-b", { priceTicks: 4_010, qtyLots: 6, tif: "ioc" });
    expect(new Set(h.venue.journal.entries.slice(-3).map((e) => e.ts)).size).toBe(1);
    expect(r.private.filter((e) => e.kind === "fill" && e.liquidity === "maker").map((e) => e.kind === "fill" && [e.clientOrderId, e.qtyLots])).toEqual([
      ["first", 5],
      ["second", 1],
    ]);
  });

  it("M-7 / M-9 empty book: IOC, FOK and market orders are cancelled without executions", () => {
    const h = harness();
    expect(h.order("syn-a", { tif: "ioc" }).private.at(-1)).toMatchObject({ kind: "cancelled", reason: "ioc-remainder", filledLots: 0 });
    expect(h.order("syn-a", { tif: "fok" }).private.at(-1)).toMatchObject({ kind: "cancelled", reason: "fok-unfilled" });
    expect(h.order("syn-a", { orderType: "market", priceTicks: undefined, tif: "ioc" }).private.at(-1)).toMatchObject({ reason: "ioc-remainder" });
    expect(h.order("syn-a", { orderType: "market", priceTicks: undefined, tif: "fok" }).private.at(-1)).toMatchObject({ reason: "fok-unfilled" });
    expect(h.venue.executions).toHaveLength(0);
    expect(h.venue.engine.inspectBook(ALPHA)).toEqual([]);
  });

  it("M-9 market order with insufficient liquidity fills what exists within the band and cancels the rest", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 3 });
    h.order("syn-a", { side: "sell", priceTicks: 4_020, qtyLots: 4 });
    const r = h.order("syn-b", { orderType: "market", priceTicks: undefined, tif: "ioc", qtyLots: 10 });
    const own = r.private.filter((e) => e.accountId === "syn-b");
    expect(kinds(own)).toEqual(["accepted", "fill", "fill", "cancelled"]);
    expect(own.at(-1)).toMatchObject({ reason: "ioc-remainder", filledLots: 7 });
    expect(h.order("syn-b", { orderType: "market", priceTicks: undefined, tif: "fok", qtyLots: 1 }).private.at(-1)).toMatchObject({ reason: "fok-unfilled" });
  });

  it("F-1 a sweep across several levels leaves exact remaining quantities on every touched order", () => {
    const h = harness();
    for (const [p, q, id] of [[4_010, 3, "m1"], [4_010, 4, "m2"], [4_011, 5, "m3"], [4_012, 6, "m4"]] as const) h.order("syn-a", { side: "sell", priceTicks: p, qtyLots: q, clientOrderId: id });
    h.order("syn-b", { priceTicks: 4_012, qtyLots: 14, tif: "ioc" });
    const view = (id: string) => h.venue.engine.orderFor("syn-a", { clientOrderId: id });
    expect([view("m1"), view("m2"), view("m3"), view("m4")].map((o) => [o!.status, o!.leavesLots])).toEqual([
      ["filled", 0],
      ["filled", 0],
      ["filled", 0],
      ["partially-filled", 4],
    ]);
    expect(h.venue.engine.publicBook(ALPHA)!.asks).toEqual([{ priceTicks: 4_012, displayedLots: 4 }]);
  });

  it("S-1 cancel-taker after earlier fills keeps those fills; the own order behind other makers is untouched", () => {
    const h = harness();
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 2 });
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 2, clientOrderId: "own" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 2 });
    const r = h.order("syn-a", { priceTicks: 4_010, qtyLots: 6, tif: "gtc", stp: "cancel-taker", clientOrderId: "t" });
    expect(r.executions.map((x) => x.qtyLots)).toEqual([2]);
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "t" })).toMatchObject({ status: "cancelled", filledLots: 2 });
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "own" })).toMatchObject({ status: "new" });
  });

  it("P-1 / P-2 repeated and late commands: second cancel, cancel after fill, replace after fill, repeated replace", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "f" });
    h.order("syn-b", { priceTicks: 4_010, qtyLots: 5, tif: "ioc" });
    const ref = { clientOrderId: "f" };
    expect(h.venue.submit({ type: "cancel", accountId: "syn-a", ref }).private[0]).toMatchObject({ reason: "order-not-modifiable" });
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref, priceTicks: 4_011, qtyLots: 9 }).private[0]).toMatchObject({ reason: "order-not-modifiable" });
    h.order("syn-a", { priceTicks: 3_990, qtyLots: 5, clientOrderId: "r" });
    const replace: EngineCommand = { type: "replace", accountId: "syn-a", ref: { clientOrderId: "r" }, priceTicks: 3_991, qtyLots: 8 };
    expect(h.venue.submit(replace).private[0]).toMatchObject({ kind: "replaced" });
    // FIX total-quantity semantics make a repeated replace a no-op rather than a second change.
    expect(h.venue.submit(replace).private[0]).toMatchObject({ reason: "replace-no-change" });
  });

  it("M-10 a refused post-only replace leaves the order exactly as it was", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    h.order("syn-b", { priceTicks: 4_000, qtyLots: 5, postOnly: true, clientOrderId: "po" });
    const before = h.venue.engine.inspectBook(ALPHA);
    expect(h.venue.submit({ type: "replace", accountId: "syn-b", ref: { clientOrderId: "po" }, priceTicks: 4_010, qtyLots: 5 }).private[0]).toMatchObject({ reason: "post-only-would-take" });
    expect(h.venue.engine.inspectBook(ALPHA)).toEqual(before);
  });

  it("R-1 replace is risk-checked: raising size past the position or notional limit is refused and the order is unchanged", () => {
    const h = harness({ limits: { maxOpenOrders: 5, maxOrderNotional: 500_000, maxPositionLots: 100 } });
    h.order("syn-a", { priceTicks: 3_990, qtyLots: 60, clientOrderId: "r" });
    const before = h.venue.engine.orderFor("syn-a", { clientOrderId: "r" });
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "r" }, priceTicks: 3_990, qtyLots: 101 }).private[0]).toMatchObject({ reason: "max-position" });
    h.order("syn-a", { priceTicks: 3_980, qtyLots: 30, clientOrderId: "r2" });
    // 60 + 30 open: growing r to 71 makes the worst case 101 > 100.
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "r" }, priceTicks: 3_990, qtyLots: 71 }).private[0]).toMatchObject({ reason: "max-position" });
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "r" }, priceTicks: 3_990, qtyLots: 70 }).private[0]).toMatchObject({ kind: "replaced" });
    const h2 = harness({ limits: { maxOpenOrders: 5, maxOrderNotional: 300_000, maxPositionLots: 1_000 } });
    h2.order("syn-a", { priceTicks: 3_990, qtyLots: 60, clientOrderId: "n" });
    expect(h2.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "n" }, priceTicks: 3_990, qtyLots: 76 }).private[0]).toMatchObject({ reason: "max-order-notional" });
    expect(h2.venue.engine.orderFor("syn-a", { clientOrderId: "n" })).toEqual({ ...before, orderId: h2.idOf("syn-a", "n"), clientOrderId: "n" });
  });

  it("M-9 the market-order protection price is clamped to the instrument's price range", () => {
    const spec = { id: "SYN-EDGE", priceDecimals: 0, tickUnits: 1, sizeDecimals: 0, lotUnits: 1, minPriceTicks: 95, maxPriceTicks: 1_000, minQtyLots: 1, maxQtyLots: 1_000, priceBandBps: 1_000, minHiddenQtyLots: 1, referencePriceTicks: 1_000 };
    const lv = createLocalVenue({ accounts: ACCOUNTS, instruments: [spec] });
    const market = (side: "buy" | "sell") =>
      lv.venue.submit({ type: "new-order", accountId: "syn-a", clientOrderId: `m${side}`, instrumentId: "SYN-EDGE", side, orderType: "market", qtyLots: 1, tif: "ioc", visibility: "displayed", postOnly: false, stp: "cancel-taker" }).private[0];
    expect(market("buy")).toMatchObject({ kind: "accepted", order: { priceTicks: 1_000 } }); // 1 100 clamped to max 1 000
    expect(market("sell")).toMatchObject({ kind: "accepted", order: { priceTicks: 900 } }); // ceil(1 000 × 0.9)
  });

  it("A-4 / §11 duplicate client order ids: per account across instruments; other accounts unaffected", () => {
    const h = harness();
    h.order("syn-a", { clientOrderId: "dup" });
    expect(h.order("syn-a", { clientOrderId: "dup", instrumentId: "SYN-BETA", priceTicks: 12_500, qtyLots: 10 }).private[0]).toMatchObject({ reason: "duplicate-client-order-id" });
    expect(kinds(h.order("syn-b", { clientOrderId: "dup" }).private)).toEqual(["accepted"]);
  });

  it("I-1 integer boundaries: unsafe instrument bounds are refused; out-of-range integers never reach the journal", () => {
    const base = SYNTHETIC_INSTRUMENTS[0]!;
    expect(instrumentSpecSchema.safeParse({ ...base, maxPriceTicks: 100_000_000_000, maxQtyLots: 100_000 }).success).toBe(false);
    expect(instrumentSpecSchema.safeParse({ ...base, maxPriceTicks: 100_000_000_001 }).success).toBe(false);
    const h = harness();
    const seq = h.venue.journal.lastSeq;
    for (const bad of [{ qtyLots: Number.MAX_SAFE_INTEGER + 1 }, { qtyLots: 1.5 }, { priceTicks: 4_000.5 }, { qtyLots: -1 }, { priceTicks: 0 }]) {
      expect(() => h.order("syn-a", bad)).toThrow(/invalid engine command/);
    }
    expect(h.venue.journal.lastSeq).toBe(seq);
    // The largest single-order notional the schema allows is exact.
    const big = h.order("syn-a", { side: "sell", priceTicks: 4_400, qtyLots: 1_000_000 });
    expect(big.private[0]).toMatchObject({ kind: "rejected", reason: "max-order-notional" });
  });

  it("VR-11 rejected commands never change the book, orders, positions, public data or other accounts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ side: fc.constantFrom("buy" as const, "sell" as const), p: fc.integer({ min: 3_990, max: 4_010 }), q: fc.integer({ min: 1, max: 300 }), hidden: fc.boolean() }), { minLength: 5, maxLength: 40, size: "max" }),
        fc.array(fc.record({ kind: fc.integer({ min: 0, max: 7 }), side: fc.constantFrom("buy" as const, "sell" as const), p: fc.integer({ min: 3_990, max: 4_010 }) }), { minLength: 1, maxLength: 20 }),
        (setup, attempts) => {
          const h = harness({ limits: { maxOpenOrders: 30, maxOrderNotional: 900_000, maxPositionLots: 2_000 } });
          setup.forEach((o, i) => h.order(ACCOUNTS[i % 3]!, { side: o.side, priceTicks: o.p, qtyLots: o.hidden ? 100 + o.q : o.q, visibility: o.hidden ? "hidden" : "displayed", clientOrderId: `s${i}` }));
          for (const [i, a] of attempts.entries()) {
            const bad: Record<string, unknown>[] = [
              { priceTicks: 9_999 },
              { qtyLots: 2_000_000 },
              { visibility: "hidden", qtyLots: 5 },
              { postOnly: true, tif: "ioc" },
              { orderType: "market", tif: "gtc", priceTicks: undefined },
              { clientOrderId: "s0" },
              { qtyLots: 250, priceTicks: 4_000 + (a.p % 5) * 100 }, // notional or band refusal
              { postOnly: true, side: a.side, priceTicks: a.side === "buy" ? 4_400 : 3_600 },
            ];
            const snap = h.venue.engine.snapshot();
            const tape = h.venue.publicTape.length;
            const r = h.order("syn-a", { side: a.side, priceTicks: a.p, clientOrderId: `x${i}`, ...bad[a.kind] });
            if (r.private[0]?.kind !== "rejected") continue;
            const after = h.venue.engine.snapshot();
            const strip = (s: typeof snap) => ({
              orders: s.orders,
              pending: s.pending,
              publicSeq: s.publicSeq,
              instruments: s.instruments,
              accounts: s.accounts.map((acc) => ({ ...acc, accountSeq: 0, holdings: acc.holdings.filter(([, v]) => v.position || v.openBuyLots || v.openSellLots || v.cash !== "0") })),
            });
            expect(strip(after)).toEqual(strip(snap));
            expect(h.venue.publicTape.length).toBe(tape);
            expect(r.private).toHaveLength(1);
            expect(r.executions).toHaveLength(0);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("A-2 private fills and public prints agree with committed executions for every command", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const lv = createLocalVenue({ accounts: ACCOUNTS, limits: { maxOpenOrders: 50, maxOrderNotional: 1e12, maxPositionLots: 1e9 } });
        let rng = seed;
        const next = (n: number) => (rng = (rng * 1_103_515_245 + 12_345) % 2_147_483_648) % n;
        for (let i = 0; i < 120; i++) {
          const r = lv.venue.submit({
            type: "new-order",
            accountId: ACCOUNTS[next(3)]!,
            clientOrderId: `o${i}`,
            instrumentId: ALPHA,
            side: next(2) ? "buy" : "sell",
            orderType: "limit",
            priceTicks: 3_995 + next(11),
            qtyLots: 1 + next(150),
            tif: (["gtc", "gtc", "ioc", "fok"] as const)[next(4)]!,
            visibility: next(4) === 0 ? "hidden" : "displayed",
            postOnly: false,
            stp: STP_MODES[next(3)]!,
          });
          const fills = r.private.filter((e) => e.kind === "fill");
          expect(fills).toHaveLength(2 * r.executions.length);
          r.executions.forEach((x, k) => {
            const [maker, taker] = [fills[2 * k]!, fills[2 * k + 1]!];
            expect(maker).toMatchObject({ orderId: x.makerOrderId, accountId: x.makerAccountId, priceTicks: x.priceTicks, qtyLots: x.qtyLots, liquidity: "maker" });
            expect(taker).toMatchObject({ orderId: x.takerOrderId, accountId: x.takerAccountId, priceTicks: x.priceTicks, qtyLots: x.qtyLots, liquidity: "taker" });
          });
          const printed = r.public.reduce((s, m) => s + (m.kind === "trade" ? m.qtyLots : 0), 0);
          expect(printed).toBe(r.executions.reduce((s, x) => s + x.qtyLots, 0));
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("Phase E — gateway and sequencing", () => {
  it("A-3 opening new sessions does not reset message or post-only limits (keyed by account)", () => {
    const { gateway } = createLocalVenue({ accounts: ACCOUNTS, gateway: { messages: { limit: 3, windowMs: 1_000 } } });
    const results = Array.from({ length: 6 }, () => gateway.handle(gateway.openSession("syn-a"), { op: "mass-cancel" }).ok);
    expect(results).toEqual([true, true, true, false, false, false]);
  });

  it("VR-04 the refusal log is bounded while totals keep counting (unauthenticated flood)", () => {
    const { gateway } = createLocalVenue({ accounts: ACCOUNTS });
    for (let i = 0; i < 25_000; i++) gateway.handle("not-a-session", { op: "mass-cancel" });
    expect(gateway.refusals.length).toBe(10_000);
    expect(gateway.refusalCounts.get("unauthenticated")).toBe(25_000);
    expect(Object.keys(gateway.refusals[0]!).sort()).toEqual(["accountId", "code", "ts"]);
  });

  it.each([
    ["null", null],
    ["array", [newMsg()]],
    ["number", 42],
    ["string", JSON.stringify(newMsg())],
    ["prototype key", JSON.parse(`{"op":"mass-cancel","__proto__":{"admin":true}}`)],
    ["constructor key", { op: "mass-cancel", constructor: { prototype: {} } }],
    ["1 MB client id", newMsg({ clientOrderId: "a".repeat(1_000_000) })],
    ["1 MB price", newMsg({ price: "1".repeat(1_000_000) })],
    ["10 000 extra keys", Object.fromEntries([...Object.entries(newMsg()), ...Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i])])],
    ["deeply nested ref", { op: "cancel", ref: JSON.parse("[".repeat(5_000) + "]".repeat(5_000)) }],
    ["account override", newMsg({ accountId: "syn-b" })],
    ["unknown op", { op: "admin.suspend-account", accountId: "syn-b" }],
  ])("A-1 malformed or oversized payload (%s) is refused without reaching the journal or echoing input", (_label, payload) => {
    const { gateway, tokens, venue } = createLocalVenue({ accounts: ACCOUNTS });
    const seq = venue.journal.lastSeq;
    const started = performance.now();
    const r = gateway.handle(tokens.get("syn-a")!, payload);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(r).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(venue.journal.lastSeq).toBe(seq);
    if (!r.ok) expect(r.error.message.length).toBeLessThan(80);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("A-4 concurrent identical submissions (including from two sessions of one account) create exactly one order", async () => {
    const { gateway, venue } = createLocalVenue({ accounts: ACCOUNTS });
    const [s1, s2] = [gateway.openSession("syn-a"), gateway.openSession("syn-a")];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => gateway.handle(i % 2 ? s1 : s2, newMsg({ clientOrderId: "once" })))));
    expect(venue.engine.openOrdersFor("syn-a")).toHaveLength(1);
    expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.replayed)).toHaveLength(9);
    const seqs = venue.journal.entries.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("VR-06 a rejected order does not consume its client order id at the gateway (retry after the halt lifts)", () => {
    const { gateway, tokens, venue } = createLocalVenue({ accounts: ACCOUNTS });
    venue.submit({ type: "admin.set-status", instrumentId: ALPHA, status: "halted" });
    const first = gateway.handle(tokens.get("syn-a")!, newMsg({ clientOrderId: "retry" }));
    expect(first).toMatchObject({ ok: true, events: [{ kind: "rejected", reason: "trading-halted" }] });
    venue.submit({ type: "admin.set-status", instrumentId: ALPHA, status: "continuous" });
    expect(gateway.handle(tokens.get("syn-a")!, newMsg({ clientOrderId: "retry" }))).toMatchObject({ ok: true, replayed: false, events: [{ kind: "accepted" }] });
  });

  it("stale client view: a replace computed from an outdated order view cannot raise exposure (P-3)", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 10, clientOrderId: "s" });
    const staleView = h.venue.engine.orderFor("syn-a", { clientOrderId: "s" })!; // leaves 10
    h.order("syn-b", { priceTicks: 4_010, qtyLots: 6, tif: "ioc" }); // fills 6 meanwhile
    // The client wants "8 left" based on its stale view and sends total quantity 8.
    h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "s" }, priceTicks: 4_010, qtyLots: staleView.leavesLots - 2 });
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "s" })).toMatchObject({ qtyLots: 8, filledLots: 6, leavesLots: 2 });
  });

  it("cancellation race: a cancel that arrives after the fill is refused and the fill stands", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "race" });
    h.order("syn-b", { priceTicks: 4_010, qtyLots: 5, tif: "ioc" });
    expect(h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { clientOrderId: "race" } }).private[0]).toMatchObject({ reason: "order-not-modifiable" });
    expect(h.venue.engine.positionFor("syn-a", ALPHA)).toBe(-5);
  });

  it("VR-01 after a fault nothing more is journaled; the faulting command is reported as outcome-unknown and survives recovery", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    const original = BookSide.prototype.add;
    let fail = true;
    BookSide.prototype.add = function (this: BookSide, ...args: Parameters<BookSide["add"]>) {
      if (fail) {
        fail = false;
        throw new Error("transient fault");
      }
      return original.apply(this, args);
    };
    try {
      expect(lv.gateway.handle(lv.tokens.get("syn-a")!, newMsg({ clientOrderId: "boom" }))).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
      const seq = lv.venue.journal.lastSeq;
      for (const account of ["syn-b", "syn-c"]) {
        expect(lv.gateway.handle(lv.tokens.get(account)!, newMsg({ clientOrderId: "after" }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
      }
      expect(lv.venue.journal.lastSeq).toBe(seq);
      const { venue } = Venue.recover({ engine: { idKey: "local-prototype-key", publication: "immediate" }, clock: lv.clock.read }, lv.venue.journal.toJsonl());
      // The journaled command takes effect on recovery; the refused ones do not.
      expect(venue.engine.orderFor("syn-a", { clientOrderId: "boom" })).toMatchObject({ status: "new" });
      expect(venue.engine.orderFor("syn-b", { clientOrderId: "after" })).toBeNull();
      expect(venue.engine.orderFor("syn-c", { clientOrderId: "after" })).toBeNull();
    } finally {
      BookSide.prototype.add = original;
    }
  });

  it("VR-19 after a fault mid-command, order queries refuse instead of serving half-applied state", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    lv.gateway.handle(lv.tokens.get("syn-a")!, newMsg({ clientOrderId: "m", side: "sell", price: "2000.00" }));
    const original = BookSide.prototype.remove;
    BookSide.prototype.remove = () => {
      throw new Error("fault mid-fill");
    };
    try {
      expect(lv.gateway.handle(lv.tokens.get("syn-b")!, newMsg({ clientOrderId: "t", price: "2000.00" }))).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
    } finally {
      BookSide.prototype.remove = original;
    }
    // Before the fix: status "new" with leaves 0 (inconsistent, never committed as such).
    expect(() => lv.gateway.order(lv.tokens.get("syn-a")!, { clientOrderId: "m" })).toThrow(/venue stopped/);
    expect(() => lv.gateway.openOrders(lv.tokens.get("syn-b")!)).toThrow(/venue stopped/);
    // Committed outputs remain readable; the faulting command produced none.
    expect(lv.gateway.events(lv.tokens.get("syn-b")!)).toEqual([]);
    expect(lv.gateway.events(lv.tokens.get("syn-a")!)!.map((e) => e.kind)).toEqual(["accepted"]);
  });

  it("VR-02 a throwing public listener cannot turn a committed order into an error or drop private events", () => {
    const { venue, gateway, tokens } = createLocalVenue({ accounts: ACCOUNTS });
    const seen: number[] = [];
    venue.onPublic(() => {
      throw new Error("faulty consumer");
    });
    venue.onPublic((m) => seen.push(m.publicSeq));
    const r = gateway.handle(tokens.get("syn-a")!, newMsg());
    expect(r).toMatchObject({ ok: true, events: [{ kind: "accepted" }] });
    expect(venue.privateEvents("syn-a")).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(venue.listenerFailures).toBe(1);
  });
});
