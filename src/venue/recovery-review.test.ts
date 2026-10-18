import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage } from "./gateway";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { readJournal } from "./journal";
import { MemoryJournalStore } from "./storage";
import { SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA, anchorFor } from "./test-helpers";
import type { EngineCommand } from "./types";
import { Venue, type VenueOptions } from "./venue";

/**
 * Regression tests for the read-only review of the Milestone 10 working tree
 * (docs/venue/RECOVERY-INTEGRITY.md §7):
 *   VR-24  trailing-duplicate repair could silently drop an acknowledged command (D-5)
 *   VR-25  idempotency records shared mutable event objects with responses (A-4)
 *   VR-26  ledger content after restart depended on the configured capacity (A-4)
 *   VR-27  inaccurate refusal messages for stale copies and blank lines (D-5)
 * plus eviction coverage for A-4. Written before the fixes and run first against the
 * unfixed Milestone 10 tree (docs/venue/verification/m10-review-fixes.log).
 */

const ACCOUNTS = ["syn-a", "syn-b"];
const options = (store?: MemoryJournalStore, extra: Record<string, unknown> = {}): VenueOptions =>
  ({ engine: { idKey: "local-prototype-key", publication: "immediate" }, clock: () => 0, allowTestFixtureIdKey: true, ...(store ? { store, anchor: anchorFor(store) } : {}), ...extra }) as VenueOptions;

function setup(venue: Venue): Venue {
  venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
  for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  return venue;
}

function gatewayFor(venue: Venue) {
  const gateway = new VenueGateway(venue, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
  const tokens = new Map(ACCOUNTS.map((a) => [a, gateway.openSession(a)]));
  return { gateway, token: (a: string) => tokens.get(a)!, send: (a: string, m: ClientMessage) => gateway.handle(tokens.get(a)!, m) };
}

const order = (o: Record<string, unknown> = {}): ClientMessage => ({ op: "new", clientOrderId: "k1", instrumentId: ALPHA, side: "buy", type: "limit", price: "1999.00", quantity: "0.010", ...o }) as ClientMessage;
const command = (i: number): EngineCommand => ({ type: "new-order", accountId: "syn-a", clientOrderId: `j${i}`, instrumentId: ALPHA, side: "buy", orderType: "limit", priceTicks: 3_990 + i, qtyLots: 3, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" });

function journal(n = 6) {
  const store = new MemoryJournalStore();
  const venue = setup(new Venue(options(store)));
  for (let i = 0; i < n; i++) venue.submit(command(i));
  const text = store.read();
  return { store, venue, text, lines: text.trimEnd().split("\n") };
}

/** Recovery must refuse with `pattern` and leave the store byte-identical. */
function refuses(text: string, pattern: RegExp) {
  const store = new MemoryJournalStore();
  store.append(text);
  expect(() => Venue.recover(options(store))).toThrow(pattern);
  expect(store.read()).toBe(text);
}

describe("VR-24 / D-5 duplicate records fail closed", () => {
  it("D-5 a store that acknowledges an append but writes the previous entry again: the acknowledged order is not silently lost", () => {
    const { store, venue, lines } = journal();
    const realAppend = store.append.bind(store);
    // Faulty store: reports success for the next append but persists a copy of the last entry.
    store.append = () => realAppend(`${lines.at(-1)}\n`);
    const r = venue.submit(command(9));
    expect(r.private.map((e) => e.kind)).toEqual(["accepted"]); // acknowledged to the client
    store.append = realAppend;
    const persisted = store.read();
    // Recovery must not reconstruct a state without j9 as if nothing happened: it refuses, store untouched.
    expect(() => Venue.recover(options(store))).toThrow(/duplicate of the last entry \(seq 9\).*cannot establish/);
    expect(store.read()).toBe(persisted);
  });

  it.each([1, 3])("D-5 %i byte-identical copies of the final entry at the end of the journal are refused, not dropped", (copies) => {
    const { text, lines } = journal();
    refuses(text + `${lines.at(-1)}\n`.repeat(copies), /line 10: duplicate of the last entry \(seq 9\)/);
  });

  it("D-5 a copy of the final entry without a trailing newline is refused, not treated as a torn write", () => {
    const { text, lines } = journal();
    refuses(text + lines.at(-1)!, /line 10: duplicate of the last entry \(seq 9\)/);
  });

  it("D-5 a copy of the final entry followed by a blank line is refused as a duplicate (accurate message)", () => {
    const { text, lines } = journal();
    refuses(`${text}${lines.at(-1)}\n\n`, /line 10: duplicate of the last entry \(seq 9\)/);
  });

  it("D-5 an interior copy of the final-so-far entry is refused as a duplicate", () => {
    const { lines } = journal();
    refuses(`${[...lines.slice(0, 5), lines[4]!, ...lines.slice(5)].join("\n")}\n`, /line 6: duplicate of the last entry \(seq 5\)/);
  });

  it("D-5 malformed and partial final writes: a torn partial line is dropped as uncommitted; a complete unparseable line is refused", () => {
    const { text, lines, venue } = journal();
    // Partial copy of the final entry without newline: indistinguishable from any torn write; uncommitted by the
    // store contract (an append is acknowledged only once the full line is stored). Dropped and reported.
    const torn = new MemoryJournalStore();
    torn.append(text + lines.at(-1)!.slice(0, 50));
    // Hand-built journal without a commit anchor (Milestone 10 store contract); the anchored case is D-6.
    const { venue: recovered, report } = Venue.recover(options(torn, { anchor: undefined, allowUnanchored: true }));
    expect(report).toMatchObject({ tornTail: true });
    expect(recovered.engine.stateHash()).toBe(venue.engine.stateHash());
    refuses(`${text}{"seq":10,"ts":0,\n`, /line 10: unparseable entry/);
  });
});

describe("VR-27 / D-5 accurate refusal messages", () => {
  it("D-5 a stale copy of an earlier entry at the very end is named as a copy of that entry", () => {
    const { text, lines } = journal();
    refuses(text + `${lines[3]}\n`, /line 10: copy of earlier entry 4/);
  });

  it("D-5 a blank line, at the end or in the middle, is refused as an empty line", () => {
    const { text, lines } = journal();
    refuses(`${text}\n`, /line 10: empty line/);
    refuses(`${[...lines.slice(0, 3), "", ...lines.slice(3)].join("\n")}\n`, /line 4: empty line/);
  });

  it("D-5 the reader's own classification is reported without the store being repaired", () => {
    const { text, lines } = journal();
    const read = readJournal(text + `${lines.at(-1)}\n`);
    expect(read).toMatchObject({ ok: false, failedAtLine: 10 });
  });
});

describe("VR-25 / A-4 idempotency records are isolated from returned objects", () => {
  it("A-4 mutating a returned response changes neither the ledger, later replays, snapshots, nor earlier responses", () => {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store)));
    const { send } = gatewayFor(venue);
    const first = send("syn-a", order());
    const firstCopy = JSON.parse(JSON.stringify(first));
    const ledgerBefore = JSON.stringify(venue.acceptedOrder("syn-a", "k1"));
    const hashBefore = venue.snapshot().idempotencyHash;

    const replay1 = send("syn-a", order()) as Extract<ReturnType<typeof send>, { ok: true }>;
    const replay1Copy = JSON.parse(JSON.stringify(replay1));
    const accepted = replay1.events[0] as { order: { qtyLots: number } };
    accepted.order.qtyLots = 999;
    replay1.events.push(replay1.events[0]!);

    const replay2 = send("syn-a", order());
    expect(replay2).toEqual({ ...firstCopy, replayed: true });
    expect(JSON.stringify(venue.acceptedOrder("syn-a", "k1"))).toBe(ledgerBefore);
    expect(venue.snapshot().idempotencyHash).toBe(hashBefore);
    expect(first).toEqual(firstCopy);

    // Mutating a later replay does not reach an earlier replay either.
    const replay2Events = (replay2 as Extract<typeof replay2, { ok: true }>).events as { order?: { qtyLots: number } }[];
    replay2Events[0]!.order!.qtyLots = 7;
    expect(JSON.parse(JSON.stringify(replay1Copy))).toEqual({ ...firstCopy, replayed: true });
  });

  it("A-4 ledger records cannot be mutated through acceptedOrder() or through a snapshot after restore", () => {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store)));
    const { send } = gatewayFor(venue);
    const first = send("syn-a", order());
    const record = venue.acceptedOrder("syn-a", "k1")!;
    expect(() => {
      (record.events[0] as { kind: string }).kind = "rejected";
    }).toThrow();
    const snapshot = venue.snapshot();
    const restored = Venue.recover(options(store), undefined, JSON.parse(JSON.stringify(snapshot))).venue;
    const exported = restored.snapshot();
    expect(() => {
      (exported.idempotency[0]![1].events[0] as { kind: string }).kind = "rejected";
    }).toThrow();
    expect(gatewayFor(restored).send("syn-a", order())).toEqual({ ...first, replayed: true });
  });
});

describe("A-4 retries after ledger eviction", () => {
  function evicted() {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store, { idempotencyCapacity: 2 })));
    const g = gatewayFor(venue);
    g.send("syn-b", order({ clientOrderId: "maker", side: "sell", quantity: "0.004" }));
    const original = g.send("syn-a", order({ clientOrderId: "e1" })); // partially fills against the maker
    g.send("syn-a", order({ clientOrderId: "e2", price: "1990.00" }));
    g.send("syn-a", order({ clientOrderId: "e3", price: "1991.00" }));
    expect(venue.acceptedOrder("syn-a", "e1")).toBeUndefined();
    return { store, venue, original, ...g };
  }
  const evictedAnswer = { ok: true, replayed: false, events: [{ kind: "rejected", reason: "duplicate-client-order-id" }] };

  it("A-4 identical and conflicting retries after eviction both get duplicate-client-order-id; never a second execution; lookup by client order id still works", () => {
    const { venue, send, gateway, token, original } = evicted();
    const executions = venue.executions.length;
    expect(send("syn-a", order({ clientOrderId: "e1" }))).toMatchObject(evictedAnswer);
    expect(send("syn-a", order({ clientOrderId: "e1", price: "1985.00", quantity: "0.050" }))).toMatchObject(evictedAnswer);
    expect(venue.executions).toHaveLength(executions);
    const view = gateway.order(token("syn-a"), { clientOrderId: "e1" });
    const acceptedEvent = original.ok ? original.events.find((e) => e.kind === "accepted") : undefined;
    expect(view).toMatchObject({ clientOrderId: "e1", orderId: acceptedEvent && "order" in acceptedEvent ? acceptedEvent.order.orderId : "?", filledLots: 4 });
  });

  it("A-4 the same holds after a full replay and after a snapshot restore with the same capacity", () => {
    const { store, venue } = evicted();
    const snapshot = JSON.parse(JSON.stringify(venue.snapshot()));
    for (const recovered of [Venue.recover(options(store, { idempotencyCapacity: 2 })).venue, Venue.recover(options(store, { idempotencyCapacity: 2 }), undefined, snapshot).venue]) {
      const { send } = gatewayFor(recovered);
      const before = recovered.engine.positionFor("syn-a", ALPHA);
      expect(send("syn-a", order({ clientOrderId: "e1" }))).toMatchObject(evictedAnswer);
      expect(send("syn-a", order({ clientOrderId: "e1", price: "1985.00" }))).toMatchObject(evictedAnswer);
      expect(recovered.engine.positionFor("syn-a", ALPHA)).toBe(before);
      expect(recovered.snapshot().idempotency.map(([k]) => k)).toEqual(venue.snapshot().idempotency.map(([k]) => k));
    }
  });
});

describe("VR-26 / A-4 ledger capacity across restarts", () => {
  it("A-4 a snapshot records its ledger capacity; restoring it under a different capacity is refused without touching the store", () => {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store, { idempotencyCapacity: 2 })));
    const { send } = gatewayFor(venue);
    for (const k of ["e1", "e2", "e3"]) send("syn-a", order({ clientOrderId: k }));
    const snapshot = JSON.parse(JSON.stringify(venue.snapshot()));
    const text = store.read();
    expect(() => Venue.recover(options(store), undefined, snapshot)).toThrow(/idempotency capacity 2 .* configured 100000/);
    expect(store.read()).toBe(text);
    expect(() => Venue.recover(options(store, { idempotencyCapacity: 2 }), undefined, { ...snapshot, idempotencyCapacity: 100_000 })).toThrow(/idempotency ledger hash mismatch/);
    expect(() => Venue.recover(options(store, { idempotencyCapacity: 2 }), undefined, snapshot)).not.toThrow();
  });

  it("A-4 a full replay rebuilds the ledger for the configured capacity: same capacity gives the same ledger; another capacity changes only which retries replay, never execution", () => {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store, { idempotencyCapacity: 2 })));
    const { send } = gatewayFor(venue);
    for (const k of ["e1", "e2", "e3"]) send("syn-a", order({ clientOrderId: k, price: k === "e1" ? "1999.00" : "1990.00" }));
    const same = Venue.recover(options(store, { idempotencyCapacity: 2 })).venue;
    expect(same.snapshot().idempotency).toEqual(venue.snapshot().idempotency);
    const larger = Venue.recover(options(store, { idempotencyCapacity: 10 })).venue;
    expect(larger.snapshot().idempotency.map(([k]) => k.split("\u0000")[1])).toEqual(["e1", "e2", "e3"]);
    const r = gatewayFor(larger).send("syn-a", order({ clientOrderId: "e1" }));
    expect(r).toMatchObject({ ok: true, replayed: true });
    expect(larger.engine.openOrdersFor("syn-a")).toHaveLength(3);
  });
});
