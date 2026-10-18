# Nova Venue — Security Review Checklist

Status: Milestone 8. Use this list when reviewing:

- the venue prototype
- any successor of the venue prototype

Marks:

- **[x]** verified for the **local prototype**, with the evidence named.
- **[ ]** open.
- **n/a (prototype)** cannot apply until real infrastructure exists.

A ticked box means "true of this prototype". It does **not** mean "ready for live use".

## A. Review checklist

### A1. Isolation from real funds and external execution

- [x] No network listener, HTTP client, WebSocket or file-system access in `src/venue`. ESLint
  enforces this with `no-restricted-imports` and `no-restricted-globals`, negative-tested, and
  `docs.test.ts` scans the source.
- [x] No module outside `src/venue` imports it. ESLint enforces this in every layer, and
  `docs.test.ts` checks it.
- [x] Instruments and accounts must be synthetic (`SYN-*`, `syn-*`). The schema enforces this.
- [x] No custody, balances of real assets, deposits, withdrawals or settlement exist.
- [x] `NOVA_EXECUTION_MODE` and the application's execution adapters are untouched by this
  milestone.

### A2. Input validation

- [x] Every client message is parsed by strict Zod schemas. Unknown fields, including `accountId`,
  are refused (adversarial tests).
- [x] Prices and quantities are converted exactly from decimal strings. Exponents, signs, hex,
  whitespace, separators, non-ASCII digits, leading zeros, excess precision, off-tick values and
  zero are refused (I-1 tests and property).
- [x] Error messages name the field and never echo submitted values.
- [x] Every journaled command is schema-validated again when it is appended, and again when the
  journal is read back (D-2).
- [x] Instrument and limit configuration is schema-validated, including the safe-integer bound on
  notional.

### A3. Authentication and authorization

- [x] Account derived from the session only (A-1).
- [x] Order queries, cancels and replaces resolve only the caller's own orders. A foreign order and
  a non-existent order produce identical responses (P-1, adversarial test).
- [x] Gateway responses and outboxes contain only the caller's events (A-2 property).
- [ ] Real authentication: credentials, MFA, token lifetime, revocation, device and IP binding.
  **n/a (prototype)**
- [ ] Admin channel authentication and four-eyes approval for operator commands. **n/a (prototype)**

### A4. Hidden-order confidentiality

- [x] No public message, public-sequence change or public timestamp depends on hidden orders that do
  not trade (H-1 non-interference property).
- [x] Public messages are strict and contain no account, order, client or visibility data (A-2
  property).
- [x] Opaque, keyed identifiers; per-account private sequence (H-8).
- [x] Taker's private view is independent of maker visibility (H-5).
- [x] Prints are aggregated per aggressor and price (H-5).
- [x] Post-only probe throttle (H-7). The leak itself is documented and tested. *M9 correction:* this
  box was ticked in M8 although `replace` bypassed the throttle (VR-03). Fixed, with a regression
  test.
- [ ] Failing-FOK absence probe (VR-08): documented, not mitigated.
- [x] Adversary-by-adversary review (public observer, trader, compromised service, operator,
  storage): [PRIVACY-REVIEW.md](PRIVACY-REVIEW.md). No protection is claimed against the last three.
- [x] No claim of cryptographic confidentiality anywhere in the design documents.
- [ ] Constant-time or batched acknowledgements against latency side channels (T-H7). M9 measured an
  engine-level dependence on the number of hidden-only levels; through the gateway it was visible
  in one of two runs (VR-15).
- [ ] Minimum execution quantity, or another defence against IOC probing (T-H4).
- [ ] Cross-account (Sybil) probe surveillance.
- [ ] Log, metric, crash-dump and support-tool review for hidden-order data. **n/a (prototype has no
  logging)**

### A5. Matching integrity

- [x] Price, then displayed-before-hidden, then time priority (M-3…M-5; examples and property).
- [x] Book never crossed, hidden included (M-6 property; reconciliation).
- [x] Executions at maker price, never beyond the taker's limit (M-2 property).
- [x] FOK and STP atomicity (M-8, S-3).
- [x] No self-trades (S-1; reconciliation).
- [x] Every state change goes through the transition table; terminal states are absorbing (property).
- [x] Conservation: positions and cash net to zero; fills re-derived from executions (reconciliation
  after every command in the property tests).
- [x] Mutation check: deliberately introduced priority, STP, sweep and publication-gap bugs are each
  caught by the suite (see Section C).
- [ ] Independent review of the engine (B1).

### A6. Durability and integrity of records

- [x] Write-ahead, hash-chained journal; deterministic replay reproduces state and output hashes
  (D-1, D-2).
- [x] Edits, reordering, injected invalid commands and torn tails are detected (D-2). Only an
  unparseable final line counts as torn; a complete final line that fails validation is refused, with
  or without its newline (M10 final review, VR-28).
- [x] Snapshots are bound to the journal head, cross-checked on restore, and verified by `stateHash`
  (D-2, D-3; M9 VR-05).
- [x] Fail-stop on internal faults (D-3). *M9 correction:* commands after the fault were still
  journaled and executed on recovery (VR-01, High). Fixed: refused before journaling, and the faulting
  command is reported as `outcome-unknown`.
- [x] Durable-store boundary with commit-before-process; crash at five persistence boundaries
  recovers to the last committed state, with outputs neither lost nor duplicated (M9;
  [RECOVERY-TEST-RESULTS.md](RECOVERY-TEST-RESULTS.md)). In-memory store only.
- [x] A failing public listener cannot affect committed results or private delivery (M9, VR-02).
- [x] Delivered events are immutable: the first response, the private feed, the public tape and every
  listener receive deep-frozen objects, so no consumer can change what another observes (M10 final
  review, VR-29). Execution records and the venue's own arrays remain mutable through the in-process
  `Venue` object.
- [x] After a fault, order queries refuse instead of serving half-applied state (M9, VR-19).
- [x] Failures after the commit point are always `outcome-unknown`; recovery takes text or a store,
  never both, and changes the store only after it succeeds; crash simulation is a test-only
  subclass seam, not an option (M9 review, VR-20…VR-23).
- [x] Idempotency survives restarts. The ledger is rebuilt from the journal and carried, hash-verified,
  in snapshots. Identical retries replay the original events; conflicting retries are refused; no
  accepted order is executed twice (property-tested). M10, VR-09.
- [x] Duplicate and conflicting journal records fail closed. Every duplicate, a reused sequence number,
  a gap or an empty line refuses recovery with a precise classification, without changing the store.
  A trailing copy of the final entry is not repaired, because it cannot be told apart from an
  acknowledged append persisted with the wrong bytes. M10, VR-10 and VR-24, rule D-5.
- [x] Idempotency records are immutable: deep-frozen ledger copies and a fresh copy per replay (VR-25).
  The snapshot records its ledger capacity; a restore under another capacity is refused (VR-26).
- [x] Separately written commit record (anchor): journal append → anchor write → process; recovery refuses a
  journal that lacks the anchored entry (truncated or lost acknowledged entries detected), refuses missing or
  unreadable anchors unless an operator bootstraps with a verified full replay and a journaled audit record.
  M11, rule D-6. **In-memory only:** detection of store faults, not proof of physical durability.
- [ ] Anchor on an independent medium (separate failure domain, write-once storage or external timestamping),
  so it also resists an insider and survives media failure. Automatic repair of duplicate tails stays
  disabled until then (founder decision D3).
- [x] Keep a permanent, recoverable client-ID index when addressing VR-13: no retention option trims it or
  the terminal-order lookup (tested with every retention at its minimum, live and after restarts). M11, A-6.
- [ ] Durable client-ID index and order archive (the long-term VR-13 design, decision D7).
- [x] Order-ID key policy enforced at the `Venue` boundary; fixture keys only with an explicit
  test-only flag; fixture literals confined to `id-key.ts` and tests. M10, VR-14, rule A-5.
- [ ] Id-key management: generation in deployment, secret storage, rotation. Verification of key
  randomness is not possible.
- [x] Poison-command quarantine and runbook (VR-18): final entry only, matching hash, reproducible fault,
  evidence of no acknowledged output; journaled decision replayed deterministically; identical command refused
  afterwards; operator records writable only by recovery (VR-30). M11, rule D-7, `runbooks/POISON-COMMAND.md`.
- [ ] Authenticated, four-eyes approval for bootstrap and quarantine (metadata is free text today).
- [x] Consumers de-duplicate regenerated outputs by sequence (D-4).
- [ ] External anchoring of journal heads. A full-chain rewrite is undetectable without it (tested).
- [ ] Durable storage, replication, failover, backup and restore drills. **n/a (prototype)**

### A7. Abuse controls

- [x] Per-account message rate limit before journaling; refusals logged without payload; log bounded
  with per-code totals (A-3; M9 VR-04). Reconnecting does not bypass limits (tested).
- [x] Idempotent order entry; conflicting reuse refused; rejected orders do not consume the ID (A-4;
  M9 VR-06).
- [x] Resting-order, notional and worst-case position limits (R-1).
- [x] Account suspension and instrument halt; cancels still accepted during a halt (R-2, R-3).
- [ ] Connection, IP and global limits; order-to-trade ratio limits; cancel-on-disconnect.
- [x] Explicit private-event gap marker (`eventsPage`); optional caps on executions, transitions, tape and
  admin errors (disabled by default), with eviction counters and journal-replay reconciliation. M11, A-6.
- [ ] Bounds for the order index and client-ID index (needs the durable index and archive, D7).
- [x] Unfilled-FOK budget per account (20 per 60 s by default), counted from the caller's own outcome,
  reconnect-proof, idempotent retries unaffected. M11, VR-08, H-7.
- [ ] Surveillance: probing, layering, spoofing, wash trading across accounts.

### A8. Dependencies and supply chain

- [x] The prototype uses only `zod` (pinned) and `node:crypto` at runtime, plus `node:os` in the
  benchmark CLI for the environment line. `fast-check` (pinned) is a test-only dependency.
- [ ] SBOM, build signing, reproducible builds. **n/a (prototype)**

## B. Components requiring independent security review before any live deployment

None of these has been independently reviewed. Each must be reviewed by a qualified party
independent of its authors before it handles real users or real funds, testnet included. A review
of one does not cover another.

| # | Component | What the review must cover |
|---|---|---|
| B1 | Matching engine and order book | Rule conformance against MATCHING-RULES; priority and STP; FOK and replace atomicity; arithmetic; fail-stop behaviour; determinism |
| B2 | Hidden-order confidentiality controls | Publication rules; identifier and sequence design; the leakage analysis (ARCHITECTURE §7.6); operator access paths; logs, metrics and dumps; data retention |
| B3 | Gateway, authentication and session management | Credential handling; schema coverage; rate limits; idempotency; network exposure and transport security |
| B4 | Sequencer, journal, snapshots and recovery | Durability guarantees; hash-chain anchoring; snapshot integrity; failover and split-brain; replay determinism across runtime versions |
| B5 | Risk, margin, liquidation, settlement | Not yet designed. Must be designed, then reviewed. |
| B6 | Custody, wallets, deposits, withdrawals | Out of scope until legal and compliance review. Separate threat model required. |
| B7 | Market-data distribution | Fair dissemination; resynchronisation; consumer-side validation; transport authentication |
| B8 | Operator tooling and admin commands | Authorization, four-eyes approval, audit trail, break-glass procedures |
| B9 | Surveillance and audit data access | Who can read private order flow; purpose limitation; retention and deletion |
| B10 | Cryptographic components | The SHA-256 chain, keyed-hash IDs and key management, plus any future encrypted order flow. That flow needs a separate cryptographic review and a published specification. |

Also required, but outside engineering: legal and regulatory review of operating a derivatives
venue, of hidden orders under pre-trade transparency rules, and of user disclosures.

## C. Evidence

- **Tests:** `src/venue/*.test.ts`
  - rule examples
  - property-based tests with fast-check
  - adversarial tests
  - recovery tests
  - documentation and isolation checks
- **Mutation check** (run manually during Milestone 8; not automated). Each mutation was introduced
  alone, and the suite was run:

  | Mutation | Caught |
  |---|---|
  | hidden queue before displayed | yes |
  | public sequence advanced on hidden add | yes (non-interference property) |
  | STP disabled | yes |
  | matching stops after one level | yes |
  | hidden orders mark displayed levels dirty | not caught |

  The last mutation is an *equivalent mutant*. Publication emits a level message only when displayed
  quantity actually changes, so the public output is unchanged.
- **Demo:** `npm run venue:demo` (reconciliation plus recovery hash comparison; exits non-zero on a
  mismatch).
