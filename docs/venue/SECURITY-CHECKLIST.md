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
- [x] Post-only probe throttle (H-7). The leak itself is documented and tested.
- [x] No claim of cryptographic confidentiality anywhere in the design documents.
- [ ] Constant-time or batched acknowledgements against latency side channels (T-H7).
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
- [x] Edits, reordering, injected invalid commands and torn tails are detected (D-2).
- [x] Snapshots are bound to the journal head and cross-checked on restore (D-2, D-3).
- [x] Fail-stop on internal faults (D-3).
- [x] Consumers de-duplicate regenerated outputs by sequence (D-4).
- [ ] External anchoring of journal heads. A full-chain rewrite is undetectable without it (tested).
- [ ] Durable storage, replication, failover, backup and restore drills. **n/a (prototype)**

### A7. Abuse controls

- [x] Per-account message rate limit before journaling; refusals logged by code only (A-3).
- [x] Idempotent order entry; conflicting reuse refused (A-4).
- [x] Resting-order, notional and worst-case position limits (R-1).
- [x] Account suspension and instrument halt; cancels still accepted during a halt (R-2, R-3).
- [ ] Connection, IP and global limits; order-to-trade ratio limits; cancel-on-disconnect.
- [ ] Surveillance: probing, layering, spoofing, wash trading across accounts.

### A8. Dependencies and supply chain

- [x] The prototype uses only `zod` (pinned) and `node:crypto` at runtime. `fast-check` (pinned) is a
  test-only dependency.
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
