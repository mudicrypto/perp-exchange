import { describe, expect, it, vi } from "vitest";
import { BookSide } from "./book";
import { EngineIntegrityError, MatchingEngine } from "./engine";
import { entryHash, GENESIS_HASH, readJournal, type JournalEntry } from "./journal";
import { PublicBookMirror } from "./public-feed";
import { reconcile } from "./reconcile";
import { createLocalVenue, syntheticFlow } from "./synthetic";
import { ALPHA } from "./test-helpers";
import { Venue } from "./venue";

/** Durable processing: journal integrity, crash recovery, fail-stop, consumer de-duplication. */

const ACCOUNTS = ["syn-p1", "syn-p2", "syn-p3", "syn-p4"];
const OPTIONS = (clock: () => number, publication: "immediate" | "batched" = "immediate") => ({ engine: { idKey: "local-prototype-key", publication }, clock });

function populated(messages = 400) {
  const lv = createLocalVenue({ accounts: ACCOUNTS });
  for (const { accountId, message } of syntheticFlow(3, messages, ACCOUNTS)) {
    lv.clock.advance(5);
    lv.gateway.handle(lv.tokens.get(accountId)!, message);
  }
  return lv;
}

describe("journal integrity", () => {
  it("D-2 detects an edited entry, a reordering and an injected command", () => {
    const { venue } = populated();
    const lines = venue.journal.toJsonl().trimEnd().split("\n");
    const edited = [...lines];
    const target = edited.findIndex((l, i) => i >= 40 && l.includes('"qtyLots"'));
    edited[target] = edited[target]!.replace(/"qtyLots":(\d+)/, (_m, n: string) => `"qtyLots":${Number(n) + 1}`);
    expect(readJournal(edited.join("\n") + "\n")).toMatchObject({ ok: false, failedAtLine: target + 1, reason: "entry hash mismatch" });

    const swapped = [...lines];
    [swapped[50], swapped[51]] = [swapped[51]!, swapped[50]!];
    expect(readJournal(swapped.join("\n") + "\n")).toMatchObject({ ok: false, failedAtLine: 51, reason: expect.stringMatching(/sequence/) });

    // Even with a correctly recomputed hash, a command outside the schema is refused.
    const prev = JSON.parse(lines[59]!) as JournalEntry;
    const bad = { seq: 61, ts: prev.ts, command: { type: "admin.add-account", accountId: "real-account", limits: { maxOpenOrders: 1, maxOrderNotional: 1, maxPositionLots: 1 } } };
    const forged = { ...bad, prevHash: JSON.parse(lines[59]!).hash, hash: entryHash(JSON.parse(lines[59]!).hash, 61, prev.ts, bad.command as never) };
    expect(readJournal([...lines.slice(0, 60), JSON.stringify(forged)].join("\n") + "\n")).toMatchObject({ ok: false, failedAtLine: 61, reason: "invalid command" });
  });

  it("D-2 a full rewrite of the chain verifies internally; only an externally anchored head exposes it", () => {
    const { venue } = populated(50);
    const anchoredHead = venue.journal.head;
    const entries = readJournal(venue.journal.toJsonl());
    if (!entries.ok) throw new Error("journal unreadable");
    let prev = GENESIS_HASH;
    const rewritten = entries.entries.map((e) => {
      const command = e.command.type === "new-order" ? { ...e.command, qtyLots: e.command.qtyLots + 1 } : e.command;
      const hash = entryHash(prev, e.seq, e.ts, command);
      const out = { seq: e.seq, ts: e.ts, command, prevHash: prev, hash };
      prev = hash;
      return out;
    });
    const read = readJournal(rewritten.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(read.ok).toBe(true);
    expect(read.ok && read.head).not.toBe(anchoredHead);
  });

  it("D-2 a torn final write is dropped and recovery resumes from the last complete entry", () => {
    const { venue, clock } = populated(200);
    const jsonl = venue.journal.toJsonl();
    const lastLine = jsonl.trimEnd().split("\n").at(-1)!;
    const torn = jsonl.slice(0, jsonl.length - 1 - Math.floor(lastLine.length / 2));
    const { venue: recovered, report } = Venue.recover(OPTIONS(clock.read), torn);
    expect(report).toMatchObject({ tornTail: true, replayed: venue.journal.lastSeq - 1 });
    const reference = Venue.recover(OPTIONS(clock.read), venue.journal.entries.slice(0, -1).map((e) => JSON.stringify(e)).join("\n") + "\n").venue;
    expect(recovered.engine.stateHash()).toBe(reference.engine.stateHash());
  });

  it("D-2 refuses a snapshot that belongs to a different journal", () => {
    const a = populated(100);
    const b = createLocalVenue({ accounts: ACCOUNTS });
    b.venue.submit({ type: "publish" });
    expect(() => Venue.recover(OPTIONS(a.clock.read), a.venue.journal.toJsonl(), { ...b.venue.snapshot(), engine: { ...b.venue.snapshot().engine, lastSeq: 3 } })).toThrow(/does not belong/);
  });
});

describe("recovery and determinism", () => {
  it("D-1 recovery from a snapshot plus the journal suffix reproduces state, outputs and reconciliation", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS, publication: "batched" });
    let snapshot: ReturnType<Venue["snapshot"]> | undefined;
    syntheticFlow(9, 1_500, ACCOUNTS).forEach(({ accountId, message }, i) => {
      lv.clock.advance(5);
      lv.gateway.handle(lv.tokens.get(accountId)!, message);
      if (i % 20 === 0) lv.venue.submit({ type: "publish" });
      if (i === 700) snapshot = lv.venue.snapshot();
    });
    const { venue: recovered } = Venue.recover(OPTIONS(lv.clock.read, "batched"), lv.venue.journal.toJsonl(), JSON.parse(JSON.stringify(snapshot)));
    expect(recovered.engine.stateHash()).toBe(lv.venue.engine.stateHash());
    expect(recovered.outputHead).toBe(lv.venue.outputHead);
    expect(reconcile(lv.venue).ok).toBe(true);
    expect(reconcile(recovered)).toMatchObject({ ok: true });
  });

  it("D-1 the engine refuses sequence gaps, duplicates and timestamps that go backwards", () => {
    const engine = new MatchingEngine({ idKey: "k", publication: "immediate" });
    engine.process({ seq: 1, ts: 10, command: { type: "publish" } });
    expect(() => engine.process({ seq: 1, ts: 10, command: { type: "publish" } })).toThrow(EngineIntegrityError);
    expect(() => engine.process({ seq: 3, ts: 10, command: { type: "publish" } })).toThrow(EngineIntegrityError);
    expect(() => engine.process({ seq: 2, ts: 9, command: { type: "publish" } })).toThrow(/backwards/);
    expect(engine.process({ seq: 2, ts: 10, command: { type: "publish" } }).seq).toBe(2);
  });

  it("D-3 fail-stop: an internal fault stops the engine; the gateway then refuses all commands", () => {
    const lv = populated(100);
    vi.spyOn(BookSide.prototype, "add").mockImplementationOnce(() => {
      throw new Error("simulated fault");
    });
    const r = lv.gateway.handle(lv.tokens.get("syn-p1")!, { op: "new", clientOrderId: "boom", instrumentId: ALPHA, side: "buy", type: "limit", price: "1900.00", quantity: "0.010" });
    expect(r).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(lv.venue.engine.stoppedReason).toBe("simulated fault");
    expect(lv.gateway.handle(lv.tokens.get("syn-p2")!, { op: "mass-cancel" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(() => lv.venue.engine.snapshot()).toThrow(/stopped/);
  });

  it("D-3 a snapshot whose holdings disagree with its orders is refused on restore", () => {
    const lv = populated(300);
    const snap = lv.venue.snapshot().engine;
    const tampered = { ...snap, accounts: snap.accounts.map((a, i) => (i === 0 ? { ...a, holdings: a.holdings.map(([k, h]) => [k, { ...h, openBuyLots: h.openBuyLots + 1 }] as typeof a.holdings[number]) } : a)) };
    expect(() => MatchingEngine.restore({ idKey: "local-prototype-key", publication: "immediate" }, tampered)).toThrow(EngineIntegrityError);
  });

  it("D-4 consumers de-duplicate outputs regenerated after a crash by sequence number", () => {
    const lv = createLocalVenue({ accounts: ACCOUNTS });
    const mirror = new PublicBookMirror();
    for (const m of lv.venue.publicTape) mirror.apply(m);
    lv.venue.onPublic((m) => mirror.apply(m));
    let snapshot: ReturnType<Venue["snapshot"]> | undefined;
    syntheticFlow(5, 600, ACCOUNTS).forEach(({ accountId, message }, i) => {
      lv.clock.advance(5);
      lv.gateway.handle(lv.tokens.get(accountId)!, message);
      if (i === 300) snapshot = lv.venue.snapshot();
    });
    const seqBefore = mirror.sequence;
    // The process "crashes" and restarts from the mid-run snapshot: every later output is emitted again.
    const { venue: recovered } = Venue.recover(OPTIONS(lv.clock.read), lv.venue.journal.toJsonl(), snapshot);
    for (const m of recovered.publicTape) mirror.apply(m);
    expect(recovered.publicTape.length).toBeGreaterThan(0);
    expect(mirror.sequence).toBe(seqBefore);
    expect(mirror.stale).toBe(false);
    expect(mirror.levels(ALPHA)).toEqual(lv.venue.engine.publishedLevels(ALPHA));
    // Private events carry per-account sequences for the same purpose.
    const original = lv.venue.privateEvents("syn-p1");
    const replayed = recovered.privateEvents("syn-p1");
    const first = replayed[0]!.accountSeq;
    expect(first).toBeGreaterThan(1);
    expect(replayed).toEqual(original.filter((e) => e.accountSeq >= first));
  });

  it("D-4 a gap in the public feed marks the mirror stale", () => {
    const mirror = new PublicBookMirror();
    mirror.apply({ kind: "status", publicSeq: 1, ts: 0, instrumentId: ALPHA, status: "continuous" });
    mirror.apply({ kind: "level", publicSeq: 3, ts: 0, instrumentId: ALPHA, side: "buy", priceTicks: 4_000, displayedLots: 5 });
    expect(mirror.stale).toBe(true);
    expect(() => mirror.apply({ kind: "trade", publicSeq: 4, ts: 0, instrumentId: ALPHA, tradeId: "T1", priceTicks: 1, qtyLots: 1, aggressor: "buy", accountId: "syn-x" })).toThrow();
  });
});
