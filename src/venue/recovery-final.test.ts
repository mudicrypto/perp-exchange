import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayResponse } from "./gateway";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { MemoryJournalStore } from "./storage";
import { SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA, anchorFor } from "./test-helpers";
import type { PublicMessage } from "./types";
import { Venue, type VenueOptions } from "./venue";

/**
 * Regression tests for the final read-only review of the Milestone 10 working tree
 * (docs/venue/RECOVERY-INTEGRITY.md §7):
 *   VR-28  a complete, parseable but invalid final line without a newline was dropped as a torn write (D-2)
 *   VR-29  event objects were shared between the first response, the private feed, the public tape and
 *          every public listener, so one consumer could alter what another observed
 * plus coverage for terminal orders evicted from the idempotency ledger and restored from a snapshot (A-4).
 * Written before the fixes and run first against the unfixed tree (docs/venue/verification/m10-final-review-fixes.log).
 */

const ACCOUNTS = ["syn-a", "syn-b"];
const options = (store?: MemoryJournalStore, extra: Record<string, unknown> = {}): VenueOptions =>
  ({ engine: { idKey: "local-prototype-key", publication: "immediate" }, clock: () => 0, allowTestFixtureIdKey: true, ...(store ? { store, anchor: anchorFor(store) } : {}), ...extra }) as VenueOptions;

function world(store?: MemoryJournalStore, extra: Record<string, unknown> = {}) {
  const venue = new Venue(options(store, extra));
  venue.submit({ type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! });
  for (const accountId of ACCOUNTS) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  return { venue, ...gatewayFor(venue) };
}

function gatewayFor(venue: Venue) {
  const gateway = new VenueGateway(venue, { clock: () => 0, ...DEFAULT_GATEWAY_LIMITS });
  const tokens = new Map(ACCOUNTS.map((a) => [a, gateway.openSession(a)]));
  const token = (a: string) => tokens.get(a)!;
  return { gateway, token, send: (a: string, m: ClientMessage) => gateway.handle(token(a), m) };
}

const order = (o: Record<string, unknown> = {}): ClientMessage => ({ op: "new", clientOrderId: "k1", instrumentId: ALPHA, side: "buy", type: "limit", price: "1999.00", quantity: "0.010", ...o }) as ClientMessage;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const okEvents = (r: GatewayResponse) => (r.ok ? r.events : []) as unknown as Record<string, unknown>[];
/** Try to change a delivered object. A frozen object refuses (throws in strict mode); either way nothing else may change. */
const attempt = (change: () => void) => {
  try {
    change();
  } catch {
    // refused: the object is immutable
  }
};
function scribble(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === "object") scribble(v);
    else attempt(() => ((value as Record<string, unknown>)[key] = typeof v === "number" ? -1 : "tampered"));
  }
}

/** Recovery must refuse with `pattern` and leave the store byte-identical. */
function refuses(text: string, pattern: RegExp) {
  const store = new MemoryJournalStore();
  store.append(text);
  expect(() => Venue.recover(options(store))).toThrow(pattern);
  expect(store.read()).toBe(text);
}

/** A journal whose final entry (seq 4, line 4) is an order acknowledged to the client. */
function acknowledged() {
  const store = new MemoryJournalStore();
  const { venue, send } = world(store);
  const before = venue.engine.stateHash();
  const response = send("syn-a", order());
  expect(okEvents(response).map((e) => e.kind)).toEqual(["accepted"]);
  const text = store.read();
  const lines = text.trimEnd().split("\n");
  const prefix = `${lines.slice(0, -1).join("\n")}\n`;
  return { text, lines, prefix, last: lines.at(-1)!, entry: JSON.parse(lines.at(-1)!) as Record<string, unknown>, before };
}

describe("VR-28 / D-2 a complete but invalid final entry is corruption, not a torn write", () => {
  it("D-2 an acknowledged final entry with a corrupted hash and no trailing newline refuses recovery; the journal is unchanged", () => {
    const { prefix, last, entry } = acknowledged();
    const corrupted = last.replace(entry.hash as string, "0".repeat(64));
    expect(corrupted).not.toBe(last);
    refuses(prefix + corrupted, /line 4: entry hash mismatch/);
    // With its newline the same line was always refused; the newline must not decide the outcome.
    refuses(`${prefix}${corrupted}\n`, /line 4: entry hash mismatch/);
  });

  it.each([
    ["wrong prev hash", (e: Record<string, unknown>) => ({ ...e, prevHash: "f".repeat(64) }), /line 4: hash chain broken/],
    ["schema violation in the command", (e: Record<string, unknown>) => ({ ...e, command: { ...(e.command as object), type: "bogus" } }), /line 4: invalid command/],
    ["unexpected field", (e: Record<string, unknown>) => ({ ...e, extra: 1 }), /line 4: unexpected entry fields/],
    ["sequence number ahead (gap)", (e: Record<string, unknown>) => ({ ...e, seq: 5 }), /line 4: sequence gap: expected 4, found 5/],
    ["sequence number not an integer", (e: Record<string, unknown>) => ({ ...e, seq: "4" }), /line 4: sequence gap or reorder/],
    ["invalid timestamp", (e: Record<string, unknown>) => ({ ...e, ts: -1 }), /line 4: invalid timestamp/],
  ])("D-2 a complete final entry without a newline with %s is refused, not dropped", (_name, corrupt, pattern) => {
    const { prefix, entry } = acknowledged();
    refuses(prefix + JSON.stringify(corrupt(entry)), pattern);
  });

  it.each([
    ["null", /line 4: entry is not an object/],
    ["42", /line 4: entry is not an object/],
    ['"text"', /line 4: entry is not an object/],
    ["[]", /line 4: unexpected entry fields/],
  ])("D-2 a final line that parses as JSON but is not an entry (%s) is refused, not dropped", (line, pattern) => {
    const { prefix } = acknowledged();
    refuses(prefix + line, pattern);
  });

  it("D-2 a genuinely truncated final line (unparseable, no newline) is still dropped as an uncommitted torn write", () => {
    const { prefix, last, before } = acknowledged();
    // Every strict prefix of a journal line is unparseable: the line is one JSON object, closed by its last byte.
    for (const cut of [1, 17, Math.floor(last.length / 2), last.length - 1]) {
      const store = new MemoryJournalStore();
      store.append(prefix + last.slice(0, cut));
      // A hand-built journal has no commit anchor: this checks the reader under the Milestone 10 store contract.
      // With an anchor, a truncated *anchored* entry is refused instead (durability-anchor.test.ts, D-6).
      const { venue, report } = Venue.recover(options(store, { anchor: undefined, allowUnanchored: true }));
      expect(report).toMatchObject({ tornTail: true, replayed: 3 });
      expect(venue.engine.stateHash()).toBe(before);
      expect(store.read()).toBe(prefix); // repaired only after recovery succeeded
    }
  });

  it("D-2 malformed lines followed by a newline, or in the middle, are refused as before", () => {
    const { prefix, last, lines } = acknowledged();
    refuses(`${prefix}${last.slice(0, 20)}\n`, /line 4: unparseable entry/);
    refuses(`${[lines[0], lines[1]!.slice(0, 20), ...lines.slice(2)].join("\n")}\n`, /line 2: unparseable entry/);
  });
});

describe("VR-29 / A-2 event objects are isolated between consumers", () => {
  function trading(store = new MemoryJournalStore()) {
    const w = world(store);
    w.send("syn-b", order({ clientOrderId: "maker", side: "sell", quantity: "0.004" }));
    return w;
  }

  it("A-2 mutating the first private response changes neither the private feed, the replay, the ledger, the tape nor engine state", () => {
    const { venue, gateway, token, send } = trading();
    const first = send("syn-a", order()); // accepted + partial fill against the maker
    const firstCopy = json(first);
    expect(okEvents(first).map((e) => e.kind)).toEqual(["accepted", "fill"]);
    const feed = json(gateway.events(token("syn-a")));
    const makerFeed = json(gateway.events(token("syn-b")));
    const ledger = JSON.stringify(venue.acceptedOrder("syn-a", "k1"));
    const tape = json(venue.publicTape);
    const state = venue.engine.stateHash();

    for (const event of okEvents(first)) scribble(event);

    expect(gateway.events(token("syn-a"))).toEqual(feed);
    expect(venue.privateEvents("syn-a")).toEqual(feed);
    expect(gateway.events(token("syn-b"))).toEqual(makerFeed);
    expect(JSON.stringify(venue.acceptedOrder("syn-a", "k1"))).toBe(ledger);
    expect(send("syn-a", order())).toEqual({ ...firstCopy, replayed: true });
    expect(venue.publicTape).toEqual(tape);
    expect(venue.engine.stateHash()).toBe(state);
  });

  it("A-2 mutating events read from the private feed changes neither later reads, the first response nor engine state", () => {
    const { venue, gateway, token, send } = trading();
    const first = send("syn-a", order());
    const firstCopy = json(first);
    const feed = json(gateway.events(token("syn-a"))!);
    const state = venue.engine.stateHash();

    for (const event of gateway.events(token("syn-a"))!) scribble(event);
    for (const event of venue.privateEvents("syn-a")) scribble(event);

    expect(gateway.events(token("syn-a"))).toEqual(feed);
    expect(gateway.events(token("syn-a"), 1)).toEqual(feed.slice(1)); // per-account sequence filter still intact
    expect(first).toEqual(firstCopy);
    expect(venue.engine.stateHash()).toBe(state);
  });

  it("A-2 a response that echoes the request reference cannot alter the journaled command", () => {
    const { venue, send } = world();
    const r = send("syn-a", { op: "cancel", ref: { clientOrderId: "missing" } });
    expect(okEvents(r)[0]).toMatchObject({ kind: "request-rejected", ref: { clientOrderId: "missing" } });
    const journaled = json(venue.journal.entries.at(-1)!);
    for (const event of okEvents(r)) scribble(event);
    expect(venue.journal.entries.at(-1)).toEqual(journaled);
  });

  it("A-2 a public listener cannot change what later listeners receive, the stored tape or engine state", () => {
    const flow = (venue: Venue, send: (a: string, m: ClientMessage) => GatewayResponse) => {
      send("syn-b", order({ clientOrderId: "maker", side: "sell", quantity: "0.004" }));
      send("syn-a", order());
      send("syn-a", order({ clientOrderId: "k2", price: "1990.00" }));
      return venue;
    };
    const reference = world();
    const expected = json(flow(reference.venue, reference.send).publicTape);

    const live = world();
    const tapeAtStart = live.venue.publicTape.length;
    const before: PublicMessage[] = [];
    const after: PublicMessage[] = [];
    live.venue.onPublic((m) => before.push(json(m)));
    live.venue.onPublic((m) => scribble(m)); // a faulty or hostile consumer
    live.venue.onPublic((m) => after.push(json(m)));
    flow(live.venue, live.send);

    expect(live.venue.publicTape).toEqual(expected);
    expect(before).toEqual(expected.slice(tapeAtStart));
    expect(after).toEqual(expected.slice(tapeAtStart));
    expect(live.venue.engine.stateHash()).toBe(reference.venue.engine.stateHash());
    expect(live.venue.outputHead).toBe(reference.venue.outputHead);

    // Mutating a message read from the stored tape does not change the tape either.
    for (const m of live.venue.publicTape) scribble(m);
    expect(live.venue.publicTape).toEqual(expected);
  });
});

describe("A-4 terminal orders evicted from the ledger and restored from a snapshot", () => {
  const evictedAnswer = { ok: true, replayed: false, events: [{ kind: "rejected", clientOrderId: "e1", reason: "duplicate-client-order-id" }] };

  it.each(["filled", "cancelled"] as const)("A-4 a %s order evicted from the ledger cannot execute again after a snapshot restore or a full replay", (terminal) => {
    const store = new MemoryJournalStore();
    const live = world(store, { idempotencyCapacity: 2 });
    if (terminal === "filled") {
      live.send("syn-b", order({ clientOrderId: "m1", side: "sell" }));
      expect(okEvents(live.send("syn-a", order({ clientOrderId: "e1" }))).map((e) => e.kind)).toEqual(["accepted", "fill"]);
    } else {
      live.send("syn-a", order({ clientOrderId: "e1" }));
      expect(okEvents(live.send("syn-a", { op: "cancel", ref: { clientOrderId: "e1" } })).map((e) => e.kind)).toEqual(["cancelled"]);
    }
    // Resting liquidity a re-executed e1 would trade against.
    live.send("syn-b", order({ clientOrderId: "m2", side: "sell", quantity: "0.050" }));
    live.send("syn-a", order({ clientOrderId: "e2", price: "1990.00" }));
    live.send("syn-a", order({ clientOrderId: "e3", price: "1991.00" }));
    expect(live.venue.acceptedOrder("syn-a", "e1")).toBeUndefined();
    expect(live.gateway.order(live.token("syn-a"), { clientOrderId: "e1" })).toMatchObject({ status: terminal });
    const snapshot = json(live.venue.snapshot());

    for (const recovered of [Venue.recover(options(store, { idempotencyCapacity: 2 }), undefined, snapshot).venue, Venue.recover(options(store, { idempotencyCapacity: 2 })).venue]) {
      const { gateway, token, send } = gatewayFor(recovered);
      const executions = recovered.executions.length;
      const position = recovered.engine.positionFor("syn-a", ALPHA);
      const view = gateway.order(token("syn-a"), { clientOrderId: "e1" });
      expect(view).toMatchObject({ clientOrderId: "e1", status: terminal });

      for (const retry of [order({ clientOrderId: "e1" }), order({ clientOrderId: "e1", price: "1999.00", quantity: "0.020" })]) {
        const answer = send("syn-a", retry);
        expect(answer).toMatchObject(evictedAnswer);
        expect(okEvents(answer)).toHaveLength(1);
      }

      expect(recovered.executions).toHaveLength(executions);
      expect(recovered.engine.positionFor("syn-a", ALPHA)).toBe(position);
      expect(gateway.order(token("syn-a"), { clientOrderId: "e1" })).toEqual(view);
      expect(recovered.engine.openOrdersFor("syn-b").map((o) => o.clientOrderId)).toContain("m2");
    }
  });
});
