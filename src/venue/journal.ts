import { createHash } from "node:crypto";
import { engineCommandSchema, type EngineCommand, type SequencedCommand } from "./types.ts";

/**
 * Write-ahead command journal. The sequencer appends a command (with its
 * sequence number and timestamp) before the engine processes it; the engine
 * is deterministic, so the journal alone reproduces every state and output.
 *
 * Entries are hash-chained. This makes edits, reordering and truncation in
 * the middle *detectable* by anyone holding a later head hash. It does not
 * stop an operator who can rewrite the whole chain; that requires anchoring
 * head hashes outside the operator's control (see docs/venue/THREAT-MODEL.md).
 */

export const GENESIS_HASH = "0".repeat(64);

/** Deterministic JSON: object keys sorted, bigint as decimal string, undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface JournalEntry extends SequencedCommand {
  readonly prevHash: string;
  readonly hash: string;
}

export function entryHash(prevHash: string, seq: number, ts: number, command: EngineCommand): string {
  return sha256(`${prevHash}\n${canonicalJson({ seq, ts, command })}`);
}

export class Journal {
  private readonly items: JournalEntry[] = [];

  get entries(): readonly JournalEntry[] {
    return this.items;
  }

  get head(): string {
    return this.items.at(-1)?.hash ?? GENESIS_HASH;
  }

  get lastSeq(): number {
    return this.items.at(-1)?.seq ?? 0;
  }

  get lastTs(): number {
    return this.items.at(-1)?.ts ?? 0;
  }

  append(ts: number, command: EngineCommand): JournalEntry {
    const entry = this.prepare(ts, command);
    this.commit(entry);
    return entry;
  }

  /** Builds the next entry without adding it (so it can be made durable first). */
  prepare(ts: number, command: EngineCommand): JournalEntry {
    const seq = this.lastSeq + 1;
    const prevHash = this.head;
    return { seq, ts, command, prevHash, hash: entryHash(prevHash, seq, ts, command) };
  }

  commit(entry: JournalEntry): void {
    if (entry.seq !== this.lastSeq + 1 || entry.prevHash !== this.head) throw new Error("journal entry does not extend the head");
    this.items.push(entry);
  }

  /** Serialises as JSON Lines (one entry per line), the prototype's "durable" form. */
  toJsonl(): string {
    return this.items.map((e) => canonicalJson(e)).join("\n") + (this.items.length ? "\n" : "");
  }

  static fromEntries(entries: readonly JournalEntry[]): Journal {
    const journal = new Journal();
    journal.items.push(...entries);
    return journal;
  }
}

export type JournalVerification =
  /** `validLength`: characters of `jsonl` covered by complete, valid entries (a torn tail starts there). */
  | { ok: true; entries: JournalEntry[]; head: string; tornTail: boolean; validLength: number }
  | { ok: false; validEntries: JournalEntry[]; failedAtLine: number; reason: string };

/**
 * Reads a JSONL journal as untrusted input: every line is parsed, every
 * command re-validated, and the sequence and hash chain checked.
 *
 * A final line without a trailing newline that fails to parse is treated as a
 * torn write (crash mid-append) and dropped; any other failure is corruption.
 */
export function readJournal(jsonl: string): JournalVerification {
  const lines = jsonl.split("\n");
  const complete = jsonl.endsWith("\n") || jsonl === "";
  if (complete) lines.pop();
  const entries: JournalEntry[] = [];
  let prev = GENESIS_HASH;
  let prevTs = 0;
  let validLength = 0;
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch {
      if (isLast && !complete) return { ok: true, entries, head: prev, tornTail: true, validLength };
      return { ok: false, validEntries: entries, failedAtLine: i + 1, reason: "unparseable entry" };
    }
    const failure = checkEntry(raw, entries.length + 1, prev, prevTs);
    if (typeof failure === "string") {
      if (isLast && !complete) return { ok: true, entries, head: prev, tornTail: true, validLength };
      return { ok: false, validEntries: entries, failedAtLine: i + 1, reason: failure };
    }
    entries.push(failure);
    prev = failure.hash;
    prevTs = failure.ts;
    // A complete entry without its trailing newline still counts (the hash covers the whole entry);
    // the newline is added before anything is appended after it.
    validLength = Math.min(jsonl.length, validLength + lines[i]!.length + 1);
  }
  return { ok: true, entries, head: prev, tornTail: false, validLength };
}

function checkEntry(raw: unknown, expectedSeq: number, prevHash: string, prevTs: number): JournalEntry | string {
  if (!raw || typeof raw !== "object") return "entry is not an object";
  const e = raw as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "command,hash,prevHash,seq,ts") return "unexpected entry fields";
  if (e.seq !== expectedSeq) return `sequence gap or reorder (expected ${expectedSeq})`;
  if (typeof e.ts !== "number" || !Number.isSafeInteger(e.ts) || e.ts < 0) return "invalid timestamp";
  if (e.ts < prevTs) return "timestamp went backwards";
  if (e.prevHash !== prevHash) return "hash chain broken";
  const parsed = engineCommandSchema.safeParse(e.command);
  if (!parsed.success) return "invalid command";
  const hash = entryHash(prevHash, expectedSeq, e.ts, parsed.data);
  if (e.hash !== hash) return "entry hash mismatch";
  return { seq: expectedSeq, ts: e.ts, command: parsed.data, prevHash, hash };
}
