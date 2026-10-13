# Nova Venue — Threat Model

Status: Milestone 8; statuses updated in Milestone 9 (adversary-by-adversary results in [PRIVACY-REVIEW.md](PRIVACY-REVIEW.md), findings in [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md)). Scope:

- The venue design in [ARCHITECTURE.md](ARCHITECTURE.md).
- Its local prototype (`src/venue/`).

Method: assets → actors → trust boundaries → threats per component (STRIDE) → mitigations →
residual risk. Each threat is marked as:

- **P**: mitigated and tested in the prototype.
- **D**: designed, but not built.
- **O**: open.

The prototype is local-only and synthetic. Many threats below matter only once a networked or real
deployment exists. They are listed now so that design decisions are made with them in view.

## 1. Assets

| ID | Asset | Why it matters |
|---|---|---|
| AS-1 | Hidden order data: existence, price, size, side, account, timing | The service promised to hidden-order users |
| AS-2 | Private account data: orders, fills, positions, balances, events | Confidentiality between participants |
| AS-3 | Fairness of matching: priority, STP, rules applied uniformly | Market integrity; fair treatment of users |
| AS-4 | Integrity of the record: journal, executions, positions | Disputes, reconciliation, any regulatory reporting |
| AS-5 | Availability of order entry and cancellation | Users must be able to manage their risk, above all to cancel |
| AS-6 | Public market data integrity | Price discovery; downstream risk systems |
| AS-7 | Operator credentials and administrative commands | Control over all of the above |

## 2. Actors

| ID | Actor | Capabilities assumed |
|---|---|---|
| AC-1 | Outsider | Network access to public endpoints. No account. |
| AC-2 | Participant | A legitimate account. Can submit any well-formed or malformed message within its limits. Can run many accounts (Sybil). Can measure timing. |
| AC-3 | Information-seeking participant | AC-2, plus intent to infer hidden liquidity or other participants' activity: probing, statistical inference, timing |
| AC-4 | Compromised client | Session token or credentials of a legitimate account stolen |
| AC-5 | Malicious or curious insider | Operator, developer or support staff with legitimate access to engine hosts, logs, journal, snapshots, or the admin interface |
| AC-6 | Infrastructure attacker | Has compromised a host, storage, the deployment pipeline or a dependency (supply chain) |

## 3. Trust boundaries

```
 AC-1/2/3/4 ──(B1: network → gateway)──▶ Gateway ──(B2: gateway → sequencer)──▶ Sequencer/Journal
                                                                                 │ (B3: storage)
 public consumers ◀──(B4: public feed)── Engine ──(B5: private channels)──▶ account owners
 AC-5 ──(B6: operator / admin / audit access)──▶ Engine state, journal, snapshots, audit stores
 AC-6 ──(B7: hosts, build, dependencies)──▶ everything
```

In the prototype, B1 and B4 are in-process function calls. B3 is in-memory or a JSONL string.
B6 is direct object access. The design treats all of them as real boundaries.

## 4. Threats and mitigations

### 4.1 Hidden-order confidentiality (AS-1)

| ID | Threat | Actor | Mitigation | Status | Residual risk |
|---|---|---|---|---|---|
| T-H1 | Hidden orders appear in public book data or messages | AC-1/2 | No public message for hidden orders. L2 from displayed quantity only. Levels holding only hidden orders are invisible (H-1). | **P**: non-interference property test | — |
| T-H2 | Public sequence gaps reveal hidden activity | AC-2/3 | Separate public sequence counting only public messages (H-1, H-8) | **P**: gap-free test, non-interference test | — |
| T-H3 | Sequential order or fill IDs, or the global sequence in private events, reveal activity between a client's own messages | AC-3 | Keyed-hash IDs; per-account sequence (H-8) | **P** | ID key compromise (AC-5/6) restores the channel. Since M10 the key policy (A-5) refuses weak and fixture keys at the `Venue` boundary; storage and rotation of the key are not designed (D). |
| T-H4 | Probing with small marketable orders inside the spread | AC-3 | Minimum hidden size (H-6), message rate limit (A-3), surveillance (D) | **P** partial | IOC probes succeed at the cost of an execution. Minimum execution quantity on hidden orders is not designed yet (MATCHING-RULES §2). |
| T-H5 | Free probing with post-only orders, new or replaced (a rejection reveals crossing liquidity); free absence probing with failing FOK orders | AC-3 | Per-account post-only rejection throttle at the gateway, covering new orders and replaces since M9 (H-7, VR-03) | **P** (throttle tested, leak documented); FOK probe **O** (VR-08) | A few probes per window per account; Sybil accounts multiply the budget. Needs cross-account surveillance (D). Failing FOKs answer "not enough" for free. |
| T-H6 | Inferring hidden volume from print size versus change in displayed quantity | AC-3 | Aggregated prints (per aggressor and price); batched publication (H-5, H-9) | **P** partial | Inherent: that hidden liquidity traded, and the minimum amount, can be inferred. Documented and tested. |
| T-H7 | Timing side channel: acknowledgement or publication latency depends on how many (hidden) orders were walked, or on how many hidden-only levels exist | AC-3 | Batched publication with publication timestamps (H-9) | **O**. M9 measured it at engine level (≈ 3 µs vs ≈ 11 µs at 50 000 hidden-only levels). Through the in-process gateway, one of two runs separated the cases (VR-15): plausibly observable. | Needs a constant-time level index and fixed-latency or batched acknowledgements. |
| T-H8 | The taker learns that the maker was hidden from fill details | AC-2 | Identical taker events for hidden and displayed makers; no counterparty fields (H-5) | **P** | — |
| T-H9 | Rejection or error reasons act as an existence oracle for other accounts' orders | AC-2 | Uniform `unknown-order` for foreign and non-existent IDs; response equality test (P-1) | **P** | — |
| T-H10 | Hidden data leaks through logs, metrics, crash dumps or support tooling | AC-5/6 | The prototype logs nothing. The gateway refusal log holds codes only. | **D** | Real logging, metrics and core-dump policies must be reviewed (SECURITY-CHECKLIST). |
| T-H11 | Marketing or disclosures overstate confidentiality, for example by claiming encryption or that the operator cannot see orders | — | The design states server-side access control only. No cryptographic claim. | **P** (documentation) | Must carry into any user-facing text. |

### 4.2 Integrity and fairness (AS-3, AS-4, AS-6)

| ID | Threat | Actor | Mitigation | Status | Residual risk |
|---|---|---|---|---|---|
| T-I1 | Matching bug violates priority or limits, or executes a self-trade | — | Rule tests; property tests for priority, limits, uncrossed book, no self-trade; reconciliation after every command; fail-stop on invariant violation | **P** | Testing is not proof. Independent review of the engine is needed (SECURITY-CHECKLIST B1). |
| T-I2 | Numerical error: floating point, overflow, rounding | AC-2 | Integer ticks and lots; exact decimal parsing; `bigint` cash; schema bound on notional (I-1) | **P** | Aggregates beyond 2^53 lots are guarded only by limits. A production engine should use checked 64-bit or 128-bit arithmetic. |
| T-I3 | Account impersonation: placing or cancelling orders for another account | AC-2/4 | Account taken from the session only; strict schema refuses `accountId`; engine resolves only the caller's own orders (A-1, P-1) | **P** | A stolen session (AC-4) is equivalent to the account. Needs strong authentication, short-lived tokens, IP and device binding (D). |
| T-I4 | Duplicate submission or replay creates extra orders | AC-2/4 | Idempotency by client order ID; engine refuses duplicate client IDs (A-4) | **P** | — |
| T-I5 | Journal tampering: edit, reorder, inject, truncate | AC-5/6 | Hash chain; schema re-validation; sequence checks; torn-tail handling (D-2) | **P** for partial edits | Full-chain rewrite by an insider is undetectable without external anchoring (tested). Anchoring is **D**. |
| T-I6 | Snapshot substitution or corruption | AC-5/6 | Snapshot bound to journal head; `stateHash` verified on restore (M9, VR-05); restore cross-checks holdings against orders (D-2, D-3) | **P** | A writer who rewrites the snapshot and recomputes its hash is not detected without an external anchor (D). |
| T-I7 | Non-determinism causes divergence between primary and replica, or a different result on replay | — | No clock, randomness or I/O in the engine; state and output hash comparison (D-1) | **P** | Hidden non-determinism from runtime upgrades. Pin the runtime, and replay test journals on every upgrade. |
| T-I8 | Front-running or selective treatment by the operator, who sees all orders | AC-5 | Sequenced, journaled processing; deterministic replay lets an auditor re-derive every outcome | **D** | Operator access to hidden flow is inherent to this design (T-O1). |
| T-I9 | Public feed spoofing or corruption in transit | AC-6 | Strict consumer validation, sequence and gap detection (D-4) | **P** for consumer side | Transport authentication and signing are **D**. |
| T-I10 | Faulty storage acknowledges an append it did not persist correctly (for example writes the previous entry again) | AC-6, storage fault | Since M10, duplicate journal records fail closed (D-5): recovery refuses and leaves the store untouched, instead of silently dropping an acknowledged command (VR-24) | **P** for duplicate bytes | A store that acknowledges a write before it is durable and later loses the end of the entry is indistinguishable from a torn tail (an unparseable final line) and is dropped as uncommitted; if it loses the whole entry, nothing is detected. Detecting either needs an independently persisted commit record (D). Since the final M10 review, a final line that parses but fails validation is refused, not dropped (VR-28). |
| T-I11 | An in-process consumer (gateway caller, public listener, feed reader) modifies a delivered event and so changes what other consumers, the stored tape or the journaled command observe | AC-6 (compromised dependency or component in the process) | Since the final M10 review, every routed event and public message is deep-frozen in `Venue.route`; the ledger keeps its own frozen copies (VR-25, VR-29) | **P** | Execution records and the venue's own arrays are mutable through the `Venue` object; code with that reference is trusted. A real deployment would separate consumers by process and serialisation. |

### 4.3 Availability and abuse (AS-5)

| ID | Threat | Actor | Mitigation | Status | Residual risk |
|---|---|---|---|---|---|
| T-A1 | Message flooding from one account, or unauthenticated floods growing the refusal log | AC-1/2 | Per-account sliding-window limit before journaling (A-3); bounded refusal log with per-code totals (M9, VR-04) | **P** | Sybil and distributed floods need connection, IP and global limits in front (D). |
| T-A2 | Book stuffing: many resting orders, deep books slow matching | AC-2 | `maxOpenOrders` per account (R-1); price band | **P** | Across many accounts; the performance plan covers deep-book worst cases. |
| T-A3 | Malformed or oversized input crashes the gateway | AC-1/2 | Strict schemas; bounded string lengths; no echo | **P** | Network framing and size limits are **D**. |
| T-A4 | Engine fault halts the whole venue (fail-stop); commands after the fault journaled and replayed on recovery | — | Fail-stop chosen deliberately (D-3). Since M9, later commands are refused before journaling and the faulting command is reported as `outcome-unknown` (VR-01). | **P** | Availability depends on HA and failover (D). Cancels are refused while stopped. A deterministic fault blocks recovery until an operator acts (VR-18). |
| T-A5 | Cancels refused during a halt | — | Cancels allowed while halted (R-2) | **P** | — |

### 4.4 Operators, infrastructure and supply chain (AS-7)

| ID | Threat | Actor | Mitigation | Status | Residual risk |
|---|---|---|---|---|---|
| T-O1 | Insider reads hidden orders or private account data | AC-5 | Design: least-privilege roles; no routine access to engine memory or journal; audited break-glass access; separate surveillance role | **D** | Inherent without cryptographic order flow. Must be disclosed to users. |
| T-O2 | Insider rewrites history | AC-5 | Hash chain plus external anchoring of heads (e.g. a third-party timestamping service or write-once storage) | **D** (chain **P**) | — |
| T-O3 | Unauthorised admin commands (halt, suspend, add instrument or account) | AC-5/6 | Admin commands are journaled like trades. Design: separate authenticated admin channel with four-eyes approval. | **D** | In the prototype, anyone with code access can submit them. |
| T-O4 | Compromised dependency or build pipeline | AC-6 | Pinned versions and lockfile; minimal dependencies (Zod and Node `crypto` only) | **P** partial | SBOM, signing, reproducible builds: **D** |
| T-O5 | Prototype accidentally wired to real users or funds | — | No network listener; ESLint forbids network, file-system and app imports in both directions; synthetic-only identifiers enforced by schema | **P** | — |

## 5. Assumptions

- The engine host and its memory are trusted. Every confidentiality property in this document is
  relative to that.
- Session tokens are secret and transported securely. The prototype has no transport.
- The ID key (`EngineConfig.idKey`) is secret and rotated with care: rotation changes every future
  ID, never past ones.
- Clocks are monotonic at the sequencer. The engine refuses timestamps that go backwards.

## 6. Out of scope (separate threat models required)

- custody, wallets, deposits, withdrawals
- margin, liquidation, settlement
- fees
- the RFQ network
- encrypted order flow
- the web terminal (covered by `docs/SECURITY.md`)
- regulatory reporting pipelines
