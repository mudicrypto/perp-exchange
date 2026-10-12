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
| Failing FOK as a free absence probe | **Open (Low).** It reveals "less than Q at ≤ P" without executing. | `privacy-review` "VR-08 …" |
| IOC probing inside the spread | **Open, inherent.** A positive answer costs an execution, which is visible to surveillance. Minimum hidden size (H-6) raises the stakes only for the hidden side. | `privacy-review` "VR-08 …" (positive answer executes) |
| Error responses and rejection behaviour | **Closed.** Cancel, replace and order lookup for another account's (hidden) order are identical to those for a non-existent ID, by order ID and by client order ID, including malformed replace values. | `privacy-review` "A-1 / P-1 every private query …"; `adversarial` A-1 |
| Order IDs and event numbering | **Closed while the ID key is secret.** The trader's own IDs, `accountSeq`, timestamps and events are identical whether or not others placed hidden orders in between. With the key, IDs map back to global sequence numbers (VR-14). | `privacy-review` "H-8 …", "VR-14 …" |
| Fill details | **Closed.** The taker's private events are identical whether the maker was hidden or displayed. | `adversarial` "H-5 the taker's private view …" |
| Timing | **Reduced / plausible.** Engine-level latency depends on the number of hidden-only price levels (about 3 µs against 11 µs at 50 000 levels). At the gateway level, one run separated (every 50 000-level round slower than every 0-level round) and one did not. Treat the channel as plausibly observable. | PERFORMANCE-RESULTS §4 (VR-15) |
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
| Probing by IOC (with cost) and FOK (free when it fails) | Execution semantics answer the question | Surveillance; FOK-failure budget (proposed); minimum execution quantity on hidden orders (not designed) |
| Post-only probes within the budget | The budget is above zero, and several accounts multiply it | Lower budget; surveillance across accounts |
| Timing of engine operations | Data-structure cost depends on all levels | Constant-time level index; fixed-latency or batched acknowledgements |
| Operator, process and storage access | Access control is the only protection | Isolation, encryption at rest, encrypted order flow (separate design and review) |
