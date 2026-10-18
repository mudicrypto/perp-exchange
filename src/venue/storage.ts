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
 * Commit anchor (MATCHING-RULES D-6): a separately written record of the last committed
 * journal entry, `canonicalJson({ seq, hash })`. The sequencer writes it after the journal
 * append returns and before the engine processes the command; both writes together are the
 * commit point. On recovery, the journal must contain the anchored entry with the anchored
 * hash, so an acknowledged entry that a non-conforming store truncated or lost is detected
 * instead of being dropped as a torn tail or missed entirely.
 *
 * `write` replaces the record and must return only once it is durable; a thrown error means
 * the outcome is unknown. `read` returns the stored record verbatim, or null if none was
 * ever written. The anchor is only as independent as the medium it is stored on: the
 * in-memory implementation detects integrity faults in the prototype and proves nothing
 * about physical durability, and an insider who can rewrite both stores is not detected.
 */
export interface CommitAnchorStore {
  write(record: string): void;
  read(): string | null;
}

export type AnchorFault = "before-write" | "torn-write" | "after-write";

export class MemoryAnchorStore implements CommitAnchorStore {
  private record: string | null = null;
  /** Test-only: fault applied to the next write, then cleared. */
  failNextWrite: AnchorFault | null = null;

  write(record: string): void {
    const fault = this.failNextWrite;
    this.failNextWrite = null;
    if (fault === "before-write") throw new StorageFault("injected: anchor write failed before anything was stored");
    if (fault === "torn-write") {
      this.record = record.slice(0, Math.max(1, Math.floor(record.length / 2)));
      throw new StorageFault("injected: torn anchor write");
    }
    this.record = record;
    if (fault === "after-write") throw new StorageFault("injected: failure after the anchor write completed");
  }

  read(): string | null {
    return this.record;
  }
}
