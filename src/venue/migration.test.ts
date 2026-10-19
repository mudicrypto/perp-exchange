import { describe, expect, it } from "vitest";
import { selectCommitRecord } from "./commit-record";
import { durableOptions, fingerprint, orderFlow, referenceVenue } from "./durability-fixtures";
import { sha256 } from "./journal";
import { migrateToCommitRecord, MigrationRefusedError, type MigrationInput } from "./migration";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage";
import type { EngineCommand } from "./types";
import { RecoveryRefusedError, Venue } from "./venue";

/**
 * Milestone 11 (Venue): offline migration of a Milestone 10 journal (no commit records) to a commit-record
 * lineage that starts at a nonzero base L, for odd and even L, followed by commands and crash/recovery
 * cycles (DURABILITY-PROTOCOL §4). Migration is not reachable from recovery.
 */

/** A Milestone 10-style journal: store-backed venue without commit records. setup (4) + n commands. */
function m10Journal(n: number) {
  const store = new MemoryJournalStore();
  const venue = new Venue(durableOptions({ store }));
  const commands = orderFlow(5, n);
  for (const c of commands) venue.submit(c);
  return { store, commands, L: commands.length };
}

function input(store: MemoryJournalStore, records: MemoryCommitRecordStore, commands: EngineCommand[], o: Partial<MigrationInput> = {}): MigrationInput {
  const text = store.read();
  const ref = referenceVenue(commands);
  return {
    options: durableOptions(),
    journalStore: store,
    recordStore: records,
    backup: { journalBytes: text, sha256: sha256(text) },
    approval: { operator: "ops-1", seq: commands.length, head: ref.journal.head, stateHash: ref.engine.stateHash(), approvedAt: "2026-10-18T00:00:00Z" },
    ...o,
  };
}

const bytes = (store: MemoryJournalStore, records: MemoryCommitRecordStore) => ({ journal: store.read(), slots: [...records.readSlots()] });

function refusesMigration(i: MigrationInput, pattern: RegExp) {
  const before = bytes(i.journalStore as MemoryJournalStore, i.recordStore as MemoryCommitRecordStore);
  expect(() => migrateToCommitRecord(i)).toThrow(MigrationRefusedError);
  expect(() => migrateToCommitRecord(i)).toThrow(pattern);
  expect(bytes(i.journalStore as MemoryJournalStore, i.recordStore as MemoryCommitRecordStore)).toEqual(before);
}

describe("D-6 offline migration to commit records", () => {
  it("D-6 normal recovery never adopts an unrecorded journal, whatever options are passed", () => {
    const { store } = m10Journal(4);
    const records = new MemoryCommitRecordStore();
    const options = { ...durableOptions({ store, records }), adoptUnrecordedJournal: true };
    expect(() => Venue.recover(options)).toThrow(RecoveryRefusedError);
    expect(() => Venue.recover(options)).toThrow(/offline migration.*migrateToCommitRecord/);
    expect(records.readSlots()).toEqual([null, null]);
  });

  it.each([
    ["odd", 11],
    ["even", 12],
  ])("D-6 an %s migration base: the first record is accepted under S5, later records keep parity and sequence through crash/recovery cycles", (_parity, n) => {
    const { store, commands, L } = m10Journal(n);
    expect(L % 2).toBe(n % 2 === 1 ? 1 : 0);
    const records = new MemoryCommitRecordStore();
    const report = migrateToCommitRecord(input(store, records, commands));
    expect(report).toMatchObject({ seq: L, base: L, slot: L % 2, alreadyMigrated: false });
    const slots = records.readSlots();
    expect(slots[(L + 1) % 2]).toBeNull();
    expect(selectCommitRecord(...slots)).toMatchObject({ ok: true, record: { seq: L, base: L }, tornSlot: false });

    const options = durableOptions({ store, records });
    let { venue, report: rec } = Venue.recover(options);
    expect(rec.commitRecord).toMatchObject({ seq: L, base: L });
    const all = [...commands];
    const extra = orderFlow(6, 12).slice(4);
    const submit = (c: EngineCommand) => {
      venue.submit(c);
      all.push(c);
      const seq = venue.journal.lastSeq;
      expect(selectCommitRecord(...records.readSlots()), `seq ${seq}`).toMatchObject({ ok: true, record: { seq, base: L } });
      expect(JSON.parse(records.readSlots()[seq % 2]!)).toMatchObject({ seq });
    };
    // Cycle 1: the first post-migration write (into the never-written slot) is torn.
    records.failNextWrite = "torn-write";
    expect(() => venue.submit(extra[0]!)).toThrow();
    all.push(extra[0]!);
    ({ venue, report: rec } = Venue.recover(options));
    expect(rec.repairs.map((s) => s.kind)).toEqual(["advance-commit-record"]);
    expect(rec.commitRecord).toMatchObject({ seq: L + 1, base: L });
    for (const c of extra.slice(1, 4)) submit(c);
    // Cycle 2: journal written, acknowledgement lost.
    store.failNextAppend = "after-write";
    expect(() => venue.submit(extra[4]!)).toThrow();
    all.push(extra[4]!);
    ({ venue } = Venue.recover(options));
    for (const c of extra.slice(5, 8)) submit(c);
    // Cycle 3: record write fails before persisting.
    records.failNextWrite = "before-write";
    expect(() => venue.submit(extra[8]!)).toThrow();
    all.push(extra[8]!);
    ({ venue } = Venue.recover(options));
    for (const c of extra.slice(9)) submit(c);

    const final = Venue.recover(options);
    expect(final.report.repairs).toEqual([]);
    expect(final.report.commitRecord).toMatchObject({ base: L, seq: all.length });
    expect(fingerprint(final.venue)).toEqual(fingerprint(referenceVenue(all)));
  });

  it("D-6 migration refuses without a matching backup, a clean journal, a bound approval and an empty record store; nothing changes", () => {
    const { store, commands } = m10Journal(6);
    const records = new MemoryCommitRecordStore();
    const ok = input(store, records, commands);
    refusesMigration({ ...ok, backup: { journalBytes: `${ok.backup.journalBytes}x`, sha256: ok.backup.sha256 } }, /backup/);
    refusesMigration({ ...ok, backup: { journalBytes: ok.backup.journalBytes, sha256: "0".repeat(64) } }, /backup/);
    refusesMigration({ ...ok, approval: { ...ok.approval, seq: ok.approval.seq - 1 } }, /approval/);
    refusesMigration({ ...ok, approval: { ...ok.approval, head: "0".repeat(64) } }, /approval/);
    refusesMigration({ ...ok, approval: { ...ok.approval, stateHash: "0".repeat(64) } }, /approval/);
    refusesMigration({ ...ok, approval: { ...ok.approval, operator: "" } }, /operator/);

    const foreign = new MemoryCommitRecordStore();
    foreign.replaceSlots(["anything", null]);
    refusesMigration({ ...ok, recordStore: foreign }, /record store is not empty/);

    const torn = new MemoryJournalStore();
    torn.append(`${store.read()}{"seq":`);
    refusesMigration(input(torn, new MemoryCommitRecordStore(), commands), /torn tail/);
    const noNewline = new MemoryJournalStore();
    noNewline.append(store.read().slice(0, -1));
    refusesMigration(input(noNewline, new MemoryCommitRecordStore(), commands), /newline/);
    const empty = new MemoryJournalStore();
    refusesMigration(input(empty, new MemoryCommitRecordStore(), []), /empty/);
    const corrupt = new MemoryJournalStore();
    corrupt.append(store.read().replace('"seq":3', '"seq":4'));
    refusesMigration(input(corrupt, new MemoryCommitRecordStore(), commands), /validation/);
  });

  it("D-6 migration is re-runnable after a torn record write, and idempotent once complete", () => {
    const { store, commands, L } = m10Journal(7);
    const records = new MemoryCommitRecordStore();
    records.failNextWrite = "torn-write";
    expect(() => migrateToCommitRecord(input(store, records, commands))).toThrow();
    expect(selectCommitRecord(...records.readSlots())).toMatchObject({ ok: false });
    expect(migrateToCommitRecord(input(store, records, commands))).toMatchObject({ seq: L, alreadyMigrated: false });
    const slots = [...records.readSlots()];
    expect(migrateToCommitRecord(input(store, records, commands))).toMatchObject({ seq: L, alreadyMigrated: true });
    expect(records.readSlots()).toEqual(slots);
  });
});

describe("D-6 migration identity (final correctness review)", () => {
  it("D-6 an approval is bound to the complete journal history: a fork with the same length cannot use it, nor vice versa", () => {
    const original = m10Journal(8);
    const forkStore = new MemoryJournalStore();
    const forkVenue = new Venue(durableOptions({ store: forkStore }));
    const forkCommands = orderFlow(6, 8); // same length, different history
    for (const c of forkCommands) forkVenue.submit(c);
    expect(forkCommands.length).toBe(original.L);
    const approvalForFork = input(forkStore, new MemoryCommitRecordStore(), forkCommands).approval;
    refusesMigration({ ...input(original.store, new MemoryCommitRecordStore(), original.commands), approval: approvalForFork }, /approval/);
    const approvalForOriginal = input(original.store, new MemoryCommitRecordStore(), original.commands).approval;
    refusesMigration({ ...input(forkStore, new MemoryCommitRecordStore(), forkCommands), approval: approvalForOriginal }, /approval/);
  });

  it("D-6 after a completed migration, a retry under a different approval is refused and changes nothing", () => {
    const { store, commands } = m10Journal(7);
    const records = new MemoryCommitRecordStore();
    const first = input(store, records, commands);
    migrateToCommitRecord(first);
    refusesMigration({ ...first, approval: { ...first.approval, operator: "ops-2" } }, /not this migration's/);
    refusesMigration({ ...first, approval: { ...first.approval, approvedAt: "2026-10-19T00:00:00Z" } }, /not this migration's/);
  });

  it("D-6 an interrupted write is resumed only by the same approval, and only when the residue identifies it", () => {
    const { store, commands, L } = m10Journal(7);
    // Residue of an interrupted migration under approval B cannot be taken over by approval A.
    const records = new MemoryCommitRecordStore();
    const a = input(store, records, commands);
    const b = { ...a, approval: { ...a.approval, operator: "ops-b" } };
    records.failNextWrite = "torn-write";
    expect(() => migrateToCommitRecord(b)).toThrow();
    refusesMigration(a, /not this migration's/);
    expect(migrateToCommitRecord(b)).toMatchObject({ alreadyMigrated: false, operator: "ops-b" });

    // A residue too short to contain the record's checksum identifies no approval: refused even for a matching prefix.
    const short = new MemoryCommitRecordStore();
    const slots: [string | null, string | null] = [null, null];
    slots[L % 2] = `{"base":${L},"checksum":"`;
    short.replaceSlots(slots);
    refusesMigration(input(store, short, commands), /not this migration's/);
  });

  it("D-6 a migrated store cannot be migrated again after the venue has run", () => {
    const { store, commands } = m10Journal(7);
    const records = new MemoryCommitRecordStore();
    const first = input(store, records, commands);
    migrateToCommitRecord(first);
    const { venue } = Venue.recover(durableOptions({ store, records }));
    venue.submit(orderFlow(8, 1).at(-1)!);
    const again = input(store, records, [...commands, orderFlow(8, 1).at(-1)!]);
    refusesMigration(again, /not empty/);
  });
});
