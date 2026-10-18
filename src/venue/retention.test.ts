import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage } from "./gateway";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { reconcile } from "./reconcile";
import { MemoryAnchorStore, MemoryJournalStore } from "./storage";
import { SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA } from "./test-helpers";
import type { EngineCommand } from "./types";
import { Venue, type VenueOptions } from "./venue";

/**
 * Milestone 11, WP3: VR-13 within the in-memory prototype (MATCHING-RULES A-6).
 *
 * - Private-event retention gaps are signalled explicitly instead of silently (outbox overflow, snapshot restore).
 * - Optional caps on the derivable audit stores, disabled by default; when they evict, history is marked
 *   incomplete and full reconciliation is done by replaying the journal.
 * - Retention never trims the engine's client-ID index or the terminal-order lookup (A-4).
 *
 * Written before the implementation and run first against 9812049 + WP1/WP2
 * (docs/venue/verification/m11/wp3-tests-before-implementation.log).
 */

const ACCOUNTS = ["syn-a", "syn-b"];
const base = (extra: Partial<VenueOptions> = {}): VenueOptions => ({ engine: { idKey: "local-prototype-key", publication: "immediate" }, allowTestFixtureIdKey: true, clock: () => 0, ...extra });

function venueWith(extra: Partial<VenueOptions> = {}) {
  const store = new MemoryJournalStore();
  const anchor = new MemoryAnchorStore();
  const options = base({ store, anchor, ...extra });
  const venue = new Venue(options);
  venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
  for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  return { store, anchor, options, venue };
}
const order = (clientOrderId: string, o: Partial<Extract<EngineCommand, { type: "new-order" }>> = {}): EngineCommand => ({
  type: "new-order",
  accountId: "syn-a",
  clientOrderId,
  instrumentId: ALPHA,
  side: "buy",
  orderType: "limit",
  priceTicks: 3_990,
  qtyLots: 2,
  tif: "gtc",
  visibility: "displayed",
  postOnly: false,
  stp: "cancel-taker",
  ...o,
});
/** One accepted resting order per call: one private event for syn-a. */
const rest = (venue: Venue, n: number, from = 0) => {
  for (let i = from; i < from + n; i++) venue.submit(order(`r${i}`, { priceTicks: 3_950 + (i % 30) }));
};
/** A maker/taker pair that trades: executions, prints, fills. */
const trade = (venue: Venue, i: number) => {
  venue.submit(order(`m${i}`, { accountId: "syn-b", side: "sell", priceTicks: 4_000, qtyLots: 1 }));
  venue.submit(order(`k${i}`, { side: "buy", priceTicks: 4_000, qtyLots: 1, tif: "ioc" }));
};

describe("A-6 private-event retention is explicit", () => {
  it("A-6 an outbox that dropped events reports a gap; within the retained window it reports none", () => {
    const { venue } = venueWith({ outboxCapacity: 5 });
    rest(venue, 12);
    const page = venue.privateEventsPage("syn-a", 0);
    expect(page).toMatchObject({ gap: true, firstAvailableAccountSeq: 8, latestAccountSeq: 12 });
    expect(page.events.map((e) => e.accountSeq)).toEqual([8, 9, 10, 11, 12]);
    expect(venue.privateEventsPage("syn-a", 3).gap).toBe(true);
    expect(venue.privateEventsPage("syn-a", 7)).toMatchObject({ gap: false });
    expect(venue.privateEventsPage("syn-a", 7).events.map((e) => e.accountSeq)).toEqual([8, 9, 10, 11, 12]);
    expect(venue.privateEventsPage("syn-a", 12)).toMatchObject({ gap: false, events: [] });
    // An account with no events has nothing missing.
    expect(venue.privateEventsPage("syn-b", 0)).toMatchObject({ gap: false, events: [], latestAccountSeq: 0, firstAvailableAccountSeq: 1 });
    // The legacy reader is unchanged: it returns what is retained, without a marker.
    expect(venue.privateEvents("syn-a", 0).map((e) => e.accountSeq)).toEqual([8, 9, 10, 11, 12]);
  });

  it("A-6 after a snapshot restore only replayed events are retained, and the page reports the gap; a full replay has none", () => {
    const { store, anchor, options, venue } = venueWith();
    rest(venue, 4);
    const snap = venue.snapshot();
    rest(venue, 2, 4);
    const fromSnap = Venue.recover(options, undefined, snap).venue;
    expect(fromSnap.privateEventsPage("syn-a", 0)).toMatchObject({ gap: true, firstAvailableAccountSeq: 5, latestAccountSeq: 6 });
    expect(fromSnap.privateEventsPage("syn-a", 4)).toMatchObject({ gap: false });
    const full = Venue.recover(options).venue;
    expect(full.privateEventsPage("syn-a", 0)).toMatchObject({ gap: false, firstAvailableAccountSeq: 1, latestAccountSeq: 6 });
    expect(store.read().length).toBeGreaterThan(0);
    expect(anchor.read()).not.toBeNull();
    // An account with events only before the snapshot: nothing retained, still a gap.
    const quiet = venueWith();
    quiet.venue.submit(order("b1", { accountId: "syn-b", side: "sell", priceTicks: 4_050 }));
    const s2 = quiet.venue.snapshot();
    quiet.venue.submit(order("a1"));
    expect(Venue.recover(quiet.options, undefined, s2).venue.privateEventsPage("syn-b", 0)).toMatchObject({ gap: true, events: [], latestAccountSeq: 1, firstAvailableAccountSeq: 2 });
  });

  it("A-6 the gateway's eventsPage carries the gap marker for the caller's own account only", () => {
    const { venue } = venueWith({ outboxCapacity: 3 });
    rest(venue, 6);
    const gateway = new VenueGateway(venue, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
    const a = gateway.openSession("syn-a");
    const b = gateway.openSession("syn-b");
    expect(gateway.eventsPage(a, 0)).toMatchObject({ gap: true, firstAvailableAccountSeq: 4, latestAccountSeq: 6 });
    expect(gateway.eventsPage(b, 0)).toMatchObject({ gap: false, events: [], latestAccountSeq: 0 });
    expect(gateway.eventsPage("unknown-token", 0)).toBeNull();
    expect(gateway.events(a, 0)!.map((e) => e.accountSeq)).toEqual([4, 5, 6]);
  });
});

describe("A-6 optional audit-store caps", () => {
  it("A-6 caps are disabled by default: every audit record is kept and history is complete", () => {
    const { venue } = venueWith();
    for (let i = 0; i < 20; i++) trade(venue, i);
    expect(venue.executions).toHaveLength(20);
    expect(venue.historyComplete).toBe(true);
    expect(venue.auditEvicted).toEqual({ executions: 0, transitions: 0, publicTape: 0, adminErrors: 0 });
    expect(reconcile(venue).ok).toBe(true);
  });

  it("A-6 enabled caps keep the most recent records, count evictions and mark history incomplete; a journal replay restores full reconciliation", () => {
    const { options, venue } = venueWith({ auditRetention: { executions: 8, transitions: 16, publicTape: 16, adminErrors: 2 } });
    const reference = venueWith();
    for (let i = 0; i < 60; i++) {
      trade(venue, i);
      trade(reference.venue, i);
    }
    expect(venue.executions.length).toBeGreaterThanOrEqual(8);
    expect(venue.executions.length).toBeLessThanOrEqual(8 + 1);
    expect(venue.executions).toEqual(reference.venue.executions.slice(-venue.executions.length));
    expect(venue.publicTape).toEqual(reference.venue.publicTape.slice(-venue.publicTape.length));
    expect(venue.auditEvicted.executions + venue.executions.length).toBe(60);
    expect(venue.historyComplete).toBe(false);
    // Caps never change trading state or outputs.
    expect(venue.engine.stateHash()).toBe(reference.venue.engine.stateHash());
    expect(venue.outputHead).toBe(reference.venue.outputHead);
    expect(reconcile(venue).ok).toBe(true);
    // Full reconciliation: replay the journal without caps.
    const replayed = Venue.recover({ ...options, auditRetention: undefined }).venue;
    expect(replayed.historyComplete).toBe(true);
    expect(replayed.executions).toHaveLength(60);
    expect(reconcile(replayed).ok).toBe(true);
    expect(replayed.engine.stateHash()).toBe(venue.engine.stateHash());
  });

  it("A-6 invalid caps are refused", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => venueWith({ auditRetention: { executions: bad } })).toThrow(/auditRetention/);
    }
  });
});

describe("A-4 / A-6 retention never trims client-ID deduplication or terminal-order lookup", () => {
  it("A-4 with every retention at its minimum, evicted terminal orders still refuse identical and conflicting retries and are found by client order id, also after restarts", () => {
    const retention: Partial<VenueOptions> = { idempotencyCapacity: 1, outboxCapacity: 1, auditRetention: { executions: 1, transitions: 1, publicTape: 1, adminErrors: 1 } };
    const { options, venue } = venueWith(retention);
    const gateway = new VenueGateway(venue, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
    const a = gateway.openSession("syn-a");
    const b = gateway.openSession("syn-b");
    const filled: ClientMessage = { op: "new", clientOrderId: "f1", instrumentId: ALPHA, side: "buy", type: "limit", price: "2000.00", quantity: "0.002" };
    expect(gateway.handle(b, { op: "new", clientOrderId: "s1", instrumentId: ALPHA, side: "sell", type: "limit", price: "2000.00", quantity: "0.002" })).toMatchObject({ ok: true });
    expect(gateway.handle(a, filled)).toMatchObject({ ok: true, replayed: false });
    const cancelled: ClientMessage = { op: "new", clientOrderId: "c1", instrumentId: ALPHA, side: "buy", type: "limit", price: "1990.00", quantity: "0.003" };
    gateway.handle(a, cancelled);
    gateway.handle(a, { op: "cancel", ref: { clientOrderId: "c1" } });
    for (let i = 0; i < 10; i++) gateway.handle(a, { op: "new", clientOrderId: `z${i}`, instrumentId: ALPHA, side: "buy", type: "limit", price: "1980.00", quantity: "0.001" });
    // Crossing liquidity rests, so a second execution of f1 would fill.
    gateway.handle(b, { op: "new", clientOrderId: "s2", instrumentId: ALPHA, side: "sell", type: "limit", price: "2000.00", quantity: "0.010" });
    const check = (v: Venue) => {
      const g = new VenueGateway(v, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
      const t = g.openSession("syn-a");
      const position = v.engine.positionFor("syn-a", ALPHA);
      for (const m of [filled, { ...filled, price: "2000.50" }, cancelled, { ...cancelled, quantity: "0.004" }] as ClientMessage[]) {
        expect(g.handle(t, m)).toMatchObject({ ok: true, events: [expect.objectContaining({ kind: "rejected", reason: "duplicate-client-order-id" })] });
      }
      expect(v.engine.positionFor("syn-a", ALPHA)).toBe(position);
      expect(g.order(t, { clientOrderId: "f1" })).toMatchObject({ status: "filled", filledLots: 2 });
      expect(g.order(t, { clientOrderId: "c1" })).toMatchObject({ status: "cancelled" });
    };
    check(venue);
    const snap = venue.snapshot();
    check(Venue.recover(options).venue);
    check(Venue.recover(options, undefined, snap).venue);
  });
});
