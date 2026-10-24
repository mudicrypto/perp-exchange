# Venue × Stellar — Settlement Safety Design and Feasibility Spike Plan (Milestone 12, WP3)

**Status:** accepted as a preliminary design (not approval to implement a vault). The bounded testnet
spike of §9 has been run with a measurement contract; its results, and the changes they require to this
design (idempotent fill identifiers instead of the strict cursor, a hidden-order decision, bounded order
lifetime), are in [`STELLAR-SPIKE-RESULTS.md`](STELLAR-SPIKE-RESULTS.md). The text below is the design
as accepted; where the spike contradicts it, the results document takes precedence.

Decisions in force:

| Decision | Content |
|---|---|
| D5 | Research B1 (off-chain matching, Soroban vault), without committing to it |
| D6 | Spot only |
| D7 | Engine-enforced funded-order reservations, subject to a correctness design (not implemented; `engine.ts` unchanged) |
| D8 | Audited testnet and a mainnet-readiness report |
| D9 | Per-fill settlement first; batching benchmarked separately |

**Environment facts for the spike** (checked 2026-10-19):

- Stellar testnet RPC, Horizon and friendbot endpoints are reachable from the development container.
- Rust and Cargo are installed; `stellar-cli` is not.
- The Stellar developer documentation site was not reachable from here.

**Every network limit, fee and time-to-live value below is therefore marked _measure_.** None is
assumed.

## 0. Model

### Parties

| Party | Role | Trusted for |
|---|---|---|
| User | Owns a Stellar account; deposits; signs orders with a registered trading key | its own keys |
| Operator | Runs the engine (matching, hidden orders), submits settlements and anchors | **liveness and fair ordering only** (not custody) |
| Vault contract | Holds deposits; settles fills; enforces limits, exactly-once and exits | its code (audited, immutable or time-locked) |
| Asset issuer | Issues the assets (testnet assets in the spike) | may freeze or claw back, per its flags |
| Stellar network | Ordering, finality, storage | liveness, consensus |

### Safety goals: what must hold even against a malicious or compromised operator

| ID | Goal |
|---|---|
| G1 | A user's deposited funds move only by (a) the user's own withdrawal, or (b) settlement of a fill between two orders that the respective users signed, within each order's limit price, maximum quantity, expiry and epoch |
| G2 | No order is ever filled beyond its signed maximum quantity, across any number of partial fills and transactions |
| G3 | No fill is settled twice; a settlement transaction can be retried safely |
| G4 | A user can always exit without the operator, after a bounded delay *D* |
| G5 | Conservation: the sum of all internal balances of an asset equals the vault's balance of that asset |

### Liveness and fairness goals: depend on an honest, available operator

- L1: every engine execution is settled within *S_max* ledgers.
- L2: matching follows the published rules.

The contract cannot enforce L1 or L2. §7 states what is detectable.

### Non-goals

- Fair ordering against the operator.
- Privacy of executed fills: settled fills are public and account-linked.
- Derivatives.
- Mainnet.
- Real funds.

### Exact units

- Each pair defines integer scales such that base = `lots × baseUnitPerLot` and
  quote = `priceTicks × lots × quoteUnitPerTickLot`, with no rounding.
- An instrument whose scales do not divide exactly is refused at listing.
- Engine values are bounded by 2⁵³; contract amounts are `i128`.
- Fees are zero in the prototype.

## 1. Withdrawal escape when the operator is unavailable (G4)

### Contract state per user

| Field | Meaning |
|---|---|
| `balance[asset]` | Internal balance |
| `epoch` | Current signing epoch |
| `pending` | `{asset, amount, unlockLedger}` or none |

### Exit flow (user only; no operator signature)

1. `request_exit(asset, amount)`, which requires the user's authorisation. It records `pending`
   with `unlockLedger = now + D` and emits an event.
2. During the delay, settlement continues for orders signed under the current epoch. Fills the
   engine matched before it saw the request therefore settle normally.
3. After `unlockLedger`, `execute_exit()` (user only):
   - increments `epoch` (§2);
   - transfers `min(amount, balance[asset])` from the vault to the user through the asset contract;
   - clears `pending`.

   The amount can be lower than requested only if fills settled during the delay. Nothing else can
   reduce the balance (G1).

### Operator path

When the engine sees an exit request it:

- puts the account into **closing**;
- cancels the account's resting orders;
- refuses new orders until `execute_exit`;
- settles any fills already matched.

An optional **fast exit** (user and operator co-sign, no delay) is safe only because the operator
attests that no fills for that user are pending. Without the operator, only the delayed path exists.

### Parameters

| Parameter | Rule |
|---|---|
| `D` | Must satisfy **D > S_max + margin** |
| `S_max` | The operator's maximum settlement latency |
| Spike | Measure ledger close time and settlement latency; a starting point is D ≈ 1 hour, S_max ≈ 10 minutes, as ledger counts |

### Remaining risk and invariant

- **Remaining risk:** if Stellar itself halts, nobody can exit. That is a network-liveness
  assumption.
- **Invariant tested in the contract's property tests:** after `execute_exit`, the user has received
  everything except fills of orders signed under the old epoch that were settled before
  `unlockLedger`.

## 2. Invalidating outstanding signed orders during withdrawal

Signed orders live off-chain and can be presented to the contract until they expire, so invalidation
has to be on-chain.

| Mechanism | Who | Effect |
|---|---|---|
| **Epoch** | contract | Every order carries `epoch`; settlement requires `order.epoch == epoch[user]`. `execute_exit` increments it, which invalidates every order signed before it at once. |
| **Expiry** | user, at signing | `expiryLedger ≤ now + MAX_ORDER_LIFETIME`, checked at settlement |
| Per-order cancel on-chain | user | `request_cancel(orderHash)`, effective at `now + D` (see the free-option problem below) |
| Engine cancel | operator | Immediate off-chain; nothing on-chain needed, because a cancelled order is never matched again |

### The free-option problem

If a user could invalidate an order **immediately** on-chain, they could:

1. trade in the engine;
2. see the fill in their private feed;
3. cancel on-chain before settlement, voiding fills they dislike.

That is a free option against every counterparty.

**Rule:** every user-initiated on-chain invalidation (exit, epoch bump, per-order cancel) takes effect
only after the delay *D*. Settlement of fills matched before the request is guaranteed if the operator
settles within *S_max < D*.

**Corollary:** a fill the operator leaves unsettled past *D* may become unsettleable. That is a
settlement failure on the operator's side (§5), never a silent loss.

### Trading keys

- Users sign orders with a **registered ed25519 trading key**, not with Soroban per-invocation
  authorisation. Authorisation entries are consumed once (nonce), which does not fit a resting order
  filled across several transactions.
- `register_key(user, pubkey)` requires the account's own authorisation, so multisig accounts are
  respected at registration.
- Rotating the key bumps the epoch, with the same delay rule.

## 3. Fund reservations, partial fills, cumulative fill accounting

### 3.1 Off-chain: engine reservations (D7)

A design for later implementation. It changes `engine.ts` and needs separate approval.

**Mirrored balances:**

- the engine keeps per-account available balances;
- they are credited from **finalised** deposit events, debited by settled exits;
- they are moved by its own fills.

**Reserve on acceptance:**

| Order | Reserve |
|---|---|
| Buy | `qty × limitPrice` in quote |
| Sell | `qty` in base |

An order that would make reservations exceed the mirrored available balance is refused (a new
rejection reason).

**Partial fill:**

- The buyer pays at the maker price, which is at or below the limit. Release `fillQty × limitPrice`
  and spend `fillQty × fillPrice`; the difference is price improvement and returns to available.
- The seller spends `fillQty` base.

**Cancel, IOC/FOK remainder, self-trade cancel:** release the remaining reservation.

**Replace:**

- Re-reserve at the new price and quantity atomically.
- Refuse it if insufficient, so the original order and its reservation are unchanged.

**Invariant (property-tested when implemented):** for every account and asset,

  reserved + settledOutflows ≤ mirroredDeposits − exits, and reserved ≥ 0, after every command.

**Hidden orders reserve exactly like displayed ones.** Rejections for insufficient funds are private
to the sender, so reservations reveal nothing publicly.

### 3.2 On-chain: cumulative fill limit (G2)

- `filled[orderHash]` holds the cumulative base quantity settled.
- Each fill requires all of:
  - `filled + q ≤ order.maxQty`;
  - the price on the correct side of both orders' limits (buy: price ≤ limit; sell: price ≥ limit);
  - the fill price equal to the maker's order price (rule M-2), checked against the maker's signed
    limit;
  - both orders unexpired, at the current epoch, signed by the owner's registered key, on opposite
    sides of the same pair, and from different users (self-trade prevention is enforced again
    on-chain).
- `orderHash` is sha256 over a canonical encoding with domain separation (§4).
- **Lifetime:**
  - `filled[orderHash]` must outlive the order: TTL ≥ `expiryLedger` + margin.
  - If the entry ever disappeared while the order was still valid, the order could be over-filled.
  - **Temporary storage is acceptable only if its maximum TTL covers `MAX_ORDER_LIFETIME`;
    otherwise it must be persistent** (§6). Settlement of an order whose counter is missing and
    whose expiry has not passed must fail closed: treat a missing counter as an error, not as zero,
    after the first fill. Track first-fill creation with the order's verification record.

## 4. Atomic settlement, duplicate-fill prevention, replay protection

**Atomicity.** A settlement transaction validates every fill it carries and only then moves balances.
Any failed check reverts the whole transaction: Soroban invocations are atomic, so there are no
partial balance updates. D9 settles **one fill per transaction first**; batches of *k* fills are
benchmarked separately (§6).

### Exactly once (G3)

**Settlement cursor:** each fill carries its engine position `(seq, index)`. The contract stores one
cursor and requires every fill to be strictly greater than it.

- O(1) storage instead of a record per fill.
- Duplicates are impossible.
- A retried transaction after an unknown outcome either succeeds once or is rejected as already
  settled. The operator resolves "outcome unknown" by reading the cursor: a decidable question.

**Cost of the cursor:** settlement is strictly in journal order, so a stuck fill blocks the ones after
it. This is intended: fail-closed, see §5.

**Gaps:**

- A cursor cannot prove that no execution was skipped. The contract never sees executions that are
  not presented to it.
- **Skipping is detectable, not preventable** (§7): an auditor compares the anchored journal with the
  settled cursor sequence.

### Replay protection for signed orders

The signed payload includes:

- a domain tag `"venue-order/1"`;
- the **network passphrase hash**, the **contract ID** and the user account;
- the pair, side, limit price, maximum quantity, salt, `expiryLedger` and `epoch`.

So a signature cannot be replayed:

- on another network or contract (domain separation);
- after expiry or exit (expiry and epoch);
- beyond its quantity (the cumulative limit).

Re-presenting the same order for further partial fills is intended, and bounded by
`filled ≤ maxQty`.

### Who may settle

- `settle` requires the operator's authorisation. A permissionless `settle` would let anyone match two
  crossing signed orders, bypassing the engine's priority and hidden-order rules. It would still stay
  within user limits, but it would break G-fairness.
- **Operator key compromise:**
  - the attacker can settle crossing signed orders at prices within their limits (worst execution
    inside the limit), but cannot breach G1–G5;
  - mitigations: short `MAX_ORDER_LIFETIME`, a hardware-backed key, an on-chain per-window
    settlement cap, rotation through a time-locked admin.

### Verification cost

ed25519 verification of both orders is needed on first use. The contract may record
`verified[orderHash]` to skip re-verification on later partial fills, which trades storage for CPU.
The spike measures both.

## 5. Engine execution versus on-chain settlement failures

**Authorities:**

- the **engine journal** is authoritative for what was matched;
- the **chain** is authoritative for what moved.

A fill that cannot be settled is a **settlement break**.

### Failure classes

| Class | Examples | Handling |
|---|---|---|
| Transient | RPC error, fee too low, sequence clash, outcome unknown | Read the cursor. If not settled, resubmit the same fill (exactly once by the cursor). Retry within *S_max*. |
| Operator-late | Order expired, or a user's delayed invalidation took effect, before settlement | Avoided by S_max < D and order lifetime ≫ S_max. If it happens anyway: **settlement break** |
| Should-be-impossible | Insufficient balance, bad signature, price outside limit | Indicates a bug: off-chain reservations, signing or mapping. **Settlement break** and **fail-stop** |
| External | Issuer freezes or claws back an asset, trustline deauthorised | **Settlement break**. The spike lists only assets without clawback, and the issuer flags of each listed asset are recorded. |

**On a settlement break, fail closed:**

- the bridge stops submitting;
- the venue halts accepting commands (as in rule D-3);
- the break is reported with the fill's journal position.

Positions after the broken fill may depend on it, so continuing would compound the inconsistency.

**Resolution needs a "trade bust" command** in the engine. It is journaled, reverses the fill in
engine state, notifies both parties privately, and publishes a correction. **That is an engine change
and requires a separate approved design.** Until it exists, a settlement break keeps the venue halted
for an operator decision.

**Visibility decision needed:** today public prints and private fills are published at execution.
With settlement, the options are:

- publish at execution, marked *pending settlement*, with possible bust notices;
- publish only after settlement, which adds latency and holds back market data.

Recommended for the prototype: **private fills show `pending` until settled, and public prints are
published at execution** (unchanged), with bust notices if needed.

**Finality:** Stellar finality is per ledger, with no reorganisations, so a successful settlement is
final.

## 6. Transaction capacity, fees, storage lifecycle

### Work per settled fill (per-fill mode)

| Item | Count |
|---|---|
| ed25519 verifications | 2 (first use of each order) |
| Persistent writes | `filled` ×2, balances ×4 (base and quote × 2 users), cursor (instance) |
| Reads | registered keys ×2, epochs ×2 |
| Events | 1 |

### To measure in the spike (none assumed)

| # | Measurement |
|---|---|
| M1 | CPU instructions and memory per ed25519 verification, and per complete fill |
| M2 | Read/write entry and byte counts per fill, against the per-transaction limits: **this decides the maximum batch size *k*** |
| M3 | Resource fee and inclusion fee per fill, for k = 1 and the largest feasible k |
| M4 | Ledger-wide Soroban capacity, which gives a throughput ceiling in fills per ledger and per second, against the engine's capacity (orders of magnitude higher) |
| M5 | Ledger close time distribution, for setting S_max and D |
| M6 | TTL behaviour: maximum TTL for temporary and persistent entries, rent per entry, behaviour of archived entries and automatic restoration on access (Protocol 23 behaviour, to verify), cost of extending the TTL of balances and counters |

### Storage lifecycle plan

| Data | Storage | Lifetime |
|---|---|---|
| Configuration, operator, cursor, anchors (latest) | instance | contract lifetime; TTL extended by the operator |
| `balance[user][asset]`, `epoch`, registered key, `pending` | persistent | long-lived; extended on use. An archived balance must still be withdrawable: restoration has to be possible without the operator (confirm in M6). |
| `filled[orderHash]` (and optionally `verified`) | temporary **only if** its maximum TTL ≥ `MAX_ORDER_LIFETIME` + margin; otherwise persistent | until order expiry + margin |

### Expected outcome

Settlement throughput will be the venue's bottleneck by orders of magnitude, so the prototype is a
low-throughput settlement layer. Batching (D9) and netting are optimisations to be measured, not
assumed.

## 7. What on-chain journal anchoring can and cannot prove

**Mechanism:**

- At a **fixed cadence** (for example every *N* ledgers, whether or not anything happened), the
  operator writes the current **journal head hash** to the contract.
- Each settlement also carries the journal position of its fill.
- **Anchors publish the head only, not the sequence number.** Sequence numbers would reveal the number
  of commands, hidden-order activity included, contrary to the spirit of H-1 and H-8. A fixed cadence
  avoids revealing activity through timing. What remains visible is whether the head changed in an
  interval.

### Can prove, to anyone holding the journal

1. **Non-rewriting after the fact.** Any journal later presented must extend every anchored head: a
   fork or rewrite of anchored history is evident (hash chain, D-2).
2. **Timing bound.** Each anchored prefix existed by that ledger's close time.
3. **Settlement completeness up to an anchor.** Every execution in the journal up to an anchored head
   appears exactly once in the settlement cursor sequence, and every settled fill appears in the
   journal. This is how skipped or invented fills (§4) become detectable.
4. **Contract-level facts** (no journal needed): every settled fill satisfied the signed limits (G1,
   G2), exactly once (G3), and balances are conserved (G5).

### Cannot prove

1. **Fair ordering or honest matching.** The operator journals whatever it chooses, including its own
   orders ahead of a user's. An anchor commits to the manipulated sequence just as well.
2. **Completeness of intake.** Orders the operator drops or delays before journaling never appear.
3. **Anything within the unanchored window.** Between anchors the operator can still reorder before
   committing.
4. **Correctness without disclosure.** The head hash reveals nothing. Checking content requires the
   journal, which contains hidden orders. That means disclosure to an auditor under NDA, or a future
   zero-knowledge proof (out of scope).
5. **History before the first anchor**, or truth beyond the operator's word: anchors are signed by the
   operator key, so a compromised key can anchor bogus heads. It cannot alter earlier anchors on the
   ledger.
6. **Privacy.** Anchoring does not hide settled fills, which are public and account-linked.

Anchoring therefore closes the long-open "no external trust anchor" item **for tamper-evidence**
(VERIFICATION-REPORT §5), not for fairness.

## 8. Threats and mitigations (summary)

| Threat | Mitigation | Residual |
|---|---|---|
| Operator steals or overfills | G1–G3 enforced by the contract | — |
| Operator front-runs, reorders, censors | Anchoring plus audits make history tamper-evident | Not preventable |
| User free option (void fills by cancelling) | Delayed invalidation; S_max < D | The operator must meet S_max |
| Operator key compromise | Limits enforced on-chain; caps; short order lifetime; HSM; time-locked rotation | Worst execution within limits |
| Replay across network, contract or time | Domain separation; expiry; epoch; cumulative limit | — |
| Storage expiry enabling over-fill | TTL rules (§3.2, §6); missing counter is an error after first fill | Depends on M6 |
| Issuer freeze or clawback | List only assets without clawback in the spike; settlement break otherwise | Real assets need issuer review |
| Rounding and overflow | Exact integer scales; i128; listing-time checks | — |
| Upgrade or admin abuse | Immutable contract, or time-locked upgrades with a public delay | Governance needs a decision |
| Fee or resource exhaustion | Measured limits; settlement caps; monitoring | Network congestion |
| Anchor or sequence leakage | Head only, fixed cadence | Activity yes/no per interval |

## 9. Bounded testnet spike (after this design is approved)

> **Done:** see [`STELLAR-SPIKE-RESULTS.md`](STELLAR-SPIKE-RESULTS.md) for the measured values of M1–M6
> and the go/no-go.

**Time box:** 2 engineer-weeks.

**Rules:**

- testnet only;
- no vault contract: measurement contracts only;
- keys generated at runtime, funded by friendbot, never written to the repository;
- everything re-deployable after testnet resets.

| Step | Output |
|---|---|
| S1 | Install `stellar-cli`; pin the versions of `soroban-sdk` and the CLI |
| S2 | A measurement contract: `verify(pubkey, msg, sig)` ×n; write n counters; write n balances. Measure M1–M3 through transaction simulation and real submission |
| S3 | Order-format round trip: TypeScript signer ↔ Rust verifier, with cross-network and cross-contract replay attempts rejected |
| S4 | TTL experiments M6: temporary versus persistent maximum TTL, archival, restoration |
| S5 | Anchoring cost and cadence; M4 and M5 from network metrics |
| S6 | Report with measured values; fills each D, S_max and k with numbers; go/no-go |

**Go criteria:** all of these must hold.

- k ≥ 1 per-fill settlement fits comfortably within transaction limits, and the batch size reaches a
  useful k (to be set with the numbers, for example ≥ 10).
- The fee per fill is acceptable for a testnet demonstration.
- The exit, delayed-invalidation and counter-lifetime rules (§1–§3) are implementable within the
  measured limits.
- No unresolved over-fill, free-option or fund-stranding path remains in this design after review.

**Otherwise:** fall back to B2, anchoring-only integration, or stop.

## 10. Decisions needed before any vault contract

1. The values of *D*, *S_max* and `MAX_ORDER_LIFETIME` (after the spike).
2. Public print timing: at execution (recommended) or at settlement.
3. A trade-bust mechanism: an engine change, separate design.
4. Engine funded-order reservations (D7): the correctness design above becomes an implementation
   proposal.
5. Trading-key registration model, and whether a co-signed fast exit is offered.
6. Contract governance: immutable, or time-locked upgrade.
7. Storage class for fill counters (after M6).
