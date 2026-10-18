# Nova Venue — Durability Detection, Poison-Command Quarantine and Retention (Milestone 11)

**Status:** approved plan (decisions D1–D8, below), implemented with regression tests written first, and
verified (§6). Baseline: Milestone 10, commit `9812049`.

**Scope:** four work packages, in this order:

| WP | Risk | Rule | Within the in-memory prototype | Needs durable storage or wider architecture |
|---|---|---|---|---|
| 1 | Acknowledged journal entries truncated or lost by a non-conforming store | D-6 | Commit anchor, ordering, recovery refusals, operator bootstrap | A physically independent anchor (separate device/failure domain, write-once storage, external timestamping); group commit |
| 2 | VR-18 poison command | D-7 | Journaled, final-entry-only quarantine; resubmission block; runbook | Authenticated, four-eyes operator approval (T-O3) |
| 3 | VR-13 growth and private-event retention | A-6 | Explicit gap marker; optional audit caps; permanent client-ID index | Durable client-ID index and order archive; journal compaction |
| 4 | VR-08 free FOK absence probe | H-7, M-8 | Per-account unfilled-FOK budget | Cross-account (Sybil) surveillance |

**Not in scope (D8):** VR-15 and the `publicBook()` hidden-liquidity timing channel move to Milestone 12.
The matching-book structure (`book.ts`) and the matching path are unchanged.

**Constraints:** everything stays local and synthetic: no network, no file system, no live trading, no
deployment.

## Founder decisions

| # | Decision |
|---|---|
| D1 | Journal append → anchor write → process. If either write fails: fail-stop, `outcome-unknown`. In-memory anchors are for prototype integrity detection, not proof of physical durability. |
| D2 | Missing or inconsistent anchors refuse recovery by default. Existing journals need an explicit operator bootstrap with integrity verification and an audit record. |
| D3 | No automatic repair: duplicate and conflicting journal entries stay fail-closed (D-5). |
| D4 | Quarantine only the final valid entry, with matching hash and a reproducible fault, with evidence that it produced no externally acknowledged execution, fill or irreversible downstream effect. Journal the decision; keep replay deterministic; refuse unsafe or ambiguous cases; document the journal-schema change. |
| D5 | `approvedBy` is free-text metadata for the prototype only, never described as authenticated approval. |
| D6 | Separate configurable failed-FOK limiter, 20 per account per 60 s; count every unfilled FOK; idempotent retries unaffected; reconnects do not reset it. |
| D7 | Audit caps optional and disabled by default. Unbounded compact client-ID index growth accepted for the prototype; never trim client-ID deduplication or break terminal-order lookup; signal private-event gaps explicitly. Long-term: a durable client-ID index and order archive, not a bounded client-ID validity window. |
| D8 | VR-15 and the `publicBook()` channel move to Milestone 12. |

## 1. Commit anchor (WP1, rule D-6)

**Problem.** The journal alone cannot tell an acknowledged entry that a non-conforming store later
truncated (it looks like a torn write and was dropped) or lost entirely (a valid, shorter journal) from a
genuine crash. RECOVERY-INTEGRITY §2 named the missing piece: an independently persisted commit record.

**Design.**

- `CommitAnchorStore` (`storage.ts`) holds one record, `canonicalJson({ seq, hash })`, of the last committed
  entry. `MemoryAnchorStore` is the only implementation, with injected faults (`before-write`,
  `torn-write`, `after-write`).
- `Venue.submit`: journal append → **anchor write** → process. Both writes together are the commit point.
  Either failure stops the venue with `outcome-unknown` before the engine sees the command.
- `Venue.recover` reads the journal as before (every D-2 and D-5 check unchanged and first), then checks the
  anchor **before replaying or repairing anything**:

| Situation | Result |
|---|---|
| Anchor seq ≤ journal length, hash equal | Accepted. Complete entries after it are applied (their client got `outcome-unknown`); an unparseable final line after it is dropped (D-2). |
| Journal ends before the anchored seq | **Refused**: `journal is missing anchored entries: commit anchor at seq A, journal ends at seq N` |
| The anchored entry is the incomplete final line | **Refused**: `anchored entry seq A is truncated` — never dropped as torn |
| Hash at the anchored seq differs | **Refused** |
| No anchor, non-empty journal | **Refused** (bootstrap required) |
| Anchor unreadable or invalid (e.g. a torn anchor write) | **Refused** (bootstrap required) |
| No anchor, empty journal | Fresh start |

- A store-backed `Venue` (or recovery) **without** an anchor store is refused unless `allowUnanchored: true`
  is passed explicitly. That is the Milestone 10 behaviour; tests that hand-build journals to exercise the
  reader use it, and say so.
- A fresh anchored `Venue` refuses a store or anchor that already holds data (use `Venue.recover`).

**Bootstrap (D2).** `Venue.recover(options, undefined, undefined, { bootstrapAnchor: { reason, approvedBy } })`:

- allowed only when the anchor is **missing or unreadable**, never when a readable anchor exists;
- requires a full verified replay (no snapshot) of a non-empty journal;
- journals an `admin.anchor-bootstrap { seq, hash, prior, reason, approvedBy }` audit record through the
  normal commit path, which writes the first anchor. The record changes no engine state.
- If the record's commit fails, nothing is anchored yet; the operator repeats the bootstrap.

Runbook: [runbooks/ANCHOR-BOOTSTRAP.md](runbooks/ANCHOR-BOOTSTRAP.md).

**What it is not.** In memory, the anchor detects faults of a store that breaks its contract. It is not
evidence of physical durability, and an insider who can rewrite both stores is not detected (VERIFICATION-REPORT
§5; T-O2).

## 2. Poison-command quarantine (WP2, VR-18, rule D-7)

**Problem.** A command that faults deterministically is journaled (fail-stop, D-3) and faults again on
every replay: recovery can never complete. Milestone 9 only named its sequence number.

**Request.** `Venue.recover(options, …, { quarantine: { seq, hash, reason, approvedBy, suspendAccount, evidence } })`,
where `evidence = { clientOutcome: "outcome-unknown" | "no-response", sameEngineBuild: true,
observedPublicSeq, observedAccountSeqs, notes }`.

**Preconditions (all required; any failure refuses with both stores untouched):**

1. The entry is the **final** valid journal entry. Under fail-stop a live fault is always the last entry,
   because nothing is journaled after it. A fault in the middle of the journal means replay is not
   deterministic (for example a code or runtime change) and is never quarantined: restore the build that
   wrote the journal.
2. Its hash matches. It is not itself an operator record. It is not already quarantined.
3. **The fault reproduces**, on a scratch engine restored from the state just before the entry, so the
   venue's own engine is never left half-applied.
4. **No externally acknowledged effect.**
   - The client outcome attested is not a success.
   - The same engine build is attested; with D-1, a reproducible fault on the same build means the live
     processing faulted too, so it produced no outputs.
   - `observedPublicSeq` and every `observedAccountSeqs` value, which are what downstream consumers actually
     saw, must not exceed the public and per-account sequences that existed before the entry. The submitting
     account must be included. A consumer that saw more means the command produced output: refused.
5. No snapshot includes the entry. A snapshot taken *at* a quarantined entry is refused as ambiguous.
6. `suspendAccount` only for an account-scoped command.

**Effect.**

- The entry is **voided** (`MatchingEngine.voidEntry`): no state change except the sequence and clock. The
  submitter gets a definitive answer:
  - new order: `rejected` with reason `quarantined` (the client order id is not consumed);
  - cancel or replace: `request-rejected` with reason `quarantined`;
  - anything else: an admin error.
- The decision is journaled immediately after it as `admin.quarantine` (anchored). Every later replay (full,
  snapshot + suffix, or a replica replaying text) voids the same entry without operator input. A quarantine
  record that does not reference the entry immediately before it, with its hash, is refused as corruption.
- The identical command is refused before journaling from then on (`QuarantinedCommandError`; gateway code
  `quarantined`). `suspendAccount` suspends the account in the same record.
- **Operator records are written only by `Venue.recover`.** `Venue.submit` refuses `admin.quarantine` and
  `admin.anchor-bootstrap`. Without this, code holding the venue could journal a quarantine of an entry that
  was already processed and acknowledged, and every later replay would void it (VR-30, found and fixed during
  implementation).
- A crash while journaling the record is safe. If the record was lost (torn), repeat the quarantine. If it
  was written, plain recovery applies it, and a repeated request is refused as "already quarantined".

**Journal-schema compatibility.** `admin.quarantine` and `admin.anchor-bootstrap` are new command types.

- A Milestone 10 reader refuses a journal containing them (`invalid command`; verified,
  `verification/m11/journal-compatibility.log`).
- A journal without them is unchanged and read by both versions. A Milestone 10 journal recovers under
  Milestone 11 with identical state and output hashes (verified).

Runbook: [runbooks/POISON-COMMAND.md](runbooks/POISON-COMMAND.md).

## 3. Retention (WP3, VR-13, rule A-6)

- **Private-event gaps are explicit.** `Venue.privateEventsPage(accountId, after)` and
  `gateway.eventsPage(token, after)` return `{ events, firstAvailableAccountSeq, latestAccountSeq, gap }`.
  - `gap` is true when events after the cursor are not retained: outbox overflow, or a restore from a
    snapshot (only replayed events are in the outbox).
  - `latestAccountSeq` is taken from the snapshot on restore and from routed events afterwards.
  - The old `events()` / `privateEvents()` readers are unchanged (and silent).
- **Optional audit caps** (`VenueOptions.auditRetention`, disabled by default):
  - Covers `executions`, `transitions`, `publicTape` and `adminErrors`.
  - Oldest records are dropped in batches; a store holds at most cap + max(1, ⌊cap/8⌋) records.
  - Every eviction is counted in `auditEvicted`, and `historyComplete` becomes false, so `reconcile` skips its
    history checks.
  - Full reconciliation is a journal replay without caps (tested).
  - Caps never change trading state, outputs, the idempotency ledger or the client-ID index (tested).
- **Never trimmed:** the engine's client-ID index and terminal orders. With every retention option at its
  minimum, identical and conflicting retries of evicted filled and cancelled orders are refused as
  duplicates, no second execution occurs, and lookup by client order id returns the terminal order — live,
  after a full replay and after a snapshot restore (tested).
- **Measured** (`npm run venue:memory`, one configuration per process; `verification/m11/memory-probe.log`):
  - About 2 825 B of heap per accepted order with defaults, and about 2 363 B with every audit cap at 1 000
    (−16 %).
  - The in-memory copy of the journal is about 314 B per entry (≈ 13 %). It is not dominant, so the journal
    API was left unchanged.
  - The remainder (orders, client-ID index, in-heap store text, idempotency ledger up to its capacity) grows
    with every accepted order. That is accepted for the prototype (D7); the long-term fix is a durable
    client-ID index and order archive.

## 4. Unfilled-FOK budget (WP4, VR-08, rules H-7, M-8)

- Every new-order FOK (limit or market) that ends `cancelled: fok-unfilled` counts toward a per-account
  sliding window (`GatewayOptions.fokUnfilled`, default **20 per 60 s**). The window is separate from the
  post-only budget.
- While exhausted, **new FOK orders** are refused with `rate-limited`, before journaling. That includes ones
  that would fill: the check precedes the sequencer.
- Keyed by account, so reconnecting does not reset it.
- An identical retry of an accepted FOK is still answered from the idempotency ledger. The ledger lookup
  comes before the throttle; a conflicting retry is still `idempotency-conflict`.
- Counting depends only on the caller's own visible outcome. An unfilled FOK against hidden liquidity and one
  against an empty book exhaust the budget identically (tested), so the throttle reveals nothing new.
- **Residual:** within the budget the first probes are still free; Sybil accounts multiply the budget; the
  planning walk's duration still depends on the levels it passes (VR-15, Milestone 12).

## 5. Unchanged contracts

- D-1 determinism, D-2 journal integrity (only refusals added), D-3 fail-stop (quarantine is the documented,
  operator-only exception for the final faulted entry), D-4 output de-duplication, D-5 fail-closed duplicates.
- A-4 idempotency: never executed twice (property, now with anchoring). A-5 id-key policy.
- VR-29 frozen outputs.
- The matching book and matching path. The engine changed only additively:
  - `voidEntry`;
  - handling of the two operator record types, as a no-op and as an optional suspension;
  - the `quarantined` reject reason.
- Demo state and output hashes are identical to Milestones 9 and 10 (`a11cdf37…`, `54733390…`).

## 6. Verification

**Tests written first** (logs in `docs/venue/verification/m11/`):

| WP | File | Before the implementation | After |
|---|---|---|---|
| 1 | `durability-anchor.test.ts` | 32 of 32 failed against `9812049` | pass |
| 2 | `poison-quarantine.test.ts` | 10 of 11 failed (the one that passed pins the unchanged VR-18 stop) | pass |
| 2 | VR-30 regression (same file) | failed against the first WP2 implementation (observed in the development run; no separate log) | pass |
| 3 | `retention.test.ts` | 6 of 7 failed (the one that passed pins the unchanged A-4 guarantee under minimum retention) | pass |
| 4 | `fok-budget.test.ts` | 5 of 6 failed (the one that passed pins the unchanged ledger replay) | pass |

**Existing tests changed** (assertions unchanged unless stated):

1. Tests that recover from or write to a `MemoryJournalStore` now pass a commit anchor (`anchorFor(store)` in
   `test-helpers.ts`).
   - Affected: the crash-boundary property, A-4 idempotency, D-5, VR-24/27/28/29.
   - Their guarantees are therefore verified **with anchoring on**. All pass unchanged.
2. Two tests that hand-build a journal to check the reader's torn-tail rule (D-2) have no anchor to check.
   They now run explicitly with `allowUnanchored: true`, with a comment; their assertions are unchanged. The
   anchored counterpart (an anchored entry truncated mid-line is refused) is in `durability-anchor.test.ts`.
3. `privacy-review` "VR-08 open: …" was renamed "VR-08 within the budget: …". Its assertions (the first
   failing FOK is still free) are unchanged and still true.
4. Benchmarks give their store-backed venues an anchor and raise the new FOK limit like the other limits, so
   they measure the same work plus the anchor.

**Checks:**

| Check | Result |
|---|---|
| Unit suite (twice) | 641 passed (52 files), both runs; venue: 264 (16 files) |
| `npm run check` (typecheck, lint, test, build, bundle scan) | pass |
| E2E | 52 passed (the same `NO_COLOR` and offline "Venue request failed (network)" log lines as M9/M10) |
| Crash boundaries | Milestone 9 property (150 runs × 5 boundaries), now anchored; new anchored property (150 runs × 8 boundaries incl. 3 anchor faults) |
| Replay / snapshot equivalence | quarantine (full, snapshot + suffix, replica from text), anchor, retention, idempotency tests |
| Demo | reconciliation OK; state hash `a11cdf37…` and output chain `54733390…` identical to M9/M10 |
| Journal compatibility | M10 journal → M11: hashes match; M11 operator record → M10 reader: refused |

**Performance** (PERFORMANCE-RESULTS §8): alternating A/B against `9812049`, four runs each.

- Most scenarios are within this host's noise. F1, whose code is unchanged, moved +11 %.
- F6 (large book) was −14 % with non-overlapping ranges inside the suite. An isolated F6-style run gives −2 %
  (unanchored) and −5 % (anchored) against the baseline, with overlapping ranges.
- The anchor itself costs about 1.1 µs per command (microbenchmark).
- The in-suite F6 difference is reproducible but not explained; it is recorded as open, not as a capacity
  statement.

## 7. Residual risks

| Risk | Status |
|---|---|
| Anchor independence | In memory only. Physical durability, separate failure domains and insider resistance need real storage and external anchoring. |
| Anchor bootstrap and quarantine approval | Free-text metadata; no operator authentication or four-eyes control (T-O3). |
| Quarantine evidence | `sameEngineBuild` and the client outcome are attestations. The sequence comparison checks only what the operator reports consumers observed. |
| Variants of a poison command | Only the identical command is blocked; a variant that triggers the same bug faults again. Mitigation: `suspendAccount`, then fix the bug. |
| Client-ID index and terminal orders | Grow with every accepted order (D7). Long-term: durable index and archive. |
| Private events after a gap | Signalled, not recovered. Clients resynchronise from order queries. |
| FOK probing | Budgeted, not eliminated; Sybil accounts; timing (VR-15). |
| D-5 duplicates | Still fail-closed and operator-dependent (D3), although the anchor now provides the evidence a future repair would need. |
