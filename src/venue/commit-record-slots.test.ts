import { describe, expect, it } from "vitest";
import { classifySlot, COMMIT_RECORD_FORMAT, commitRecordChecksum, encodeCommitRecord, newLineage, selectCommitRecord, type CommitRecordFields } from "./commit-record";
import { canonicalJson, GENESIS_HASH, sha256 } from "./journal";

/**
 * Milestone 11 (Venue) workstream A: validation of each commit-record slot and selection of the
 * latest record (docs/venue/DURABILITY-PROTOCOL.md §3, rules S1–S6). Pure functions; no store involved.
 */

const LINEAGE = "0123456789abcdef0123456789abcdef";
const h = (n: number) => sha256(`entry-${n}`);
const fields = (seq: number, o: Partial<CommitRecordFields> = {}): CommitRecordFields => ({ lineage: LINEAGE, base: 0, seq, head: seq === 0 ? GENESIS_HASH : h(seq), writerRulesVersion: "test-rules", ...o });
const rec = (seq: number, o: Partial<CommitRecordFields> = {}) => encodeCommitRecord(fields(seq, o));
/** A record whose checksum is valid over arbitrary (possibly schema-invalid) content. */
const forged = (content: Record<string, unknown>) => canonicalJson({ ...content, checksum: commitRecordChecksum(content) });
/** Slots indexed by parity: [slot 0, slot 1]. */
const slots = (...records: (string | null)[]) => records as [string | null, string | null];

describe("D-6 commit-record slot validation", () => {
  it("D-6 a written record is valid only in the slot of its parity", () => {
    expect(classifySlot(0, rec(4))).toMatchObject({ kind: "valid", record: { seq: 4, head: h(4), format: COMMIT_RECORD_FORMAT } });
    expect(classifySlot(1, rec(4))).toMatchObject({ kind: "inconsistent", reason: expect.stringMatching(/parity/) });
    expect(classifySlot(1, rec(5))).toMatchObject({ kind: "valid" });
    expect(classifySlot(0, null)).toEqual({ kind: "absent" });
  });

  it("D-6 every strict prefix of a record (a torn write) is torn, never valid or inconsistent", () => {
    const line = rec(6);
    for (let cut = 0; cut < line.length; cut++) expect(classifySlot(0, line.slice(0, cut)).kind, `cut ${cut}`).toBe("torn");
  });

  it("D-6 a change to any single byte is detected (checksum) and never yields a valid record", () => {
    const line = rec(8);
    for (let i = 0; i < line.length; i++) {
      const changed = line.slice(0, i) + (line[i] === "0" ? "1" : "0") + line.slice(i + 1);
      expect(classifySlot(0, changed).kind, `byte ${i}`).not.toBe("valid");
    }
  });

  it.each([
    ["unknown format", { ...fields(2), format: "other/1" }],
    ["missing field", { format: COMMIT_RECORD_FORMAT, lineage: LINEAGE, base: 0, seq: 2, head: h(2) }],
    ["non-integer seq", { ...fields(2), format: COMMIT_RECORD_FORMAT, seq: 2.5 }],
    ["seq below base", { ...fields(2), format: COMMIT_RECORD_FORMAT, base: 4 }],
    ["malformed head", { ...fields(2), format: COMMIT_RECORD_FORMAT, head: "xyz" }],
    ["malformed lineage", { ...fields(2), format: COMMIT_RECORD_FORMAT, lineage: "not-hex" }],
    ["seq 0 with a non-genesis head", { ...fields(0), format: COMMIT_RECORD_FORMAT, head: h(1) }],
  ])("D-6 a record with a valid checksum but %s is inconsistent (written by something other than the venue)", (_name, content) => {
    expect(classifySlot(0, forged(content))).toMatchObject({ kind: "inconsistent" });
  });

  it("D-6 a fresh lineage is 128 random bits in hex", () => {
    const a = newLineage();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newLineage()).not.toBe(a);
  });
});

describe("D-6 commit-record selection (S1–S6)", () => {
  it("D-6 S3: two valid consecutive records select the newer, whichever slot it is in", () => {
    expect(selectCommitRecord(...slots(rec(6), rec(7)))).toMatchObject({ ok: true, record: { seq: 7 }, tornSlot: false });
    expect(selectCommitRecord(...slots(rec(8), rec(7)))).toMatchObject({ ok: true, record: { seq: 8 } });
  });

  it("D-6 S4: one valid record and one torn slot select the valid one and report the torn slot", () => {
    const torn = rec(9).slice(0, 30);
    expect(selectCommitRecord(...slots(rec(8), torn))).toMatchObject({ ok: true, record: { seq: 8 }, tornSlot: true });
    expect(selectCommitRecord(...slots("garbage", rec(9)))).toMatchObject({ ok: true, record: { seq: 9 }, tornSlot: true });
  });

  it.each([0, 7, 8])("D-6 S5: the first record of a lineage (base %i) is accepted with the other slot absent", (base) => {
    const first = rec(base, { base });
    const [s0, s1] = base % 2 === 0 ? [first, null] : [null, first];
    expect(selectCommitRecord(s0, s1)).toMatchObject({ ok: true, record: { seq: base, base }, tornSlot: false });
  });

  it.each([7, 8])("D-6 S5 + S3: after a migration at %i the following records alternate slots and stay consecutive", (base) => {
    let pair: [string | null, string | null] = [null, null];
    for (let seq = base; seq < base + 6; seq++) {
      pair[seq % 2] = rec(seq, { base });
      expect(selectCommitRecord(...pair), `after writing ${seq}`).toMatchObject({ ok: true, record: { seq, base } });
      pair = [...pair] as [string | null, string | null];
    }
  });

  it("D-6 S5: a later record with the other slot absent is refused (a slot was lost)", () => {
    expect(selectCommitRecord(rec(4), null)).toMatchObject({ ok: false, code: "F2-missing-slot" });
    expect(selectCommitRecord(null, rec(9, { base: 7 }))).toMatchObject({ ok: false, code: "F2-missing-slot" });
  });

  it("D-6 S2: both slots absent means no record yet", () => {
    expect(selectCommitRecord(null, null)).toEqual({ ok: true, record: null, tornSlot: false });
  });

  it("D-6 S1: an inconsistent slot refuses selection even when the other slot is valid", () => {
    expect(selectCommitRecord(rec(4), rec(4))).toMatchObject({ ok: false, code: "F2-inconsistent" }); // seq 4 cannot be in slot 1
    expect(selectCommitRecord(rec(6), forged({ ...fields(7), format: "other/1" }))).toMatchObject({ ok: false, code: "F2-inconsistent" });
  });

  it("D-6 S3: records of different lineages or bases are refused (slots from different stores or a mixed backup)", () => {
    expect(selectCommitRecord(rec(6), rec(7, { lineage: "f".repeat(32) }))).toMatchObject({ ok: false, code: "F2-lineage" });
    expect(selectCommitRecord(rec(8, { base: 7 }), rec(9, { base: 1 }))).toMatchObject({ ok: false, code: "F2-lineage" });
  });

  it("D-6 S3: non-consecutive records are refused (the record store lost writes)", () => {
    expect(selectCommitRecord(rec(4), rec(7))).toMatchObject({ ok: false, code: "F2-stale", reason: expect.stringMatching(/4.*7|7.*4/) });
  });

  it("D-6 S6: no valid slot is refused", () => {
    expect(selectCommitRecord("x", "y")).toMatchObject({ ok: false, code: "F2-unreadable" });
    expect(selectCommitRecord("x", null)).toMatchObject({ ok: false, code: "F2-unreadable" });
  });

  it("D-6 a consistent but outdated pair is selectable: only the journal comparison can reveal that it is behind", () => {
    // Selection alone cannot distinguish a rolled-back pair from a current one (storage assumption, §3.4).
    expect(selectCommitRecord(rec(4), rec(5))).toMatchObject({ ok: true, record: { seq: 5 } });
  });
});
