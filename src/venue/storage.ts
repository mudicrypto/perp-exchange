/**
 * Durable-storage boundary for the command journal.
 *
 * `append` must return only once the line is durable; the sequencer treats a
 * returned append as the commit point. Any thrown error means the outcome is
 * unknown (nothing, part, or all of the line may be stored) and the venue
 * stops accepting commands until it is recovered from storage.
 *
 * The prototype ships an in-memory implementation with fault injection for
 * tests only. A file- or replicated-log-backed store does not exist (the
 * prototype may not touch the file system), so real durability (fsync,
 * replication, media failure) is unverified.
 */
export interface JournalStore {
  append(line: string): void;
  read(): string;
  /** Drops everything after `length` characters (used to remove a torn tail during recovery). */
  truncate(length: number): void;
}

export class StorageFault extends Error {
  override readonly name = "StorageFault";
}

export type AppendFault = "before-write" | "torn-write" | "after-write";

export class MemoryJournalStore implements JournalStore {
  private text = "";
  /** Test-only: fault applied to the next append, then cleared. */
  failNextAppend: AppendFault | null = null;

  append(line: string): void {
    const fault = this.failNextAppend;
    this.failNextAppend = null;
    if (fault === "before-write") throw new StorageFault("injected: write failed before any byte was stored");
    if (fault === "torn-write") {
      this.text += line.slice(0, Math.max(1, Math.floor(line.length / 2)));
      throw new StorageFault("injected: torn write");
    }
    this.text += line;
    // The line is stored, but the caller never learns it (e.g. the acknowledgement was lost).
    if (fault === "after-write") throw new StorageFault("injected: failure after the write completed");
  }

  read(): string {
    return this.text;
  }

  truncate(length: number): void {
    this.text = this.text.slice(0, length);
  }
}

/**
 * Commit-record store (MATCHING-RULES D-6; docs/venue/DURABILITY-PROTOCOL.md §3.5). Two slots, written
 * one at a time. Contract: `writeSlot(i, …)` touches only slot `i` and is durable once it returns; a slot
 * write need not be atomic (a torn slot is detected by its checksum); `readSlots` returns the last
 * durable bytes of each slot; failures are independent of the journal store's. Like the journal store,
 * the prototype has only an in-memory implementation, so real independence and durability are unverified.
 */
export interface CommitRecordStore {
  readSlots(): readonly [string | null, string | null];
  writeSlot(index: 0 | 1, bytes: string): void;
}

/**
 * `before-write`: throws, nothing stored. `torn-write`: stores a prefix, then throws.
 * `after-write`: stores everything, then throws. `lost-write`: returns normally but stores nothing
 * (a nonconforming store that acknowledges a write it did not persist).
 */
export type SlotWriteFault = "before-write" | "torn-write" | "after-write" | "lost-write";

export class MemoryCommitRecordStore implements CommitRecordStore {
  private slots: [string | null, string | null] = [null, null];
  /** Test-only: fault applied to the next slot write, then cleared. */
  failNextWrite: SlotWriteFault | null = null;

  readSlots(): readonly [string | null, string | null] {
    return [this.slots[0], this.slots[1]];
  }

  writeSlot(index: 0 | 1, bytes: string): void {
    const fault = this.failNextWrite;
    this.failNextWrite = null;
    if (fault === "before-write") throw new StorageFault("injected: slot write failed before any byte was stored");
    if (fault === "lost-write") return;
    if (fault === "torn-write") {
      this.slots[index] = bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2)));
      throw new StorageFault("injected: torn slot write");
    }
    this.slots[index] = bytes;
    if (fault === "after-write") throw new StorageFault("injected: failure after the slot write completed");
  }

  /** Test-only: replace both slots (simulates restores, rollbacks and external damage). */
  replaceSlots(slots: readonly [string | null, string | null]): void {
    this.slots = [slots[0], slots[1]];
  }
}
