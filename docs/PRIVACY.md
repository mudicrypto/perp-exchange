# Nova Exchange — Private Execution and Privacy Model

Status: Milestone 4. Private modes run **only on the simulated venue**. Hyperliquid, the only live
venue, publishes every resting order, so no private mode is available there. See
[`docs/CHECKLIST.md`](CHECKLIST.md) for progress and [`docs/TRADING.md`](TRADING.md) for the
capability matrix.

## Principles

1. **Privacy belongs to the venue and the protocol, not the UI.** Nova shows an order as private
   only if the venue that receives it supports that mode, and says exactly who can still see it.
2. **No substitution.** Nova never sends a "hidden" order to a venue with a public order book and
   presents it as hidden, and never swaps a private mode for a public order type.
3. **Disclosures come from declarations that are checked.** Each venue declares a privacy profile
   for every mode it offers. The capability registry refuses to load a venue whose profiles are
   incomplete or contradict what the mode can honestly promise (`validateVenuePrivacy`).
4. **Minimise collection.** The server receives only what a mode needs. Records are deleted
   shortly after use, and logs contain no order details.
5. **Authorise on the server.** Who may read a request is decided by the RFQ desk on the server,
   not by which buttons the UI shows.

## Execution modes

| Mode | What it is | What it is not |
|---|---|---|
| Public limit | Rests in the venue's public order book | — |
| Hidden | Rests at the venue without being shown in the public book; matches like a limit order | Not invisible: the matching engine and the operator see it, and fills are public |
| Iceberg | An **execution algorithm**: a displayed slice rests publicly and is refilled after it fills | Not anonymity: the slice, every refill and every fill are public, and repeated refills at one price can reveal a large order |
| Private RFQ | A request sent only to counterparties you select; you accept a quote bilaterally | Not invisible to Nova's RFQ service or to the selected counterparties; accepted trades print on the (simulated) tape |
| Encrypted | Orders encrypted until matching | **Planned only.** It needs a protocol-level design (for example, threshold-encrypted order flow). It is not a UI setting, and no venue may declare it supported (enforced in code) |

## Parties and data

The model (`src/core/privacy/model.ts`) records, for each venue × mode, what each **party** can see of
each **data class**:

- **Parties:**
  - public market observers
  - the matching engine
  - the venue operator
  - the selected RFQ counterparties
  - Nova's backend
  - other Nova users
- **Data classes:**
  - order details before execution (side, size, price)
  - account identity
  - execution details (price, size, time)
  - linkage to subsequent trades
- **Exposure levels:**
  - `sees`
  - `partly` (the note says what)
  - `cannot see`
  - `n/a` (the party plays no role)

Consistency rules (`src/core/privacy/consistency.ts`):

- a profile exists if and only if the venue offers the mode
- every cell is filled
- the matching engine and the operator always see order details
- a hidden order is invisible to public observers and to other Nova users
- an iceberg's public order details are `partly`, and its executions are public
- RFQ counterparties see the request, and public observers do not
- counterparties have no role outside RFQ
- encrypted execution cannot be supported or profiled

## Privacy matrices

Generated from the code, and checked by `src/adapters/privacy-docs.test.ts`. The per-cell notes
shown in the workspace come from the same declarations
(`src/adapters/*/capabilities.ts`).

### Simulated venue

<!-- privacy-matrix:simulation:start -->
#### Simulator · public-limit

| Party | Order details (side, size, price) before execution | Account identity | Execution details (price, size, time) | Linkage to your subsequent trades |
|---|---|---|---|---|
| Public market observers | 👁 sees | — cannot see | 👁 sees | — cannot see |
| Matching engine | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Venue operator | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Selected RFQ counterparties | n/a | n/a | n/a | n/a |
| Nova backend | — cannot see | — cannot see | — cannot see | — cannot see |
| Other Nova users | — cannot see | — cannot see | — cannot see | — cannot see |

#### Simulator · hidden

| Party | Order details (side, size, price) before execution | Account identity | Execution details (price, size, time) | Linkage to your subsequent trades |
|---|---|---|---|---|
| Public market observers | — cannot see | — cannot see | 👁 sees | — cannot see |
| Matching engine | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Venue operator | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Selected RFQ counterparties | n/a | n/a | n/a | n/a |
| Nova backend | — cannot see | — cannot see | — cannot see | — cannot see |
| Other Nova users | — cannot see | — cannot see | — cannot see | — cannot see |

#### Simulator · iceberg

| Party | Order details (side, size, price) before execution | Account identity | Execution details (price, size, time) | Linkage to your subsequent trades |
|---|---|---|---|---|
| Public market observers | ◐ partly | — cannot see | 👁 sees | — cannot see |
| Matching engine | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Venue operator | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Selected RFQ counterparties | n/a | n/a | n/a | n/a |
| Nova backend | — cannot see | — cannot see | — cannot see | — cannot see |
| Other Nova users | — cannot see | — cannot see | — cannot see | — cannot see |

#### Simulator · rfq

| Party | Order details (side, size, price) before execution | Account identity | Execution details (price, size, time) | Linkage to your subsequent trades |
|---|---|---|---|---|
| Public market observers | — cannot see | — cannot see | ◐ partly | — cannot see |
| Matching engine | 👁 sees | ◐ partly | 👁 sees | — cannot see |
| Venue operator | 👁 sees | ◐ partly | 👁 sees | — cannot see |
| Selected RFQ counterparties | ◐ partly | — cannot see | ◐ partly | — cannot see |
| Nova backend | ◐ partly | ◐ partly | 👁 sees | — cannot see |
| Other Nova users | — cannot see | — cannot see | — cannot see | — cannot see |

#### Simulator · encrypted

Unavailable: Planned. Encrypted orders need a protocol-level design (e.g. threshold-encrypted order flow) that does not exist in Nova; it is not a UI setting.
<!-- privacy-matrix:simulation:end -->

### Hyperliquid (live, read-only in Nova)

Hyperliquid publishes resting orders in its L2 book, and trades carry buyer and seller addresses (the
official SDK's `Trade.users`). Only `public-limit` exists, and Nova cannot submit even that yet.

<!-- privacy-matrix:hyperliquid:start -->
#### Hyperliquid · public-limit

| Party | Order details (side, size, price) before execution | Account identity | Execution details (price, size, time) | Linkage to your subsequent trades |
|---|---|---|---|---|
| Public market observers | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Matching engine | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Venue operator | 👁 sees | 👁 sees | 👁 sees | 👁 sees |
| Selected RFQ counterparties | n/a | n/a | n/a | n/a |
| Nova backend | n/a | ◐ partly | n/a | n/a |
| Other Nova users | 👁 sees | 👁 sees | 👁 sees | 👁 sees |

#### Hyperliquid · hidden

Unavailable: Not one of Hyperliquid's order types (official SDK: limit with Gtc/Ioc/Alo, and trigger tp/sl orders). Resting orders are public in the L2 book.

#### Hyperliquid · iceberg

Unavailable: Not one of Hyperliquid's order types (official SDK: limit with Gtc/Ioc/Alo, and trigger tp/sl orders). Resting orders are public in the L2 book.

#### Hyperliquid · rfq

Unavailable: Hyperliquid has no request-for-quote order flow.

#### Hyperliquid · encrypted

Unavailable: Planned. Encrypted orders need a protocol-level design (e.g. threshold-encrypted order flow) that does not exist in Nova; it is not a UI setting.
<!-- privacy-matrix:hyperliquid:end -->

## How the simulator makes these statements true

The simulated venue is the "compatible venue" for this milestone. Its claims are enforced in code
and tested, not just labelled:

| Claim | Where enforced | Test |
|---|---|---|
| Your resting limit orders appear in the public book; hidden orders never do | `PaperEngine.publicLiquidity` merged into the public book by `SimulatedMarketDataSource` | `adapters/private-execution.test.ts`, E2E "hidden order rests without appearing" |
| An iceberg shows only its displayed slice, and refills are counted | `PaperEngine` (`consumeSlice`, `icebergState`) | `paper-engine.test.ts`, E2E |
| The engine never matches you against your own displayed orders | the engine reads `subscribeVenueBook` (raw synthetic book) | `private-execution.test.ts` |
| Every fill prints on the tape without account or order ids | `SimulationAdapter` → `printTrade` | `private-execution.test.ts` |
| Hidden/iceberg orders never reach Nova's server | the paper engine runs in the browser | by construction: there is no endpoint |
| RFQ counterparties see only market, size, timing and (if revealed) side | `counterpartyView` (`core/rfq/desk.ts`), used by the server and by the UI preview | `desk.test.ts`, E2E inbox check |
| The limit price is never sent | `RfqCreateSchema` is `.strict()` and has no price field; the UI keeps the limit local | `private-execution.test.ts`, E2E (`limitPrice` → 400) |
| Only the accepted counterparty learns the execution | `counterpartyView` | `desk.test.ts`, E2E |
| RFQ records are deleted ≤ 5 minutes after completion | `RfqDesk.sweep` (`RFQ_RETENTION_MS`) | `desk.test.ts` |

## Routing and boundaries

- **Hidden and iceberg orders** go through `PrivateExecutionService` (`core/trading/private-execution.ts`).
  Before the adapter is called it:
  - re-validates the venue's privacy declarations
  - requires the mode's capability to be `supported`
  - requires the user's confirmation to match the disclosure *derived at submission time* (mode,
    venue and visibility level), so a stale or forged confirmation is refused
  - checks that the order type matches the mode

  A test spies on the Hyperliquid adapter and asserts that `validateOrder` and `submitOrder` are
  never called for hidden or iceberg orders, even with a forged acknowledgement.
- **RFQ** never goes through an order book. The browser talks to Nova's RFQ service, and an
  accepted quote is booked on the paper account as an `rfq` order (`liquidity: "rfq"`). Before
  accepting, the account checks the trade without side effects (`checkRfqTrade`), so the desk never
  confirms a trade the account would refuse.
- **Encrypted** is always refused (`unsupported`, "Planned…").

## RFQ service (server)

| Endpoint | Caller | Authorization |
|---|---|---|
| `POST /api/session` | browser | same-origin; issues a random 256-bit id in an `HttpOnly`, `SameSite=Strict` cookie (path `/api`, `Secure` over HTTPS) |
| `GET /api/rfq/counterparties` | requester | session |
| `POST /api/rfq`, `GET /api/rfq` | requester | session + same-origin for POST; at most 10 open requests per session |
| `GET /api/rfq/:id`, `POST /api/rfq/:id/accept`, `POST /api/rfq/:id/cancel` | requester | session must own the request, otherwise **404** (no existence oracle) |
| `GET /api/rfq/inbox` | counterparty | bearer token; returns only requests addressed to it, redacted |
| `POST /api/rfq/:id/quotes` | counterparty | bearer token; 404 unless the request was addressed to it |

How the service is built:

- Every body is validated with a strict Zod schema (unknown fields are rejected), with a 4 KB cap.
- Counterparty tokens come from `NOVA_RFQ_COUNTERPARTY_TOKENS` (server-only; at least 24
  characters). Comparison uses SHA-256 digests and `timingSafeEqual`.
- In live mode (`NOVA_MARKET_DATA_SOURCE=hyperliquid`) every RFQ and session route answers 404.
- Counterparties are fictitious simulated desks: two quote automatically around the public mid the
  browser supplies, and "Desk C" quotes only through its API. The reference mid is client-supplied
  public data. A real counterparty would price from its own data.

### Data minimisation and logging

- No account, wallet or personal data is collected. The requester is a random session id, which
  is never included in any response or log.
- Stored per request:
  - market, size, side (only if revealed, or on accept), selected counterparty ids, quotes,
    timestamps and the execution
  - never the limit price or the reference price
- Retention:
  - open requests expire after 30 s
  - completed requests are deleted 5 minutes after completion
  - sessions expire after 12 h idle
- Everything is held in memory only, in one process.
- Audit lines (`server/rfq/audit-record.ts`) use an allow-list:
  - event, status, counts, denial reason, route
  - a 10-character SHA-256 prefix of the RFQ id
  - **never** sizes, prices, sides, markets, sessions or tokens (tested)

### Known limits of the simulated RFQ service

- In-memory and single-process. Restarting the server drops everything, and it does not scale
  horizontally.
- The server is trusted: it sees market, size and quotes in plaintext. Confidentiality comes from
  authorization, not cryptography.
- Counterparties authenticate with static bearer tokens. A production design needs per-counterparty
  credentials with rotation, mTLS or signed requests, and onboarding/KYC outside Nova's code.
- Timing and size can still leak information to the selected counterparties (they may hedge on the
  public market). The disclosure says they see market and size.

## Requirements for a native private matching engine

Milestone 8 designs the matching engine, its hidden-order rules and its leakage analysis, and
builds a local, synthetic-only prototype of them: [`docs/venue/ARCHITECTURE.md`](venue/ARCHITECTURE.md).
The prototype hides orders by server-side access control only. Nothing below is offered to
users.

What it would take to offer these modes on a real venue that Nova operates. None of this exists
for real users or funds.

1. **Matching engine with native order types:**
   - hidden orders (with an explicit priority policy against displayed liquidity)
   - icebergs (refill semantics, queue position per refill)
   - midpoint pegs
   - deterministic, auditable matching rules
2. **Market data publication policy:**
   - which book levels and trades are published, when, and with which identifiers
   - no account identifiers on the public tape
   - delayed or aggregated prints where appropriate
3. **Operator access controls:**
   - least-privilege access to the order book and order flow
   - audited break-glass access
   - separation between the matching, surveillance and support roles
   - the disclosures must keep saying "operator sees order details" until this is cryptographically
     constrained
4. **Encrypted order flow (for the `encrypted` mode):**
   - commit-reveal or threshold encryption, so the operator cannot read orders before matching
   - a key ceremony and a decryption committee
   - liveness and fairness guarantees
   - a published specification and an independent cryptographic review
5. **RFQ network:**
   - authenticated counterparty onboarding
   - per-counterparty credentials (mTLS or signed requests)
   - end-to-end encrypted request and quote channels where the server should not read them
   - rate limits and anti-gaming rules (for example, last-look policy)
   - a durable, access-controlled audit trail
6. **Settlement and risk:**
   - margining, liquidation and settlement for privately matched trades
   - a regulatory reporting design that reconciles transparency obligations with privacy promises
7. **Surveillance:**
   - manipulation and abuse detection that works on private order flow without widening access
8. **Persistence and retention:**
   - encrypted at-rest order journal
   - retention schedules per data class, with deletion that is verified
9. **Independent review:**
   - an external audit of every privacy claim before a mode is advertised for real funds
   - the consistency rules in `validateVenuePrivacy` stay as the minimum bar
