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
| Torn final write | Dropped; recovery equals the prefix | `recovery` D-2; crash-recovery |
| Complete final entry without its newline | Treated as committed; newline restored before the next append | crash-recovery "D-2 …" |
| Duplicated final line (retried append) | Recovery refuses; fail-closed (VR-10, open) | crash-recovery "VR-10 …" |
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
- Concurrent writers: the prototype has a single writer.
- Recovery-time objectives at production journal sizes. PERFORMANCE-RESULTS F7 measures 60 000
  entries only.
- Idempotency records survive restarts: they do not (VR-09).
