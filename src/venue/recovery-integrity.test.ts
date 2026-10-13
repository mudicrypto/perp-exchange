import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayResponse } from "./gateway";
import { canonicalJson, entryHash, type JournalEntry } from "./journal";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { MemoryJournalStore } from "./storage";
import { createLocalVenue, SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA } from "./test-helpers";
import type { EngineCommand } from "./types";
import { Venue, type PersistenceBoundary, type VenueOptions } from "./venue";

/**
 * Milestone 10 — recovery integrity and idempotency (docs/venue/RECOVERY-INTEGRITY.md).
 * Rules: A-4 (idempotency across restarts, VR-09), D-5 (duplicate and conflicting journal
 * records, VR-10), A-5 (order-ID key policy, VR-14).
 *
 * Written before the implementation and run against the Milestone 9 commit (27dee34) first;
 * only APIs that exist there are used, so the file loads against both versions.
 */

const FIXTURE_KEY = "local-prototype-key";
const ACCOUNTS = ["syn-a", "syn-b"];
const NOW = 1_700_000_000_000;
const LIMITS = { messages: { limit: 1e9, windowMs: 1_000 }, postOnlyRejects: { limit: 1e9, windowMs: 1_000 } };

const options = (store?: MemoryJournalStore, extra: Record<string, unknown> = {}): VenueOptions =>
  ({ engine: { idKey: FIXTURE_KEY, publication: "immediate" }, clock: () => NOW, allowTestFixtureIdKey: true, ...(store ? { store } : {}), ...extra }) as VenueOptions;

function setup<V extends Venue>(venue: V): V {
  venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
  for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  return venue;
}

function gatewayFor(venue: Venue) {
  const gateway = new VenueGateway(venue, { clock: () => NOW, ...DEFAULT_GATEWAY_LIMITS, ...LIMITS });
  const sessions = new Map(ACCOUNTS.map((a) => [a, gateway.openSession(a)]));
  return { gateway, send: (account: string, message: ClientMessage) => gateway.handle(sessions.get(account)!, message) };
}

const order = (o: Record<string, unknown> = {}): ClientMessage => ({ op: "new", clientOrderId: "k1", instrumentId: ALPHA, side: "buy", type: "limit", price: "1999.00", quantity: "0.010", ...o }) as ClientMessage;

/** Restart: the process and its gateway are gone; only the store survives. */
function restart(store: MemoryJournalStore, snapshot?: ReturnType<Venue["snapshot"]>) {
  const { venue, report } = Venue.recover(options(store), undefined, snapshot);
  return { venue, report, ...gatewayFor(venue) };
}

class CrashingVenue extends Venue {
  crashAt: { point: PersistenceBoundary; seq: number } | null = null;
  protected override boundary(point: PersistenceBoundary, seq: number): void {
    if (this.crashAt && this.crashAt.point === point && this.crashAt.seq === seq) throw new Error("process killed");
  }
}

describe("A-4 / VR-09 idempotency across restarts", () => {
  it("A-4 an identical retry after a restart (full replay) returns the original events and is not journaled again", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    const { send } = gatewayFor(live);
    send("syn-b", order({ clientOrderId: "maker", side: "sell", price: "1999.00", quantity: "0.004" }));
    const first = send("syn-a", order());
    expect(first).toMatchObject({ ok: true, replayed: false, events: [{ kind: "accepted" }, { kind: "fill" }] });

    const after = restart(store);
    const seq = after.venue.journal.lastSeq;
    const retry = after.send("syn-a", order());
    expect(retry).toEqual({ ...first, replayed: true });
    expect(after.venue.journal.lastSeq).toBe(seq);
    expect(after.venue.executions).toHaveLength(1);
  });

  it("A-4 the same holds after recovery from a snapshot taken after the order was accepted", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    const { send } = gatewayFor(live);
    const first = send("syn-a", order());
    send("syn-b", order({ clientOrderId: "other", side: "sell", price: "2010.00" }));
    const snapshot = live.snapshot();
    send("syn-b", order({ clientOrderId: "later", side: "sell", price: "2011.00" }));

    const after = restart(store, JSON.parse(JSON.stringify(snapshot)));
    const seq = after.venue.journal.lastSeq;
    expect(after.send("syn-a", order())).toEqual({ ...first, replayed: true });
    expect(after.venue.journal.lastSeq).toBe(seq);
  });

  it("A-4 a conflicting retry after a restart is refused without being journaled", () => {
    const store = new MemoryJournalStore();
    const { send } = gatewayFor(setup(new Venue(options(store))));
    send("syn-a", order());
    const after = restart(store);
    const seq = after.venue.journal.lastSeq;
    expect(after.send("syn-a", order({ price: "1998.00" }))).toMatchObject({ ok: false, error: { code: "idempotency-conflict" } });
    expect(after.venue.journal.lastSeq).toBe(seq);
  });

  it("A-4 an outcome-unknown request is resolved by an identical retry once the venue is recovered", () => {
    for (const point of ["after-journal", "after-process"] as const) {
      const store = new MemoryJournalStore();
      const live = setup(new CrashingVenue(options(store)));
      const { send } = gatewayFor(live);
      send("syn-b", order({ clientOrderId: "maker", side: "sell", price: "1999.00", quantity: "0.004" }));
      live.crashAt = { point, seq: live.journal.lastSeq + 1 };
      expect(send("syn-a", order())).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });

      const after = restart(store);
      const seq = after.venue.journal.lastSeq;
      const retry = after.send("syn-a", order());
      expect(retry).toMatchObject({ ok: true, replayed: true, events: [{ kind: "accepted" }, { kind: "fill" }] });
      expect(after.venue.journal.lastSeq).toBe(seq);
      expect(after.venue.executions).toHaveLength(1);
    }
  });

  it("A-4 messages that normalise to the same engine command are the same request (\"1999.0\" vs \"1999.00\")", () => {
    const store = new MemoryJournalStore();
    const { send } = gatewayFor(setup(new Venue(options(store))));
    const first = send("syn-a", order({ price: "1999.00" }));
    expect(send("syn-a", order({ price: "1999.0", quantity: "0.0100" }))).toEqual({ ...first, replayed: true });
    expect(restart(store).send("syn-a", order({ price: "1999" , quantity: "0.01" }))).toEqual({ ...first, replayed: true });
  });

  it("A-4 while the venue is stopped, an identical retry is answered from committed outputs; anything new is unavailable", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    const { send } = gatewayFor(live);
    const first = send("syn-a", order());
    store.failNextAppend = "before-write";
    expect(send("syn-a", order({ clientOrderId: "k2" }))).toMatchObject({ ok: false, error: { code: "outcome-unknown" } });
    expect(live.stoppedReason).not.toBeNull();
    expect(send("syn-a", order())).toEqual({ ...first, replayed: true });
    expect(send("syn-a", order({ clientOrderId: "k3" }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("A-4 a rejected request is evaluated again after a restart (it never consumed the client order id)", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    live.submit({ type: "admin.set-status", instrumentId: ALPHA, status: "halted" });
    expect(gatewayFor(live).send("syn-a", order())).toMatchObject({ ok: true, events: [{ kind: "rejected", reason: "trading-halted" }] });
    const after = restart(store);
    after.venue.submit({ type: "admin.set-status", instrumentId: ALPHA, status: "continuous" });
    expect(after.send("syn-a", order())).toMatchObject({ ok: true, replayed: false, events: [{ kind: "accepted" }] });
  });

  it("A-4 the ledger rebuilt by full replay and the ledger restored from a snapshot equal the live ledger", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    const { send } = gatewayFor(live);
    for (let i = 0; i < 12; i++) send(ACCOUNTS[i % 2]!, order({ clientOrderId: `L${i}`, side: i % 2 ? "sell" : "buy", price: (1_996 + (i % 5)).toFixed(2), quantity: "0.003" }));
    const snapshot = live.snapshot();
    for (let i = 12; i < 20; i++) send(ACCOUNTS[i % 2]!, order({ clientOrderId: `L${i}`, side: i % 2 ? "sell" : "buy", price: (1_996 + (i % 5)).toFixed(2), quantity: "0.003" }));
    const ledger = (v: Venue) => v.snapshot().idempotency;
    expect(ledger(Venue.recover(options(store)).venue)).toEqual(ledger(live));
    expect(ledger(Venue.recover(options(store), undefined, JSON.parse(JSON.stringify(snapshot))).venue)).toEqual(ledger(live));
    expect(ledger(live).length).toBeGreaterThan(10);
  });

  it("A-4 an altered idempotency ledger in a snapshot is refused", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store)));
    gatewayFor(live).send("syn-a", order());
    const snapshot = JSON.parse(JSON.stringify(live.snapshot()));
    snapshot.idempotency[0][1].command = snapshot.idempotency[0][1].command.replace('"qtyLots":10', '"qtyLots":11');
    expect(() => Venue.recover(options(store), undefined, snapshot)).toThrow(/idempotency ledger hash mismatch/);
  });

  it("A-4 residual: after a ledger entry is evicted, a retry is refused by the engine as a duplicate — never executed twice", () => {
    const store = new MemoryJournalStore();
    const live = setup(new Venue(options(store, { idempotencyCapacity: 2 })));
    const { send } = gatewayFor(live);
    for (const k of ["e1", "e2", "e3"]) send("syn-a", order({ clientOrderId: k }));
    const retry = send("syn-a", order({ clientOrderId: "e1" }));
    expect(retry).toMatchObject({ ok: true, replayed: false, events: [{ kind: "rejected", reason: "duplicate-client-order-id" }] });
    expect(live.engine.openOrdersFor("syn-a")).toHaveLength(3);
  });

  it("A-4 property: across random restarts, storage faults and retries, accepted orders are never journaled or executed twice", () => {
    type Step =
      | { kind: "new"; account: number; key: number; price: number; fault: "none" | "before-write" | "after-write" }
      | { kind: "retry"; account: number; key: number; conflicting: boolean }
      | { kind: "restart"; snapshot: boolean };
    const step: fc.Arbitrary<Step> = fc.oneof(
      {
        weight: 7,
        arbitrary: fc.record({
          kind: fc.constant("new" as const),
          account: fc.nat(1),
          key: fc.nat(10),
          price: fc.integer({ min: 0, max: 8 }),
          fault: fc.constantFrom("none" as const, "none" as const, "none" as const, "none" as const, "before-write" as const, "after-write" as const),
        }),
      },
      { weight: 5, arbitrary: fc.record({ kind: fc.constant("retry" as const), account: fc.nat(1), key: fc.nat(10), conflicting: fc.boolean() }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant("restart" as const), snapshot: fc.boolean() }) },
    );
    let totalChecks = 0;
    fc.assert(
      fc.property(fc.array(step, { minLength: 5, maxLength: 60, size: "max" }), (steps) => {
        const store = new MemoryJournalStore();
        let venue: Venue = setup(new Venue(options(store)));
        let send = gatewayFor(venue).send;
        let snapshot: ReturnType<Venue["snapshot"]> | undefined;
        const lastSent = new Map<string, ClientMessage>(); // latest message per order key (for retries)
        const accepted = new Map<string, { message: ClientMessage; response: GatewayResponse }>();
        for (const s of steps) {
          if (s.kind === "restart") {
            if (s.snapshot && !venue.stoppedReason) snapshot = venue.snapshot();
            const r = restart(store, s.snapshot ? snapshot : undefined);
            venue = r.venue;
            send = r.send;
            continue;
          }
          if (venue.stoppedReason) continue; // a stopped venue answers only after a restart
          const account = ACCOUNTS[s.account]!;
          const id = `${account}|k${s.key}`;
          let message: ClientMessage;
          if (s.kind === "retry") {
            const previous = lastSent.get(id);
            if (!previous) continue;
            message = s.conflicting ? ({ ...previous, quantity: "0.777" } as ClientMessage) : previous;
          } else {
            message = order({ clientOrderId: `k${s.key}`, side: s.key % 2 ? "sell" : "buy", price: (1_995 + s.price).toFixed(2), quantity: "0.005" });
            if (s.fault !== "none") store.failNextAppend = s.fault;
          }
          const seq = venue.journal.lastSeq;
          const response = send(account, message);
          store.failNextAppend = null;
          const prior = accepted.get(id);
          if (prior) {
            totalChecks++;
            if (canonicalJson(message) === canonicalJson(prior.message)) {
              // Identical retry of an accepted order: the original events, nothing journaled.
              expect(response).toEqual({ ...prior.response, replayed: true });
            } else {
              expect(response).toMatchObject({ ok: false, error: { code: "idempotency-conflict" } });
            }
            expect(venue.journal.lastSeq).toBe(seq);
            continue;
          }
          lastSent.set(id, message);
          if (response.ok && response.events.some((e) => e.kind === "accepted")) accepted.set(id, { message, response: { ...response, replayed: false } });
        }
        const final = Venue.recover(options(store)).venue;
        // Exactly one accepted order per order key, and no execution recorded twice.
        const keys = final.transitions.filter((t) => t.cause === "accept").map((t) => t.orderId);
        expect(new Set(keys).size).toBe(keys.length);
        const execs = final.executions.map((x) => x.execId);
        expect(new Set(execs).size).toBe(execs.length);
      }),
      { numRuns: 150 },
    );
    // The property must actually exercise retries of accepted orders (identical and conflicting).
    expect(totalChecks).toBeGreaterThan(300);
  });
});

describe("D-5 / VR-10 duplicate and conflicting journal records", () => {
  function journal(n = 12) {
    const store = new MemoryJournalStore();
    const venue = setup(new Venue(options(store)));
    for (let i = 0; i < n; i++) {
      venue.submit({ type: "new-order", accountId: ACCOUNTS[i % 2]!, clientOrderId: `j${i}`, instrumentId: ALPHA, side: i % 2 ? "sell" : "buy", orderType: "limit", priceTicks: 3_995 + (i % 7), qtyLots: 3, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" });
    }
    const text = store.read();
    return { store, venue, text, lines: text.trimEnd().split("\n") };
  }
  const reference = (lines: string[]) => Venue.recover(options(), `${lines.join("\n")}\n`).venue;

  // Milestone 10 review (VR-24): trailing duplicates are no longer dropped. A byte-identical copy of the last
  // entry is indistinguishable from a later acknowledged append persisted with the wrong bytes, so it refuses.
  it.each([1, 3])("D-5 %i byte-identical copies of the final line refuse recovery and leave the store untouched", (copies) => {
    const { store, lines } = journal();
    store.append(`${lines.at(-1)}\n`.repeat(copies));
    const persisted = store.read();
    expect(() => Venue.recover(options(store))).toThrow(/line 16: duplicate of the last entry \(seq 15\)/);
    expect(store.read()).toBe(persisted);
    expect(reference(lines).journal.lastSeq).toBe(15); // the journal without the copy is intact and recoverable
  });

  it("D-5 a duplicated final line without its newline is refused the same way (not treated as a torn write)", () => {
    const { store, lines } = journal();
    store.append(lines.at(-1)!);
    const persisted = store.read();
    expect(() => Venue.recover(options(store))).toThrow(/line 16: duplicate of the last entry \(seq 15\)/);
    expect(store.read()).toBe(persisted);
  });

  const refuses = (text: string, pattern: RegExp) => {
    const store = new MemoryJournalStore();
    store.append(text);
    expect(() => Venue.recover(options(store))).toThrow(pattern);
    expect(store.read()).toBe(text); // a refused recovery changes nothing
  };

  it("D-5 an interior duplicate (a copy followed by further entries) is refused", () => {
    const { lines } = journal();
    refuses(`${[...lines.slice(0, 8), lines[7]!, ...lines.slice(8)].join("\n")}\n`, /line 9: duplicate of the last entry \(seq 8\)/);
  });

  it("D-5 a trailing duplicate followed by a torn write is refused (ambiguous)", () => {
    const { lines } = journal();
    refuses(`${lines.join("\n")}\n${lines.at(-1)}\n${lines.at(-1)!.slice(0, 40)}`, /line 16: duplicate of the last entry \(seq 15\)/);
  });

  it("D-5 a re-serialised copy of the final entry (valid hash, different bytes) is refused as reuse with different content", () => {
    const { lines } = journal();
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(last).reverse()));
    expect(reordered).not.toBe(lines.at(-1)); // same entry, different bytes
    refuses(`${lines.join("\n")}\n${reordered}\n`, /sequence number \d+ reused with different content/);
  });

  it("D-5 a different command under an already-used sequence number is refused, at the end and in the interior", () => {
    const { lines } = journal();
    const conflicting = (at: number) => {
      const original = JSON.parse(lines[at]!) as JournalEntry;
      const command: EngineCommand = { type: "publish" };
      return JSON.stringify({ seq: original.seq, ts: original.ts, command, prevHash: original.prevHash, hash: entryHash(original.prevHash, original.seq, original.ts, command) });
    };
    refuses(`${lines.join("\n")}\n${conflicting(lines.length - 1)}\n`, new RegExp(`sequence number ${lines.length} reused with different content`));
    refuses(`${[...lines.slice(0, 6), conflicting(3), ...lines.slice(6)].join("\n")}\n`, /sequence number 4 reused with different content/);
  });

  it("D-5 a sequence gap is refused as a gap", () => {
    const { lines } = journal();
    refuses(`${[...lines.slice(0, 5), ...lines.slice(6)].join("\n")}\n`, /sequence gap: expected 6, found 7/);
  });
});

describe("A-5 / VR-14 order-ID key policy", () => {
  const strong = () => randomBytes(32).toString("base64url");
  const venueWith = (idKey: unknown, extra: Record<string, unknown> = {}) => () => new Venue({ engine: { idKey, publication: "immediate" }, clock: () => 0, ...extra } as unknown as VenueOptions);

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["short", "a".repeat(20)],
    ["42 characters", strong().slice(0, 42)],
    ["outside base64url", `${strong()}!`],
    ["low diversity", "ab".repeat(30)],
  ])("A-5 refuses a %s key without echoing it", (_label, idKey) => {
    expect(venueWith(idKey)).toThrow(/id key/i);
    try {
      venueWith(idKey)();
    } catch (error) {
      if (typeof idKey === "string" && idKey.length > 3) expect((error as Error).message).not.toContain(idKey);
    }
  });

  it("A-5 a test-fixture key is refused unless explicitly allowed, and the flag never relaxes the policy for other keys", () => {
    expect(venueWith(FIXTURE_KEY)).toThrow(/test-fixture/);
    expect(venueWith("perf-key")).toThrow(/test-fixture/);
    expect(venueWith(FIXTURE_KEY, { allowTestFixtureIdKey: true })).not.toThrow();
    expect(venueWith("short-but-not-a-fixture", { allowTestFixtureIdKey: true })).toThrow(/id key/i);
  });

  it("A-5 a strong key is accepted and yields ids unrelated to the fixture key", () => {
    const a = createLocalVenue({ accounts: ["syn-a"], idKey: strong() });
    const b = createLocalVenue({ accounts: ["syn-a"] });
    const id = (lv: typeof a) => {
      const r = lv.gateway.handle(lv.tokens.get("syn-a")!, order());
      return r.ok && r.events[0]!.kind === "accepted" ? r.events[0]!.order.orderId : null;
    };
    expect(id(a)).toMatch(/^o[0-9a-f]{16}$/);
    expect(id(a)).not.toBe(id(b));
  });

  it("A-5 recovery enforces the same policy", () => {
    const store = new MemoryJournalStore();
    setup(new Venue(options(store)));
    expect(() => Venue.recover({ engine: { idKey: "weak", publication: "immediate" }, clock: () => 0, store })).toThrow(/id key/i);
    expect(() => Venue.recover({ engine: { idKey: FIXTURE_KEY, publication: "immediate" }, clock: () => 0, store })).toThrow(/test-fixture/);
  });

  it("A-5 the synthetic factory uses the fixture key explicitly; a weak custom key is refused", () => {
    expect(() => createLocalVenue({ accounts: ["syn-a"] })).not.toThrow();
    expect(() => createLocalVenue({ accounts: ["syn-a"], idKey: "weak" })).toThrow(/id key/i);
  });

  it("A-5 fixture key literals appear only in the key-policy module and tests", () => {
    const dir = join(__dirname);
    const files = readdirSync(dir, { recursive: true }) as string[];
    const offenders = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "id-key.ts" && f !== "test-helpers.ts").filter((f) => /["'`](local-prototype-key|perf-key)["'`]/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
