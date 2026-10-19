# Nova Venue — Recovery Test Results (Milestone 9)

**Tests:**

- `src/venue/crash-recovery.test.ts` (new)
- `src/venue/recovery.test.ts` (existing; D-3 test corrected for VR-01)

Findings referenced as VR-nn are in [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

## 1. What was built for these tests

| Piece | Role |
|---|---|
| `JournalStore` (`storage.ts`) | Durable-storage boundary. `append` returning means the entry is committed. Any error means the outcome is unknown, and the venue stops. |
| `MemoryJournalStore` | **The only implementation.** It is in-memory and supports injected faults: `before-write`, `torn-write` and `after-write`. The prototype is forbidden to use the file system, so there is no file or replicated store. **Real-media durability is unverified.** |
| `Venue` commit order | 1. refuse if stopped<br>2. validate<br>3. **store append (commit)**<br>4. in-memory journal<br>5. engine<br>6. outputs to the stores<br>7. listeners |
| `Venue.boundary` (test seam) | A `protected` no-op called after the journal commit and after engine processing. Only the test subclass `CrashingVenue` overrides it to simulate process death; it is not a configuration option (VR-23). |
| `Venue.recover` | Takes journal text **or** a store, never both (VR-21). Reads the store as untrusted input, verifies the snapshot binding and `stateHash`, and replays, naming the sequence number of any faulting entry. **Only then** repairs the store: truncates a torn tail and restores a missing final newline. A failed recovery leaves the store byte-identical (VR-22). |

## 2. Crash-boundary property

The test "recovery equals the last committed state at every boundary" runs 150 cases. In each case:

1. Generate a seeded synthetic flow: about 80 commands (adds, hidden adds, IOC/FOK, post-only,
   cancels, replaces, mass cancels).
2. Pick a random command *k* and one of the 5 boundaries below.
3. Interrupt processing there.
4. Discard the process.
5. Recover from the store alone.
6. Compare with an **uninterrupted reference run** of exactly the committed commands.

| Boundary | Committed? | Client sees | Recovered state equals |
|---|---|---|---|
| before-write (store throws, nothing written) | no | `outcome-unknown` (cannot be told apart from the next row) | commands 1…k−1 |
| torn-write (partial line written) | no; the tail is truncated on recovery | `outcome-unknown` | commands 1…k−1 |
| after-write (written, acknowledgement lost) | **yes** | `outcome-unknown` | commands 1…k |
| after-journal (crash before the engine) | **yes** | none (crashed) | commands 1…k |
| after-process (crash before outputs are routed) | **yes** | none (crashed) | commands 1…k |

Compared after recovery, all equal to the reference:

- engine state hash
- output hash chain
- journal position (sequence number and head hash)
- open orders of every account
- executions (fills)
- public tape
- every account's private events

**Consumer view:** a consumer that kept what it received before the crash, then read the recovered
venue and de-duplicated by `publicSeq` and `accountSeq`, ends with **exactly** the reference outputs.
Nothing is lost and nothing is duplicated.

**Continuity:** after recovery, the remaining commands are submitted to the recovered venue on the
same store, and the store is recovered again. There is no torn tail, and the state equals an
uninterrupted run of all commands.

**Result: 150/150 cases pass.** Since the review follow-up the property simulates crashes through the `CrashingVenue` test subclass.

## 3. Journal and snapshot tests

| Case | Result | Test |
|---|---|---|
| Canonical serialisation: same command → same bytes → same hash | Holds. Recovery reproduces head and output hashes in every case above. | crash-recovery property; `recovery` D-1 |
| Edited entry, swapped entries, injected command with a recomputed hash | Detected at the exact line (hash mismatch, sequence error, schema refusal) | `recovery` D-2 |
| Full-chain rewrite | **Not detected** without an external anchor (verifies internally; different head) | `recovery` D-2 |
| Torn final write (unparseable final line, no newline) | Dropped; recovery equals the prefix. Correct only under the store contract (§5). | `recovery` D-2; crash-recovery; recovery-final VR-28 |
| Complete final entry that parses but fails validation, without its newline | **Was dropped as a torn write (VR-28, pre-existing since Milestone 8).** Now refused, store unchanged. | recovery-final VR-28 |
| Complete final entry without its newline | Treated as committed; newline restored before the next append | crash-recovery "D-2 …" |
| Duplicated final line (retried append, or an acknowledged append persisted with the previous bytes) | **M10 (D-5), fail-closed:** every duplicate refuses recovery with a precise classification, and the store is left unchanged. This covers a trailing copy with or without a newline, an interior copy, a stale copy, sequence reuse with different content, a gap and an empty line. A first M10 version dropped trailing copies; the review showed this could silently lose an acknowledged order (VR-24), so it was reverted. | crash-recovery "VR-10 / D-5 …"; recovery-integrity D-5; recovery-review VR-24/VR-27 |
| Invalid sequence (gap, duplicate, reorder) or timestamp going backwards | Refused by the reader and the engine | `recovery` D-1, D-2 |
| Snapshot from another journal | Refused (journal-head binding) | `recovery` D-2 |
| Snapshot with altered content (internally consistent) | **Was accepted (VR-05).** Now refused by the `stateHash` check. | crash-recovery "VR-05 …" |
| Snapshot whose holdings disagree with its orders | Refused | `recovery` D-3 |
| Snapshot + suffix vs full replay | Identical state and outputs | `recovery` D-1; `properties` D-1 (100 runs, random cut) |
| Failed append in a live process | Venue stops; no later append can follow the torn line | crash-recovery "VR-07 …" |
| Command after the engine stopped | **Was journaled (VR-01).** Now refused before journaling. | `verification` "VR-01 …"; `recovery` D-3 |
| Poison command (deterministic fault) | Replay stops and names the sequence number (VR-18, partial) | crash-recovery "VR-18 …" |
| Rejected or failed commands leaving partial state | Rejections change no book, order, position or public state (property). A failure mid-command leaves the in-memory engine partly changed, but it is stopped, publishes nothing, refuses order queries (VR-19), and recovery rebuilds from the journal. | `verification` "VR-11 …", "VR-01 …", "VR-19 …" |
| Failure while routing outputs after the commit | Venue stops; reported as `outcome-unknown`, never "nothing recorded"; the command takes effect on recovery (VR-20) | crash-recovery "VR-20 …" |
| Recovery from journal text and a store together | Refused (VR-21) | crash-recovery "VR-21 …" |
| Recovery that fails (altered snapshot, poison command) | Store left byte-identical; repaired by the next successful recovery (VR-22) | crash-recovery "VR-22 …" |
| Visible outputs ahead of the commit | Never. Every public message and every response is emitted after its command is in the store. | crash-recovery "externally visible results never get ahead …" |

## 4. What the hash chain does and does not protect against

See [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md) §5. In short:

- **Detected:** corruption, and partial edits (edit, reorder, insert or delete in the middle).
- **Not detected:**
  - truncation of the end
  - a full rewrite by anyone with write access
  - a re-hashed snapshot

  Each of these is detectable only against an independently protected anchor, which does not exist
  here. The journal is not tamper-proof.

## 5. Not covered

- Real storage: fsync semantics, partial sector writes, reordering by the OS or disk, media errors,
  disk full, replication and fail-over (split brain).
- A store that acknowledges an append before it is durable. If such a store later loses the end of an
  acknowledged entry, recovery drops it as a torn write; if it loses the whole entry, nothing is
  detected. Detecting either needs an independent commit record or trust anchor.
- Concurrent writers: the prototype has a single writer.
- Recovery-time objectives at production journal sizes. PERFORMANCE-RESULTS F7 measures 60 000
  entries only.
- Idempotency at ledger capacity: beyond the newest 100 000 accepted orders, a retry gets the engine's duplicate rejection, not the original response (RECOVERY-INTEGRITY §6). Since Milestone 10 the ledger itself survives restarts (VR-09 resolved).

## 6. Milestone 10 — idempotency and duplicate records across recovery

Tests: `src/venue/recovery-integrity.test.ts`. Specification and full results:
[RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §5.

| Case | Result |
|---|---|
| Identical retry after a restart (full replay; snapshot + suffix) | Original events, `replayed: true`, not journaled |
| Conflicting retry after a restart | `idempotency-conflict`, not journaled |
| Crash after the journal commit (`after-journal`, `after-process`), then recovery and an identical retry | Original events; exactly one execution |
| Random restarts, storage faults and retries (property, 150 runs, at least 300 retry checks per run) | No accepted order journaled or executed twice; every identical retry replayed, every conflicting retry refused |
| Ledger after full replay and after snapshot recovery | Equal to the live ledger **with the same capacity**. A snapshot restore under a different capacity is refused (VR-26). An altered ledger or capacity in a snapshot is refused (hash). |
| Retries after ledger eviction, live and after full replay or snapshot restore | Identical and conflicting retries both get `duplicate-client-order-id`; no second execution; the order can still be looked up by client order ID |
| Faulty store: acknowledged append persisted as a copy of the previous entry | Recovery refuses; the store is untouched; the acknowledged order is not silently lost (VR-24) |
| Duplicate and conflicting journal records | Rule D-5, fail-closed (row above) |
| Terminal (filled, cancelled) order evicted from the ledger, then snapshot restore or full replay | Identical and conflicting retries get `duplicate-client-order-id`; no execution although crossing liquidity rests; lookup returns the terminal order (recovery-final A-4) |
| Consumers mutating delivered events (first response, private feed, public listeners, stored tape) | Refused (objects frozen); no other consumer, the ledger, the tape or engine state changes (recovery-final VR-29) |

The crash-boundary property in §2 passes unchanged.

## 7. Milestone 11 (Venue) — commit records, interrupted repair, retention

Tests: `commit-record.test.ts`, `commit-record-slots.test.ts`, `migration.test.ts`,
`retry-semantics.test.ts`, `retention.test.ts`, `poison-diagnostics.test.ts`. Protocol and full crash
matrix: [DURABILITY-PROTOCOL.md](DURABILITY-PROTOCOL.md).

| Case | Result |
|---|---|
| Crash-boundary property with commit records: 9 boundaries (journal faults, record faults, crashes after the journal, after the record and after processing), 150 runs | Recovery equals an uninterrupted run of exactly the committed commands; the stores stay appendable; a second recovery plans no repair |
| Crash-matrix rows 1–12 | Each outcome-unknown resolves to the committed state; an identical retry of the new order returns the original (committed) or executes once (not committed); never twice |
| Committed entry lost, truncated, replaced by the previous bytes, or an interior entry corrupted, after the response was returned | Refused (F4, F4, D-5, F1); both stores byte-identical |
| The same entry lost from both stores | **Not detected** (pinned as a limitation) |
| Record ahead, two behind, wrong head, unreadable, absent | Refused (F4, F6, F5, F2, F3) |
| Snapshot + roll forward; snapshot + missing committed entry; snapshot ahead of the record | Rolls forward; F4 (not masked); F7 |
| Interrupted repair at every boundary (IR-2 to IR-12) | Converges to the same committed state under the modelled faults; an overshoot into a committed entry is refused (RI-6); an overshoot into the uncommitted entry converges without it |
| Convergence property (IR-14): up to five random recoverable repair faults, 150 runs | Always the same committed state and canonical stores |
| Offline migration at odd and even bases, then commands and three crash/recovery cycles | First record accepted under S5; parity and sequence correct after every write; the final state equals the reference |

The Milestone 9 crash-boundary property in §2 passes unchanged (no commit-record store: Milestone 10
behaviour).
