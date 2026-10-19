import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson, GENESIS_HASH, sha256 } from "./journal.ts";

/**
 * Commit records (MATCHING-RULES D-6; docs/venue/DURABILITY-PROTOCOL.md §3).
 *
 * A commit record names the last committed journal entry: `seq` and its hash `head`. It lives in a
 * store independent of the journal, in two slots. Record `seq` is always written to slot `seq mod 2`,
 * so a write overwrites the older slot and leaves the newest intact; consecutive writes alternate.
 * `lineage` (random, per store) and `base` (the first seq of the lineage: 0 for a fresh venue, L for a
 * migrated journal) tie both slots to one history. `checksum` covers every other field.
 *
 * This module only encodes, validates and selects. It never touches a store.
 */

export const COMMIT_RECORD_FORMAT = "nova-commit-record/1";

const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const recordSchema = z
  .object({
    format: z.literal(COMMIT_RECORD_FORMAT),
    lineage: z.string().regex(hex(32)),
    base: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    head: z.string().regex(hex(64)),
    writerRulesVersion: z.string().min(1).max(64),
    checksum: z.string().regex(hex(64)),
  })
  .strict();

export type CommitRecord = z.infer<typeof recordSchema>;
export type CommitRecordFields = Omit<CommitRecord, "format" | "checksum">;

/** sha256 over the canonical JSON of every field except `checksum` (format included). */
export function commitRecordChecksum(content: Record<string, unknown>): string {
  const rest = { ...content };
  delete rest.checksum;
  return sha256(canonicalJson(rest));
}

export function encodeCommitRecord(fields: CommitRecordFields): string {
  const content = { format: COMMIT_RECORD_FORMAT, lineage: fields.lineage, base: fields.base, seq: fields.seq, head: fields.head, writerRulesVersion: fields.writerRulesVersion };
  return canonicalJson({ ...content, checksum: commitRecordChecksum(content) });
}

export const slotFor = (seq: number): 0 | 1 => (seq % 2 === 0 ? 0 : 1);

/** A fresh 128-bit lineage identifier. */
export function newLineage(): string {
  return randomBytes(16).toString("hex");
}

export type SlotState =
  | { readonly kind: "absent" }
  /** Unparseable or failing its checksum: consistent with an interrupted write or with corruption. */
  | { readonly kind: "torn" }
  /** Checksum valid but structurally wrong: written by something other than this protocol. */
  | { readonly kind: "inconsistent"; readonly reason: string }
  | { readonly kind: "valid"; readonly record: CommitRecord };

export function classifySlot(index: 0 | 1, bytes: string | null): SlotState {
  if (bytes === null) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch {
    return { kind: "torn" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "torn" };
  const content = raw as Record<string, unknown>;
  if (typeof content.checksum !== "string" || commitRecordChecksum(content) !== content.checksum) return { kind: "torn" };
  const parsed = recordSchema.safeParse(content);
  if (!parsed.success) return { kind: "inconsistent", reason: `slot ${index}: ${parsed.error.issues[0]?.path.join(".") || "record"} invalid` };
  const record = parsed.data;
  if (record.seq < record.base) return { kind: "inconsistent", reason: `slot ${index}: seq ${record.seq} below base ${record.base}` };
  if (slotFor(record.seq) !== index) return { kind: "inconsistent", reason: `slot ${index}: seq ${record.seq} has the wrong parity for this slot` };
  if (record.seq === 0 && record.head !== GENESIS_HASH) return { kind: "inconsistent", reason: `slot ${index}: seq 0 with a non-genesis head` };
  return { kind: "valid", record };
}

export type SelectionFailure = "F2-inconsistent" | "F2-lineage" | "F2-equal-seq" | "F2-stale" | "F2-missing-slot" | "F2-unreadable";
export type Selection =
  | { readonly ok: true; readonly record: CommitRecord | null; readonly tornSlot: boolean }
  | { readonly ok: false; readonly code: SelectionFailure; readonly reason: string };

/**
 * Rules S1–S6 (DURABILITY-PROTOCOL §3.3), applied in order; the first match decides.
 * A torn newest slot is indistinguishable from an interrupted write of it (S4): that is a storage
 * assumption, not something this function can detect.
 */
export function selectCommitRecord(slot0: string | null, slot1: string | null): Selection {
  const states = [classifySlot(0, slot0), classifySlot(1, slot1)] as const;
  const fail = (code: SelectionFailure, reason: string): Selection => ({ ok: false, code, reason });
  // S1: any inconsistent slot.
  for (const s of states) if (s.kind === "inconsistent") return fail("F2-inconsistent", s.reason);
  const valid = states.flatMap((s) => (s.kind === "valid" ? [s.record] : []));
  const absent = states.filter((s) => s.kind === "absent").length;
  // S2: nothing written yet.
  if (absent === 2) return { ok: true, record: null, tornSlot: false };
  // S3: both valid.
  if (valid.length === 2) {
    const [a, b] = valid as [CommitRecord, CommitRecord];
    if (a.lineage !== b.lineage || a.base !== b.base) return fail("F2-lineage", "the slots belong to different record lineages");
    if (a.seq === b.seq) return fail("F2-equal-seq", `both slots hold seq ${a.seq}`);
    if (Math.abs(a.seq - b.seq) !== 1) return fail("F2-stale", `slots not consecutive (seq ${a.seq} and ${b.seq}): the record store lost writes`);
    return { ok: true, record: a.seq > b.seq ? a : b, tornSlot: false };
  }
  if (valid.length === 1) {
    const record = valid[0]!;
    // S4: the other slot is torn (an interrupted write of seq + 1).
    if (absent === 0) return { ok: true, record, tornSlot: true };
    // S5: the other slot was never written: only the first record of a lineage.
    if (record.seq === record.base) return { ok: true, record, tornSlot: false };
    return fail("F2-missing-slot", `seq ${record.seq} (base ${record.base}) with the other slot missing`);
  }
  // S6: no valid slot.
  return fail("F2-unreadable", "no slot holds a valid record");
}
