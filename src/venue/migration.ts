import { classifySlot, encodeCommitRecord, selectCommitRecord, slotFor } from "./commit-record.ts";
import { canonicalJson, readJournal, sha256 } from "./journal.ts";
import { VENUE_RULES_VERSION } from "./rules-version.ts";
import type { CommitRecordStore, JournalStore } from "./storage.ts";
import { Venue, type VenueOptions } from "./venue.ts";

/**
 * Offline migration of a journal written without commit records (Milestone 10) to a commit-record
 * lineage starting at its last entry L (docs/venue/DURABILITY-PROTOCOL.md §4; MATCHING-RULES D-6).
 *
 * This is an operator procedure, deliberately not reachable from `Venue.recover`, the gateway or any
 * venue option: normal recovery refuses an unrecorded journal (F3). It requires
 *   - a backup copy of the journal, verified byte for byte and by sha256 (the prototype cannot write
 *     durable backups itself, so the caller supplies the copy);
 *   - a full validation: the journal must read cleanly (no torn tail, final newline present) and replay;
 *   - an approval bound to exactly the validated seq, head and state hash. The approval is a structured
 *     argument, not authenticated: real four-eyes approval needs admin authentication (open).
 *
 * The record is written to slot L mod 2 with base L and a lineage derived from the approval, so its bytes
 * are deterministic: a re-run after an interrupted write accepts only a strict prefix of exactly that
 * record, and a re-run after completion changes nothing.
 */

export interface MigrationInput {
  /** Engine configuration and policies used to validate the journal by replay (stores are ignored). */
  readonly options: VenueOptions;
  readonly journalStore: JournalStore;
  readonly recordStore: CommitRecordStore;
  readonly backup: { readonly journalBytes: string; readonly sha256: string };
  readonly approval: { readonly operator: string; readonly seq: number; readonly head: string; readonly stateHash: string; readonly approvedAt: string };
}

export interface MigrationReport {
  readonly seq: number;
  readonly head: string;
  readonly stateHash: string;
  readonly lineage: string;
  readonly base: number;
  readonly slot: 0 | 1;
  /** The identical record was already in place; nothing was written. */
  readonly alreadyMigrated: boolean;
  readonly operator: string;
  readonly approvedAt: string;
}

export class MigrationRefusedError extends Error {
  override readonly name = "MigrationRefusedError";
}

export function migrateToCommitRecord(input: MigrationInput): MigrationReport {
  const refuse = (message: string): never => {
    throw new MigrationRefusedError(`migration refused: ${message}`);
  };
  const { approval } = input;
  if (typeof approval.operator !== "string" || approval.operator.trim() === "") refuse("the approval names no operator");

  // Backup: the caller's copy must be the journal, byte for byte.
  const text = input.journalStore.read();
  if (input.backup.journalBytes !== text || sha256(input.backup.journalBytes) !== input.backup.sha256) refuse("the backup does not match the journal (bytes or sha256)");

  // Validation: a clean journal that replays.
  if (text === "") refuse("the journal is empty; a fresh venue bootstraps its own commit record");
  const read = readJournal(text);
  if (!read.ok) return refuse(`journal validation failed at line ${read.failedAtLine}: ${read.reason}`);
  if (read.tornTail) refuse("the journal has a torn tail; repair it first by ordinary recovery without a commit-record store");
  if (!text.endsWith("\n")) refuse("the journal's final entry lacks its newline; repair it first by ordinary recovery without a commit-record store");
  const { store: _store, commitRecords: _records, ...engineOptions } = input.options;
  void _store;
  void _records;
  let stateHash: string;
  try {
    stateHash = Venue.recover({ ...engineOptions, journalMemory: "full" }, text).venue.engine.stateHash();
  } catch (error) {
    return refuse(`journal validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const L = read.entries.length;
  const head = read.head;

  // Approval: bound to exactly what was validated.
  if (approval.seq !== L || approval.head !== head || approval.stateHash !== stateHash) refuse("the approval does not match the validated journal (seq, head and state hash must all match)");

  // Record store: empty, or holding only this migration's record (complete, or an interrupted write of it).
  const lineage = sha256(canonicalJson({ purpose: "nova-commit-record-migration", head, seq: L, stateHash, operator: approval.operator, approvedAt: approval.approvedAt })).slice(0, 32);
  const intended = encodeCommitRecord({ lineage, base: L, seq: L, head, writerRulesVersion: VENUE_RULES_VERSION });
  const slot = slotFor(L);
  const slots = input.recordStore.readSlots();
  const current = slots[slot];
  if (slots[slot === 0 ? 1 : 0] !== null) refuse("the commit-record store is not empty");
  let alreadyMigrated = false;
  if (current !== null) {
    // A torn residue is overwritten only if it is a strict prefix of exactly this record that already contains
    // the record's full checksum: that binds it to this approval and journal head. A shorter residue (for
    // example `{"base":15,"ch`) is a prefix of any approval's record for this seq and proves nothing.
    const checksumEnd = intended.indexOf('","format"');
    const ours = classifySlot(slot, current).kind === "torn" && intended.startsWith(current) && current.length >= checksumEnd;
    if (current === intended) alreadyMigrated = true;
    else if (!ours) refuse("the commit-record store is not empty (it holds a record or a partial write that is not this migration's)");
  }

  if (input.journalStore.read() !== text) refuse("the journal changed during migration");
  if (!alreadyMigrated) input.recordStore.writeSlot(slot, intended);

  const back = selectCommitRecord(...input.recordStore.readSlots());
  if (!back.ok || back.record?.seq !== L || back.record.head !== head || back.record.base !== L) {
    throw new MigrationRefusedError("migration incomplete: the commit record did not read back; run the migration again");
  }
  return { seq: L, head, stateHash, lineage, base: L, slot, alreadyMigrated, operator: approval.operator, approvedAt: approval.approvedAt };
}
