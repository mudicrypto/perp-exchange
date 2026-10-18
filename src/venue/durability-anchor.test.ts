import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SYNTHETIC_INSTRUMENTS } from "./instrument";
import { canonicalJson, readJournal } from "./journal";
import { MemoryAnchorStore, MemoryJournalStore, type AnchorFault, type AppendFault, type CommitAnchorStore } from "./storage";
import { seededRandom, SYNTHETIC_LIMITS } from "./synthetic";
import { ALPHA } from "./test-helpers";
import type { EngineCommand } from "./types";
import { OutcomeUnknownError, Venue, type PersistenceBoundary, type VenueOptions } from "./venue";

/**
 * Milestone 11, WP1: the commit anchor (MATCHING-RULES D-6).
 *
 * A separately written record of the last committed journal entry, so recovery can detect an
 * acknowledged entry that a non-conforming store later truncated or lost — cases the journal
 * alone cannot see (VERIFICATION-REPORT §5, RECOVERY-INTEGRITY §2). In-memory anchors detect
 * integrity faults in the prototype; they prove nothing about physical durability.
 *
 * Written before the implementation and run first against the Milestone 10 commit 9812049
 * (docs/venue/verification/m11-tests-against-9812049.log).
 */

const ACCOUNTS = ["syn-a", "syn-b", "syn-c"];
const ENGINE = { idKey: "local-prototype-key", publication: "immediate" as const };

const opts = (store?: MemoryJournalStore, anchor?: CommitAnchorStore, extra: Partial<VenueOptions> = {}): VenueOptions => ({
  engine: ENGINE,
  allowTestFixtureIdKey: true,
  clock: () => 1_700_000_000_000,
  ...(store ? { store } : {}),
  ...(anchor ? { anchor } : {}),
  ...extra,
});

const setup: EngineCommand[] = [
  { type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! },
  ...ACCOUNTS.map((accountId): EngineCommand => ({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS })),
];
const order = (i: number, o: Partial<Extract<EngineCommand, { type: "new-order" }>> = {}): EngineCommand => ({
  type: "new-order",
  accountId: ACCOUNTS[i % 3]!,
  clientOrderId: `a${i}`,
  instrumentId: ALPHA,
  side: i % 2 ? "sell" : "buy",
  orderType: "limit",
  priceTicks: 3_996 + (i % 9),
  qtyLots: 1 + (i % 40),
  tif: "gtc",
  visibility: "displayed",
  postOnly: false,
  stp: "cancel-taker",
  ...o,
});

/** An anchored, store-backed venue with `n` orders after setup. */
function anchored(n = 8) {
  const store = new MemoryJournalStore();
  const anchor = new MemoryAnchorStore();
  const venue = new Venue(opts(store, anchor));
  for (const c of setup) venue.submit(c);
  for (let i = 0; i < n; i++) venue.submit(order(i));
  return { store, anchor, venue, lines: store.read().trimEnd().split("\n") };
}

/** Recovery must refuse with `pattern` and leave both stores byte-identical. */
function refuses(store: MemoryJournalStore, anchor: CommitAnchorStore, pattern: RegExp) {
  const text = store.read();
  const record = anchor.read();
  expect(() => Venue.recover(opts(store, anchor))).toThrow(pattern);
  expect(store.read()).toBe(text);
  expect(anchor.read()).toBe(record);
}

const anchorRecord = (seq: number, hash: string) => canonicalJson({ seq, hash });

describe("D-6 commit anchor: ordering and fail-stop", () => {
  it("D-6 the anchor is written after the journal append and before the engine processes the command", () => {
    const store = new MemoryJournalStore();
    const seen: { journalLines: number; engineSeq: number; record: string }[] = [];
    let venue: Venue | null = null;
    const spy: CommitAnchorStore = {
      write(record: string) {
        seen.push({ journalLines: store.read().split("\n").length - 1, engineSeq: venue!.engine.sequence, record });
      },
      read: () => seen.at(-1)?.record ?? null,
    };
    venue = new Venue(opts(store, spy));
    for (const c of setup) venue.submit(c);
    venue.submit(order(0));
    const entries = readJournal(store.read());
    expect(entries.ok).toBe(true);
    const all = entries.ok ? entries.entries : [];
    expect(seen).toHaveLength(all.length);
    for (const [i, s] of seen.entries()) {
      expect(s.journalLines).toBe(i + 1); // the entry is already in the journal store
      expect(s.engineSeq).toBe(i); // the engine has not processed it yet
      expect(JSON.parse(s.record)).toEqual({ seq: i + 1, hash: all[i]!.hash });
    }
  });

  it.each(["before-write", "torn-write", "after-write"] as const)("D-6 an anchor write that fails (%s) stops the venue with outcome-unknown, before processing", (fault: AnchorFault) => {
    const { anchor, venue } = anchored(3);
    const before = venue.engine.stateHash();
    anchor.failNextWrite = fault;
    expect(() => venue.submit(order(50))).toThrow(OutcomeUnknownError);
    // Not processed: the engine state is unchanged, and the venue refuses everything after.
    expect(venue.engine.sequence).toBe(setup.length + 3);
    expect(() => venue.submit(order(51))).toThrow(/venue stopped/);
    expect(before).toBeTruthy();
  });

  it.each(["before-write", "after-write"] as const)("D-6 after a failed anchor write (%s) the complete journal entry is recovered (outcome-unknown contract)", (fault: AnchorFault) => {
    const { store, anchor, venue } = anchored(3);
    anchor.failNextWrite = fault;
    expect(() => venue.submit(order(60))).toThrow(OutcomeUnknownError);
    const { venue: recovered, report } = Venue.recover(opts(store, anchor));
    expect(recovered.journal.lastSeq).toBe(setup.length + 4);
    expect(recovered.engine.orderFor("syn-a", { clientOrderId: "a60" })).not.toBeNull();
    expect(report.anchoredSeq).toBe(fault === "after-write" ? setup.length + 4 : setup.length + 3);
    // The recovered venue re-anchors on its next commit.
    recovered.submit(order(61));
    expect(JSON.parse(anchor.read()!).seq).toBe(setup.length + 5);
  });

  it("D-6 a store-backed venue without an anchor store is refused unless explicitly unanchored (Milestone 10 mode)", () => {
    const store = new MemoryJournalStore();
    expect(() => new Venue(opts(store))).toThrow(/anchor/);
    expect(() => Venue.recover(opts(store))).toThrow(/anchor/);
    expect(() => new Venue(opts(store, undefined, { allowUnanchored: true }))).not.toThrow();
    expect(() => Venue.recover(opts(store, undefined, { allowUnanchored: true }))).not.toThrow();
    // An anchor needs a journal store to anchor.
    expect(() => new Venue(opts(undefined, new MemoryAnchorStore()))).toThrow(/anchor/);
  });

  it("D-6 a fresh anchored venue refuses a store or anchor that already holds data (use Venue.recover)", () => {
    const { store, anchor } = anchored(1);
    expect(() => new Venue(opts(store, anchor))).toThrow(/recover/);
    expect(() => new Venue(opts(new MemoryJournalStore(), anchor))).toThrow(/recover/);
  });
});

describe("D-6 recovery detects missing or truncated anchored entries", () => {
  it("D-6 the whole final acknowledged entry is missing: refused, nothing changed", () => {
    const { store, anchor, lines } = anchored();
    store.truncate(store.read().length - lines.at(-1)!.length - 1);
    expect(readJournal(store.read())).toMatchObject({ ok: true, tornTail: false }); // the journal alone cannot see it
    refuses(store, anchor, /anchor.*seq 12.*journal ends at seq 11/);
  });

  it("D-6 several acknowledged entries lost from the end: refused", () => {
    const { store, anchor, lines } = anchored();
    const keep = lines.slice(0, 6).join("\n") + "\n";
    store.truncate(keep.length);
    refuses(store, anchor, /journal ends at seq 6/);
  });

  it.each([1, 10, 40, 0.5])("D-6 an acknowledged entry truncated mid-line (cut %s) is not dropped as a torn write", (cut: number) => {
    const { store, anchor, lines } = anchored();
    const last = lines.at(-1)!;
    const keep = cut < 1 ? Math.floor(last.length * cut) : cut;
    store.truncate(store.read().length - 1 - last.length + keep);
    expect(readJournal(store.read())).toMatchObject({ ok: true, tornTail: true }); // what Milestone 10 would drop
    refuses(store, anchor, /anchored entry seq 12 is truncated/);
  });

  it("D-6 the anchor's hash does not match the entry at its sequence: refused", () => {
    const { store, anchor } = anchored();
    const record = JSON.parse(anchor.read()!) as { seq: number; hash: string };
    anchor.write(anchorRecord(record.seq, "f".repeat(64)));
    refuses(store, anchor, /anchor hash does not match entry seq 12/);
  });

  it("D-6 an anchor ahead of an empty or lost journal: refused", () => {
    const { anchor } = anchored();
    refuses(new MemoryJournalStore(), anchor, /journal ends at seq 0/);
  });

  it("D-6 a missing anchor with a non-empty journal is refused by default; an empty journal starts fresh", () => {
    const { store } = anchored();
    refuses(store, new MemoryAnchorStore(), /no commit anchor.*bootstrap/);
    const fresh = Venue.recover(opts(new MemoryJournalStore(), new MemoryAnchorStore()));
    expect(fresh.report).toMatchObject({ replayed: 0, anchoredSeq: null });
  });

  it.each(["", "{", "not json", '{"seq":3}', '{"seq":-1,"hash":"' + "0".repeat(64) + '"}', '{"seq":1,"hash":"xyz"}', '{"extra":1,"hash":"' + "0".repeat(64) + '","seq":1}'])(
    "D-6 an unreadable or invalid anchor record (%j) is refused",
    (record: string) => {
      const { store } = anchored();
      const anchor = new MemoryAnchorStore();
      anchor.write(record);
      refuses(store, anchor, /commit anchor (is unreadable|record is invalid)/);
    },
  );

  it("D-6 a torn anchor write leaves an unreadable anchor: recovery refuses until an operator bootstraps", () => {
    const { store, anchor, venue } = anchored(3);
    anchor.failNextWrite = "torn-write";
    expect(() => venue.submit(order(70))).toThrow(OutcomeUnknownError);
    refuses(store, anchor, /commit anchor is unreadable/);
  });

  it("D-6 VR-24 store fault (acknowledged k+1 persisted as a copy of k) and a silently lost append are both refused", () => {
    const copy = anchored(4);
    const realAppend = copy.store.append.bind(copy.store);
    copy.store.append = () => realAppend(`${copy.lines.at(-1)}\n`); // writes the previous bytes, returns success
    copy.venue.submit(order(80));
    refuses(copy.store, copy.anchor, /duplicate of the last entry|anchor/);

    const lost = anchored(4);
    lost.store.append = () => {}; // acknowledges, stores nothing
    lost.venue.submit(order(81));
    refuses(lost.store, lost.anchor, /anchor at seq 9.*journal ends at seq 8/);
  });

  it("D-6 a torn final line beyond the anchor is still dropped as uncommitted, and the store repaired", () => {
    const { store, anchor, venue } = anchored(3);
    store.failNextAppend = "torn-write";
    expect(() => venue.submit(order(90))).toThrow(OutcomeUnknownError);
    const { venue: recovered, report } = Venue.recover(opts(store, anchor));
    expect(report).toMatchObject({ tornTail: true, anchoredSeq: setup.length + 3 });
    expect(recovered.journal.lastSeq).toBe(setup.length + 3);
    recovered.submit(order(91));
    expect(readJournal(store.read())).toMatchObject({ ok: true, tornTail: false });
    expect(Venue.recover(opts(store, anchor)).venue.engine.stateHash()).toBe(recovered.engine.stateHash());
  });

  it("D-6 snapshot plus suffix recovery checks the anchor too", () => {
    const { store, anchor, venue } = anchored(6);
    const snap = venue.snapshot();
    venue.submit(order(100));
    const ok = Venue.recover(opts(store, anchor), undefined, snap);
    expect(ok.venue.engine.stateHash()).toBe(venue.engine.stateHash());
    const lastLine = store.read().trimEnd().split("\n").at(-1)!;
    store.truncate(store.read().length - lastLine.length - 1); // lose the acknowledged order(100)
    expect(() => Venue.recover(opts(store, anchor), undefined, snap)).toThrow(/journal ends at seq/);
  });
});

describe("D-6 operator bootstrap of an existing (unanchored) journal", () => {
  function unanchored(n = 5) {
    const store = new MemoryJournalStore();
    const venue = new Venue(opts(store, undefined, { allowUnanchored: true }));
    for (const c of setup) venue.submit(c);
    for (let i = 0; i < n; i++) venue.submit(order(i));
    return { store, venue };
  }
  const BOOT = { bootstrapAnchor: { reason: "Milestone 11 migration of a Milestone 10 journal", approvedBy: "operator-1 (prototype, unauthenticated)" } };

  it("D-6 bootstrap verifies and replays the journal, writes the anchor and journals an audit record", () => {
    const { store, venue } = unanchored();
    const anchor = new MemoryAnchorStore();
    const { venue: recovered, report } = Venue.recover(opts(store, anchor), undefined, undefined, BOOT);
    expect(report.bootstrapped).toBe(true);
    expect(recovered.journal.lastSeq).toBe(venue.journal.lastSeq + 1);
    const last = recovered.journal.entries.at(-1)!;
    expect(last.command).toEqual({
      type: "admin.anchor-bootstrap",
      seq: venue.journal.lastSeq,
      hash: venue.journal.head,
      prior: "missing",
      reason: BOOT.bootstrapAnchor.reason,
      approvedBy: BOOT.bootstrapAnchor.approvedBy,
    });
    expect(JSON.parse(anchor.read()!)).toEqual({ seq: last.seq, hash: last.hash });
    // The audit record changes no trading state.
    expect(recovered.engine.snapshot().orders).toEqual(venue.engine.snapshot().orders);
    // From now on, plain recovery is anchored and succeeds.
    expect(Venue.recover(opts(store, anchor)).venue.engine.stateHash()).toBe(recovered.engine.stateHash());
  });

  it("D-6 bootstrap is refused when a readable anchor exists, the journal is corrupt, or the request is incomplete", () => {
    const { store } = unanchored();
    const consistent = new MemoryAnchorStore();
    Venue.recover(opts(store, consistent), undefined, undefined, BOOT); // bootstrapped once
    const text = store.read();
    expect(() => Venue.recover(opts(store, consistent), undefined, undefined, BOOT)).toThrow(/bootstrap.*readable anchor/);
    expect(store.read()).toBe(text);

    const corrupt = unanchored();
    const lines = corrupt.store.read().trimEnd().split("\n");
    const bad = new MemoryJournalStore();
    bad.append(`${[...lines.slice(0, 3), lines[4]!, lines[3]!, ...lines.slice(5)].join("\n")}\n`);
    expect(() => Venue.recover(opts(bad, new MemoryAnchorStore()), undefined, undefined, BOOT)).toThrow(/journal corrupt/);

    const fresh = unanchored();
    for (const req of [{ reason: "", approvedBy: "x" }, { reason: "valid reason", approvedBy: "" }]) {
      expect(() => Venue.recover(opts(fresh.store, new MemoryAnchorStore()), undefined, undefined, { bootstrapAnchor: req })).toThrow(/bootstrap/);
    }
  });

  it("D-6 bootstrap after a torn anchor write records the unreadable prior anchor", () => {
    const store = new MemoryJournalStore();
    const anchor = new MemoryAnchorStore();
    const venue = new Venue(opts(store, anchor));
    for (const c of setup) venue.submit(c);
    anchor.failNextWrite = "torn-write";
    expect(() => venue.submit(order(1))).toThrow(OutcomeUnknownError);
    const { venue: recovered } = Venue.recover(opts(store, anchor), undefined, undefined, BOOT);
    const last = recovered.journal.entries.at(-1)!.command;
    expect(last).toMatchObject({ type: "admin.anchor-bootstrap", prior: "unreadable", seq: setup.length + 1 });
    expect(recovered.engine.orderFor("syn-b", { clientOrderId: "a1" })).not.toBeNull();
  });
});

// ── crash-boundary property with anchoring ────────────────────────────────────

type Boundary = `journal-${AppendFault}` | `anchor-${AnchorFault}` | PersistenceBoundary;
const BOUNDARIES: Boundary[] = [
  "journal-before-write",
  "journal-torn-write",
  "journal-after-write",
  "anchor-before-write",
  "anchor-torn-write",
  "anchor-after-write",
  "after-journal",
  "after-process",
];
/** Whether the interrupted command is in the committed journal. */
const COMMITTED = (b: Boundary) => b !== "journal-before-write" && b !== "journal-torn-write";

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

function flow(seed: number, n: number): EngineCommand[] {
  const rnd = seededRandom(seed);
  const pick = (k: number) => Math.floor(rnd() * k);
  const out: EngineCommand[] = [...setup];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.65) out.push(order(i, { side: pick(2) ? "buy" : "sell", priceTicks: 3_995 + pick(11), tif: (["gtc", "gtc", "ioc", "fok"] as const)[pick(4)]!, accountId: ACCOUNTS[pick(3)]! }));
    else if (r < 0.85) out.push({ type: "cancel", accountId: ACCOUNTS[pick(3)]!, ref: { clientOrderId: `a${pick(i + 1)}` } });
    else out.push({ type: "replace", accountId: ACCOUNTS[pick(3)]!, ref: { clientOrderId: `a${pick(i + 1)}` }, priceTicks: 3_995 + pick(11), qtyLots: 1 + pick(60) });
  }
  return out;
}

const reference = (commands: EngineCommand[]) => {
  const v = new Venue(opts());
  for (const c of commands) v.submit(c);
  return v;
};

describe("D-6 crash at every persistence boundary, anchored", () => {
  it("D-6 / D-1 / D-2 recovery equals the last committed state at every boundary (torn anchors require a bootstrap)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.nat(), fc.constantFrom(...BOUNDARIES), (seed, at, boundary) => {
        const commands = flow(seed, 60);
        const k = setup.length + (at % (commands.length - setup.length));
        const store = new MemoryJournalStore();
        const anchor = new MemoryAnchorStore();
        const live = new CrashingVenue(opts(store, anchor), boundary, k + 1);
        let interrupted = false;
        for (const [i, c] of commands.entries()) {
          if (i === k && boundary.startsWith("journal-")) store.failNextAppend = boundary.slice("journal-".length) as AppendFault;
          if (i === k && boundary.startsWith("anchor-")) anchor.failNextWrite = boundary.slice("anchor-".length) as AnchorFault;
          try {
            live.submit(c);
          } catch (error) {
            expect(error).toBeInstanceOf(OutcomeUnknownError);
            interrupted = true;
            break;
          }
        }
        expect(interrupted).toBe(true);
        let recovered: Venue;
        if (boundary === "anchor-torn-write") {
          expect(() => Venue.recover(opts(store, anchor))).toThrow(/commit anchor is unreadable/);
          recovered = Venue.recover(opts(store, anchor), undefined, undefined, { bootstrapAnchor: { reason: "torn anchor after crash", approvedBy: "test" } }).venue;
        } else {
          recovered = Venue.recover(opts(store, anchor)).venue;
        }
        const committed = commands.slice(0, COMMITTED(boundary) ? k + 1 : k);
        const ref = reference(committed);
        if (boundary === "anchor-torn-write") {
          // The bootstrap journals one audit entry (no engine effect), so only the sequence counters differ.
          const trading = (v: Venue) => ({ ...v.engine.snapshot(), lastSeq: 0, lastTs: 0 });
          expect(trading(recovered)).toEqual(trading(ref));
          expect(recovered.journal.entries.at(-1)!.command.type).toBe("admin.anchor-bootstrap");
        } else {
          expect(recovered.engine.stateHash()).toBe(ref.engine.stateHash());
          expect(recovered.outputHead).toBe(ref.outputHead);
        }
        // Keeps appending; a second plain recovery is anchored and identical.
        for (const c of commands.slice(committed.length)) recovered.submit(c);
        recovered.submit({ type: "publish" }); // at least one commit after recovery, so the anchor is current
        const again = Venue.recover(opts(store, anchor));
        expect(again.venue.engine.stateHash()).toBe(recovered.engine.stateHash());
        expect(again.report.anchoredSeq).toBe(recovered.journal.lastSeq);
      }),
      { numRuns: 150 },
    );
  });
});
