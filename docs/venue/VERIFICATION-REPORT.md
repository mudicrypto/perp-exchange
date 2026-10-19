# Nova Venue — Milestone 9 Verification Report

**Scope:** independent verification and hardening of the local venue prototype (`src/venue/`)
against its specifications (`docs/venue/`).

**Constraints:** synthetic orders and deterministic fixtures only, no network, no funds. The
prototype is a local research artefact: it is not deployable, and nothing in this report says
otherwise.

Companion reports:

| Report | Content |
|---|---|
| [PRIVACY-REVIEW.md](PRIVACY-REVIEW.md) | Hidden-order leakage by threat model (A–E) |
| [RECOVERY-TEST-RESULTS.md](RECOVERY-TEST-RESULTS.md) | Crash boundaries, journal, snapshots |
| [PERFORMANCE-RESULTS.md](PERFORMANCE-RESULTS.md) | Reproducible synthetic benchmarks |

Raw logs are in `docs/venue/verification/`.

## Verdict

**Verified with limitations.**

### Verified within the tested scope

- **Matching rules:** all 43 numbered rules in [MATCHING-RULES.md](MATCHING-RULES.md) behave as
  specified. This holds for the example, property-based, adversarial and crash-boundary tests in
  §4, after the fixes in §3.
- **Feeds:** public and private feeds agree with committed executions.
- **Recovery:** recovery from the durable-store boundary reproduces the last committed state and
  outputs at every interruption point tested.

### Limitations

1. **Durability is unverified.** Durability is verified only against an in-memory store with
   injected faults. There is no file-backed or replicated store; real media, fsync and replication
   behaviour are untested.
2. **The hash chain is not tamper-proof.** It is tamper-evident only relative to a head stored
   somewhere the attacker cannot change. No such independent anchor exists.
3. **Hidden orders are not confidential from everyone.** They are hidden from the public and other
   traders by access control and publication rules. They are not hidden from:
   - the operator
   - the same process
   - anyone who can read storage

   Residual inference channels remain. Some are reduced; none is eliminated
   ([PRIVACY-REVIEW.md](PRIVACY-REVIEW.md)).
4. **Several findings are open, at Low severity or below (§3).**
5. **Performance numbers describe this container only.** They are not capacity.

## 1. Baseline (Phase A)

Measured on branch `claude/vibrant-archimedes-n82pph` at commit `4edf72b`, working tree clean,
before any change. Logs are in `docs/venue/verification/baseline/`.

| Check | Command | Result |
|---|---|---|
| Venue tests | `npx vitest run src/venue` | 83 passed (6 files) |
| Full unit suite | `npm test` | 460 passed (42 files) |
| Typecheck | `npm run typecheck` | pass |
| Lint | `npm run lint` | pass |
| Build + bundle scan | `npm run build`, `npm run verify:bundle` | pass; 20 files, 9 patterns, clean |
| E2E | `npm run test:e2e` | 52 passed (simulation and live-config servers; the live server's venue fetches fail by design: no network) |
| Demo | `npm run venue:demo` | reconciliation OK; recovered state and output hashes match |

**Discrepancy with the brief:** the brief cites 73 venue tests. The repository had **83**. The extra
10 tests come from `docs.test.ts` (7) and `demo.test.ts` (3), which were added after the figure of
73 was reported. The other figures (460 unit, 52 E2E, build) matched.

### What the baseline did not cover

These were found by reading the code and the specification, not from the test results:

- **Untested failure paths:**
  - a public listener that throws
  - a command submitted after the engine stopped
  - storage write failures
  - a corrupted (but self-consistent) snapshot
  - unauthenticated floods
  - replace-based probing
- **Missing coverage:**
  - risk checks on replace
  - market-order protection price at the edges of the price range
  - commands sharing a timestamp
  - private and public feeds checked against executions per command
  - crash boundaries
- **Contradictory requirements:**
  - MATCHING-RULES §11 ("a rejected order consumes no client ID") against gateway idempotency
    (VR-06).
  - H-7 promised a post-only probe throttle that `replace` bypassed (VR-03).
  - H-9 described ticks journaled "at a fixed interval", which nothing implements (VR-12).
- **Unsafe defaults:**
  - The fixture `idKey` is a constant (VR-14).
  - Publication defaults to `immediate`, the leakier mode (PRIVACY-REVIEW §A).
  - Outboxes silently drop the oldest events (VR-13).

## 2. Changes made

Each change fixes a demonstrated defect. The engine itself was not rewritten.

| File | Change | Finding |
|---|---|---|
| `src/venue/venue.ts` | Refuses commands *before* journaling once stopped. Raises `OutcomeUnknownError` when a command was or may have been journaled. Routes outputs to every store before notifying listeners, and isolates listener failures. Optional `JournalStore` with commit-before-process. Snapshot carries `stateHash`, verified on restore. Recovery truncates a torn tail and restores a missing final newline, but repairs the store only after the journal, the snapshot and the replay all succeed. It takes journal text or a store, never both, and names the sequence number of a poison command. A failure while routing outputs after the commit is `outcome-unknown`. Crash simulation is a `protected` no-op seam that only a test subclass overrides, not a configuration option. | VR-01, VR-02, VR-05, VR-07, VR-18, VR-20…VR-23 |
| `src/venue/storage.ts` (new) | `JournalStore` interface; `MemoryJournalStore` with injected faults (before, torn and after write). No file-system implementation; ESLint forbids file-system access in the prototype. | VR-07 |
| `src/venue/journal.ts` | `prepare`/`commit` split; `validLength` reported for torn-tail truncation; reader refuses timestamps that go backwards | VR-07 |
| `src/venue/gateway.ts` | New error code `outcome-unknown`. Order queries refuse while the venue is stopped (VR-19). Post-only rejections of **replaces** count toward, and are blocked by, the probe throttle. Refusal log bounded (10 000 records) plus per-code totals. Only accepted orders are stored as idempotency records. | VR-01, VR-03, VR-04, VR-06, VR-19 |
| `src/venue/recovery.test.ts` | The existing D-3 test asserted the defective `unavailable` answer for a command that had been journaled. It now asserts `outcome-unknown`, and also that nothing more is journaled. This makes the test stricter, not weaker. | VR-01 |
| `src/venue/perf.ts`, `cli/perf.ts` (new), `package.json` | `npm run venue:perf`: reproducible benchmarks and timing probe | Phase F |
| New tests | `verification.test.ts` (34), `crash-recovery.test.ts` (12), `privacy-review.test.ts` (13) | all |
| Docs | This report and the three companion reports. MATCHING-RULES, ARCHITECTURE, THREAT-MODEL and SECURITY-CHECKLIST updated where behaviour or claims changed. `docs/CHECKLIST.md` updated. | — |

No test or isolation rule was weakened. The venue's ESLint isolation rules are unchanged.

## 3. Findings

**Severity:**

| Level | Meaning |
|---|---|
| High | Externally visible results can contradict committed state, or a stated protection fails in normal use |
| Medium | A stated protection can be bypassed, or a resource can be exhausted, with modest effort |
| Low | A limited inference or availability effect, or a documentation and spec mismatch |
| Info | A property worth recording; no defect against the specification |

**Status:**

| Status | Meaning |
|---|---|
| Resolved | Fixed, with a regression test |
| Open | Documented, with a test that pins current behaviour where possible |
| Accepted | Intended design |

**Evidence that the fixes are real:**

- **Against the original commit.** The current `verification.test.ts` and `privacy-review.test.ts`
  (47 tests) were run against the original commit `4edf72b`, exported with `git archive`.
  **Exactly the 6 regression tests for VR-01, -02, -03, -04, -06 and -19 failed.** The other 41
  passed, which shows they pin existing behaviour
  (`docs/venue/verification/regression-tests-against-4edf72b.log`). An earlier version of this log
  covered only 44 tests (5 failures), because it was produced before the VR-19 test and two coverage
  tests were added. It has been replaced.
- **Against the pre-fix working tree.** VR-20 to VR-23 come from the review of the Milestone 9
  working tree. Their 5 regression tests were run against that working tree with `venue.ts`
  reconstructed without the four fixes, and **all 5 failed**
  (`docs/venue/verification/review-notes-against-prefix.log`).
- **By reproduction.** VR-05 and VR-07 depend on APIs added in this milestone. Their evidence is the
  reproduction recorded below, which was run against the unchanged code.

### VR-01: Commands journaled after a fault; the client is told "not accepting" — **High, Resolved**

- **Rule:** D-3 (fail-stop), §12 durable processing.
- **Evidence:** `Venue.submit` appended to the journal before calling the engine. After a fault had
  stopped the engine, every later command was still appended, and then refused. The gateway
  answered `unavailable` ("The venue is not accepting commands") both for those commands and for
  the faulting command itself.
- **Reproduction:**
  1. Make `BookSide.add` throw once.
  2. Account A submits an order.
  3. Account B submits an order.
  4. Recover from the journal.

  Before the fix: the journal grew for B, and after recovery **both** A's and B's orders were
  resting. B had been told its order was not accepted.
- **Fix:**
  - A stopped venue throws `VenueUnavailableError` before journaling, so nothing is recorded.
  - A fault after journaling throws `OutcomeUnknownError`, and the gateway answers
    `outcome-unknown`.
- **Regression test:** `verification.test.ts` "VR-01 …". The `recovery.test.ts` D-3 test was
  corrected to match.

### VR-02: A throwing public listener drops private events and misreports a committed order — **Medium, Resolved**

- **Rule:** A-2, §12 ("route outputs").
- **Evidence:** the routing code called public listeners inside the loop that filled the public
  tape, before private events were routed. A listener exception escaped `submit` *after* the engine
  had committed the order.
- **Reproduction:** `venue.onPublic(() => { throw … })`, then place an order. Before the fix:
  - the gateway answered `unavailable`
  - the order was resting
  - the private outbox was empty, so the event was lost for good
- **Fix:** all outputs are recorded first, then listeners are notified. Each listener runs in
  isolation and failures are counted in `listenerFailures`.
- **Regression test:** `verification.test.ts` "VR-02 …".

### VR-03: Post-only probe throttle bypassed through replace — **Medium, Resolved**

- **Rule:** H-7.
- **Evidence:** only post-only rejections of *new* orders were counted. Replacing a resting
  post-only order to a price inside the spread is refused with `post-only-would-take` whenever
  hidden liquidity crosses. That is the same free probe, and it was unlimited apart from the
  general message rate.
- **Reproduction:** with a throttle of 3 per minute, alternate replaces between 2000.50 and 2000.00
  against a hidden ask at 2000.50. Before the fix, every second replace answered
  `post-only-would-take`, without limit.
- **Fix:** replace refusals count toward the same per-account budget, and replaces of post-only
  orders are refused once the budget is spent. The budget is shared with new orders and is not
  reset by reconnecting.
- **Regression test:** `privacy-review.test.ts` "VR-03 …".

### VR-04: Unbounded refusal log (memory growth, unauthenticated) — **Medium, Resolved**

- **Rule:** A-3; THREAT-MODEL T-A1.
- **Evidence:** every refusal, including calls with no valid session, appended a record forever.
- **Reproduction:** 100 000 calls (50 000 rate-limited plus 50 000 with no valid session) produced
  99 995 retained records.
- **Fix:** a bounded log of the most recent 10 000 records, plus per-code totals.
- **Regression test:** `verification.test.ts` "VR-04 …".

### VR-05: Altered snapshot restored silently — **Medium, Resolved**

- **Rule:** D-2, D-3 (snapshot integrity).
- **Evidence:** restore only cross-checked open lots. Changing a live order's price inside a snapshot
  passed every check.
- **Reproduction:** change a bid's `priceTicks` from 3 998 to 4 200 in a snapshot, then recover.
  Before the fix, the public book showed a bid at 4 200 that never existed.
- **Fix:** the snapshot stores its state hash, and the restored state must reproduce it exactly.
  This detects accidental corruption and naive edits. Someone who can rewrite the snapshot can also
  recompute the hash; see PRIVACY-REVIEW E and §5.
- **Regression test:** `crash-recovery.test.ts` "VR-05 …".

### VR-06: Gateway cached rejections, contradicting §11 — **Low, Resolved**

- **Rule:** A-4, MATCHING-RULES §11.
- **Evidence:** a rejected order, for example `trading-halted`, was stored as the idempotency
  response. An identical retry after the halt was lifted got the stale rejection back. A corrected
  retry got `idempotency-conflict`. So the client ID was in effect consumed.
- **Fix:** only accepted orders create idempotency records. A rejection created nothing, so
  evaluating the retry again cannot cause a duplicate.
- **Regression test:** `verification.test.ts` "VR-06 …".

### VR-07: No durable-storage boundary; a torn write would corrupt later appends — **Medium (gap), Resolved in scope**

- **Rule:** D-2, §12.
- **Evidence:** no storage interface existed. The design's "torn tail is dropped" rule had no
  implementation. The design also did not say that after a failed append the process must stop,
  because a later append written after a partial line corrupts the middle of the journal, which is
  unrecoverable.
- **Fix:** a `JournalStore` that commits before the engine sees the command. Any append failure
  stops the venue with `outcome-unknown`. Recovery truncates a torn tail.
- **Regression tests:** `crash-recovery.test.ts`, "VR-07 …" and the boundary property.
- **Remaining:** only the in-memory implementation exists.

### VR-08: Failing FOK is a free absence probe — **Low, Open**

- **Rule:** H-7 (by analogy), M-8.
- **Evidence:** a FOK that cannot fill is cancelled with no execution. That reveals "less than Q
  available at or better than P, hidden included" at no cost. A positive answer costs a real
  execution.
- **Proposed mitigation (not implemented, because it changes semantics):** count `fok-unfilled`
  inside the displayed spread toward the probe budget, or require a minimum FOK size.
- **Test:** `privacy-review.test.ts` "VR-08 …" pins the current behaviour.

### VR-09: Idempotency records are not durable — **Low, Resolved in Milestone 10**

- **Rule:** A-4.
- **Evidence:** records live in gateway memory. If a client retries after a crash, there is no
  duplicate execution: the engine refuses the duplicate client ID, which is journaled state. But the
  client gets `duplicate-client-order-id` instead of its original response, and must look the order
  up by client order ID.
- **Test (Milestone 9):** covered by the outcome-unknown flow in `verification.test.ts` "VR-01 …"
  (lookup by client order ID after recovery).
- **Resolution (Milestone 10):** a venue idempotency ledger is rebuilt from the journal and carried
  in snapshots under a verified hash. An identical retry after a restart now returns the original
  events without journaling. A conflicting retry is `idempotency-conflict`. A residual remains at
  capacity eviction. Rule A-4; [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §1, §5.

### VR-10: A duplicated final line stops recovery (fail-closed) — **Low, Resolved in Milestone 10**

- **Rule:** D-2.
- **Evidence:** an append retried after a lost acknowledgement duplicates the last line. The reader
  treats this as corruption, so the venue stays down until an operator intervenes.
- **Assessment:** safe, but unavailable. A writer that is idempotent on (seq, hash) would avoid it.
- **Test (Milestone 9):** `crash-recovery.test.ts` "VR-10 …". The test was updated in Milestone 10
  to the new rule.
- **Resolution (Milestone 10):** rule D-5, **fail-closed**.
  - Every duplicate refuses recovery with a precise classification, and the store is left unchanged.
    This covers a trailing copy of the final entry, with or without a newline, an interior copy, a
    stale copy, sequence reuse with different content, a gap and an empty line.
  - The first Milestone 10 version dropped trailing copies. The review showed that this could
    silently lose an acknowledged command (VR-24), so it was reverted.
  - **What changed relative to Milestone 9:**
    - Precise classification.
    - The no-newline copy of the final entry, which Milestone 9 silently dropped as a torn tail, is
      now refused.
  - **Availability:** still depends on an operator. Safe automatic repair would need an independently
    persisted commit record.
  - [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §2, §5, §7.

### VR-11: Rejected orders create empty account holdings — **Info, Accepted**

- **Evidence:** the risk check creates a zeroed holding record per (account, instrument), even when
  the order is rejected. This is bounded by the number of instruments. Books, orders, positions and
  public data are never changed by a rejection (property-tested).
- **Test:** `verification.test.ts` "VR-11 …".

### VR-12: H-9 described a scheduler that does not exist — **Low, Resolved (documentation)**

- **Evidence:** MATCHING-RULES H-9 said the sequencer journals publish ticks "at a fixed interval".
  In fact, the driver (demo or tests) submits `publish` commands, and no scheduler exists.
- **Fix:** the text was corrected. A fixed-interval scheduler is listed as missing.

### VR-13: Unbounded in-memory growth; outboxes drop silently — **Low, Open**

- **Evidence:** these grow without limit:
  - `orders` and the client-ID index, which keep terminal orders
  - `publicTape`, `executions` and `transitions`

  Outboxes keep 10 000 events per account and drop the oldest without notice. Clients can only
  detect the loss through a gap in `accountSeq`.
- **Mitigation needed:** retention and archiving; an explicit gap marker.
- **Dependency (recorded in Milestone 10):** the engine's client-ID index is what prevents a second
  execution once an idempotency-ledger entry has been evicted (A-4). Any retention fix for VR-13 must
  keep a permanent, recoverable client-ID index.
- **Test:** none (operational).

### VR-14: Opaque IDs rest entirely on the secrecy of the ID key; fixtures use a constant — **Low, Resolved in Milestone 10 (policy); key management open**

- **Rule:** H-8.
- **Evidence:** with the fixture key `local-prototype-key`, an order ID maps straight back to the
  global sequence number.
- **Mitigation:** the key must be a managed secret per deployment. The fixture key is acceptable
  only for synthetic, local use.
- **Test:** `privacy-review.test.ts` "VR-14 …". It still demonstrates the dependency on the key.
- **Resolution (Milestone 10):** rule A-5.
  - `Venue` and `Venue.recover` refuse keys that are short, outside the base64url alphabet or of low
    diversity.
  - They refuse the registered fixture keys unless `allowTestFixtureIdKey: true` is passed.
  - Fixture literals are confined to `id-key.ts` and tests (static check).
  - **Still open:** rotation, storage and distribution of the key; verification of its randomness.
    The engine itself does not enforce the policy.
  - [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §3, §6.

### VR-15: Timing side channel from hidden-only price levels — **Low, Open**

- **Rule:** THREAT-MODEL T-H7.
- **Evidence:** inserting a new displayed price level shifts a sorted array that includes
  hidden-only levels. Engine-path median latency is about **3 µs with 0 hidden-only levels against
  about 10–11 µs with 50 000** (`npm run venue:perf`, 5 rounds, two runs; PERFORMANCE-RESULTS §4).
- **Through the gateway path** (about 150–245 µs per call) the two runs disagree. In the first, the
  round medians overlapped. In the evidence run they separated: every 50 000-level round (207–245
  µs) was slower than every 0-level round (158–205 µs). Treat the channel as plausibly observable end
  to end. It is neither established as reliably exploitable nor ruled out.
- **Mitigation:**
  - an array indexed by tick offset (constant-time insert)
  - batched or fixed-latency acknowledgements
- **Test:** measurement only. Timing assertions would be flaky in CI.

### VR-16: No isolation inside the process — **Info, Open (design)**

TypeScript `private` is a compile-time annotation. Any code holding the gateway object can reach
the venue and the full hidden book (PRIVACY-REVIEW C, tested).

### VR-17: Journal and snapshots hold hidden orders in plaintext — **Info, Open (design)**

There is no encryption at rest (PRIVACY-REVIEW E, tested).

### VR-18: Poison command — **Low, Partially mitigated**

- **Evidence:** a command that faults deterministically also faults on every replay, so recovery
  cannot complete.
- **Mitigation:** recovery now reports the faulting sequence number. An operator runbook (quarantine
  procedure, a reviewed skip) is still needed.
- **Test:** `crash-recovery.test.ts` "VR-18 …".

### VR-19: Order queries served half-applied state after a fault — **Medium, Resolved**

- **Rule:** D-3. The requirement "externally visible results cannot get ahead of committed state".
- **Evidence:** this was found while reviewing the VR-01 fix. A fault in the middle of a command
  leaves the in-memory engine partly changed. `gateway.order` and `openOrders` still read it.
- **Reproduction:**
  1. Account A rests a sell order.
  2. Make `BookSide.remove` throw.
  3. Account B sends a crossing buy order.

  Afterwards, both orders were reported as `status: "new"` with `filledLots: 10, leavesLots: 0`.
  That is inconsistent, and it was never committed.
- **Fix:** while the venue is stopped, order and open-order queries throw `VenueUnavailableError`.
  `events` stays readable, because outboxes only hold outputs of fully processed commands.
- **Regression test:** `verification.test.ts` "VR-19 …". On the original commit this test fails at
  its first assertion, because `outcome-unknown` did not exist yet (VR-01).

### VR-20: A failure while routing outputs after the commit was reported as "nothing recorded" — **Low (latent), Resolved**

- **Rule:** D-3, A-4 (`unavailable` must mean "nothing was recorded").
- **Evidence:** this was found in the review of the Milestone 9 working tree. `Venue.submit` called
  `route()` outside any guard. Since VR-02 no listener can throw there, but any other exception
  would escape after the commit. The gateway then maps it to `unavailable` ("Nothing was
  recorded"), which is false: the command is journaled and executes on recovery.
- **Reproduction:** make `route` throw once, then submit. Before the fix, the venue kept running and
  the gateway answered `unavailable`.
- **Fix:** a routing failure stops the venue and raises `OutcomeUnknownError`.
- **Regression tests:** `crash-recovery.test.ts`, the two "VR-20 …" tests.

### VR-21: Recovery accepted journal text and a store together — **Low, Resolved**

- **Rule:** D-2.
- **Evidence:** `Venue.recover(options, text)` with `options.store` set built state from the text,
  but appended later commands to the store. The two records could then disagree.
- **Fix:** passing both is refused.
- **Regression test:** `crash-recovery.test.ts` "VR-21 …".

### VR-22: A recovery that failed could already have changed the store — **Low, Resolved**

- **Rule:** D-2.
- **Evidence:** the torn-tail truncation and newline repair ran before the snapshot check and the
  replay. A recovery that then failed (bad snapshot, poison command) had already changed the store.
  The change itself was harmless (a torn tail is never committed), but a failed recovery should
  leave the evidence as it found it.
- **Fix:** the store is repaired only after the journal, the snapshot and the whole replay succeed.
- **Regression test:** `crash-recovery.test.ts` "VR-22 …": the store is byte-identical after both
  failure modes, and repaired after a later successful recovery.

### VR-23: Test-only crash hooks were part of the public options — **Info, Resolved**

- **Evidence:** `VenueOptions.crashHooks` let any caller inject a simulated process death.
- **Fix:** removed. Crash simulation is a `protected` no-op method, `boundary`, which only a test
  subclass (`CrashingVenue` in `crash-recovery.test.ts`) overrides.
- **Regression test:** `crash-recovery.test.ts` "VR-23 …". It checks at type level
  (`@ts-expect-error`) and at runtime that an options object carrying hooks has no effect. The
  150-case crash property now runs through the subclass.

### Observations that are not verified defects

- **Rate limiter cost:** `WindowLimiter` keeps one timestamp per hit within the window. With very
  high configured limits (the benchmarks use 10⁹), cost per call grows with the window's contents.
  This is not measured in isolation. At the default limits the list is bounded by the limit (200).
- **Session table:** `openSession` is unbounded. It is an operator-side call; no unauthenticated
  path creates sessions.
- **RFQ recipient permissions:** the venue prototype has no RFQ. The application's RFQ desk was
  verified in earlier milestones (`src/core/rfq/desk.test.ts`; E2E scenario 10), and those tests
  pass in this run.

## 4. Rule-by-rule audit (Phase B)

The table maps each rule in MATCHING-RULES.md to its implementation and its tests ("files": test
files whose test names cite the rule). "OK" means behaviour matches the text after the fixes above.

| Rule | Implementation | Test files | Verdict |
|---|---|---|---|
| I-1 exact units | `instrument.ts` parseScaled, priceToTicks, quantityToLots | adversarial, properties, verification | OK. Integer boundaries added (VR tests). |
| I-2 price range and band | `engine.checkPrice`, reference price = last trade | engine | OK |
| I-3 quantity range | `engine.newOrder`, `replace` | engine | OK |
| M-1 matching on arrival | `newOrder` → `plan`/`execute` | engine | OK |
| M-2 maker price | `fill` uses maker price | engine, properties | OK |
| M-3 price priority | `BookSide.bestFirst` | engine, properties | OK |
| M-4 displayed before hidden | `plan` iterates displayed, then hidden | engine, properties | OK. Mutation-tested in M8. |
| M-5 time priority | Map insertion order, `priority` = seq | engine, properties, verification | OK, including commands with the same timestamp |
| M-6 never crossed | consequence of M-1 | properties, reconcile | OK |
| M-7 GTC / IOC remainders | `settleTaker` | engine, verification | OK, including the empty book |
| M-8 FOK atomic | plan, then apply | engine | OK. Free absence probe: VR-08. |
| M-9 market orders | `collar` | engine, verification | OK, including clamping to the range and insufficient liquidity |
| M-10 post-only | `crossesBest` | engine, verification | OK. A refused replace leaves the order unchanged. |
| F-1 partial fills | `fill` reduce in place | engine, verification | OK, including multi-level sweeps |
| F-2 fill reports | `fill` emits maker and taker | engine, verification (feeds vs executions) | OK |
| P-1 cancel | `resolve` scoped to account | adversarial, engine, privacy-review, verification | OK, including late and repeated cancels |
| P-2 replace priority | `replace` retain rule | engine, verification | OK, including a repeated replace being a no-op |
| P-3 total quantity | `replace` | engine, verification | OK, including a stale client view |
| P-4 crossing replace | `replace` → plan | engine | OK |
| P-5 mass cancel | `massCancel` | engine | OK |
| S-1…S-3 STP | `plan` | engine, verification | OK |
| H-1 concealment | `flush`, separate `publicSeq` | adversarial, demo, privacy-review, properties | OK for hidden orders that do not trade. Residuals in PRIVACY-REVIEW. |
| H-2 engine visibility | `inspectBook` | engine | OK, by design |
| H-3 / H-4 priority and interaction | `plan` | engine, properties | OK |
| H-5 disclosure | aggregated prints | adversarial, privacy-review, properties | OK. Inference residual documented. |
| H-6 eligibility | `newOrder`, `replace` | engine | OK |
| H-7 probe throttle | gateway | adversarial, privacy-review | **Was bypassable (VR-03).** OK after the fix. |
| H-8 opaque IDs and sequences | `opaqueId`, `accountSeq` | adversarial, privacy-review, properties | OK while the key is secret (VR-14) |
| H-9 batched publication | `flush` on `publish` | adversarial | OK. Text corrected (VR-12). |
| R-1 pre-trade risk | `checkRisk` | engine, verification | OK, including on replace (new test) |
| R-2 halt / R-3 suspension | `dispatch` | engine | OK |
| D-1 determinism | engine has no clock or randomness | crash-recovery, demo, properties, recovery | OK |
| D-2 journal integrity | `readJournal`, store | crash-recovery, recovery | OK, after VR-05 and VR-07. Not tamper-proof (§5). |
| D-3 fail-stop | `process`, `Venue.submit` | recovery, verification | **Was defective (VR-01).** OK after the fix. |
| D-4 de-duplication | sequence numbers | crash-recovery, recovery | OK |
| A-1 authentication | session map, strict schema | adversarial, privacy-review, verification | OK, including oversized and malformed payloads |
| A-2 separation | strict public schema, outbox routing | properties, verification | OK, including feeds checked against executions per command |
| A-3 rate limit | `WindowLimiter` by account | adversarial, verification | OK. Reconnect does not bypass. Log bounded (VR-04). |
| A-4 idempotency | gateway | adversarial, properties, verification | OK after VR-06. Not durable (VR-09). |

The specification adds no semantics in this milestone. The new `outcome-unknown` answer and the
storage boundary are documented in MATCHING-RULES (D-2, D-3, A-4) and ARCHITECTURE §12 as explicit
changes.

## 5. What the hash chain does and does not protect against

| Threat | Protected? | Why |
|---|---|---|
| Accidental corruption, bit flips, a torn write | **Detected** | The entry hash and schema re-validation fail. A torn tail is dropped. |
| Editing, reordering, inserting or deleting one entry in the middle | **Detected** | The chain breaks at the first changed entry (tested) |
| Truncating the end of the journal | **Not detected** on its own | The shorter journal is a valid prefix. It is detectable only against a head hash recorded elsewhere. |
| Rewriting the whole chain from any point | **Not detected** on its own | Anyone who can write the journal can recompute every later hash (tested). It is detectable only against an **independently protected anchor**, which does not exist here. |
| Substituting a snapshot | **Detected** only if not re-hashed | The snapshot `stateHash` and the journal-head binding catch naive edits. A writer who recomputes both is not caught. |
| Confidentiality | **None** | The journal is plaintext |

**The storage is therefore tamper-evident only relative to a trusted anchor, and that anchor is not
provided.** It must not be described as tamper-proof.

## 6. Checks after the changes

These are the final results. Logs are in `docs/venue/verification/final/`.

| Check | Result |
|---|---|
| Venue tests | 142 passed (9 files): 83 existing + 59 new |
| Full unit suite | 519 passed (45 files) |
| Typecheck / lint / build / bundle scan | pass / pass / pass / clean |
| E2E | 52 passed |
| Demo | reconciliation OK; hashes match. The seeded run journals 5 194 commands, against 5 195 at baseline, with one more `rate-limited` refusal: a replace of a post-only order is now throttled (VR-03). This is an intended change. |
| Benchmarks | `npm run venue:perf -- 1 3`, re-run on the final code with nothing else running (PERFORMANCE-RESULTS.md; `perf-run.log`) |

## 7. Unresolved findings for review

- **High:** none open. VR-01 is resolved.
- **Medium:** none open. VR-02, VR-03, VR-04, VR-05, VR-07 and VR-19 are resolved.
- **Resolved in the review follow-up:** VR-20, VR-21 and VR-22 (Low) and VR-23 (Info).
- **Resolved in Milestone 10:** VR-09 and VR-10 (Low). VR-14 (Low) is resolved as a policy; key management stays open.
- **Low, open:** VR-08 and VR-15. VR-13 and VR-18 are partly mitigated in Milestone 11 (Venue) (§9).
- **Info:** VR-16 and VR-17 (design).

These are not findings against the specification, but they remain the highest risks of the design
as a whole:

- **No real authentication.** Sessions are local tokens.
- **Durability is unverified.** Only the in-memory stores have been tested. That includes the idempotency ledger, which is as durable as the journal it is rebuilt from, and the commit-record store, whose independence from the journal store is modelled, not real.
- **No trust anchor.** The hash chain has no independently protected anchor.
- **The operator and the process can read all hidden orders**, which are also stored in plaintext.

Any use beyond a synthetic local prototype needs the independent reviews listed in
[SECURITY-CHECKLIST.md](SECURITY-CHECKLIST.md) §B.

## 8. Milestone 10: recovery integrity and idempotency

**Scope:** VR-09, VR-10 and VR-14 only. Specification and detailed results:
[RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md). `src/venue/engine.ts` is unchanged (`git diff 27dee34
-- src/venue/engine.ts` is empty).

**Verdict for this milestone:** verified with limitations. VR-09, VR-10 and VR-14 are resolved within
the tested scope. So are the four findings of the read-only review of this milestone (VR-24 to
VR-27) and the two pre-existing defects found by the final read-only review (VR-28, VR-29;
RECOVERY-INTEGRITY §7). The open items are listed below. The venue remains a synthetic, local
prototype and is not deployable.

### Evidence

- **Tests written first.** `recovery-integrity.test.ts` (30 tests) was written before the
  implementation; `recovery-review.test.ts` (16 tests) was written before the review fixes.
- **Against `27dee34`:** 41 of the 46 failed and 5 passed; the 5 that pass pin unchanged behaviour.
  The 41 failures break down as:
  - **18 behaviour:** VR-09 (6), VR-14 (10), and the no-newline duplicate silently dropped by
    `27dee34` (2)
  - **14 classification only:** `27dee34` already refused those journals, with a generic message
  - **9 new mechanism:** the ledger or its capacity does not exist in `27dee34`

  Log: `docs/venue/verification/m10-tests-against-27dee34.log`.
- **Against the unfixed Milestone 10 tree:** the 16 review tests gave 12 failed, 4 passed:
  - VR-24 silent drop (5)
  - VR-27 messages (4)
  - VR-25 (2)
  - VR-26 (1)

  Log: `docs/venue/verification/m10-review-fixes.log`.
- **Against the tree before the final-review fixes:** the 19 tests in `recovery-final.test.ts` gave
  15 failed, 4 passed:
  - VR-28: a complete but invalid final line without a newline dropped as a torn write (11)
  - VR-29: shared event objects between consumers (4)
  - The 4 that pass pin behaviour that was already correct: genuine torn tails, malformed lines with
    a newline, and two terminal-order eviction tests that close a coverage gap.

  Log: `docs/venue/verification/m10-final-review-fixes.log`.
- **Key properties hold after the change:**
  - Idempotency property: 150 runs with restarts, snapshots, storage faults and retries, at least
    300 retry checks per run. No accepted order is journaled or executed twice.
  - The crash-boundary property (150 runs, five boundaries) passes unchanged.
- **Existing tests changed:**
  - Fixture-key call sites now pass `allowTestFixtureIdKey: true`, with their assertions unchanged.
  - One H-8 test now uses generated strong keys.
  - The Milestone 9 VR-10 test asserted a generic refusal. It now asserts the specific D-5 refusal,
    the store left untouched, and the interior case.
  - Three D-5 tests from the first Milestone 10 version asserted drop-and-report. After VR-24 they
    assert refusal. No assertion was removed or loosened.

### Checks

Logs are in `docs/venue/verification/m10-final/`.

| Check | Result |
|---|---|
| Venue tests | 207 passed (12 files) |
| Full unit suite | 584 passed (48 files) |
| Typecheck / lint / build / bundle scan | pass / pass / pass / clean |
| E2E | 52 passed. The log contains Node warnings about `NO_COLOR` being ignored, caused by setting both colour variables for log capture; the Milestone 9 log has the same. It also contains a web-server line "Venue request failed (network)": the app's live adapter has no outbound network in this sandbox; the Milestone 9 log has it too. |
| Demo | reconciliation OK; state and output hashes identical to Milestone 9 (`a11cdf37…`, `54733390…`) |

### Benchmarks

Measured as an alternating A/B against `27dee34` in one session (PERFORMANCE-RESULTS §6). The
reportable differences:

- Recovery replay is about 15 % slower, consistent with recording ledger entries.
- Gateway entry is about 9 % faster.
- Immediate publication moved −12 %. This is unexplained and not treated as a measured regression.
- Everything else is within the noise floor. Code identical in both versions moved 7 %.
- **Review fixes** (PERFORMANCE-RESULTS §7): inconclusive. Code identical in both versions moved
  +14 % with non-overlapping ranges, and the order-entry scenarios disagree in sign (F2 +9 %, F3–F5
  −11 % to −20 %). No regression or improvement is established. Recovery showed no change beyond the
  noise floor in that session.
- **Final-review fixes:** the per-event freeze added for VR-29 was not benchmarked.

### Review findings (VR-24 to VR-29)

| ID | Severity | Status | Summary |
|---|---|---|---|
| VR-24 | Medium | Resolved | The first D-5 version dropped a trailing duplicate, so a store that acknowledged an append but persisted the previous entry again silently lost an acknowledged, published order. D-5 is now fail-closed. |
| VR-25 | Low | Resolved | Ledger records, replays and snapshots shared mutable event objects. Records are now deep-frozen copies, and each replay returns a fresh copy. |
| VR-26 | Low | Resolved | The ledger after a restart depended on the capacity in use at recovery. Snapshots now record and verify their capacity, and full-replay behaviour under a changed capacity is defined (responses only, never execution). |
| VR-27 | Info | Resolved | Refusal messages were inaccurate. They now name the duplicate of the last entry, a copy of an earlier entry, or an empty line. |
| VR-28 | Medium | Resolved | Pre-existing since Milestone 8. `readJournal` dropped *any* invalid final line without a newline as a torn write, including a complete line that parses but fails validation, so a corrupted acknowledged entry was silently discarded. Only an unparseable final line is now treated as torn; a parseable invalid line is refused. This does **not** detect an acknowledged entry that a non-conforming store truncated or lost. |
| VR-29 | Low | Resolved | Pre-existing since Milestone 8. The first response, the private feed, the public tape and every public listener shared event objects (and a `request-rejected` event shared the journaled command's `ref`), so one consumer could change what another observed. `Venue.route` now deep-freezes every routed event and public message; `engine.ts` unchanged. |

### Open after Milestone 10

- **From Milestone 9:** VR-08 (FOK absence probe), VR-13 (unbounded growth), VR-15 (timing channel)
  and VR-18 (poison-command runbook). VR-16 and VR-17 remain open by design.
- **Id-key management:** generation in deployment, storage and rotation. Key randomness cannot be
  verified, and the engine does not enforce the policy.
- **Ledger:** after eviction, identical and conflicting retries get the same `duplicate-client-order-id`
  answer, and each is journaled. Its snapshot hash is not tamper-proof without an independent anchor,
  and it is only as durable as the in-memory store tested here.
- **Client-ID index dependency:** no double execution after eviction rests on the engine's permanent
  client-ID index. That index is part of the unbounded growth in VR-13, and must be kept by any VR-13
  fix.
- **Duplicate journal records:** fail-closed, so availability depends on an operator. Safe automatic
  repair needs an independently persisted commit record or trust anchor.
- **Torn-tail assumption:** an unparseable final line is dropped as uncommitted. This assumes the
  store never acknowledges a write before it is durable. In a store that does, an acknowledged entry
  that is truncated mid-line or missing entirely is not detected (VR-28 does not change this).
- **Output immutability scope:** routed events and public messages are frozen (VR-29). Execution
  records and the venue's own arrays (`executions`, `publicTape`, outboxes) are reachable, mutable,
  through the in-process `Venue` object.

## 9. Milestone 11 (Venue): durability protocol, retention and poison diagnostics

**Scope:** three workstreams.

- **A:** a commit record in a separate store, recovery split into verify and repair phases, offline
  migration.
- **B:** retention with exact gap reporting.
- **C:** poison-command diagnostics and rules-version compatibility.

Design and results: [DURABILITY-PROTOCOL.md](DURABILITY-PROTOCOL.md). `src/venue/engine.ts` is
unchanged (`git diff 9812049 -- src/venue/engine.ts` is empty). D-5 stays fail-closed.

**Verdict for this milestone:** verified with limitations, within the tested scope, for the in-memory
prototype. The venue remains a synthetic, local prototype and is not deployable.

### Evidence

- **Tests written first** (94 new across six files; one Milestone 9 test changed). Against `9812049`:
  - four suites cannot load (the commit-record module does not exist);
  - the remaining runs gave **16 failed and 13 passed**:
    - retention behaviour: unbounded audit stores, no `eventsPage`, no history reporting, no
      head-only mode;
    - all seven retry-semantics tests, which need the commit-record store;
    - the changed VR-18 test: the old message echoes the raw engine fault.
  - The 13 that pass pin unchanged behaviour.

  After the change all **106** pass. Log: `docs/venue/verification/m11-tests-against-9812049.log`.
- **Properties:**
  - crash-boundary property with commit records: 9 boundaries, 150 runs;
  - repair-convergence property: up to five random repair faults, 150 runs;
  - the Milestone 9 crash-boundary property and the Milestone 10 idempotency property, unchanged.
- **Existing tests changed:** two.
  - `crash-recovery` "VR-18 …" now requires that the message does **not** contain the raw engine
    message and that `cause` does.
  - `recovery-integrity` "A-4 property …" runs 300 cases instead of 150. Unseeded, its coverage floor
    (more than 300 retry checks) was missed in 2 of 25 runs on `9812049` and on this tree alike; with
    300 cases, 0 of 25. The seed, the assertions and the floor are unchanged
    (`m11-final-review.log`).

  The rest of the Milestone 9 and 10 suites pass unmodified.

### Checks

Logs are in `docs/venue/verification/m11-final/`.

| Check | Result |
|---|---|
| Venue tests | 311 passed (18 files) |
| Full unit suite | 688 passed (54 files) |
| Typecheck / lint / build / bundle scan | pass / pass / pass / clean |
| E2E | 52 passed. The same benign `NO_COLOR` and "Venue request failed (network)" lines as in Milestones 9 and 10 (no outbound network in this sandbox). |
| Demo | reconciliation OK; state and output hashes identical to Milestones 9 and 10 (`a11cdf37…`, `54733390…`) |
| Memory probe (F8) | PERFORMANCE-RESULTS §8 |

### Findings and design changes during implementation

| ID | Severity | Status | Summary |
|---|---|---|---|
| VR-30 | Medium | Resolved (design) | Without a commit record, a committed entry that a non-conforming store loses or truncates is indistinguishable from an uncommitted torn write. With a commit-record store, recovery refuses (F4). Correlated loss in both stores remains undetected. |
| VR-31 | Low | Resolved | A repair step could report success while the store did not apply it: a partial or overshooting truncation, or a lost record write. Each step is now read back. An overshoot into uncommitted data is caught before the record is advanced over it. |
| VR-32 | Info | Documented | A lost record write followed by exactly one more write is refused (F2-stale). Followed by two or more, the later record covers the entry and it is not detected. That is harmless, but it corrects the earlier design table. |
| VR-33 | Low | Resolved | The replay-fault message echoed the raw engine error, which can carry order data. The message is now fixed-format, and the error is kept as `cause` only. |
| VR-34 | Low | Resolved (final review) | A migration re-run overwrote any torn residue that was a strict prefix of its intended record. A residue shorter than the checksum is a prefix of every approval's record for that seq, so it identified no approval. The residue must now contain the full checksum. The test fails against the earlier rule (`m11-final-review.log`). |

**Final correctness review:** six confirmation tests in `commit-record.test.ts` and four in
`migration.test.ts`:

- a lost record write healed by two or three later writes: the record binds the complete journal
  prefix (shortened journal: F4; rewritten history with recomputed hashes: F5);
- every refusal code checked against a write trap: zero mutating calls;
- repair read-back catches a silent truncation no-op, a lost newline append and a lost record write;
- a migration approval is bound to the complete history (fork refused both ways);
- a completed migration refuses retries under other approvals, and refuses once the venue has run.

### Open after Milestone 11 (Venue)

- **Storage:**
  - no atomic update across the two stores;
  - correlated loss or consistent rollback of both stores is undetected;
  - a corrupted newest slot looks like a torn write;
  - both stores are in memory, so real independence, fsync and group commit are unverified;
  - no external trust anchor.
- **Clients:**
  - cancel, replace and mass cancel are not request-idempotent (mass cancel not even
    effect-idempotent);
  - there is no position or fill-history query to recover fills lost in an outbox gap.
- **VR-13 (partly open):** engine orders and the permanent client-ID index grow without bound by
  design; bounding them needs a durable archive.
- **VR-18 (partly open):** diagnostics and a runbook exist; a poison command still keeps the venue
  down. Skipping is deliberately absent.
- **Migration:** the operator approval is unauthenticated, and the backup is caller-supplied.
- **Still open:** VR-08, VR-15, VR-16, VR-17, and id-key management.
