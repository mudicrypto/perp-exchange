# Nova Venue — Recovery Integrity and Idempotency (Milestone 10)

**Status:** specification written before implementation, then implemented and verified (§5). It
addresses VR-09, VR-10 and VR-14 from [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

A read-only review of the Milestone 10 working tree then found four problems (VR-24 to VR-27, §7).
They are fixed here. In particular, the first version of D-5 dropped a trailing duplicate; it is
now **fail-closed** again (§2). A final read-only review found two pre-existing defects (VR-28: a
complete but invalid final line was dropped as a torn write; VR-29: consumers shared mutable event
objects). Both are fixed (§7).

**Constraints:**

- The matching engine (`src/venue/engine.ts`) is not changed.
- Everything stays local and synthetic.

**Normative rules:** MATCHING-RULES **A-4** (idempotency), **D-5** (duplicate and conflicting
journal records) and **A-5** (order-ID key policy).

## 1. Idempotent order entry across restarts (VR-09, rule A-4)

### Definitions

| Term | Meaning |
|---|---|
| **Order key** | `(accountId, clientOrderId)`. The account comes from the session, never from the message. |
| **Normalised command** | The engine `new-order` command that the gateway derives from a client message: integer ticks and lots, schema defaults applied. Two messages are the **same request** if and only if their normalised commands are byte-identical in canonical JSON. So `"2000.5"` and `"2000.50"` are the same price. |
| **Idempotency ledger** | Kept by the venue, not the gateway. For every **accepted** new order it records the normalised command, its sequence number, and the private events that command produced for the requesting account. |

The ledger is rebuilt deterministically by replaying the journal:

- On a full replay, it is rebuilt entry by entry.
- With a snapshot, it is carried inside the snapshot, verified by its own hash, and then extended by
  the replayed suffix.

The **journal is the authority.** The ledger holds nothing that the journal and the deterministic
engine cannot reproduce.

### Behaviour (exact responses)

| Situation | Response | Journaled? |
|---|---|---|
| First request; the engine accepts | `{ ok: true, replayed: false, events }` with `accepted` and any `fill`/`cancelled` events; ledger entry recorded | yes |
| First request; the engine rejects | `{ ok: true, replayed: false, events: [{ kind: "rejected", reason }] }`; **no** ledger entry (rule §11) | yes |
| **Identical** retry of an accepted order while its ledger entry is **retained** (same process, after a full replay, or after a snapshot restore) | `{ ok: true, replayed: true, events }`. `events` is a **fresh copy** of the original events; mutating it affects nothing else (VR-25). | **no** |
| **Conflicting** retry while the ledger entry is retained (same order key, different normalised command) | `{ ok: false, error: { code: "idempotency-conflict" } }` | **no** |
| Identical retry after `outcome-unknown`, once the venue is recovered | If the command was committed and accepted, the original events with `replayed: true`. Otherwise it is evaluated as a new request. | only in the second case |
| Retry of a **rejected** request, identical or not | Evaluated as a new request | yes |
| **Identical or conflicting** retry after the ledger entry was **evicted** | `{ ok: true, replayed: false, events: [{ kind: "rejected", reason: "duplicate-client-order-id" }] }`. The two cases get **the same answer**. Nothing executes. | yes, as a rejection (journal growth per retry is limited only by the message rate limit) |
| Lookup of the original order after eviction | `gateway.order(token, { clientOrderId })` returns the order's **current** view: `orderId`, status, filled and remaining quantity. This is the supported way to resolve a retry whose original response is no longer retained. The original fill events remain in the account's private event feed until the outbox drops them (VR-13). | — |

**Invariant (tested):** across any number of restarts, evictions and retries, each order key produces
at most one accepted order and at most one set of executions.

**What enforces it: the engine's permanent client-ID index.**

- `MatchingEngine` keeps a map from (account, client order ID) to every **accepted** order, finished
  orders included (`engine.ts`, the duplicate-client-order-id check). It is rebuilt on snapshot
  restore and by replay.
- The **ledger** only provides the original *response*. The protection against a second execution
  after eviction comes entirely from this index.
- **Dependency:** the index grows with every accepted order; it is part of the unbounded-growth risk
  VR-13. Any future fix for VR-13 (archiving finished orders) **must keep a permanent, recoverable
  client-ID index**. Otherwise evicted retries would execute again. This dependency is recorded in
  VERIFICATION-REPORT (VR-13) and SECURITY-CHECKLIST A6.

**Order of gateway checks for a new order:**

1. session and rate limit
2. schema
3. instrument and exact decimal conversion
4. ledger lookup (replay or conflict)
5. post-only probe throttle
6. sequencer

A retry with an invalid price is therefore answered `invalid-request`, not `idempotency-conflict`:
a message that cannot be normalised cannot be compared. Ledger replays read only committed outputs,
so they are answered even while the venue is stopped. Requests that need the sequencer get
`unavailable` until the venue is recovered.

**Ledger records are immutable.** Each record is a deep-frozen private copy, made when it is recorded
and again when it is restored from a snapshot. Every replay returns a fresh copy (VR-25).

### Capacity across restarts (VR-26)

- **Capacity:** 100 000 entries by default (`VenueOptions.idempotencyCapacity`). The oldest entry is
  evicted first, so the ledger holds the most recent *C* accepted orders.
- **Snapshots** record the capacity they were taken with, covered by the ledger hash. Restoring a
  snapshot under a **different** configured capacity is **refused**, before anything is changed.
  Restore with the same capacity, or recover by full replay.
- **Full replay** rebuilds the ledger for the **configured** capacity:
  - With the same capacity, the recovered ledger **equals** the live ledger (tested).
  - With a different capacity, it holds the most recent *C′* accepted orders. A larger capacity may
    let a retry that was refused before the restart be replayed after it, and a smaller one the
    reverse.
  - **Only the response changes, never execution.** The engine's client-ID index refuses any second
    execution either way (tested).
- So **"the recovered ledger equals the live ledger" holds only when the capacity is unchanged.**

## 2. Duplicate and conflicting journal records (VR-10, rule D-5): fail-closed

The reader processes lines in order. Entry *k* is the last valid entry read so far.

| Line | Classification | Recovery |
|---|---|---|
| `seq = k + 1`, valid hash chain and schema | normal entry | accepted |
| Byte-identical copy of entry *k*, anywhere: at the end, with or without a trailing newline, repeated, or followed by anything | `duplicate of the last entry (seq k)` | **refused** |
| Byte-identical copy of an earlier entry *j* < *k* | `copy of earlier entry j` | **refused** |
| `seq ≤ k` with different bytes (including a valid-hash re-serialisation) | `sequence number N reused with different content` | **refused** |
| `seq > k + 1` | `sequence gap: expected k+1, found N` | **refused** |
| Empty line, at the end or in the middle | `empty line` | **refused** |
| Complete line that is not valid JSON | `unparseable entry` | **refused** |
| Line that parses as JSON but fails entry validation (hash, `prevHash`, sequence number, timestamp, fields, command schema), **anywhere, including a final line without a trailing newline** | the validation failure, e.g. `entry hash mismatch` | **refused** (VR-28) |
| Unparseable final line without a trailing newline | torn tail | dropped as uncommitted (D-2), under the storage assumption below |

**A refused recovery never modifies the store.** The store is repaired only after a successful
recovery: a torn tail is truncated and a missing final newline restored.

**Why a trailing duplicate is no longer repaired (VR-24).**

- The first version of D-5 dropped byte-identical copies of the final entry, assuming they came from
  an append retried after a lost acknowledgement.
- The review showed the reader cannot distinguish that from a store that **acknowledged a later
  append but persisted the previous entry's bytes again**. The venue had already answered and
  published the later command, so dropping the copy silently lost an acknowledged order.
- A matching final line is therefore not treated as proof that the copy is harmless.
- **Safe repair would need independent evidence of which entry was committed last.** That would
  mean a separately persisted, independently protected journal head or commit record, written by the
  sequencer after each acknowledged append and checked during recovery. Such a record does not exist
  (VERIFICATION-REPORT §5: no trust anchor), and adding one is a persistence-format change outside
  this fix.
- Until it exists, duplicates fail closed. An operator must establish the truth from outside the
  journal — client acknowledgements, the public tape (`publicSeq`), account events — and repair the
  store manually.

**Torn write or corrupt entry (VR-28).** Every journal line is one canonical JSON object closed by
its last byte, so no strict prefix of a line parses as JSON. Only an *unparseable* final line without
a newline can therefore be a partial write. A final line that *parses* is a complete entry; if it then
fails validation it is corrupt, and recovery refuses it exactly as it would anywhere else. Before
VR-28 such a line was dropped as a torn tail, which silently discarded a corrupted acknowledged
entry.

**Milestone 11 update:** the independent commit record described below now exists for store-backed venues as
the commit anchor (rule D-6, [DURABILITY-AND-RETENTION.md](DURABILITY-AND-RETENTION.md) §1). With it, an
anchored entry that was truncated or lost is refused instead of being dropped or missed. Duplicates remain
fail-closed (founder decision D3). The text below describes the journal reader on its own, which is
unchanged.

**Assumption that remains:** an unparseable final line is still dropped as uncommitted. This relies
on the store contract in `storage.ts`: `append` returns success only once the whole line is durable.
The reader cannot verify that contract. In a store that acknowledges writes before they are durable:

- an acknowledged entry that is later **truncated** mid-line looks exactly like a torn write, and is
  dropped;
- an acknowledged entry that is **missing entirely** leaves a valid, shorter journal, and nothing is
  detected (truncation of the end, VERIFICATION-REPORT §5).

VR-28 does **not** address either case. Both need the same independent commit record or trust anchor
described above.

## 3. Order-ID key policy (VR-14, rule A-5)

Order, fill and execution IDs are a keyed hash of internal counters (H-8). Whoever knows the key can
map IDs back to global sequence numbers. The key therefore has to be a real secret, and the
deterministic key used by tests and demos must never become a default.

**Policy, enforced by `Venue` and `Venue.recover`:**

1. The `idKey` must be at least **43 characters** from the base64url alphabet `[A-Za-z0-9_-]`. That
   is 256 bits if the characters are random. `generateIdKey()` produces such a key from
   `crypto.randomBytes(32)`.
2. It must contain at least **16 distinct characters**. This is a heuristic against obviously
   non-random keys; randomness cannot be verified.
3. **Test-fixture keys** (registry `TEST_FIXTURE_ID_KEYS`, currently `local-prototype-key` and
   `perf-key`):
   - They are refused unless the caller passes `allowTestFixtureIdKey: true`.
   - The flag allows only those registered keys. It never relaxes rules 1–2 for any other key.
4. Error messages describe the rule that failed and never echo the key.

**Fixture separation:**

- `createLocalVenue` is the synthetic-only factory used by tests, the demo and benchmarks. It uses
  the fixture key **explicitly**, through the flag.
- Supplying any other key to it must satisfy the policy.
- No other module may contain a fixture key literal (static check in tests).
- `MatchingEngine` takes the key unvalidated. It is an internal component that only `Venue`, tests
  and benchmarks construct directly; the enforcement point is the `Venue` boundary. The engine is
  unchanged by design.

**Not covered:** rotation, storage and distribution of the key. These need a key-management design
and remain open.

## 4. Unchanged contracts

- **Fail-stop (D-3):** unchanged. A command that may have been committed but whose result cannot be
  established still answers `outcome-unknown` and stops the venue.
- **After `outcome-unknown`:** the client either retries the identical request once the venue is
  recovered (§1 resolves it from the ledger), or looks the order up by client order ID.
- **Crash recovery** at the five persistence boundaries (RECOVERY-TEST-RESULTS §2) must still produce
  the last committed state.

## 5. Verification

**Tests:**

- `src/venue/recovery-integrity.test.ts` (30 tests), written before the implementation.
- `src/venue/recovery-review.test.ts` (16 tests), written before the review fixes.
- `src/venue/recovery-final.test.ts` (19 tests), written before the final-review fixes (§7).

**Evidence:**

| Run | Result | Log |
|---|---|---|
| Both files against the Milestone 9 commit `27dee34` | 41 failed, 5 passed (46) | `docs/venue/verification/m10-tests-against-27dee34.log` |
| Review tests against the unfixed Milestone 10 tree | 12 failed, 4 passed | `docs/venue/verification/m10-review-fixes.log` |
| Final-review tests against the tree before the final-review fixes | 15 failed, 4 passed (19) | `docs/venue/verification/m10-final-review-fixes.log` |
| All, after the fixes | all pass | — |

The 41 failures against `27dee34` break down as:

| Class | Count | Meaning |
|---|---|---|
| Behaviour | 18 | VR-09 (6), VR-14 (10), and the no-newline duplicate that `27dee34` silently dropped as a torn tail (2) |
| Classification | 14 | `27dee34` already refused these journals, but with the generic message |
| New mechanism | 9 | The ledger or its capacity does not exist in `27dee34` |

| Requirement | Test(s) | Result |
|---|---|---|
| Identical retry after restart (full replay, snapshot) | recovery-integrity A-4 | original events, `replayed`, not journaled |
| Conflicting retry after restart | recovery-integrity A-4 | `idempotency-conflict`, not journaled |
| Outcome-unknown resolved by retry | recovery-integrity A-4 (crash after the journal commit and after processing) | original events after recovery; one execution |
| Normalised identity | recovery-integrity A-4 | same request in-process and after restart |
| Never executed twice | property, 150 runs: restarts, snapshots, storage faults, identical and conflicting retries, at least 300 retry checks per run | holds |
| Identical **and** conflicting retry after eviction; lookup by client order ID | recovery-review A-4 eviction | both get `duplicate-client-order-id`; no execution; lookup returns the order |
| Eviction + full replay; eviction + snapshot restore (same capacity) | recovery-review A-4 eviction | same answers; position unchanged; ledger keys equal to live |
| **Terminal** (filled, cancelled) order evicted, then snapshot restore or full replay, with crossing liquidity resting | recovery-final A-4 (2) | identical and conflicting retries both get exactly one `rejected: duplicate-client-order-id` event; no execution; position unchanged; lookup returns the terminal order |
| Returned objects isolated from the ledger | recovery-review VR-25 (2 tests) | mutating a replay changes neither the ledger, later replays, snapshots, nor earlier responses; records are frozen, also after restore |
| Capacity recorded and checked | recovery-review VR-26 | snapshot under another capacity refused, store untouched; capacity tampering caught by the hash; full replay follows the configured capacity, execution unaffected |
| Faulty store: acknowledged append persisted as a copy of the previous entry | recovery-review VR-24 | recovery refuses, store untouched; the order is not silently lost |
| Duplicates (1, 3, no newline, followed by a blank line, interior), stale copy, blank lines, malformed line | recovery-review VR-24, VR-27; recovery-integrity D-5 | refused with accurate messages, store untouched |
| Torn partial final line | recovery-review VR-24; recovery-final VR-28 (4 cut points) | dropped as uncommitted (store contract); store repaired only after success |
| Complete but invalid final line without a newline: corrupted hash of an acknowledged entry, wrong `prevHash`, schema violation, extra field, sequence gap, non-integer sequence, invalid timestamp, non-entry JSON | recovery-final VR-28 (11) | refused with the validation failure; store untouched |
| Event isolation between consumers: first response, private feed, journaled request reference, public listeners, stored tape | recovery-final VR-29 (4) | mutation is refused; no other consumer, the ledger, the tape or engine state changes |
| Ledger durability | recovery-integrity A-4 | equal to live; tampering refused |
| Stopped venue | recovery-integrity A-4 | identical retry answered from committed outputs; new requests `unavailable` |
| Key policy (A-5) | recovery-integrity A-5 | as specified in §3 |

**Existing tests changed:**

1. Tests that build a `Venue` directly with the fixture key now pass `allowTestFixtureIdKey: true`,
   the explicit marking the policy requires. Their assertions are unchanged.
2. One H-8 test used the weak keys `"key-one"` and `"key-two"`. It now uses `generateIdKey()`.
3. The Milestone 9 test "VR-10 … stops recovery: fail-closed" asserted a generic refusal. It now
   asserts the specific D-5 refusal, that the store is untouched, and the interior case.
4. Three D-5 tests in `recovery-integrity.test.ts` asserted the first D-5 version (drop and report).
   After VR-24 they assert refusal with the store untouched. This is stricter, not looser.

The crash-boundary property (150 runs, five boundaries) passes unchanged.

## 6. Residual risks

| Risk | Status |
|---|---|
| Evicted retries | Identical and conflicting retries get the same `duplicate-client-order-id` answer, and each is journaled. The original response must be reconstructed by lookup (§1). |
| Client-ID index dependency | No double execution after eviction rests entirely on the engine's permanent client-ID index. That index grows without bound (VR-13). A fix for VR-13 must preserve it. |
| Capacity changes | A full replay under a different capacity changes which retries are replayed (responses only). A snapshot restore under a different capacity is refused. |
| Ledger in snapshots | Verified by a hash stored in the same snapshot (including the capacity). This detects corruption, not a writer who also recomputes the hash (same limitation as `stateHash`, VERIFICATION-REPORT §5). |
| Duplicate journal records | Fail-closed: availability depends on an operator. Safe automatic repair needs an independently persisted commit record or trust anchor (§2), which does not exist. |
| Torn tail trust | Dropping an unparseable final line assumes the store never acknowledges a write before it is durable (§2). A truncated or missing acknowledged entry in such a store is not detected. |
| Immutable outputs | Routed events and public messages are deep-frozen (VR-29). A consumer that tries to modify one gets a `TypeError` in strict-mode code (a public listener's error is counted in `listenerFailures`). Execution records (`Venue.executions`, `CommandResult.executions`) and the `publicTape` and outbox arrays themselves are not frozen; they are reachable only through the in-process `Venue` object. |
| Key management | Rotation, storage and distribution of the id key are not designed. Rotating the key changes all future ids, not past ones. |
| Key randomness | Cannot be verified. The policy checks length, alphabet and a distinct-character heuristic only. |
| Engine boundary | `MatchingEngine` accepts any key. Only the `Venue` boundary enforces the policy. Direct engine construction is limited to tests and benchmarks by convention, not by a mechanism. |

## 7. Review findings (read-only review of the Milestone 10 working tree)

| ID | Severity | Finding | Fix | Regression tests |
|---|---|---|---|---|
| VR-24 | **Medium** | The trailing-duplicate rule of the first D-5 version dropped a byte-identical copy of the final entry. A store that acknowledged a later append but wrote the previous bytes therefore lost an acknowledged, published order silently. `27dee34` had the same silent drop for a copy without a trailing newline. | D-5 is fail-closed for every duplicate; the store is untouched on refusal (§2) | recovery-review VR-24 (6); recovery-integrity D-5 |
| VR-25 | Low | Replayed responses, the ledger and snapshots shared event objects. Mutating a returned response changed later replays and snapshot contents. | Deep-frozen ledger copies, made at record and restore time; a fresh copy per replay | recovery-review VR-25 (2) |
| VR-26 | Low | The ledger after a restart depended on the capacity in use at recovery. The documentation wrongly claimed the recovered ledger always equals the live one. | Capacity recorded and hashed in snapshots, with mismatching restores refused; full-replay behaviour defined (§1) | recovery-review VR-26 (2) |
| VR-27 | Info | Refusal messages were inaccurate: "not at the end" for a copy that was at the end, and "unparseable" for blank lines | Precise classification (§2) | recovery-review VR-27 (3) |

**Final read-only review.**

| ID | Severity | Finding | Fix | Regression tests |
|---|---|---|---|---|
| VR-28 | **Medium** | `readJournal` treated *any* invalid final line without a newline as a torn write, including a complete line that parses but fails validation. A corrupted acknowledged final entry was silently discarded, reported only as `tornTail`. Pre-existing since Milestone 8. | Only an unparseable final line can be torn; a parseable invalid line is refused anywhere (§2) | recovery-final VR-28 (13) |
| VR-29 | Low | Event objects were shared between the first response, the account's outbox (`events()`, `privateEvents`), the public tape and every public listener; a `request-rejected` event's `ref` was the journaled command's own object. One consumer could alter what another observed, the stored tape, or the in-memory journal entry. Engine state and the ledger were not affected. Pre-existing since Milestone 8. | `Venue.route` deep-freezes every routed event and public message. The engine creates a fresh object per event and keeps none of them, and no consumer modifies them (the public mirror re-parses each message), so freezing is safe. `engine.ts` unchanged. | recovery-final VR-29 (4) |
| — | Info | A terminal order evicted from the ledger and restored from a snapshot was not tested | — (behaviour was already correct: the engine's client-ID index is rebuilt from all snapshot orders, terminal ones included) | recovery-final A-4 (2) |
