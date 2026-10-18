import fc from "fast-check";
import { BookSide } from "./book";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, readJournal } from "./journal";
import { MemoryJournalStore, type AppendFault } from "./storage";
import { createLocalVenue, seededRandom, SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA, anchorFor } from "./test-helpers";
import type { EngineCommand, PrivateEvent, PublicMessage } from "./types";
import { OutcomeUnknownError, Venue, type PersistenceBoundary, type VenueOptions } from "./venue";

/**
 * Phase C: process interruption at every persistence boundary, then recovery
 * from the durable store, compared with an uninterrupted reference run of the
 * commands that were committed. Results: docs/venue/RECOVERY-TEST-RESULTS.md.
 */

const ACCOUNTS = ["syn-a", "syn-b", "syn-c"];
const ENGINE = { idKey: "local-prototype-key", publication: "immediate" as const };
type Boundary = AppendFault | "after-journal" | "after-process";
const BOUNDARIES: Boundary[] = ["before-write", "torn-write", "after-write", "after-journal", "after-process"];
/** Whether the interrupted command is part of the committed journal. */
const COMMITTED: Record<Boundary, boolean> = { "before-write": false, "torn-write": false, "after-write": true, "after-journal": true, "after-process": true };

/** Deterministic synthetic flow (engine commands): setup, then orders, cancels and replaces. */
function flow(seed: number, n: number): EngineCommand[] {
  const rnd = seededRandom(seed);
  const pick = (k: number) => Math.floor(rnd() * k);
  const out: EngineCommand[] = [
    { type: "admin.add-instrument", spec: { id: "SYN-ALPHA", priceDecimals: 2, tickUnits: 50, sizeDecimals: 3, lotUnits: 1, minPriceTicks: 1, maxPriceTicks: 2_000_000, minQtyLots: 1, maxQtyLots: 1_000_000, priceBandBps: 1_000, minHiddenQtyLots: 100, referencePriceTicks: 4_000 } },
    ...ACCOUNTS.map((accountId): EngineCommand => ({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS })),
  ];
  for (let i = 0; i < n; i++) {
    const accountId = ACCOUNTS[pick(3)]!;
    const r = rnd();
    if (r < 0.6) {
      const hidden = pick(4) === 0;
      out.push({
        type: "new-order",
        accountId,
        clientOrderId: `c${i}`,
        instrumentId: ALPHA,
        side: pick(2) ? "buy" : "sell",
        orderType: "limit",
        priceTicks: 3_995 + pick(11),
        qtyLots: hidden ? 100 + pick(200) : 1 + pick(150),
        tif: hidden ? "gtc" : (["gtc", "gtc", "ioc", "fok"] as const)[pick(4)]!,
        visibility: hidden ? "hidden" : "displayed",
        postOnly: pick(8) === 0,
        stp: (["cancel-taker", "cancel-maker", "cancel-both"] as const)[pick(3)]!,
      });
    } else if (r < 0.8) out.push({ type: "cancel", accountId, ref: { clientOrderId: `c${pick(i + 1)}` } });
    else if (r < 0.95) out.push({ type: "replace", accountId, ref: { clientOrderId: `c${pick(i + 1)}` }, priceTicks: 3_995 + pick(11), qtyLots: 1 + pick(300) });
    else out.push({ type: "mass-cancel", accountId });
  }
  return out;
}

/** A consumer that keeps everything it has seen, de-duplicating by sequence (D-4). */
class Consumer {
  readonly tape: PublicMessage[] = [];
  readonly events = new Map<string, PrivateEvent[]>();
  attach(venue: Venue) {
    venue.onPublic((m) => {
      if (m.publicSeq > (this.tape.at(-1)?.publicSeq ?? 0)) this.tape.push(m);
    });
  }
  pull(venue: Venue) {
    for (const a of ACCOUNTS) {
      const box = this.events.get(a) ?? [];
      for (const e of venue.privateEvents(a, box.at(-1)?.accountSeq ?? 0)) box.push(e);
      this.events.set(a, box);
    }
  }
}

function observable(venue: Venue) {
  return {
    stateHash: venue.engine.stateHash(),
    outputHead: venue.outputHead,
    journal: { seq: venue.journal.lastSeq, head: venue.journal.head },
    openOrders: ACCOUNTS.map((a) => venue.engine.openOrdersFor(a)),
    executions: venue.executions,
    tape: venue.publicTape,
    events: ACCOUNTS.map((a) => venue.privateEvents(a)),
  };
}

/** Test-only subclass: simulates process death at one persistence boundary of one command. */
class CrashingVenue extends Venue {
  private readonly at: Boundary;
  private readonly seq: number;
  constructor(options: VenueOptions, at: Boundary, seq: number) {
    super(options);
    this.at = at;
    this.seq = seq;
  }
  protected override boundary(point: PersistenceBoundary, seq: number): void {
    if (point === this.at && seq === this.seq) throw new Error("process killed");
  }
}

function reference(commands: EngineCommand[]) {
  const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 1_700_000_000_000 });
  for (const c of commands) venue.submit(c);
  return venue;
}

describe("crash at persistence boundaries", () => {
  it("D-1 / D-2 / D-4 recovery equals the last committed state at every boundary, and the journal stays appendable", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.nat(), fc.constantFrom(...BOUNDARIES), (seed, at, boundary) => {
        const commands = flow(seed, 80);
        const k = 4 + (at % (commands.length - 4)); // crash while submitting commands[k]
        const store = new MemoryJournalStore();
        const options: VenueOptions = { engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 1_700_000_000_000, store, anchor: anchorFor(store) };
        const live = new CrashingVenue(options, boundary, k + 1);
        const consumer = new Consumer();
        consumer.attach(live);
        let interrupted = false;
        for (const [i, c] of commands.entries()) {
          if (i === k && (boundary === "before-write" || boundary === "torn-write" || boundary === "after-write")) store.failNextAppend = boundary;
          try {
            live.submit(c);
          } catch (error) {
            expect(error).toBeInstanceOf(OutcomeUnknownError);
            interrupted = true;
            break;
          }
          consumer.pull(live);
        }
        expect(interrupted).toBe(true);
        // The "process" is gone; anything it holds in memory is lost. Recover from the store alone.
        const { venue: recovered, report } = Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 1_700_000_000_000, store, anchor: anchorFor(store) });
        expect(report.tornTail).toBe(boundary === "torn-write");
        consumer.attach(recovered);
        for (const m of recovered.publicTape) if (m.publicSeq > (consumer.tape.at(-1)?.publicSeq ?? 0)) consumer.tape.push(m);
        consumer.pull(recovered);

        const committed = commands.slice(0, COMMITTED[boundary] ? k + 1 : k);
        const ref = reference(committed);
        expect(observable(recovered)).toEqual(observable(ref));
        // What the consumer ends up with equals the reference outputs: nothing lost, nothing duplicated.
        expect(consumer.tape).toEqual(ref.publicTape);
        expect(ACCOUNTS.map((a) => consumer.events.get(a))).toEqual(ACCOUNTS.map((a) => ref.privateEvents(a)));

        // The recovered venue keeps appending to the same store; a second recovery sees one valid journal.
        for (const c of commands.slice(committed.length)) recovered.submit(c);
        const again = Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 1_700_000_000_000, store, anchor: anchorFor(store) });
        expect(again.report.tornTail).toBe(false);
        expect(again.venue.engine.stateHash()).toBe(reference(commands).engine.stateHash());
      }),
      { numRuns: 150 },
    );
  });

  it("VR-07 a failed append stops the venue: no later command can follow a torn line in the store", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    const commands = flow(1, 10);
    commands.slice(0, 6).forEach((c) => venue.submit(c));
    store.failNextAppend = "torn-write";
    expect(() => venue.submit(commands[6]!)).toThrow(OutcomeUnknownError);
    expect(() => venue.submit(commands[7]!)).toThrow(/venue stopped/);
    const read = readJournal(store.read());
    expect(read).toMatchObject({ ok: true, tornTail: true });
    expect(read.ok && read.entries.length).toBe(6);
  });

  it("D-2 a complete final entry without its newline is committed, and recovery restores the newline before appending", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    const commands = flow(2, 10);
    commands.forEach((c) => venue.submit(c));
    store.truncate(store.read().length - 1);
    const { venue: recovered } = Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    expect(recovered.journal.lastSeq).toBe(commands.length);
    recovered.submit({ type: "publish" });
    expect(readJournal(store.read())).toMatchObject({ ok: true, tornTail: false });
  });

  it("VR-10 / D-5 a duplicated final line refuses recovery without touching the store; an interior duplicate does too", () => {
    // Milestone 9 refused any duplicate. Milestone 10 first dropped a trailing copy (D-5), which could hide a lost
    // acknowledged entry (VR-24); the rule is fail-closed again. Full coverage: recovery-review.test.ts.
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    flow(3, 5).forEach((c) => venue.submit(c));
    const lines = store.read().trimEnd().split("\n");
    store.append(`${lines.at(-1)}\n`);
    const persisted = store.read();
    expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) })).toThrow(/duplicate of the last entry/);
    expect(store.read()).toBe(persisted);
    const interior = new MemoryJournalStore();
    interior.append(`${[...lines.slice(0, 3), lines[2]!, ...lines.slice(3)].join("\n")}\n`);
    expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store: interior, anchor: anchorFor(interior) })).toThrow(/line 4: duplicate of the last entry \(seq 3\)/);
  });


  it("VR-18 a command that faults deterministically stops replay and names its sequence number (poison command)", () => {
    const venue = reference(flow(4, 20));
    const poison: EngineCommand = { type: "new-order", accountId: "syn-a", clientOrderId: "poison", instrumentId: ALPHA, side: "buy", orderType: "limit", priceTicks: 3_900, qtyLots: 1, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" };
    const r = venue.submit(poison);
    venue.submit({ type: "publish" });
    // A logic fault that hits this order on every replay (stands in for an engine bug).
    const original = BookSide.prototype.add;
    BookSide.prototype.add = function (this: BookSide, order: Parameters<BookSide["add"]>[0]) {
      if (order.clientOrderId === "poison") throw new Error("deterministic fault");
      return original.call(this, order);
    };
    try {
      expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0 }, venue.journal.toJsonl())).toThrow(new RegExp(`replay stopped at seq ${r.seq}: deterministic fault`));
    } finally {
      BookSide.prototype.add = original;
    }
  });

  it("VR-05 a snapshot whose content was altered is refused even when it is internally consistent", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    lv.venue.submit({ type: "new-order", accountId: "syn-a", clientOrderId: "r", instrumentId: ALPHA, side: "buy", orderType: "limit", priceTicks: 3_998, qtyLots: 10, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" });
    const snap = JSON.parse(JSON.stringify(lv.venue.snapshot()));
    snap.engine.orders.find((o: { clientOrderId: string }) => o.clientOrderId === "r").priceTicks = 4_200;
    expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: lv.clock.read }, lv.venue.journal.toJsonl(), snap)).toThrow(/state hash mismatch/);
    // The untouched snapshot still restores.
    expect(Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: lv.clock.read }, lv.venue.journal.toJsonl(), lv.venue.snapshot()).venue.engine.stateHash()).toBe(lv.venue.engine.stateHash());
  });

  it("externally visible results never get ahead of the durable journal", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    const committedSeqs = () => new Set(store.read().trimEnd().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq));
    let checked = 0;
    venue.onPublic(() => {
      // When a public message is delivered, the command that caused it is already durable.
      expect(committedSeqs().has(venue.journal.lastSeq)).toBe(true);
      checked++;
    });
    for (const c of flow(5, 200)) {
      const r = venue.submit(c);
      expect(committedSeqs().has(r.seq)).toBe(true);
      expect(store.read().endsWith(`${canonicalJson(venue.journal.entries.at(-1))}\n`)).toBe(true);
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("recovery-contract review notes (Milestone 9 review)", () => {
  const order = (clientOrderId: string): EngineCommand => ({ type: "new-order", accountId: "syn-a", clientOrderId, instrumentId: ALPHA, side: "buy", orderType: "limit", priceTicks: 3_990, qtyLots: 5, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" });

  it("VR-20 a failure while routing outputs after the commit is reported as outcome-unknown, not 'nothing recorded'", () => {
    const store = new MemoryJournalStore();
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    // Rebuild the same venue on a store so the committed command can be recovered.
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: lv.clock.read, store, anchor: anchorFor(store) });
    for (const e of lv.venue.journal.entries) venue.submit(e.command);
    const route = vi.spyOn(Venue.prototype as unknown as { route(r: unknown): void }, "route").mockImplementationOnce(() => {
      throw new Error("routing fault");
    });
    expect(() => venue.submit(order("routed"))).toThrow(OutcomeUnknownError);
    route.mockRestore();
    expect(venue.stoppedReason).toMatch(/output routing failed/);
    expect(() => venue.submit(order("after"))).toThrow(/venue stopped/);
    const { venue: recovered } = Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: lv.clock.read, store, anchor: anchorFor(store) });
    expect(recovered.engine.orderFor("syn-a", { clientOrderId: "routed" })).toMatchObject({ status: "new" });
    expect(recovered.engine.orderFor("syn-a", { clientOrderId: "after" })).toBeNull();
  });

  it("VR-20 through the gateway the same failure answers outcome-unknown", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    const route = vi.spyOn(Venue.prototype as unknown as { route(r: unknown): void }, "route").mockImplementationOnce(() => {
      throw new Error("routing fault");
    });
    const r = lv.gateway.handle(lv.tokens.get("syn-a")!, { op: "new", clientOrderId: "g", instrumentId: ALPHA, side: "buy", type: "limit", price: "1995.00", quantity: "0.005" });
    route.mockRestore();
    expect(r).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
  });

  it("VR-21 recovery refuses journal text and a store together", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    flow(6, 5).forEach((c) => venue.submit(c));
    expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) }, venue.journal.toJsonl())).toThrow(/not both/);
  });

  it("VR-22 a recovery that fails leaves the store byte-for-byte untouched (bad snapshot, poison command)", () => {
    const store = new MemoryJournalStore();
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    flow(7, 30).forEach((c) => venue.submit(c));
    const snapshot = venue.snapshot();
    venue.submit(order("poison"));
    // A torn tail that a successful recovery would truncate.
    store.failNextAppend = "torn-write";
    expect(() => venue.submit(order("torn"))).toThrow(OutcomeUnknownError);
    const before = store.read();
    expect(readJournal(before)).toMatchObject({ ok: true, tornTail: true });

    const altered = { ...snapshot, stateHash: "0".repeat(64) };
    expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) }, undefined, altered)).toThrow(/state hash mismatch/);
    expect(store.read()).toBe(before);

    const original = BookSide.prototype.add;
    BookSide.prototype.add = function (this: BookSide, o: Parameters<BookSide["add"]>[0]) {
      if (o.clientOrderId === "poison") throw new Error("deterministic fault");
      return original.call(this, o);
    };
    try {
      expect(() => Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) })).toThrow(/replay stopped/);
    } finally {
      BookSide.prototype.add = original;
    }
    expect(store.read()).toBe(before);

    // Once recovery succeeds, the torn tail is repaired.
    Venue.recover({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, store, anchor: anchorFor(store) });
    expect(readJournal(store.read())).toMatchObject({ ok: true, tornTail: false });
  });

  it("VR-23 crash injection is not configurable through VenueOptions; only a test subclass can simulate a crash", () => {
    const hooks = { afterJournal: () => {
      throw new Error("must never run");
    } };
    // @ts-expect-error -- `crashHooks` is no longer part of the public options.
    const venue = new Venue({ engine: ENGINE, allowTestFixtureIdKey: true, clock: () => 0, crashHooks: hooks });
    expect(() => flow(8, 5).forEach((c) => venue.submit(c))).not.toThrow();
    expect(venue.stoppedReason).toBeNull();
  });
});
