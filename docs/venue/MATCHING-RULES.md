# Nova Venue — Matching Rules Specification

Status: Milestone 8 design, implemented by the **local prototype** in `src/venue/`. It uses
synthetic instruments and accounts only. It is not connected to funds or to any external venue.

This is the normative rule set for the prototype. Each rule has an ID. Every ID is verified by at
least one test whose name starts with that ID. `src/venue/docs.test.ts` fails if a rule here has no
test. Related documents:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [ORDER-STATE-MACHINE.md](ORDER-STATE-MACHINE.md)
- [THREAT-MODEL.md](THREAT-MODEL.md)

Keywords: **must** means the engine enforces it. **Leak** marks an information channel that the
design reduces but does not remove.

## 1. Instruments and units

- **I-1** **Exact units.** The engine works only in integers:
  - Price is a whole number of **ticks**. Quantity is a whole number of **lots**.
  - At the gateway, prices and quantities arrive as plain decimal strings. They are converted
    exactly, or refused. Refused forms:
    - exponent, sign, hex, whitespace, separators
    - non-ASCII digits, leading zeros
    - non-zero digits beyond the instrument's precision
    - values that are not a multiple of the tick or lot size
    - zero
  - Errors name the field and never echo the submitted value.
- **I-2** **Price limits.**
  - A limit price must lie within `[minPriceTicks, maxPriceTicks]`.
  - It must also lie within ±`priceBandBps` of the reference price, which acts as a fat-finger
    collar:
    - The reference price starts at the configured value.
    - After that, it is the price of the last execution.
  - Integer form of the band check: `|p − ref| · 10 000 ≤ band · ref`.
- **I-3** **Quantity limits.** Quantity must lie within `[minQtyLots, maxQtyLots]`.

Configuration is validated with Zod (`instrumentSpecSchema`):
- Prototype instrument IDs must match `SYN-*`.
- `maxPriceTicks × maxQtyLots` must be an exact integer in a double, so that every single-order
  notional is exact.

Example instrument `SYN-ALPHA`:

| Parameter | Value |
|---|---|
| Tick | 0.50 |
| Lot | 0.001 |
| Price band | ±10 % |
| Minimum hidden size | 0.100 |
| Reference price | 2 000.00 |

## 2. Order types and attributes

| Attribute | Values | Notes |
|---|---|---|
| type | `limit`, `market` | A market order is a marketable limit order whose price is the band edge (M-9) |
| time in force | `gtc`, `ioc`, `fok` | |
| visibility | `displayed`, `hidden` | A hidden order must be a GTC limit order of at least `minHiddenQtyLots` (H-6) |
| post-only | boolean | GTC limit orders only (M-10) |
| self-trade prevention | `cancel-taker` (default), `cancel-maker`, `cancel-both` | S-1 |

**Immutable after entry:** side, instrument, visibility, time in force, post-only, STP mode.
Replace (P-2…P-4) may change only price and quantity.

### Not implemented in the prototype

These are deliberate, documented omissions:

- **Icebergs** (a displayed slice plus a hidden reserve).
- **Midpoint pegs.**
- **Minimum execution quantity on hidden orders.** This would blunt small probes, but an incoming
  order that skips a hidden order needs a rule for the resulting crossed state. That rule is not
  designed yet. See [THREAT-MODEL.md](THREAT-MODEL.md) T-H4.
- **Auctions, fees, expiry times and stop orders.**

## 3. Matching

- **M-1** **Continuous matching on arrival.** An incoming order is first matched against resting
  orders on the opposite side, for as long as their price crosses its limit. Matching of resting
  orders only ever happens when another order arrives or is replaced.
- **M-2** **Execution price.** Every execution happens at the resting (maker) order's price. The
  taker never trades beyond its limit.
- **M-3** **Price priority.**
  - A better-priced resting order always executes before a worse-priced one.
  - This holds whatever the order's visibility or arrival time.
- **M-4** **Displayed priority.** At one price, every displayed order executes before any hidden
  order, even hidden orders that arrived earlier.
- **M-5** **Time priority within a class.**
  - Within one price and one visibility, orders execute in the order they obtained priority.
  - Priority is the sequence number of the command that gave it.
  - Each price level keeps two FIFO queues, displayed and hidden. Queue order is ascending priority.
    Reconciliation checks this.
- **M-6** **The book is never crossed.** This includes hidden orders: at rest, the best bid is
  always strictly below the best ask over all orders. It follows from M-1, and it is checked by
  property tests after every command.
- **M-7** **Remainders after matching:**
  - GTC: the remainder rests in the book.
  - IOC: the remainder is cancelled (`ioc-remainder`).
- **M-8** **FOK is all-or-nothing and atomic.**
  - The match is planned without changing anything.
  - If the plan does not fill the whole quantity, nothing in it is applied: no fills and no STP
    cancellations. The order is accepted, then cancelled with `fok-unfilled`. Each `fok-unfilled`
    counts toward the account's FOK budget at the gateway (H-7).
- **M-9** **Market orders.**
  - Treated as IOC or FOK limit orders priced at the band edge: reference × (1 ± band).
  - They never rest. They cannot be GTC, hidden or post-only.
  - They must not include a price. A limit order must include one.
- **M-10** **Post-only.**
  - An order that would execute against **any** resting order is rejected with
    `post-only-would-take`, whether that order is displayed or hidden.
  - **Leak:** see H-7.

## 4. Fills

- **F-1** **Partial fills.**
  - A partially filled resting order keeps its place in the queue, and its remaining quantity
    shrinks.
  - Status goes `new → partially-filled → filled`.
  - A taker's fills are applied in order. Its status follows the same path.
- **F-2** **Fill reports.**
  - Each execution produces one private `fill` event for the maker and one for the taker.
  - Each report describes only the recipient's own order: price, quantity, liquidity
    (maker/taker), cumulative filled, leaves and status.
  - Reports contain no counterparty identity and no counterparty visibility.
  - Maker and taker get **distinct** opaque fill IDs, so the two parties cannot link their reports
    by ID.

## 5. Cancel and replace

- **P-1** **Cancel.**
  - Only the owning account can cancel, by order ID or client order ID.
  - Another account's order gets `unknown-order`, the same response as an ID that does not exist.
  - The owner's terminal orders get `order-not-modifiable`.
  - Cancels are accepted while trading is halted.
- **P-2** **Replace and priority.** Replace is atomic. Priority is **kept** only for a size
  reduction at the same price. Any of these **loses** priority, and the order moves to the back of
  its new queue:
  - a price change
  - a size increase
- **P-3** **Replace quantity semantics.**
  - The new quantity is the **total** order quantity, as in FIX.
  - It must be greater than the filled quantity. Otherwise the replace is refused with
    `replace-quantity-below-filled`.
  - A replace that changes nothing is refused with `replace-no-change`.
  - Effect on a racing partial fill: a fill that lands before the replace counts against the new
    total, so a replace can never raise exposure beyond what the client asked for.
- **P-4** **Crossing replace.**
  - A replace whose new price crosses the opposite side trades immediately as a taker, at the
    makers' prices.
  - The remainder rests with the new priority.
  - A post-only order whose replace would cross is refused, and the order stays unchanged.
- **P-5** **Mass cancel.**
  - Cancels all of the caller's resting orders, optionally for one instrument only.
  - Never touches other accounts.

Replace is subject to the same price, quantity, hidden-size, risk and trading-status checks as a
new order.

## 6. Self-trade prevention

- **S-1** **STP modes.**
  - Two orders of the same account never execute against each other.
  - The **incoming** order's mode decides what happens:
    - `cancel-taker`: stop matching, cancel the taker's remainder. Earlier fills against other
      accounts stand.
    - `cancel-maker`: cancel the resting order and continue matching.
    - `cancel-both`: cancel both.
  - The STP identity is the account. STP groups across accounts are future work.
- **S-2** **STP and hidden orders.** STP applies to the account's hidden orders exactly as to its
  displayed ones. This reveals nothing new, because the account already knows its own orders.
- **S-3** **FOK with STP.** STP cancellations are part of the FOK plan (M-8). A FOK that fails
  cancels no resting order.

## 7. Hidden orders

What hidden orders are, and what they are **not**: they are hidden by **server-side access
control**. They are not hidden cryptographically.

- The matching engine, its operators, and anyone with access to the journal or snapshots can see
  every hidden order in full.
- Nothing in this design provides cryptographic confidentiality.
- Encrypted or commit-reveal order flow is a separate, future mode (`docs/PRIVACY.md`, mode
  `encrypted`).

- **H-1** **Concealed from public market data.** Hidden orders affect no public message:
  - not their existence, price, size or side
  - not their account, client ID or order ID
  - not their arrival time, changes or cancellation
  - not how many there are

  The public feed has its **own** sequence counter:
  - Hidden activity produces no public message.
  - Hidden activity also produces no public sequence gap.
  - Levels that hold only hidden orders do not exist in the public book.

  A property test checks this (non-interference). Adding hidden orders that never trade leaves
  every public message, public sequence number, timestamp and other account's private events
  unchanged.
- **H-2** **Visible to the matching engine.** The engine holds hidden orders in full:
  - price, size, side, account, time
  - remaining quantity
  - STP mode

  It needs all of these to match. Operator tooling (`inspectBook`) and the audit log show them. Any
  real deployment must restrict and audit that access (THREAT-MODEL T-O1).
- **H-3** **Hidden-order priority.** Priority is price (M-3), then displayed before hidden (M-4),
  then time within the hidden queue (M-5). A hidden order at a better price executes before
  displayed orders at a worse price.
- **H-4** **Interaction with displayed liquidity.** Hidden and displayed liquidity interact in both
  directions:
  - Any incoming order, displayed or hidden-flagged, executes against resting hidden orders.
  - An incoming hidden-flagged order takes displayed liquidity like any other order. Its
    visibility applies only to the remainder that rests.
- **H-5** **Disclosure of executions.**
  - **Public:** one trade print per aggressing order and price. A print contains:
    - public trade ID
    - instrument, price and summed quantity
    - aggressor side
    - publication timestamp

    A print contains no maker or taker identity, no order IDs, no visibility flag, and no count of
    makers.
  - **Private:** fill reports as described in F-2. The taker's private events are identical
    whether the liquidity it hit was hidden or displayed (tested).
  - **Audit (operator only):** the full execution record, including both accounts and the maker's
    visibility.
  - **Leak (inherent):**
    - A print at a price with no displayed level shows that non-displayed liquidity was there.
    - So does a print larger than the displayed quantity removed (print 0.500 when only 0.300 was
      displayed means at least 0.200 was hidden).
    - Aggregation hides how many orders there were and which ones; it cannot hide that hidden
      liquidity traded.
- **H-6** **Eligibility.** Hidden orders must be GTC limit orders of at least `minHiddenQtyLots`,
  and must stay at or above it when replaced. This discourages dust and cheap hidden probes. It
  does not prevent probing.
- **H-7** **Post-only probing.**
  - **Leak:** a post-only rejection inside the displayed spread is a free signal that something
    rests at that price.
  - Mitigation: the gateway counts post-only rejections per account, for new orders **and for
    replaces of post-only orders** (Milestone 9, VR-03). After `limit` of them in a window (default
    20 per minute), it refuses new post-only orders and replaces of post-only orders from that
    account until the window passes. Reconnecting does not reset the budget.
  - IOC probing is not throttled separately, but it costs an execution and is visible to
    surveillance.
  - **Leak (budgeted since Milestone 11, VR-08):** a FOK that cannot fill reveals "less than Q at or
    better than P" without executing. Every unfilled FOK (limit or market) counts toward a separate
    per-account budget (`fokUnfilled`, default 20 per minute). Once it is spent, new FOK orders are
    refused (`rate-limited`) before journaling until the window passes. Reconnecting does not reset it.
    Counting depends only on the caller's own outcome, so the throttle reveals nothing further. Within
    the budget the probe is still free, and Sybil accounts multiply it.
- **H-8** **No side channels through identifiers or sequences.**
  - Order, fill and execution IDs are a keyed hash of an internal counter (`o…`, `f…`, `x…`).
    Sequential IDs would let a client count other participants' activity, hidden activity included,
    between two of its own orders.
  - Private events carry a **per-account** sequence number, never the global one.
  - Public messages carry the **public** sequence only.
- **H-9** **Batched publication.** With `publication: "batched"`, the public feed is published only
  on `publish` ticks, which are journaled commands. In the prototype, the driver (demo or tests)
submits them. A sequencer-owned fixed-interval scheduler is **not implemented** (VR-12). Within an
interval:
  - Changes to a displayed level are netted: an add followed by a cancel publishes nothing.
  - Messages carry the publication time, not the event time.

  This reduces leaks from timing and per-event aggregates. Prints still reveal executed volume and
  price.

## 8. Risk and trading status

- **R-1** **Pre-trade risk.** Checked per account before acceptance and on every replace:
  - **Resting orders:** at most `maxOpenOrders` (checked for GTC orders).
  - **Notional:** each order's notional (`price × total quantity`, in tick·lot units) must not
    exceed `maxOrderNotional`. A market order uses its protection price.
  - **Worst-case position:** `|position + open lots on the order's side + new quantity|` must not
    exceed `maxPositionLots`, assuming every open order on that side fills (IOC orders included).

  These are synthetic limits. There is no margin, collateral or liquidation in the prototype (see
  ARCHITECTURE §11).
- **R-2** **Trading status.** `continuous` or `halted`, changed by an operator command and published
  as a `status` message. While halted:
  - New orders and replaces are refused.
  - Cancels are accepted.
  - Resting orders stay in the book.
- **R-3** **Account suspension.** An operator command cancels all of the account's resting orders
  (`account-suspended`) and refuses its new orders.

## 9. Determinism and durability

- **D-1** **Determinism.**
  - Engine state and outputs are a pure function of the ordered command journal.
  - The engine reads no clock, randomness, environment or network.
  - It refuses sequence gaps, duplicate sequence numbers, and timestamps that go backwards.
  - Replaying from scratch, or from any snapshot plus the journal suffix, reproduces the state hash
    and the output hash chain.
- **D-2** **Journal integrity.**
  - The journal is written ahead of processing and is hash-chained.
  - With a `JournalStore`, the commit point is the store's `append` returning **and**, since Milestone
    11, the commit-anchor write returning (D-6). Any error in either means the outcome is unknown, and
    the venue stops (VR-07).
  - On read it is treated as untrusted. Each entry is parsed, its command validated with the
    schema, and its sequence and hash chain checked.
  - Recovery takes journal text or a store, never both. The store is repaired only after the
    journal, the snapshot and the replay have all succeeded (VR-21, VR-22).
  - A torn final line, meaning an **unparseable** final line without a newline, is dropped (and
    truncated from the store). Under the store contract that command was never acknowledged. The
    reader cannot verify the contract; since Milestone 11 the commit anchor does (D-6): a torn line at
    or before the anchored sequence is refused, never dropped.
  - A final line that parses as JSON but fails validation is a complete, corrupt entry, not a torn
    write. It refuses recovery even without a trailing newline (VR-28).
  - A complete final entry without its newline counts as committed. The newline is restored before
    the next append.
  - Duplicate and conflicting records follow D-5: every one refuses recovery, with a precise
    classification.
  - Any other inconsistency is corruption, and recovery stops.
  - A snapshot must reference the journal entry it was taken after, and the restored state must
    reproduce the snapshot's `stateHash` (VR-05).
  - A rewrite of the *whole* chain is detectable only against an externally anchored head.
- **D-3** **Fail-stop.**
  - Any internal fault or invariant violation stops the engine.
  - The command that faulted was already journaled, so its outcome is unknown. The gateway answers
    `outcome-unknown`; recovery may apply it.
  - Every later command is refused **before** it is journaled, and the gateway answers
    `unavailable` ("nothing was recorded") (VR-01).
  - While stopped, order and open-order queries refuse rather than serve possibly half-applied
    state. Private events (committed outputs only) stay readable (VR-19).
  - A command that faults deterministically also faults on replay. Recovery then stops and names
    its sequence number (VR-18). Since Milestone 11 an operator may quarantine it if it is the final
    entry (D-7); that is the only exception to "a journaled command takes effect on recovery".
  - A snapshot whose holdings disagree with its orders is refused on restore.
- **D-4** **Duplicate outputs after recovery.**
  - Outputs regenerated after recovery carry the same sequence numbers: `publicSeq`, `accountSeq`,
    and command `seq`.
  - Consumers drop sequence numbers they have already processed.
  - A public consumer that sees a gap marks its book stale.
- **D-5** **Duplicate and conflicting journal records: fail-closed** (details:
  [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §2).
  - Every duplicate refuses recovery, with a precise classification:
    - `duplicate of the last entry (seq k)`, including a copy at the very end of the file, with or
      without a newline
    - `copy of earlier entry j`
    - `sequence number N reused with different content`, including a valid-hash re-serialisation
    - `sequence gap`
    - `empty line`
  - A refused recovery leaves the store untouched.
  - A byte-identical copy of the last entry is **not** treated as harmless. It cannot be told apart
    from a store that acknowledged a later append but persisted the previous bytes, which would lose
    an acknowledged command (VR-24). Automatic repair would need an independently persisted commit
    record, which does not exist.
  - A partial final line (torn write, unparseable) is still dropped as uncommitted. This relies on
    the store contract that an append is acknowledged only once it is durable. A store that breaks
    it can lose an acknowledged entry by truncation or omission without detection.

- **D-6** **Commit anchor** (Milestone 11; details: [DURABILITY-AND-RETENTION.md](DURABILITY-AND-RETENTION.md) §1).
  - A store-backed venue has a `CommitAnchorStore` beside its `JournalStore`. For every command the sequencer
    appends the entry to the journal, then writes the anchor `{ seq, hash }`, then processes. **Both writes
    together are the commit point.** If either fails, the outcome is unknown: the gateway answers
    `outcome-unknown` and the venue stops (D-3).
  - Recovery requires the journal to contain the anchored entry with the anchored hash. It refuses, without
    changing either store, when:
    - the journal ends before the anchored sequence number (acknowledged entries missing);
    - the anchored entry is the incomplete final line (an acknowledged entry truncated: never dropped as torn);
    - the anchored entry's hash differs;
    - the anchor is missing for a non-empty journal, unreadable or invalid.
  - Complete entries after the anchor are applied (their client got `outcome-unknown`); an unparseable final
    line after the anchor is still dropped as a torn write (D-2).
  - **Operator bootstrap** of a missing or unreadable anchor: only through `Venue.recover` with an explicit
    `bootstrapAnchor { reason, approvedBy }`, after a verified full replay (no snapshot). It journals an
    `admin.anchor-bootstrap` audit record, which anchors the journal and changes no engine state. A readable
    anchor is never replaced. `approvedBy` is free-text metadata, **not** an authenticated approval.
  - A store without an anchor is refused unless `allowUnanchored: true` is passed explicitly (the Milestone
    10 behaviour). Duplicate and conflicting entries stay fail-closed (D-5): no automatic repair.
  - In memory, the anchor detects integrity faults of a non-conforming store. It is **not** evidence of
    physical durability, and it does not stop an insider who can rewrite both stores (§5 of the report).

- **D-7** **Quarantine of a poison command** (Milestone 11, VR-18; details:
  [DURABILITY-AND-RETENTION.md](DURABILITY-AND-RETENTION.md) §2; runbook:
  [runbooks/POISON-COMMAND.md](runbooks/POISON-COMMAND.md)).
  - Only an operator can quarantine, only through `Venue.recover` with an explicit `quarantine` request, and
    only when **all** of these hold; otherwise recovery refuses without changing either store:
    - the entry is the **final** valid journal entry (fail-stop, D-3, means a live fault is always last; a
      fault in the middle of the journal signals non-determinism and is never quarantined);
    - its hash matches;
    - its fault **reproduces** (checked on a scratch copy of the state just before it);
    - the evidence attests the same engine build and a non-successful client outcome, and the observed
      public and per-account sequences do not exceed those that existed before the entry (no externally
      acknowledged execution, fill or other output);
    - no snapshot includes the entry.
  - The quarantined entry is **voided** deterministically: it takes no effect, and the submitter gets a
    definitive `rejected` / `request-rejected` with reason `quarantined` (other commands: an admin error).
  - The decision is journaled immediately after the voided entry as `admin.quarantine` (anchored, D-6). Every
    later replay — full, from a snapshot, or by a replica — voids the same entry without operator input. A
    record that does not reference the immediately preceding entry is refused as corruption.
  - The identical command is refused before journaling from then on (`quarantined`); `suspendAccount`
    suspends its account in the same record.
  - **Journal-schema change:** `admin.quarantine` and `admin.anchor-bootstrap` are new command types. A
    Milestone 10 reader refuses a journal that contains them (`invalid command`); journals without them are
    unchanged and read by both.
  - `approvedBy`, `reason` and `notes` are free-text metadata, **not** an authenticated approval.

## 10. Gateway and access

- **A-1** **Authentication.**
  - A session token maps to exactly one account.
  - The account is taken from the session and never from the message. A body field `accountId` is
    refused by the strict schema.
  - Queries return only the caller's own orders and events.
- **A-2** **Separation of public and private data.**
  - Public messages are validated against strict schemas that have no account, order, client or
    visibility fields.
  - Every private event is routed only to its account.
  - A gateway response contains only the caller's events, even when the command also produced
    events for a counterparty.
  - Delivered events and public messages are immutable. The first response, the private feed, the
    public tape and every public listener receive frozen objects, so no consumer can change what
    another observes (VR-29).
- **A-3** **Message rate limit.**
  - Limited per account with a sliding window (default 200 messages per second).
  - Excess messages are refused before they are journaled, with `retryAfterMs`.
  - Refusals are logged with timestamp, account and code only, never the payload. The log keeps the
    most recent 10 000 records, plus totals per code (VR-04).
- **A-4** **Idempotent order entry** (details: [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §1).
  - Keyed by account and client order ID.
  - Two messages are the **same request** if and only if they normalise to the same engine command
    (integer ticks and lots, defaults applied).
  - **While the ledger entry is retained** (same process, after a full replay, or after a snapshot
    restore):
    - An identical retry returns `replayed: true` with a fresh copy of the original events, and is
      not journaled.
    - A conflicting retry gets `idempotency-conflict`, and is not journaled.
  - The **idempotency ledger** holds deep-frozen copies of accepted orders' commands and events. It is
    rebuilt from the journal, and carried in snapshots with its capacity under a verified hash.
  - **After eviction** (capacity *C*, 100 000 by default; the most recent *C* accepted orders are
    retained):
    - Identical and conflicting retries both get `rejected: duplicate-client-order-id` and are
      journaled as rejections.
    - The original order can be looked up with `gateway.order(token, { clientOrderId })`.
  - **No second execution, in every case**, is enforced by the engine's permanent client-ID index, not
    by the ledger. Any change to the unbounded-growth risk VR-13 must keep that index.
  - **Capacity across restarts:** a snapshot restore under a different capacity is refused. A full
    replay follows the configured capacity; this changes which retries replay, never execution.
  - A rejected order creates no ledger entry, so a retry is evaluated again (§11).
  - `outcome-unknown`: once the venue is recovered, an identical retry returns the original events if
    the command was committed and accepted. Otherwise it is evaluated as a new request.
- **A-5** **Order-ID key policy** (details: [RECOVERY-INTEGRITY.md](RECOVERY-INTEGRITY.md) §3).
  - `Venue` and `Venue.recover` refuse an `idKey` that:
    - is shorter than 43 characters
    - is outside the base64url alphabet
    - has fewer than 16 distinct characters
    - is a registered test-fixture key without `allowTestFixtureIdKey: true`
  - The flag admits only the registered fixture keys; it never relaxes the policy for any other key.
  - `generateIdKey()` produces a conforming key (32 random bytes).
  - Errors never echo the key.
  - Fixture key literals exist only in `id-key.ts` and tests (static check).
  - Key rotation and storage are not covered (open).

- **A-6** **Retention and its limits** (Milestone 11, VR-13; details:
  [DURABILITY-AND-RETENTION.md](DURABILITY-AND-RETENTION.md) §3).
  - **Private events:** each account's outbox keeps the most recent `outboxCapacity` events (default
    10 000). Loss is **explicit**: `Venue.privateEventsPage` / `gateway.eventsPage` return
    `{ events, firstAvailableAccountSeq, latestAccountSeq, gap }`, and `gap` is true whenever events after the
    caller's cursor were dropped or are not retained (outbox overflow, or a restore from a snapshot). The
    client then resynchronises from its order queries. The older `events()` reader is unchanged and silent.
  - **Audit stores** (`executions`, `transitions`, `publicTape`, `adminErrors`): optional caps
    (`auditRetention`), **disabled by default**. When a cap evicts, `auditEvicted` counts it and
    `historyComplete` becomes false; full reconciliation is done by replaying the journal.
  - **Never trimmed:** the engine's client-ID index and its terminal orders. They are what refuses a second
    execution after an idempotency-ledger eviction (A-4) and what answers a lookup by client order ID, so they
    grow with every accepted order in the prototype. The long-term design is a durable client-ID index and
    order archive, not a bounded client-ID validity window.

## 11. Order of validation

New orders are checked in this order, and the first failure decides the rejection reason:

1. account
2. trading status
3. quantity
4. type and price rules
5. hidden eligibility
6. post-only
7. duplicate client ID
8. risk
9. post-only crossing

The gateway runs its own checks first (RECOVERY-INTEGRITY §1, extended in Milestone 11): session and
rate limit, schema, instrument and exact decimal conversion, idempotency-ledger lookup, post-only
throttle, **unfilled-FOK throttle (H-7)**, then the sequencer. The sequencer refuses an operator record
(D-6, D-7) and a quarantined command (D-7) before journaling.

All checks happen before any state changes. A rejected order consumes neither its client ID, at the
engine or the gateway, nor any book, order, position or public state. It does consume one
`accountSeq` (its `rejected` event) and may leave an empty holding record (VR-11).
