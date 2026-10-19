# Nova Venue — Hidden-Order Privacy Review (Milestone 9)

This review asks one question: can an adversary infer anything about a hidden order — its
existence, price, size, side, owner or activity?

**Assumed adversary capabilities:**

- submit orders and cancel orders
- observe all public messages
- reconnect repeatedly
- compare responses and timing

**Tests:** `src/venue/privacy-review.test.ts`, `adversarial.test.ts` and `properties.test.ts` (H-1
non-interference). Findings referenced as VR-nn are in [VERIFICATION-REPORT.md](VERIFICATION-REPORT.md).

**Baseline statement.** Hidden orders are protected by **server-side access control and publication
rules only**. Nothing in this prototype provides cryptographic confidentiality.

**Vocabulary:**

| Term | Meaning |
|---|---|
| **Closed** | No inference found, and a test supports it |
| **Reduced** | Mitigated, but information still leaks |
| **Open** | Not mitigated |

None of the channels below is *eliminated* in an absolute sense. "Closed" means "closed for the
behaviours tested".

## Summary by threat model

| Model | Adversary | Protection claimed | Status |
|---|---|---|---|
| A | Unauthenticated public observer | No hidden-order data in public messages; nothing left except inference from prints | Closed for orders that never trade. Reduced for orders that trade. |
| B | Authenticated trader | Same as A, plus no cross-account access, uniform errors, opaque IDs, throttled probes | Reduced: probing remains possible (IOC, FOK, post-only within budget) |
| C | Compromised application service (same process) | **None** | Open, by design |
| D | Privileged matching-engine operator | **None** | Open, by design |
| E | Access to logs or persistent storage | Logs: codes only. Journal and snapshots: **none**. | Open for storage |

**No protection is claimed against C, D or E** beyond what is listed. These rows are not mitigated
by any technical design in this prototype. Mitigating them would need, at least:

- process isolation and least-privilege access to state
- encrypted storage with separately held keys
- for D, encrypted or commit-reveal order flow, which is out of scope and would need its own
  cryptographic review

## A — Unauthenticated public observer

| Channel | Result | Evidence |
|---|---|---|
| Public book and level messages | **Closed.** Levels holding only hidden orders do not exist publicly. Adding, replacing or cancelling a hidden order emits nothing, in both publication modes. | `privacy-review` "H-1 add, replace and cancel …"; `properties` H-1 non-interference (150 runs per mode) |
| Public sequence counters and gaps | **Closed.** The public sequence counts public messages only. | `adversarial` "H-1 the public sequence is gap-free …"; non-interference property |
| Update frequency and timestamps | **Closed** for hidden orders that do not trade. The number of messages and their timestamps are unchanged by hidden activity (non-interference compares every field). | non-interference property |
| Trade prints | **Reduced.** Prints are aggregated per aggressor and price, with no maker count, IDs or visibility. But a print at a price with no displayed level, or larger than the displayed quantity removed, **reveals that hidden liquidity existed and a lower bound on its size**. | `privacy-review` "H-5 residual …"; `adversarial` "H-5 residual inference …" |
| Aggregate volume | **Reduced.** Same as prints. Volume per interval is public. | — |
| Diagnostic endpoints | **Closed (vacuous).** The prototype exposes no network endpoint. | — |

**Default to note:** `publication: "immediate"` is the default in fixtures. `batched` nets level
changes and uses publication timestamps. Batched mode is less informative to a timing observer. A
real deployment should default to it and schedule publish ticks itself; no scheduler exists (VR-12).

## B — Authenticated trader

| Channel | Result | Evidence |
|---|---|---|
| Post-only rejection as a free probe | **Reduced.** Per-account budget (default 20 per minute), shared by new orders **and replaces**. Replaces bypassed it before VR-03. Reconnecting does not reset it. Several accounts multiply the budget, which needs surveillance. | `privacy-review` "VR-03 …"; `adversarial` "H-7 …" |
| Failing FOK as a free absence probe | **Reduced (Milestone 11).** It still reveals "less than Q at ≤ P" without executing, but every unfilled FOK counts toward a per-account budget (20 per 60 s); beyond it FOK orders are refused. Counting uses only the caller's own outcome. Sybil accounts multiply the budget. | `privacy-review` "VR-08 within the budget …"; `fok-budget` (H-7) |
| IOC probing inside the spread | **Open, inherent.** A positive answer costs an execution, which is visible to surveillance. Minimum hidden size (H-6) raises the stakes only for the hidden side. | `privacy-review` "VR-08 …" (positive answer executes) |
| Error responses and rejection behaviour | **Closed.** Cancel, replace and order lookup for another account's (hidden) order are identical to those for a non-existent ID, by order ID and by client order ID, including malformed replace values. | `privacy-review` "A-1 / P-1 every private query …"; `adversarial` A-1 |
| Order IDs and event numbering | **Closed while the ID key is secret.** Since Milestone 10, `Venue` enforces a key policy (A-5): at least 43 base64url characters, at least 16 distinct characters, and fixture keys only with an explicit test-only flag. Key management stays open. The trader's own IDs, `accountSeq`, timestamps and events are identical whether or not others placed hidden orders in between. With the key, IDs map back to global sequence numbers (VR-14). | `privacy-review` "H-8 …", "VR-14 …" |
| Fill details | **Closed.** The taker's private events are identical whether the maker was hidden or displayed. | `adversarial` "H-5 the taker's private view …" |
| Timing | **Reduced, still open (Milestone 12).** `publicBook()` latency no longer depends on hidden-only levels in the tested range (VR-31). Order-entry latency still depends on them: insert-front p50 is 6.6 → 10.9 µs from 0 to 50 000 hidden-only levels at engine level, about 1.7–2×, down from 2.2× (VR-15). A walk that reaches hidden levels is inherent. Gateway-level round medians overlapped in Milestone 12. Treat the channel as plausibly observable; **no timing-privacy claim is made**. | "Milestone 12" below; PERFORMANCE-RESULTS §9 |
| Subscription behaviour | **Closed.** Private events are only reachable through the owner's session. Closed or forged sessions read nothing. Gateway responses contain only the caller's events. | `privacy-review` "subscription …"; `properties` A-2 |
| Cross-account access | **Closed.** The account comes from the session. A body `accountId` is refused. | `adversarial` A-1; `verification` "A-1 malformed …" |
| Logs | **Closed.** Gateway refusal records hold `ts`, `accountId` and `code` only; no payload. The log is bounded (VR-04). | `privacy-review` "logs …"; `verification` VR-04 |
| RFQ recipient permissions | **Not applicable to the venue,** which has no RFQ. The application's RFQ desk enforces that only selected counterparties see a redacted request, and that only the accepted counterparty learns the execution. | `src/core/rfq/desk.test.ts`; E2E scenario 10 (Milestone 7) |

## C — Compromised application service

**Open by design.** Any code running in the same process with a reference to the gateway can reach
the venue and the complete book, hidden orders and owners included. TypeScript `private` is a
compile-time annotation only. The test `privacy-review` "C — … `private` is not isolation"
demonstrates it.

A real deployment would need:

- the engine in its own process or host
- a narrow, authenticated interface
- no shared memory with order-entry or market-data services

## D — Privileged matching-engine operator

**Open by design. Nothing in this prototype protects hidden orders from the operator.** The
operator view (`inspectBook`) and the audit records (executions with `makerVisibility`, transitions)
expose hidden orders by intent. The test `privacy-review` "D — …" pins this.

Design-level mitigations are organisational only:

- least privilege
- audited break-glass access
- role separation (THREAT-MODEL T-O1)

They are not implemented and not tested. Users must be told that the operator can see hidden orders.

## E — Access to logs or persistent storage

- **Logs:** the gateway refusal log holds no payload. The prototype has no other logging.
- **Journal and snapshots:** **plaintext.** They hold every order, including hidden ones, with
  owner, price and size (test `privacy-review` "E — …"). Anyone who can read the store learns
  everything.
- **The hash chain gives no confidentiality.** It also gives no integrity against a writer, unless
  an independently protected anchor exists (VERIFICATION-REPORT §5).

**Required before any real use:**

- encryption at rest, with keys held outside the storage tier
- access control and audit on the store
- retention limits

## Residual leakage — mitigation is not elimination

| Residual | Why it remains | What reduces it further |
|---|---|---|
| Trades reveal that hidden liquidity existed, and a lower bound on its size | Prints must report executed price and quantity | Nothing short of not printing, which is unacceptable for a transparent market. Batched publication blurs timing only. |
| Probing by IOC (with cost) and FOK (free when it fails, within a budget) | Execution semantics answer the question | Surveillance; FOK-failure budget (implemented in M11); minimum execution quantity on hidden orders (not designed) |
| Post-only probes within the budget | The budget is above zero, and several accounts multiply it | Lower budget; surveillance across accounts |
| Timing of engine operations | Since Milestone 12, the cost depends weakly on the number of hidden-only levels (map size, cache) and fully on the levels a match walks | Fixed-latency or batched acknowledgements (transport layer); dummy work cannot hide a walk without bounding it |
| Operator, process and storage access | Access control is the only protection | Isolation, encryption at rest, encrypted order flow (separate design and review) |

## Milestone 12 — Hidden-liquidity timing (VR-15, VR-31)

Measurements: PERFORMANCE-RESULTS §9. Raw logs: `verification/m12/`.

**Method.**

- Books with **identical displayed liquidity** differ only in their hidden-only levels: 0, 1 000, 10 000 or
  50 000, asserted before measuring.
- The configurations alternate within each round.
- VR-31 (`publicBook`) and VR-15 (order entry) are measured by separate probes.
- The Milestone 11 book is measured in the same engine as the new one.

| Channel | Before (`9fcee80`) | After (Milestone 12) | Status |
|---|---|---|---|
| `publicBook(20)` with hidden-only levels better than the displayed ones (VR-31) | p50 2 µs → 10 345 µs at 50 000 | 3.9 → 4.2 µs; rerun 4.2 → 4.4 µs; round medians overlap | **Resolved within the tested scope** (1 to 50 000 levels, one host). Not walking hidden-only levels is structural: the displayed-level index never contains them. |
| Displayed insert at a new level (VR-15) | 6.7 → 15.0 µs (2.2×) | 6.6 → 10.9 µs (1.7×); corrected historical probe about 2× | **Reduced, open** |
| Cancel that order (removes the level) | 1.7 → 8.3 µs (4.8×) | 2.1 → 2.8 µs (1.3×) | Reduced, open |
| IOC taking a displayed level in front | 16.7 → 23.4 µs | 10.7 → 18.8 µs (noisy) | Reduced, open |
| Post-only accept | 5.4 → 6.3 µs | 6.3 → 8.8 µs | Small dependence, open |
| FOK or taker whose limit reaches hidden levels | 8 µs → 34 ms | 7 µs → 30 ms | **Inherent**: matching must visit each level it could fill against |
| Gateway path (historical probe) | Separated in one Milestone 9 run | Overlapping round medians (corrected probe, 50 000 real levels) | Plausibly observable; not established either way |

**What remains.** The remaining dependence is about **2×** at 50 000 hidden-only levels on the engine path. It
is an **open privacy risk**, not noise:

- **Residual structure cost.** It follows the number of hidden-only **levels**, not hidden orders: 50 000
  orders on one level cost the same as none (`insert-control.log`). Larger level maps and index nodes and
  cache misses are the likely source. Removing it would need a fixed-size preallocated structure, or
  constant-time padding of every operation.
- **Inherent walks.** A FOK or IOC whose limit reaches hidden levels pays for visiting them. That is matching
  itself, and the FOK budget (H-7) bounds how often a FOK probe is free.
- **End to end.**
  - Through the in-process gateway, per-call cost (about 300–580 µs on this host) dwarfs the residual. The
    corrected probe's ranges overlap.
  - A co-located attacker with many samples may still separate it.
  - Fixed-latency or batched acknowledgements need a transport layer, which the prototype does not have.
- **Scope.** One host and one runtime (node 22). Results on other hardware, under load, or with other book
  shapes may differ.

**Claim.** Milestone 12 reduces the hidden-liquidity timing channels and removes the `publicBook` dependence
in the tested range. It does **not** provide timing privacy for hidden orders, and no document may say it does.

**No hidden data was added to any output.**

- `publicBook` returns the same displayed levels as before. The differential tests compare it at depths 20,
  3, 1 and 0 after every command.
- The new index is internal; no API exposes it.

