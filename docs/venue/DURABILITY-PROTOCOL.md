# Nova Venue — Durability Protocol, Retention and Poison Diagnostics (Milestone 11, Venue)

**Status:** specified, then implemented test-first, in the local synthetic prototype. Rules
[MATCHING-RULES](MATCHING-RULES.md) D-2, D-3, D-6, D-7, A-4 and A-6. Results:
[VERIFICATION-REPORT](VERIFICATION-REPORT.md) §9.

**Constraints:**

- `src/venue/engine.ts` is unchanged.
- D-5 stays fail-closed.
- Every Milestone 10 guarantee is preserved.
- Both stores are in memory: real durability and real independence of the two stores are **not**
  verified.

## 1. Terms

| Term | Meaning | Recorded where |
|---|---|---|
| Store-acknowledged | A store write call returned | — |
| Journaled | The entry's bytes were appended to the journal store | journal |
| **Committed** | Journaled **and** covered by a commit record: written live, or by a recovery that rolls the entry forward (§4.2). Every successful recovery applies every committed command exactly once. | journal + commit record |
| Applied | Processed by the engine | memory only |
| Released | Outputs routed: ledger, outbox, tape, listeners | memory only |
| Response returned | `Venue.submit` returned to the gateway, and the gateway to its caller | nowhere |
| Client-acknowledged | The client received the response | **unknowable to the venue** |

A commit record proves that a command was committed before any output for it existed. It does
**not** prove that a response was returned or delivered. Refusals therefore say "committed entry *n*
missing", never "acknowledged entry missing".

Without a commit-record store (`commitRecords` unset) the venue behaves exactly as in Milestone 10:
the journal append is the commit point.

## 2. Live protocol

```
Idle ─validate─▶ Validated ─journal.append─▶ Journaled ─record.writeSlot─▶ Committed
  ─engine.process─▶ Applied ─route─▶ Released ─return─▶ Returned ─(transport)─▶ Delivered?
```

**Bootstrap:** a fresh venue with a commit-record store writes the genesis record
`{seq 0, base 0, head GENESIS}` into slot 0 before it accepts any command. The constructor refuses
non-empty stores; existing stores are opened only by `Venue.recover`.

| Failure moving to… | Venue afterwards | Caller receives |
|---|---|---|
| Validated | running | invalid request; nothing journaled |
| Journaled (append throws) | **halted** | `outcome-unknown`; none, part or all of the line may be stored |
| Committed (record write throws) | **halted** | `outcome-unknown`; the entry is journaled; the record may or may not be written |
| Applied (engine fault) | **halted** (D-3) | `outcome-unknown`; committed |
| Released (routing throws) | **halted** (VR-20) | `outcome-unknown`; committed |
| Returned / Delivered | — | nothing; committed |

### 2.1 Crash matrix

`k` is the command being processed. "Retry" is an identical new-order retry after recovery. Tests are
in `src/venue/commit-record.test.ts` unless stated otherwise.

| # | Event | Journal | Record | Recovery | State | Retry | Test |
|---|---|---|---|---|---|---|---|
| 1 | Append fails before any byte | k−1 | k−1 | consistent | 1…k−1 | executes once | row 1 |
| 2 | Torn append | k−1 + torn | k−1 | drop torn tail (established relative to the record) | 1…k−1 | executes once | row 2 |
| 3 | Append written, acknowledgement lost | k | k−1 | roll forward | 1…k | original, `replayed` | row 3 |
| 4 | **Journal written, record missing** (crash) | k | k−1 | roll forward | 1…k | original | row 4 |
| 5 | Record write fails before persisting | k | k−1 | roll forward | 1…k | original | row 5 |
| 6 | Torn record slot | k | k−1 (other slot) | S4, roll forward | 1…k | original | row 6 |
| 7 | Record written, acknowledgement lost | k | k | consistent | 1…k | original | row 7 |
| 8 | **Record written, not executed** (crash) | k | k | replay applies k | 1…k | original | row 8 |
| 9 | Engine fault (poison) | k | k | **F10**: replay-fault diagnostic; venue stays down | — | after an operator fix | row 9 |
| 10 | Crash after execution, before release | k | k | replay | 1…k | original | row 10 |
| 11 | Routing fails mid-release | k | k | replay; consumers de-duplicate by seq (D-4) | 1…k | original | row 11 |
| 12 | **Executed, response not delivered** | k | k | replay (indistinguishable from 10) | 1…k | original | row 12 |
| 13 | **Response returned, then the journal loses the last entry** | k−1 | k | **F4** | — | — | rows 13–16 |
| 14 | Response returned, last line truncated | k−1 + torn | k | **F4** (truncated committed entry) | — | — | rows 13–16 |
| 15 | Last entry replaced by the previous bytes | k−1 + copy | k | **D-5** (F1) | — | — | rows 13–16 |
| 16 | Interior entry corrupted | corrupt | k | **F1** | — | — | rows 13–16 |
| 17 | **Both stores lose entry k** | k−1 | k−1 | consistent: **silent loss** | 1…k−1 | executes again | row 17 (limitation) |
| 18 | Record ahead (incl. empty journal) | < r | r | **F4** | — | — | rows 18–21 |
| 19 | Record two or more behind | L | ≤ L−2 | **F6** | — | — | rows 18–21 |
| 20 | Record names another head | L | r | **F5** | — | — | rows 18–21 |
| 21 | Record unreadable / absent with a non-empty journal | L | — | **F2** / **F3** | — | — | rows 18–21 |
| 22 | Snapshot ≤ record, consistent | — | — | restore + suffix = full replay | — | — | row 22 |
| 23 | Snapshot + journaled-uncommitted entry | k | k−1 | restore, roll forward | 1…k | original | row 23 |
| 24 | Snapshot + committed entry missing | k−1 | k | **F4** (not masked) | — | — | row 24 |
| 25 | Snapshot ahead of the record | k | k−1 | **F7** | — | — | row 25 |
| 26 | Snapshot rules version missing or different | — | — | **F8** | — | — | `poison-diagnostics` D-7 |

A property test interrupts a random command of a 64-command flow at each of nine boundaries
(150 runs). It checks that recovery equals an uninterrupted run of exactly the committed commands, and
that the stores stay appendable.

## 3. Commit records

### 3.1 Format and write rule

```
{ format: "nova-commit-record/1", lineage, base, seq, head, writerRulesVersion, checksum }
```

| Field | Meaning |
|---|---|
| `lineage` | 128 bits, one value per record store. Random for a fresh venue; derived from the approval for a migration (§6). |
| `base` | First seq of the lineage: 0 for a fresh venue, `L` for a migrated journal |
| `checksum` | sha256 over the canonical JSON of every other field |

**Write rule:**

- Record `seq` is written to slot `seq mod 2`. A write overwrites the older slot and leaves the newest
  intact.
- Seq advances by exactly one per write: the live commit, or the recovery roll-forward.

Implementation: `src/venue/commit-record.ts` (pure: encode, validate, select). The store interface is
`CommitRecordStore` in `storage.ts`.

### 3.2 Slot validation

| Class | Condition |
|---|---|
| absent | never written |
| **torn** | unparseable, or the checksum fails. A strict prefix of the canonical JSON never parses; any changed byte fails the checksum (tested at every position). |
| **inconsistent** | checksum valid but: unknown format, schema failure, `seq < base`, `seq mod 2 ≠ slot`, or `seq = 0` with a non-genesis head |
| valid | otherwise |

### 3.3 Selection (S1–S6, first match decides)

| Rule | Slots | Result |
|---|---|---|
| S1 | either inconsistent | refuse `F2-inconsistent` |
| S2 | both absent | no record. Allowed only with an empty journal (recovery then bootstraps); otherwise **F3** |
| S3 | both valid | lineage or base differs: `F2-lineage`; equal seq: `F2-equal-seq` (unreachable through parity, kept defensively); seqs differ by 1: the higher; by ≥ 2: `F2-stale` |
| S4 | one valid, one torn | the valid one; `tornSlot: true` |
| S5 | one valid, one absent | allowed only if `seq = base` (the first record of a lineage); otherwise `F2-missing-slot` |
| S6 | no valid slot | refuse `F2-unreadable` |

**Nonzero bases (migration).** A migrated lineage starts at `L` in slot `L mod 2`, with the other slot
absent. This is accepted by S5, for odd and even `L`. The first live write after it is `L+1` into the
other, never-written slot: S3, consecutive. Every later write alternates. A torn write of `L+1` leaves
`{valid L, torn}`, which is S4 and rolls forward. Tested for `L = 15` and `L = 16`, with commands and
three crash/recovery cycles (`migration.test.ts`), and in the pure selection tests for bases 0, 7 and 8.

### 3.4 What selection can and cannot detect

| Scenario | Outcome | Detectable? |
|---|---|---|
| Torn write of `k+1` | S4 → `k`, roll forward | yes (reported) |
| Write of `k+1` done, acknowledgement lost | `k+1` | — (venue halted) |
| Lost write (acknowledged, not persisted) of the final command | `k`, roll forward | indistinguishable from a crash before the write; correct outcome |
| Lost write, then **one** more write | slots `k+1`, `k−1`: `F2-stale` | **yes** (refused) |
| Lost write, then **two or more** writes | consecutive again. The newer record names a head that chains through the lost seq, so that entry is committed by implication. | **no**, and harmless (tested) |
| Corruption of the older slot | S4 | yes |
| Corruption of the newest slot | S4 selects the older record. Correct if the journal still holds the entry (roll forward); **silent loss** if the journal also lost it. | **storage assumption** |
| Both slots corrupt | S6 | yes |
| Well-formed record in the wrong slot, mixed lineages | S1 / S3 | yes |
| Valid but outdated pair (rolled back), journal current | roll forward if one behind, otherwise F6 | yes |
| Outdated pair **and** journal rolled back consistently | consistent, older state | **no** (correlated; needs an external anchor) |

### 3.5 Store contracts

| Store | Contract | If violated |
|---|---|---|
| Journal | `append` returns only when the line is durable; `read` returns exactly the appended bytes; `truncate` is used only by recovery | detected while the commit record is intact (F4, D-5, F1), except correlated loss |
| Commit record | `writeSlot(i)` touches only slot `i` and is durable when it returns; a slot write need not be atomic; `readSlots` returns the last durable bytes; failures are independent of the journal store's | §3.4 |

## 4. Recovery

### 4.1 Phases

**Phase V (verify and plan), read-only:**

1. Read the journal (F1).
2. Select the record (F2, F3).
3. Compare it with the journal (F4, F5, F6).
4. Snapshot checks (binding, F7, F8, state hash, ledger hash, capacity).
5. Replay (F10).

**Every refusal happens in Phase V.**

**Phase R (repair):** the planned steps in order. Each step is followed by a **read-back** of the store
it changed. If repair fails or a read-back disagrees, recovery throws `RecoveryRepairError`
(`completedSteps`, `failedStep`) and **returns no venue**. No command can be journaled before Phase R
has completed.

### 4.2 Fail-closed conditions

Each condition throws `RecoveryRefusedError` with the code shown and changes no store.

| Code | Condition |
|---|---|
| F1-journal | `readJournal` refusal: D-5 duplicates, VR-28 invalid lines, gap, empty line, hash chain |
| F2-* | record selection failure (§3.3) |
| F3-unrecorded-journal | no record, non-empty journal. Use the offline migration (§6); recovery has no adoption flag. |
| F4-record-ahead | record seq `r` > journal seq `L` ("missing"), or a torn line at `r = L + 1` ("truncated") |
| F5-record-mismatch | `hash(entry r) ≠ record.head` |
| F6-journal-ahead | `L − r ≥ 2` |
| F7-snapshot-ahead | snapshot seq > `r` |
| F8-snapshot-rules-version | snapshot rules version different, or missing without `allowLegacySnapshot` |
| F10-replay-fault | a command faults on replay (`ReplayFaultError`, §8) |

F9 of the earlier design (seq 0 with a non-genesis head) is part of slot validation (S1).

**Roll forward** happens when `r = L − 1`.

### 4.3 Repair steps (the only mutations)

| Step | When | Mutation | Read-back |
|---|---|---|---|
| R1 `truncate-torn-tail` | unparseable final line without a newline | `truncate(validLength)` | journal equals the valid prefix |
| R2 `restore-newline` | complete final entry without `\n` | `append("\n")` | journal equals prefix + `\n` |
| R3 `advance-commit-record` | `r = L − 1` | write record `L` to slot `L mod 2` | selection yields `(L, head, lineage)` |
| R0 `bootstrap-commit-record` | no record, empty journal | write genesis record | selection yields seq 0 |

Order: R1 or R2 (never both), then R3 or R0. The journal is repaired first and the record advanced
last, so the record never covers a journal state that has not been made consistent.

### 4.4 Invariants

| ID | Invariant |
|---|---|
| RI-1 | A **refused** recovery leaves the journal and both record slots byte-identical. This is the precise form of the Milestone 10 guarantee, which concerned refusals (VR-22). |
| RI-2 | Phase R mutates only by R0–R3, with the planned arguments, journal first (tested with a mutation log). |
| **RI-3 (revised)** | Under conforming stores and the **modelled recoverable faults**, any sequence of interrupted repairs ends, at the next successful recovery, in **the same committed state**: state hash, output head, journal head and ledger. The repaired stores are canonical: the clean journal, and a record naming its last entry. The plan of a later attempt is **not** required to be a suffix of the earlier one. For example, a partial truncation is completed by a revised R1 that removes fewer bytes. |
| RI-4 | Recovery of fully repaired stores plans nothing and changes no bytes. |
| RI-5 | No venue is returned, and no command is journaled, until Phase R has completed. |
| RI-6 | A nonconforming truncation that cuts into a **committed** entry is refused at the next recovery (F4); it is never accepted as a shorter journal. |

**Modelled recoverable faults:**

- truncation that throws before changing anything;
- partial truncation, followed by an error or reported as success (caught by the read-back);
- newline append that fails before or after writing;
- record write that fails before writing, is torn, persists and then throws, or is acknowledged but
  lost (caught by the read-back).

**Nonconforming faults that end in refusal or a different state instead of convergence:**

| Fault | Outcome |
|---|---|
| Truncation overshooting into a committed entry | read-back error, then **F4** on the next recovery (RI-6) |
| Truncation overshooting into the uncommitted entry `L` | read-back error before R3. The next recovery converges to the state **without** `L`, which was never committed: the committed state is unchanged, but the roll-forward is lost. |
| Damage outside the planned steps (other slot, interior journal bytes) | F1 / F2 refusal |

**Interrupted-repair tests** (`commit-record.test.ts`): IR-2, IR-3, IR-3b, IR-4, IR-5, IR-7, IR-7b,
IR-9, IR-10, IR-11, IR-12. IR-1 and IR-13 coincide with IR-2 and RI-4. IR-14 is a property: 150 runs
of up to five random recoverable faults, on two repair states.

## 5. Retries after an unknown outcome

- **Request idempotency:** the same request returns the same response and causes no further effect.
- **Effect idempotency:** applying the command again causes no further state change, **provided
  nothing else changed the affected state in between**. A retry is always evaluated against current
  state.

`outcome-unknown` means the command may or may not have been committed. If committed, every
successful recovery applies it exactly once. Commands are refused with `unavailable` until recovery
completes.

| Command | Request-idempotent | Effect-idempotent | Blind-retry hazard (demonstrated in `retry-semantics.test.ts`) | Client action |
|---|---|---|---|---|
| New order | yes, while the ledger retains it, and only if the original was **accepted** | yes (permanent client-ID index) | after eviction the answer is `duplicate-client-order-id`. A **rejected** original did not consume the ID, so a retry may now be accepted (a first acceptance, not a second). | retry allowed; then look up by client order ID |
| Cancel | **no** | only for that one order | the same `order-not-modifiable` answer whether the first cancel worked or the order filled meanwhile | look the order up; never read the retry's answer as the outcome |
| Replace | **no** | only if nothing else touched the order | a retry can **revert** an interleaved replace; partial fills change the answer | look up, read fills; never two replaces in flight for one order |
| Mass cancel | **no** | **no** | cancels orders placed after the original | never blind-retry; read `openOrders`, cancel explicitly |

### 5.3 Client reconciliation procedure

1. **Freeze** commands for the account, including parallel sessions.
2. **Wait** until the venue is available again.
3. **Catch up:** `eventsPage(token, lastProcessedAccountSeq)`, processed in `accountSeq` order and
   de-duplicated (D-4).
   - If `gap` is non-null, rebuild from `order()` and `openOrders()`.
   - Fills inside a gap are not recoverable by a client: there is no position or fill-history query
     (limitation).
4. **Resolve** the unknown command using the table above.
5. **Resume.**

## 6. Offline migration (`src/venue/migration.ts`)

`migrateToCommitRecord` is the only way to put a Milestone 10 journal under commit records. It is not
reachable from `Venue.recover`, the gateway or any venue option.

Every refusal (`MigrationRefusedError`) changes nothing. The procedure:

1. Require an operator in the approval.
2. **Backup:** the caller's copy must equal the journal byte for byte and by sha256.
3. **Validation:** the journal reads cleanly (no torn tail, final newline present) and replays.
4. **Approval** must match the validated `seq`, `head` and `stateHash` exactly.
5. **Record store** must be empty, or hold only this migration's record: complete (the procedure is
   idempotent) or a strict prefix of it (an interrupted write; the procedure re-runs).
6. Confirm the journal is unchanged.
7. Write `{seq L, base L}` to slot `L mod 2`.
8. Read it back.

The lineage is derived from the approval, which makes the intended bytes deterministic. That is what
lets a re-run recognise its own interrupted write and refuse anything else.

- **What binds an approval to a journal:** the journal head is the hash chain over the complete
  history, so an approval for another history of the same length is refused, in both directions.
- **When torn residue may be overwritten:** only if it is a strict prefix of exactly the intended
  record **and already contains its full checksum**. A shorter residue (for example
  `{"base":15,"checksum":"`) is a prefix of any approval's record and is refused (final review; tested
  failing against the earlier rule).
- **What a completed migration accepts:** no retry under a different operator or time, and no
  migration of a store whose venue has already run.

The approval is an unauthenticated argument, and the backup is caller-supplied (limitation).

## 7. Retention (rule A-6)

| Data | Class | Behaviour |
|---|---|---|
| Journal store, commit record, snapshots | authoritative / recovery | never discarded |
| Engine orders and client-ID index | authoritative: permanent duplicate protection | unchanged, unbounded by design (measured, F8) |
| Idempotency ledger | authoritative for replayed responses | unchanged (bounded, capacity-verified) |
| `executions`, `transitions`, `publicTape`, `adminErrors` | audit (regenerable by full replay) | **unbounded by default**; `auditRetention` is opt-in, counted in `auditDropped`, and marks history partial |
| Per-account outbox | operational | ring buffer: retained ≤ capacity, storage ≤ capacity + max(capacity, 1024); `privateEventsPage` / `gateway.eventsPage` report gaps exactly; `events()` unchanged |
| In-memory journal copy | derived | `journalMemory: "head"` keeps the last entry only (requires a store); `entries` / `toJsonl()` then throw |

**History reporting:** `historyComplete` is false, with `historyIncompleteReasons` (`snapshot-restore`,
`audit-retention:<store>`), whenever audit records are missing. `reconcile()` then reports
`history: "partial"` and skips the execution-derived checks.

**Head-only dependency check:** every reader of `journal.entries` / `toJsonl()` outside tests (demo,
bench, perf) uses store-less venues, which stay in full mode.

## 8. Poison commands and rules versions (rules D-3, D-7)

**`ReplayFaultError`** (code F10) carries:

- `seq`, `entryHash`, `commandType`, `isFinalEntry`;
- `commitState`: `committed`, `uncommitted` or `no-commit-record`;
- `codeRulesVersion`, `snapshotRulesVersion`, `writerRulesVersion`.

Its message has a fixed format with **no command payload and no raw engine message**. The engine
copies arbitrary error text, which can contain order data; the original error is kept only as
`cause`.

There is no skip, quarantine or journal-rewrite API. Procedure: [RUNBOOK-POISON-COMMAND.md](RUNBOOK-POISON-COMMAND.md).

**Rules version** (`VENUE_RULES_VERSION` in `rules-version.ts`):

- Snapshots carry it.
- A different version refuses the restore (F8); full replay remains possible.
- A missing version (a pre-Milestone 11 snapshot) is refused unless `allowLegacySnapshot` is passed,
  which is reported.
- The commit record's `writerRulesVersion` is report-only.
- The field is not hashed: it guards compatibility, not integrity.

## 9. Verification

| Test file | Tests | Covers |
|---|---|---|
| `commit-record-slots.test.ts` | 25 | slot validation and S1–S6, including odd and even bases |
| `commit-record.test.ts` | 47 | crash matrix, F1–F10, RI-1–RI-6, IR boundaries, convergence property, crash-boundary property |
| `migration.test.ts` | 9 | offline migration, odd and even bases with crash cycles, refusals, re-run |
| `retry-semantics.test.ts` | 7 | request vs effect idempotency, reconciliation |
| `retention.test.ts` | 10 | audit, outbox, gaps, head-only mode, duplicate protection |
| `poison-diagnostics.test.ts` | 6 | F10 diagnostics, rules versions |

The Milestone 9 test `crash-recovery` "VR-18 …" was updated: the message must no longer contain the
raw engine message, and the cause must.

Evidence: `docs/venue/verification/m11-tests-against-9812049.log`, `m11-final/`.

## 10. Remaining limitations

**Storage**

- No atomic update across the two stores. Correctness rests on ordered, read-back repair steps and
  convergence.
- Correlated loss (crash-matrix row 17), consistent rollback of both stores, and insider rewrites are
  undetected. The commit record is not a trust anchor.
- A corrupted newest record slot looks like a torn write (§3.4).
- A lost record write followed by two or more writes is covered by the later record, not detected.
- Both stores are in memory: no fsync, no group commit, and two synchronous writes per command.

**Clients**

- Delivery is unknowable.
- Cancel, replace and mass cancel are not request-idempotent, and mass cancel is not
  effect-idempotent.
- There is no position or fill-history query to recover fills lost in an outbox gap.

**Operations**

- Migration approval is unauthenticated, and its backup is caller-supplied.
- Poison commands still keep the venue down; only diagnosis and the runbook exist.
- The rules version does not protect a full replay across an incompatible upgrade.

**Growth**

- Engine order and client-ID maps stay unbounded.
- The in-memory stores dominate the heap in this prototype (F8).

## 11. Changes found during implementation

1. **Per-step read-back in Phase R** (added). Without it, a truncation that silently overshot, or a
   lost record write, could let the *same* recovery return a venue whose in-memory journal disagrees
   with the store. With it, both are reported at once as `RecoveryRepairError`, and an overshoot into
   uncommitted data is caught *before* R3 can commit the lost entry.
2. **Lost record write followed by further writes.** The earlier design said this was refused. That
   is true only for exactly one further write. After two or more, the slots are consecutive again and
   the later record covers the entry (§3.4).
3. **Migration lineage is derived from the approval**, not random. This makes the re-run rule
   ("accept only a strict prefix of exactly this record") exact.
4. **Final review.** Residue accepted on a migration re-run must contain the intended record's full
   checksum (§6).

   Confirmed by new tests:
   - a lost record write healed by later writes leaves a record that binds the complete journal
     prefix: a shortened journal is refused (F4), and a history rewritten from the lost seq with
     recomputed hashes is refused (F5);
   - Phase V never calls a mutating store method, for any refusal code (a write trap, stricter than
     byte equality);
   - repair read-back catches a silently skipped truncation, a lost newline append and a lost record
     write.

   Evidence: `docs/venue/verification/m11-final-review.log`.
