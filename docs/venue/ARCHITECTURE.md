# Nova Venue — Architecture of a Native Matching Venue with Hidden Orders

Status: **Milestone 8: design and local prototype; independently verified and hardened in Milestone 9** ([VERIFICATION-REPORT.md](VERIFICATION-REPORT.md): verified with limitations). The prototype (`src/venue/`) works as follows:

- It runs in one process, on synthetic instruments (`SYN-*`) and synthetic accounts (`syn-*`).
- It has no network listener, no file I/O, no funds, no custody, no settlement, and no connection to
  Hyperliquid or any other venue.
- ESLint forbids the rest of the application from importing it, and forbids it from using the
  network or file system.

This is **not** a real-money exchange, and nothing here should be deployed as one. Section 13 lists
what must be built and independently reviewed first.

Companion documents:

| Document | Content |
|---|---|
| [MATCHING-RULES.md](MATCHING-RULES.md) | Normative rules (IDs referenced below as M-x, H-x …) |
| [ORDER-STATE-MACHINE.md](ORDER-STATE-MACHINE.md) | Order states, transitions, events |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Assets, adversaries, threats, mitigations, residual risk |
| [PERFORMANCE-PLAN.md](PERFORMANCE-PLAN.md) | Performance test plan and prototype baseline |
| [SECURITY-CHECKLIST.md](SECURITY-CHECKLIST.md) | Review checklist; components requiring independent review |

> **Confidentiality model.** Hidden orders are hidden from *other market participants and the
> public* by server-side access control and publication rules. They are **not** cryptographically
> confidential:
> - The matching engine, its operators, and anyone with access to the journal, snapshots, memory or
>   audit logs can read them in full.
> - No statement in this design should be read as a cryptographic guarantee.

## 1. Goals and non-goals

**Goals**

- Deterministic, auditable price-time matching with native hidden orders.
- A precise statement of what is concealed, from whom, and what still leaks.
- Strict separation of public market data from private account data.
- Durable, replayable processing with tamper-evident audit records.

**Non-goals for this milestone**

- Real funds, deposits, withdrawals, custody, margin, liquidation, settlement or fees.
- Network-facing APIs.
- High availability.
- Production performance.
- Regulatory reporting.
- Encrypted order flow.

## 2. Components

```
            synthetic clients (in-process calls; no network listener)
                     │  session token + JSON message
                     ▼
┌───────────────────────────────────────────┐
│ Gateway  (gateway.ts)                     │  authN (session→account), strict Zod schemas,
│                                           │  exact decimal→tick/lot conversion, per-account
│                                           │  rate limits, post-only probe throttle,
│                                           │  idempotency, response = caller's events only
└───────────────┬───────────────────────────┘
                │ EngineCommand (integers only)
                ▼
┌───────────────────────────────────────────┐
│ Sequencer  (venue.ts, journal.ts)         │  validate → assign seq + ts → append to
│                                           │  hash-chained journal (write-ahead)
└───────────────┬───────────────────────────┘
                │ SequencedCommand
                ▼
┌───────────────────────────────────────────┐
│ Matching engine  (engine.ts, book.ts)     │  deterministic, single-threaded, fail-stop;
│                                           │  books, risk, matching, STP, lifecycle
└──┬──────────────┬──────────────┬──────────┘
   │ public       │ private      │ executions, transitions
   ▼              ▼              ▼
 public tape   per-account     audit stores ── reconcile.ts (independent re-derivation)
 (publicSeq)   outboxes        output hash chain
   │           (accountSeq)
   ▼
 PublicBookMirror (consumer; gap detection, de-duplication)

 Operator commands (admin.*) enter through the sequencer and are journaled like any other command.
 Snapshots (engine + journal head + output head) and recovery: Venue.snapshot / Venue.recover.
```

| Module | Responsibility |
|---|---|
| `instrument.ts` | Instrument and account-limit schemas; exact decimal conversion; synthetic instruments |
| `types.ts` | Engine command schema (also used to re-validate the journal); private events; strict public message schemas |
| `book.ts` | Price levels, displayed and hidden FIFO queues, sorted sides |
| `engine.ts` | Validation, risk, matching, STP, lifecycle, publication, snapshot/restore, state hash |
| `state-machine.ts` | Allowed transitions |
| `journal.ts` | Canonical JSON, SHA-256 hash chain, untrusted journal reader |
| `venue.ts` | Sequencer, output routing, output hash chain, recovery |
| `gateway.ts`, `rate-limit.ts` | Order entry, authentication, validation, abuse controls |
| `public-feed.ts` | Public-feed consumer (mirror) |
| `reconcile.ts` | Independent reconciliation |
| `synthetic.ts`, `demo.ts`, `bench.ts`, `cli/*` | Synthetic flow, demo, benchmarks |

## 3. Instrument configuration and trading rules

Each instrument (`instrumentSpecSchema`) defines:

- price precision and tick size
- quantity precision and lot size
- price range and quantity range
- price band in basis points around the reference price
- minimum hidden size
- initial reference price

All engine arithmetic is integer: ticks, lots, and tick·lot notional. A single notional is exact
because the schema requires `maxPriceTicks × maxQtyLots ≤ 2^53 − 1`. Cash balances are `bigint`.

Trading status is `continuous` or `halted`, set by operator commands and published (R-2). Account
limits (`accountLimitsSchema`) are:

- maximum resting orders
- maximum order notional
- maximum worst-case position

Rules: MATCHING-RULES §1–2 and §8.

## 4. Order book data structures

| Structure | Implementation (prototype) | Cost | Production direction |
|---|---|---|---|
| Book side | Sorted array of prices (best first) + `Map<price, PriceLevel>` | best O(1); new level O(L) insert; lookup O(1) | Array indexed by tick offset within the band, or a B-tree / skip list; bitmap of non-empty levels |
| Price level | Two `Map<orderId, Order>` queues (displayed, hidden); insertion order = time priority; cached displayed and hidden totals | append, remove, lookup O(1) | Intrusive doubly-linked lists in preallocated pools |
| Order index | `Map<orderId, Order>` (all orders, including terminal ones) | O(1) | Live orders in memory; terminal orders archived to the store |
| Client-ID index | `Map<account + clientOrderId, orderId>` | O(1) | Bounded by a retention policy |
| Account state | Resting-order set, per-instrument holdings (position, open buy and sell lots, cash) | O(1) per update | Same, plus margin state |

Matching walks levels best-first. At each level it consumes the displayed queue, then the hidden
queue (M-3…M-5). It is computed as a **plan** that changes nothing, so FOK and STP can be atomic
(M-8, S-3). The plan is then applied.

## 5. Price-time priority and matching

Order of priority:

1. price
2. displayed before hidden
3. time (the sequence number at which priority was obtained)

Every execution happens at the maker's price. The book is never crossed, hidden orders included.
Rules: MATCHING-RULES §3. Properties checked over random sequences:

- price, then displayed-before-hidden, then time order for every execution
- executions never beyond the taker's limit
- no IOC remainder cancelled while crossing liquidity is left (absent STP)

## 6. Public versus hidden visibility

| Data | Public feed | Other participants (private channel) | Order owner | Matching engine and operator |
|---|---|---|---|---|
| Displayed order: price, total displayed size per level | ✔ (L2 aggregate) | — | ✔ | ✔ |
| Displayed order: individual order, account, order ID | ✘ (no L3 feed) | ✘ | ✔ | ✔ |
| Hidden order: existence, price, size, side, time, count | ✘ | ✘ | ✔ | ✔ |
| Execution: price, size, aggressor side, time | ✔ (aggregated per aggressor and price) | — | ✔ (own fills) | ✔ |
| Execution: maker/taker identity, maker visibility | ✘ | ✘ (the counterparty is never named) | own side only | ✔ |
| Order and fill IDs | ✘ | ✘ | own only (opaque) | ✔ |
| Global sequence numbers | ✘ (public feed has its own sequence) | ✘ | ✘ (per-account sequence) | ✔ |

## 7. Hidden orders: the explicit specification

**7.1 What is concealed from public market data.** Everything about a hidden order:

- its existence, price, size and side
- its account and client order ID
- its arrival, modification and cancellation times
- the number of hidden orders, and which levels hold them

Hidden orders:

- produce no public message
- do not advance the public sequence
- do not appear in book snapshots

A level that holds only hidden orders does not exist publicly (H-1).

**7.2 What the matching engine sees.** Everything: price, size, side, account, time, remaining
quantity and STP mode. The engine needs all of these to match. The operator can see the same data
through `inspectBook`, the journal, snapshots and audit records (H-2). Restricting that access is an
operational control (THREAT-MODEL T-O1). It is not a cryptographic one.

**7.3 How matching priority works.**

- Price first: a better-priced hidden order beats worse-priced displayed orders.
- At the same price, displayed orders execute before hidden orders, even hidden orders that arrived
  earlier. This rewards participants who show liquidity.
- Within each class, time priority applies.

A hidden order that is replaced to a new price, or to a larger size, joins the back of the hidden
queue at its new price (H-3, P-2).

**7.4 Whether hidden liquidity interacts with displayed liquidity.** Yes, in both directions:

- Resting hidden orders execute against any incoming order.
- An incoming hidden-flagged order takes displayed and hidden liquidity like any other order. Only
  its resting remainder is hidden.
- Hidden orders may rest inside the displayed spread. The book (hidden included) never crosses,
  because every incoming order matches on arrival (H-4, M-6).

**7.5 How executions are disclosed and reported.**

- **Public:** one print per aggressing order and price, with price, summed quantity, aggressor side,
  public trade ID and publication time. A print contains no identities and no visibility flag, and
  it does not reveal how many makers or which visibility class took part.
- **Private:** each side gets a fill for its own order only, with a distinct opaque fill ID and no
  counterparty data. The taker's view is identical whether it hit hidden or displayed liquidity
  (tested).
- **Audit:** the operator keeps the complete record of both sides and the maker's visibility, for
  surveillance, disputes and any regulatory reporting a real venue would owe (H-5).

**7.6 How leakage through fills, timing and aggregate data is reduced, and what remains.**

| Channel | Mitigation in this design | What still leaks |
|---|---|---|
| Public messages on add, change or cancel of hidden orders | None are sent; separate public sequence (H-1) | — |
| Sequence-number gaps (public, private, IDs) | Public feed sequence counts public messages only; per-account private sequence; IDs are keyed hashes of a counter (H-8) | — |
| Prints revealing makers | Aggregated per aggressor and price; no maker count, IDs or visibility (H-5) | That *some* non-displayed liquidity traded, when the print exceeds the displayed quantity removed or occurs at a price with no displayed level |
| Taker's own fills | Same events for hidden and displayed makers | Fill price and quantity themselves (inherent) |
| Cheap probing | Minimum hidden size (H-6); post-only rejection throttle (H-7); message rate limit (A-3) | IOC probes inside the spread succeed at the cost of an execution; small post-only probes within the throttle budget |
| Timing of public updates | Optional batched publication with netting and publication timestamps (H-9) | Execution prints in the next batch; volume per interval |
| Engine processing time (latency side channel) | None in the prototype | A real deployment must decouple acknowledgement timing from book-walk length, for example by fixed-latency acknowledgement queues |
| Rejection reasons | Uniform `unknown-order` for foreign and non-existent IDs (P-1) | The post-only rejection reason (H-7) |
| Insiders | Not addressed by the engine; see THREAT-MODEL T-O1–T-O3 | Everything, to anyone with operator access |

## 8. Order validation and risk checks

There are three layers. A failure in any layer is final, and changes no state.

1. **Gateway (syntactic):**
   - session → account
   - strict schema
   - exact decimal conversion
   - rate limits and idempotency
2. **Engine (semantic, MATCHING-RULES §11):**
   - account and instrument state
   - quantity and price range, price band
   - order-type combinations, hidden eligibility, post-only rules
   - duplicate client ID
3. **Engine (risk, R-1):**
   - open-order count
   - order notional
   - worst-case position, assuming every open order on that side fills

The engine never trusts the gateway: every command is re-validated by schema before it is journaled,
and again when the journal is read back.

## 9. Order lifecycle, fills, cancellation, replacement

- **Lifecycle and events:** [ORDER-STATE-MACHINE.md](ORDER-STATE-MACHINE.md).
- **Partial fills:** makers keep their queue position (F-1).
- **Fill reports:** both sides, own order only (F-2).
- **Cancel:** owner only. Foreign and non-existent IDs give the same response (P-1).
- **Replace** is atomic, uses FIX-style total quantity, and keeps priority only for a same-price
  size reduction. A replace that crosses trades as a taker (P-2…P-4).
- **Self-trade prevention:** three modes, with the incoming order's mode applied (S-1…S-3).

## 10. Market-data publication

Message types (strict schemas, `publicMessageSchema`):

| Message | Fields |
|---|---|
| `status` | instrument, trading status |
| `level` | instrument, side, price, total displayed lots (0 = level removed) |
| `trade` | public trade ID, instrument, price, quantity, aggressor side |

Every message carries `publicSeq` (gap-free over public messages) and `ts` (publication time).

**Modes:**

- `immediate`: publish after each command.
- `batched`: publish on journaled `publish` ticks. Changes are netted per level. The timestamp is the
  tick time.

**Consumers:** `PublicBookMirror` validates each message, ignores duplicates, and marks itself stale
on a gap. A real feed would add periodic snapshots for re-synchronisation. The prototype exposes
`publicBook()` for this.

## 11. Audit logs and reconciliation

| Record | Content | Integrity |
|---|---|---|
| Command journal | Every sequenced command, operator commands included, with `seq` and `ts` | SHA-256 hash chain; re-validated on read |
| Output chain | Hash over every command result (private, public, executions, transitions) | Recomputed on replay; equal head means identical outputs |
| Executions | Both sides, accounts, maker visibility, price, quantity | Covered by the output chain |
| Transitions | Every order status change, with cause and `seq` | Covered by the output chain |
| Gateway refusals | Timestamp, account, error code (never payloads) | Not chained (pre-sequencer) |

`reconcile()` recomputes from primary records:

- Order quantities agree with status.
- Every live order is in exactly one queue at the right level, in priority order.
- Level totals equal the sum of their orders' remaining quantity.
- The book is not crossed.
- Published levels equal the displayed book, and a public mirror equals the published levels.
- Per-account open lots equal the remaining quantity of live orders.
- Account limits hold.
- Positions and cash net to zero per instrument.
- Executions re-derive every order's filled quantity and every position.
- No execution is a self-trade.
- Public prints account for exactly the executed volume.

Reconciliation runs after every command in the property tests and at the end of the demo.

**Tamper evidence is not tamper-proofing.** An operator who can rewrite the whole journal can
recompute the whole chain (this is tested). A real deployment must anchor journal heads somewhere the
operator cannot rewrite, and must restrict and audit access to the journal (THREAT-MODEL T-O2).

## 12. Failure recovery, durable processing, rate limits, data separation

**Durable processing (D-1…D-4)**

The order of work is:

1. refuse if the venue has stopped (nothing is journaled)
2. validate
3. append to the durable `JournalStore`; without a commit-record store, its return is the commit point
3b. with a commit-record store (Milestone 11, Venue): write the commit record. Only then is the
   command committed (D-6; [DURABILITY-PROTOCOL.md](DURABILITY-PROTOCOL.md))
4. process deterministically
5. hash outputs
6. record outputs in the idempotency ledger (accepted orders, A-4), the audit stores, the public
   tape and the per-account outboxes
7. notify public listeners, each in isolation

Routed events and public messages are deep-frozen before step 6, so every consumer (first response,
outbox, tape, listeners) receives the same immutable objects (VR-29).

Recovery is a verified read of the store and the commit record, plus an optional snapshot (bound to
its journal head and verified by `stateHash` and its rules version), plus replay of the suffix.
Since Milestone 11 (Venue) it has two phases:

- **Verify:** read-only; every refusal happens here.
- **Repair:** ordered steps, each read back. It is not atomic across the two stores, so an
  interrupted repair is completed by the next recovery (DURABILITY-PROTOCOL §4).

**Retention (A-6):** authoritative data (journal, commit records, snapshots, engine orders and the
permanent client-ID index, the ledger) is never discarded. Audit stores are unbounded unless
`auditRetention` is set. The outbox is a ring buffer whose gaps `eventsPage` reports exactly.

**Clients after `outcome-unknown`:** only an accepted new order is request-idempotent. Before sending
further commands, clients freeze, catch up with `eventsPage`, look orders up, and only then resume
(DURABILITY-PROTOCOL §5.3).

**Failure cases:**

| Case | What happens |
|---|---|
| Append fails, at any point | The outcome is unknown. The gateway answers `outcome-unknown` and the venue stops, so no later append can follow a torn line. Recovery truncates a torn tail (an unparseable final line); a complete final line that fails validation is refused (VR-28). |
| Commit-record write fails | The entry is journaled but may be uncommitted. The venue stops with `outcome-unknown`; recovery rolls the entry forward (D-6). |
| Internal fault | The engine stops (fail-stop). The faulting command was journaled, so its outcome is unknown. Later commands are refused **before** journaling (`unavailable`). If it faults again on replay, recovery reports a `ReplayFaultError` without payload (D-3; [RUNBOOK-POISON-COMMAND.md](RUNBOOK-POISON-COMMAND.md)). |
| Faulty public listener | Cannot affect the committed result, the private outboxes or other listeners; it cannot modify the messages it receives (frozen) |
| Any other failure while routing outputs | The command is committed, so the venue stops and reports `outcome-unknown` (VR-20) |

The prototype's only store is in memory, with fault injection. Its crash boundaries are tested in
[RECOVERY-TEST-RESULTS.md](RECOVERY-TEST-RESULTS.md).

Regenerated outputs keep their sequence numbers, so consumers can de-duplicate.

**Not in the prototype:**

- a file-backed or replicated store (fsync, replication); only `MemoryJournalStore` exists
- an independently protected anchor for journal heads
- a hot standby replaying the same journal
- sequencer failover
- snapshot scheduling
- journal compaction and retention

**Rate limits and abuse prevention (A-3, A-4, H-6, H-7)**

- per-account message window
- post-only rejection throttle
- minimum hidden size
- idempotency records
- per-account limits on resting orders
- account suspension (R-3)
- a refusal log for surveillance

Also needed in production:

- connection and IP limits in front of the gateway
- order-to-trade ratio limits
- cancel-on-disconnect
- surveillance of probing and layering patterns

**Separation of public and private data (A-1, A-2)**

- **Different channels:** public tape versus per-account outboxes.
- **Different schemas:** strict public schemas cannot carry identities.
- **Different sequences:** `publicSeq` versus `accountSeq`; the global `seq` stays internal.
- **Gateway responses:** filtered to the caller.
- **Lint rules:** ESLint forbids the application from importing the prototype.

A property test checks, over random sequences, that:

- no public message contains an account, order ID, client ID or visibility value
- every private event reaches only its owner

## 13. From prototype to anything live

The prototype demonstrates semantics, not production readiness. Before *any* deployment, even
testnet with real users, at least the following must exist and be reviewed.

**Independent security review required** (each item reviewed separately; see
[SECURITY-CHECKLIST.md](SECURITY-CHECKLIST.md) §B):

1. Matching engine and order book: priority, STP, FOK atomicity, replace semantics, integer
   arithmetic.
2. Hidden-order confidentiality controls:
   - publication rules
   - operator access paths
   - logging
   - snapshot and journal access
   - the leakage analysis in §7.6
3. Gateway and authentication:
   - session issuance and binding
   - schema validation
   - rate limits
   - idempotency
   - network exposure
4. Sequencer, journal, snapshots and recovery: durability, integrity anchoring, replay determinism,
   failover.
5. Risk engine, margin, liquidation and settlement. These do not exist yet and must be designed.
6. Custody, wallets, deposits and withdrawals. These are out of scope until legal and compliance
   review.
7. Market-data distribution: fairness of dissemination, snapshot and resync, consumer protections.
8. Operator tooling and administrative commands: authorization, four-eyes approval, audit.
9. Surveillance pipeline: access to private order flow, and a retention policy.

**Engineering still missing:**

- persistence
- replication and HA
- network transport with mutual authentication
- fees
- margin and liquidation
- icebergs and pegs
- auctions and halts with re-opening
- surveillance
- regulatory reporting
- capacity engineering (see [PERFORMANCE-PLAN.md](PERFORMANCE-PLAN.md))

**Legal and regulatory:** operating a venue for perpetual futures is regulated, or prohibited, in
most jurisdictions. Hidden orders interact with pre-trade transparency rules. No live deployment is
possible without qualified legal advice and the relevant authorisations (see `docs/SECURITY.md` §4).

## 14. Running the prototype

```bash
npm run venue:demo            # hidden-order walkthrough + 5 000 synthetic messages, reconcile, recover
npm run venue:demo -- 42 20000
npm run venue:bench           # indicative local micro-benchmarks (PERFORMANCE-PLAN.md)
npx vitest run src/venue      # rule, property, adversarial and recovery tests
```

The CLIs run with Node's built-in TypeScript type stripping. That is why the prototype uses relative
`.ts` imports and `import type`, both enforced by ESLint.
