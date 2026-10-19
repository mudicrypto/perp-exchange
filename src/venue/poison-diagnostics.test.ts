import { afterEach, describe, expect, it } from "vitest";
import { BookSide } from "./book";
import { encodeCommitRecord, selectCommitRecord } from "./commit-record";
import { durableOptions, fingerprint, orderFlow } from "./durability-fixtures";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage";
import { VENUE_RULES_VERSION } from "./rules-version";
import type { EngineCommand } from "./types";
import { RecoveryRefusedError, ReplayFaultError, Venue, type VenueSnapshot } from "./venue";

/**
 * Milestone 11 (Venue) workstream C: poison-command diagnostics (rule D-3) and rules-version
 * compatibility (rule D-7). No command skipping and no journal rewriting exist.
 */

const SECRET_ID = "poison-secret-77";
const poison: EngineCommand = { type: "new-order", accountId: "syn-a", clientOrderId: SECRET_ID, instrumentId: "SYN-ALPHA", side: "buy", orderType: "limit", priceTicks: 3_911, qtyLots: 7, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" } as EngineCommand;
const original = BookSide.prototype.add;
/** A logic fault that hits the poison order on every replay; its message carries order data. */
function arm() {
  BookSide.prototype.add = function (this: BookSide, order: Parameters<BookSide["add"]>[0]) {
    if (order.clientOrderId === SECRET_ID) throw new Error(`secret detail 4242 for ${order.clientOrderId}`);
    return original.call(this, order);
  };
}
afterEach(() => {
  BookSide.prototype.add = original;
});

function journalWithPoison(o: { records?: boolean; final?: boolean; uncommitted?: boolean } = {}) {
  const store = new MemoryJournalStore();
  const records = o.records ? new MemoryCommitRecordStore() : undefined;
  const venue = new Venue(durableOptions({ store, records }));
  for (const c of orderFlow(4, 10)) venue.submit(c);
  if (o.uncommitted) records!.failNextWrite = "before-write";
  try {
    venue.submit(poison);
  } catch {
    // outcome unknown (uncommitted case)
  }
  if (!o.final && !o.uncommitted) venue.submit({ type: "publish" });
  return { store, records, seq: 15, hash: JSON.parse(store.read().trimEnd().split("\n")[14]!).hash as string };
}

function replayFault(store: MemoryJournalStore, records?: MemoryCommitRecordStore): ReplayFaultError {
  arm();
  const before = { journal: store.read(), slots: records ? [...records.readSlots()] : null };
  try {
    Venue.recover(durableOptions({ store, records }));
  } catch (error) {
    expect({ journal: store.read(), slots: records ? [...records.readSlots()] : null }).toEqual(before);
    return error as ReplayFaultError;
  } finally {
    BookSide.prototype.add = original;
  }
  throw new Error("recovery did not fail");
}

describe("D-3 replay-fault diagnostics", () => {
  it("D-3 a replay fault names seq, entry hash and command type, never the command payload or the raw engine message", () => {
    const j = journalWithPoison();
    const error = replayFault(j.store);
    expect(error).toBeInstanceOf(ReplayFaultError);
    expect(error).toBeInstanceOf(RecoveryRefusedError);
    expect(error).toMatchObject({ code: "F10-replay-fault", seq: j.seq, entryHash: j.hash, commandType: "new-order", isFinalEntry: false, commitState: "no-commit-record", codeRulesVersion: VENUE_RULES_VERSION, snapshotRulesVersion: null, writerRulesVersion: null });
    expect(error.message).toMatch(new RegExp(`^replay stopped at seq ${j.seq}`));
    for (const leak of [SECRET_ID, "4242", "secret detail", "3911"]) expect(error.message).not.toContain(leak);
    expect((error.cause as Error).message).toContain("secret detail 4242");
  });

  it("D-3 the diagnostic distinguishes a committed entry, a final entry and a journaled-but-uncommitted entry", () => {
    const committed = journalWithPoison({ records: true });
    expect(replayFault(committed.store, committed.records)).toMatchObject({ commitState: "committed", isFinalEntry: false, writerRulesVersion: VENUE_RULES_VERSION });
    const final = journalWithPoison({ records: true, final: true });
    expect(replayFault(final.store, final.records)).toMatchObject({ commitState: "committed", isFinalEntry: true });
    const uncommitted = journalWithPoison({ records: true, uncommitted: true });
    expect(replayFault(uncommitted.store, uncommitted.records)).toMatchObject({ commitState: "uncommitted", isFinalEntry: true, seq: uncommitted.seq });
  });

  it("D-3 no API skips, quarantines or rewrites journal entries", () => {
    const names = [...Object.getOwnPropertyNames(Venue), ...Object.getOwnPropertyNames(Venue.prototype)];
    expect(names.filter((n) => /skip|quarantine|rewrite/i.test(n))).toEqual([]);
    const j = journalWithPoison();
    arm();
    try {
      expect(() => Venue.recover({ ...durableOptions({ store: j.store }), skipSeq: j.seq } as never)).toThrow(ReplayFaultError);
    } finally {
      BookSide.prototype.add = original;
    }
  });
});

describe("D-7 rules-version compatibility", () => {
  function snapshotWorld() {
    const store = new MemoryJournalStore();
    const venue = new Venue(durableOptions({ store }));
    for (const c of orderFlow(4, 30)) venue.submit(c);
    return { store, venue, snapshot: JSON.parse(JSON.stringify(venue.snapshot())) as VenueSnapshot };
  }

  it("D-7 snapshots carry the rules version; an incompatible snapshot is refused, full replay still recovers", () => {
    const { store, venue, snapshot } = snapshotWorld();
    expect(snapshot.rulesVersion).toBe(VENUE_RULES_VERSION);
    const text = store.read();
    const other = { ...snapshot, rulesVersion: "nova-venue-rules/0" };
    expect(() => Venue.recover(durableOptions({ store }), undefined, other)).toThrow(RecoveryRefusedError);
    expect(() => Venue.recover(durableOptions({ store }), undefined, other)).toThrow(/rules version nova-venue-rules\/0 .*incompatible.*full replay/);
    expect(() => Venue.recover(durableOptions({ store }, { allowLegacySnapshot: true }), undefined, other)).toThrow(/incompatible/);
    expect(store.read()).toBe(text);
    expect(fingerprint(Venue.recover(durableOptions({ store })).venue)).toEqual(fingerprint(venue));
  });

  it("D-7 a legacy snapshot without a rules version is refused unless explicitly allowed, and the report says so", () => {
    const { store, venue, snapshot } = snapshotWorld();
    const legacy = { ...snapshot } as Partial<VenueSnapshot>;
    delete (legacy as { rulesVersion?: string }).rulesVersion;
    expect(() => Venue.recover(durableOptions({ store }), undefined, legacy as VenueSnapshot)).toThrow(/legacy snapshot without a rules version/);
    const { venue: restored, report } = Venue.recover(durableOptions({ store }, { allowLegacySnapshot: true }), undefined, legacy as VenueSnapshot);
    expect(report.legacySnapshot).toBe(true);
    expect(fingerprint(restored)).toEqual(fingerprint(venue));
    expect(Venue.recover(durableOptions({ store }), undefined, snapshot).report.legacySnapshot).toBe(false);
  });

  it("D-7 a commit record written under another rules version is reported, not refused", () => {
    const store = new MemoryJournalStore();
    const records = new MemoryCommitRecordStore();
    const venue = new Venue(durableOptions({ store, records }));
    for (const c of orderFlow(4, 5)) venue.submit(c);
    const current = selectCommitRecord(...records.readSlots());
    if (!current.ok || !current.record) throw new Error("no record");
    const slots = [...records.readSlots()] as [string | null, string | null];
    slots[current.record.seq % 2] = encodeCommitRecord({ ...current.record, writerRulesVersion: "nova-venue-rules/older" });
    records.replaceSlots(slots);
    const { report } = Venue.recover(durableOptions({ store, records }));
    expect(report.commitRecord).toMatchObject({ writerRulesVersion: "nova-venue-rules/older", writerRulesVersionMatches: false });
  });
});
