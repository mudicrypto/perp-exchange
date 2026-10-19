import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DURABILITY_ACCOUNTS, DURABILITY_ALPHA, DURABILITY_CLOCK, durableOptions, fingerprint, orderFlow, setupCommands } from "./durability-fixtures";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage } from "./gateway";
import { reconcile } from "./reconcile";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage";
import type { EngineCommand } from "./types";
import { Venue, type VenueOptions, type VenueSnapshot } from "./venue";

/**
 * Milestone 11 (Venue) workstream B: retention (rule A-6). Authoritative and recovery data is never
 * discarded; audit history is discarded only when explicitly configured, and then reported; the
 * per-account outbox is an operational ring buffer with exact gap reporting; the in-memory journal copy
 * may be kept head-only when a store holds the journal. Client-ID duplicate protection is unaffected.
 */

const AUDIT = ["executions", "transitions", "publicTape", "adminErrors"] as const;
const run = (options: VenueOptions, commands: readonly EngineCommand[]) => {
  const venue = new Venue(options);
  for (const c of commands) venue.submit(c);
  return venue;
};

describe("A-6 audit history", () => {
  it("A-6 by default no audit history is discarded, however long the run", () => {
    const venue = run(durableOptions(), orderFlow(7, 1_500));
    expect(venue.auditDropped).toEqual({ executions: 0, transitions: 0, publicTape: 0, adminErrors: 0 });
    expect(venue.historyComplete).toBe(true);
    expect(reconcile(venue)).toMatchObject({ ok: true, history: "complete", historyReasons: [] });
  });

  it("A-6 opt-in audit retention bounds every audit store, keeps exactly the newest records and marks history partial", () => {
    const commands = orderFlow(7, 600);
    const full = run(durableOptions(), commands);
    const bounded = new Venue(durableOptions({}, { auditRetention: 20 }));
    for (const c of commands) {
      bounded.submit(c);
      for (const store of AUDIT) expect(bounded[store].length).toBeLessThanOrEqual(20);
    }
    for (const store of AUDIT) {
      expect(bounded[store]).toEqual(full[store].slice(-20));
      expect(bounded.auditDropped[store]).toBe(Math.max(0, full[store].length - 20));
    }
    expect(bounded.historyComplete).toBe(false);
    expect(bounded.historyIncompleteReasons).toEqual(expect.arrayContaining(["audit-retention:executions", "audit-retention:publicTape"]));
    const report = reconcile(bounded);
    expect(report).toMatchObject({ ok: true, history: "partial" });
    expect(report.historyReasons).toEqual(bounded.historyIncompleteReasons);
  });

  it("A-6 reconciliation never reports complete history after a snapshot restore; a full replay is complete", () => {
    const store = new MemoryJournalStore();
    const venue = run(durableOptions({ store }), orderFlow(8, 60));
    const snapshot = JSON.parse(JSON.stringify(venue.snapshot())) as VenueSnapshot;
    const restored = Venue.recover(durableOptions({ store }), undefined, snapshot).venue;
    expect(reconcile(restored)).toMatchObject({ history: "partial", historyReasons: ["snapshot-restore"] });
    expect(reconcile(Venue.recover(durableOptions({ store })).venue)).toMatchObject({ history: "complete", historyReasons: [] });
  });
});

describe("A-6 private-event outbox and eventsPage", () => {
  it("A-6 the ring-buffer outbox returns exactly what the Milestone 10 outbox returned", () => {
    const commands = orderFlow(9, 400);
    const unbounded = run(durableOptions({}, { outboxCapacity: 1_000_000 }), commands);
    const bounded = run(durableOptions({}, { outboxCapacity: 5 }), commands);
    for (const a of DURABILITY_ACCOUNTS) {
      const all = unbounded.privateEvents(a);
      expect(bounded.privateEvents(a)).toEqual(all.slice(-5));
      expect(bounded.privateEvents(a, all.at(-3)!.accountSeq)).toEqual(all.slice(-2));
    }
  });

  it("A-6 eventsPage reports gaps exactly: at the boundary, across a wrap, beyond the high-water mark", () => {
    const venue = run(durableOptions({}, { outboxCapacity: 5 }), orderFlow(9, 400));
    const all = venue.privateEvents("syn-a");
    const first = all[0]!.accountSeq;
    const high = all.at(-1)!.accountSeq;
    expect(venue.privateEventsPage("syn-a", 0)).toEqual({ events: all, firstRetainedAccountSeq: first, highWaterAccountSeq: high, gap: { fromAccountSeq: 1, toAccountSeq: first - 1 } });
    expect(venue.privateEventsPage("syn-a", first - 2).gap).toEqual({ fromAccountSeq: first - 1, toAccountSeq: first - 1 });
    expect(venue.privateEventsPage("syn-a", first - 1)).toMatchObject({ events: all, gap: null });
    expect(venue.privateEventsPage("syn-a", high)).toMatchObject({ events: [], gap: null, highWaterAccountSeq: high });
    expect(venue.privateEventsPage("syn-unknown", 0)).toEqual({ events: [], firstRetainedAccountSeq: 1, highWaterAccountSeq: 0, gap: null });
  });

  it("A-6 after a snapshot restore the high-water mark comes from the snapshot and earlier events are an exact gap", () => {
    const store = new MemoryJournalStore();
    const venue = run(durableOptions({ store }), orderFlow(9, 80));
    const high = venue.privateEvents("syn-b").at(-1)!.accountSeq;
    const restored = Venue.recover(durableOptions({ store }), undefined, JSON.parse(JSON.stringify(venue.snapshot()))).venue;
    expect(restored.privateEventsPage("syn-b", 0)).toEqual({ events: [], firstRetainedAccountSeq: high + 1, highWaterAccountSeq: high, gap: { fromAccountSeq: 1, toAccountSeq: high } });
    expect(restored.privateEventsPage("syn-b", high)).toMatchObject({ events: [], gap: null });
    // A full replay regenerates the outbox.
    expect(Venue.recover(durableOptions({ store })).venue.privateEventsPage("syn-b", 0)).toMatchObject({ gap: null, highWaterAccountSeq: high });
  });

  it("A-6 per-account sequence numbers are contiguous, so a gap can only come from retention", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), (seed) => {
        const venue = run(durableOptions({}, { outboxCapacity: 1_000_000 }), orderFlow(seed, 120));
        for (const a of DURABILITY_ACCOUNTS) venue.privateEvents(a).forEach((e, i) => expect(e.accountSeq).toBe(i + 1));
      }),
      { numRuns: 30, seed: 3 },
    );
  });

  it("A-6 the gateway keeps events() unchanged and adds eventsPage() for the caller's own account only", () => {
    const venue = run(durableOptions({}, { outboxCapacity: 4 }), orderFlow(9, 50));
    const gateway = new VenueGateway(venue, { clock: DURABILITY_CLOCK, ...DEFAULT_GATEWAY_LIMITS });
    const token = gateway.openSession("syn-a");
    expect(gateway.events(token)).toEqual(venue.privateEvents("syn-a"));
    expect(gateway.eventsPage(token, 0)).toEqual(venue.privateEventsPage("syn-a", 0));
    expect(gateway.eventsPage("not-a-session", 0)).toBeNull();
  });
});

describe("A-6 head-only in-memory journal", () => {
  it("A-6 head-only mode requires a store, refuses whole-journal reads, and recovers to the same state as full mode", () => {
    expect(() => new Venue(durableOptions({}, { journalMemory: "head" }))).toThrow(/journalMemory.*store/);
    const commands = orderFlow(10, 120);
    const fullStore = new MemoryJournalStore();
    const headStore = new MemoryJournalStore();
    const full = run(durableOptions({ store: fullStore }), commands);
    const head = run(durableOptions({ store: headStore, records: new MemoryCommitRecordStore() }, { journalMemory: "head" }), commands);
    expect(() => head.journal.entries).toThrow(/head-only/);
    expect(() => head.journal.toJsonl()).toThrow(/head-only/);
    expect({ seq: head.journal.lastSeq, head: head.journal.head, ts: head.journal.lastTs }).toEqual({ seq: full.journal.lastSeq, head: full.journal.head, ts: full.journal.lastTs });
    expect(headStore.read()).toBe(fullStore.read());
    expect(fingerprint(head)).toEqual(fingerprint(full));
    const snapshot = JSON.parse(JSON.stringify(head.snapshot())) as VenueSnapshot;
    expect(fingerprint(Venue.recover(durableOptions({ store: headStore }, { journalMemory: "head" }), undefined, snapshot).venue)).toEqual(fingerprint(full));
    expect(fingerprint(Venue.recover(durableOptions({ store: headStore }, { journalMemory: "head" })).venue)).toEqual(fingerprint(full));
    expect(reconcile(head)).toMatchObject({ history: "complete" });
  });
});

describe("A-4 / A-6 client-ID duplicate protection survives every retention mechanism", () => {
  it("A-4 old filled, cancelled and live orders cannot be accepted again after ledger eviction, outbox and audit wrap, head-only journal, snapshot restore and full replay", () => {
    const store = new MemoryJournalStore();
    const records = new MemoryCommitRecordStore();
    const options = durableOptions({ store, records }, { idempotencyCapacity: 2, outboxCapacity: 3, auditRetention: 5, journalMemory: "head" });
    const venue = new Venue(options);
    for (const c of setupCommands()) venue.submit(c);
    const gateway = new VenueGateway(venue, { clock: DURABILITY_CLOCK, ...DEFAULT_GATEWAY_LIMITS, messages: { limit: 10_000, windowMs: 1_000 } });
    const a = gateway.openSession("syn-a");
    const b = gateway.openSession("syn-b");
    const msg = (clientOrderId: string, o: Record<string, unknown> = {}) => ({ op: "new", clientOrderId, instrumentId: DURABILITY_ALPHA, side: "buy", type: "limit", price: "1990.00", quantity: "0.010", ...o }) as ClientMessage;
    gateway.handle(b, msg("m1", { side: "sell", price: "1995.00" }));
    gateway.handle(a, msg("o-fill", { price: "1995.00" }));
    gateway.handle(a, msg("o-cancel"));
    gateway.handle(a, { op: "cancel", ref: { clientOrderId: "o-cancel" } });
    gateway.handle(a, msg("o-live"));
    for (let i = 0; i < 12; i++) gateway.handle(a, msg(`pad-${i}`, { price: "1980.00" }));
    gateway.handle(b, msg("m2", { side: "sell", price: "1999.00", quantity: "1.000" })); // liquidity a re-executed order would hit
    for (const id of ["o-fill", "o-cancel", "o-live"]) expect(venue.acceptedOrder("syn-a", id)).toBeUndefined();
    expect(venue.auditDropped.publicTape).toBeGreaterThan(0);
    const snapshot = JSON.parse(JSON.stringify(venue.snapshot())) as VenueSnapshot;

    for (const recovered of [venue, Venue.recover(options, undefined, snapshot).venue, Venue.recover(options).venue]) {
      const g = new VenueGateway(recovered, { clock: DURABILITY_CLOCK, ...DEFAULT_GATEWAY_LIMITS });
      const s = g.openSession("syn-a");
      const ordersBefore = recovered.engine.snapshot().orders.length;
      const position = recovered.engine.positionFor("syn-a", DURABILITY_ALPHA);
      for (const id of ["o-fill", "o-cancel", "o-live"]) {
        for (const retry of [msg(id, id === "o-fill" ? { price: "1995.00" } : {}), msg(id, { price: "1999.00", quantity: "0.500" })]) {
          expect(g.handle(s, retry)).toMatchObject({ ok: true, replayed: false, events: [{ kind: "rejected", reason: "duplicate-client-order-id" }] });
        }
      }
      expect(recovered.engine.snapshot().orders.length).toBe(ordersBefore);
      expect(recovered.engine.positionFor("syn-a", DURABILITY_ALPHA)).toBe(position);
    }
  });
});
