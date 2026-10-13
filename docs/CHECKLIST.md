# Nova Exchange — Project Checklist

Legend: `[x]` done and verified by tests or a run · `[~]` partial · `[ ]` not started.
Only mark an item done when a test or an actual run supports it.

## Milestone 1 — Read-only market data terminal

Foundation
- [x] Next.js 16.4 App Router, TypeScript 5.9 strict (+ `noUncheckedIndexedAccess`), Tailwind CSS 4
- [x] shadcn/ui primitives (`src/components/ui`, sourced from the official shadcn repo)
- [x] ESLint (next core-web-vitals + TS) with architecture-boundary import rules
- [x] Vitest unit tests; Playwright E2E against the simulated source
- [x] `npm run check` = typecheck + lint + unit tests + production build

Architecture
- [x] Venue-agnostic domain types with Zod schemas (`src/core/domain`)
- [x] Explicit ports for market data, account data, execution, risk, private execution,
      persistence, auth (`src/core/ports`)
- [x] Server/browser composition roots (`src/server/catalog-gateway.ts`, `features/terminal/create-sources.ts`)

Market data
- [x] Hyperliquid wire schemas (Zod) + mappers to domain types
- [x] Server-side `/info` client: timeout, retry (network/5xx/429 only), short TTL cache, typed errors
- [x] `/api/markets`, `/api/candles` (validated query), `/api/health`
- [x] Browser websocket source: shared socket, ref-counted subscriptions, validation of every message
- [x] Reconnect with exponential backoff + jitter; heartbeat watchdog; subscription replay
- [x] Duplicate / out-of-order handling: trade id de-dup, book timestamp ordering, candle merge
- [x] Stale-data detection and UI dimming; disconnected state shown
- [x] Deterministic simulated source, labelled in UI (banner + badge), refused in production unless allowed
- [ ] **Verify against the live Hyperliquid API** — see Milestone 2 (`npm run test:live` added)

Terminal UI
- [x] Market selector with search, mark price, 24h change, volume
- [x] Market header: mark, oracle, 24h change/volume, OI, funding (+APR), max leverage, size step
- [x] Candlestick + volume chart (lightweight-charts), interval switching, persisted preference
- [x] Order book with cumulative depth and spread
- [x] Trades tape
- [x] Positions / orders / account panels with explicit "no account" states (no fake balances)
- [x] Responsive layout (desktop grid, stacked on mobile)

Risk & analytics
- [x] Isolated liquidation estimate, initial margin, maintenance-margin rate
- [x] Market-order book-walk impact estimate + "exceeds visible depth" warning
- [x] Pre-trade warnings: leverage, impact, near-liquidation, stale data, crossing limit
- [x] Portfolio risk functions (exposure, effective leverage, margin utilisation, uPnL) — unit tested, UI pending account data
- [x] Market risk facts panel (margin rates, funding APR, mark/oracle basis)

Execution & safety
- [x] Order intent schema + validation against market precision/leverage/margin mode
- [x] `DisabledExecutionAdapter` only; `NOVA_EXECUTION_MODE` accepts only `disabled`
- [x] Submit button disabled with an explanation

Private execution
- [x] Venue capability model + disclosure derived only from venue capabilities
- [x] Hyperliquid declared public (book + ledger + address attribution); UI says so

Security
- [x] CSP and security headers; `poweredByHeader` off
- [x] Server-only config module; browser receives whitelisted public config only
- [x] No key/seed handling anywhere; UI states Nova will never ask for them

## Milestone 1b — Complete terminal UI (demo environment)

Shell & navigation
- [x] Header: logo, Trade / Portfolio / Private Execution navigation, data-source badge, connection status
- [x] Wallet placeholder dialog (no connect flow, no key/seed inputs)
- [x] Demo controls (simulation only): connection loss, chart data failure, reset demo account
- [x] Skip link, keyboard-operable controls, accessible names (incl. leverage slider thumb)

Trade page
- [x] Market sidebar (xl) with search, price, 24h change, volume, arrow-key navigation; popover selector below xl
- [x] Chart with timeframe controls; loading / error + retry overlays
- [x] Order book (click a level to set the ticket price), recent trades with initial snapshot
- [x] Order entry: limit/market, buy/sell, price, quantity with % presets, leverage slider, TIF, reduce-only
- [x] Review dialog before submission; result banner (fill / resting / rejected with reason)
- [x] Bottom panel: positions (market close), open orders (cancel / cancel all), order history, fills; market risk info
- [x] Portfolio summary (equity, available margin, margin in positions/orders, uPnL, realised PnL, fees)
- [x] Risk summary (gross/net/long/short exposure, effective leverage, maintenance/equity, closest liquidation), labelled as estimates
- [x] Loading, empty, disconnected and error states
- [x] Responsive: 4-column (xl), 3-column (lg), stacked mobile with order entry right after the chart

Simulated paper venue (demo only)
- [x] `PaperEngine`: visible-depth matching, maker/taker fees, IOC/GTC/post-only, reduce-only, 5% market slippage cap,
      margin checks, isolated positions with averaging / reduce / flip, liquidation at the simulator's own liquidation price
- [x] Demo account fixtures replayed through the engine (positions, orders, fills, rejected/cancelled history are consistent by construction)
- [x] Order entry paused while the simulated feed is disconnected
- [x] Live venues remain `executionMode: "disabled"`; paper mode exists only with `NOVA_MARKET_DATA_SOURCE=simulation`

Other pages
- [x] Portfolio page sharing account state with the trade page
- [x] Private Execution page: current venue capabilities, planned modes, commitments — no "make private" control

Design system
- [x] Semantic colour tokens (buy/sell/warning/private, surface elevation) in `globals.css`
- [x] Reusable trading primitives in `src/components/trading` (Panel, Stat, SummaryRow, SignedAmount, SideLabel, OrderStatusLabel, EstimateHint)

## Milestone 2 — Real market-data integration (Hyperliquid, read-only)
- [x] Typed protocol module: subscriptions, canonical keys, pure never-throwing frame parser
- [x] Instrument metadata + market snapshots (`metaAndAssetCtxs`), candle history (`candleSnapshot`)
- [x] Live WS: `l2Book`, `trades`, `candle`, `activeAssetCtx`, `allMids` (market list prices)
- [x] Selected market wired to chart, book, trades, header; market list streams mids
- [x] Zod validation of every frame; malformed frames counted with reason, never rendered
- [x] Per-stream status (waiting/live/stale/disconnected/error) with last-update age; connection diagnostics popover
- [x] Reconnect with backoff + jitter, heartbeat, `online` event, subscription replay, full cleanup on dispose
- [x] De-duplicated venue subscriptions; late frames dropped; newest-wins for book, candles and stats
- [x] Venue `Invalid subscription` errors routed to the affected stream (not replayed)
- [x] Server-side REST weight budget (below documented limit), 429 handling, `Retry-After`
- [x] Mode separation enforced in code (`source-mismatch` guard; no simulated fallback in live mode)
- [x] Integration documented: `docs/integrations/HYPERLIQUID.md`
- [ ] **Run `npm run test:live` against the real API** (blocked in the build environment)
- [ ] Re-check rate-limit figures and schemas against the official docs pages
- [ ] Record real WS/REST fixtures from a live session to replace hand-written ones

## Milestone 3 — Venue-independent trading domain and execution adapters
- [x] Domain models: Instrument, OrderRequest (8 types), Order + statuses, Fill, Position, Balance/AccountSnapshot, TradingError/Result, capabilities
- [x] `origin: "simulated" | "venue"` on orders, fills and account snapshots; unreported venue fields are `null`
- [x] Pure order-lifecycle reducer + `OrderStore` (duplicate events/fills, stale sequences, invalid transitions, overfill)
- [x] Venue-independent validation (unsupported-first, then all rule issues; significant figures, decimals, leverage, margin modes, min value)
- [x] `ExecutionAdapter` port: capabilities, describeInstrument, validate, submit, cancel, cancel-all, open orders, positions, account state, order/fill streams
- [x] `CapabilityRegistry` with explicit status for every capability; unknown venues unsupported
- [x] SimulationAdapter: deterministic, configurable fills (book/none, liquidity fraction), rejection rules, ack latency, stop/TP market triggers
- [x] HyperliquidAdapter: SDK-verified order model + price rules for validation; read-only account by public address; submit/cancel/streams explicitly unsupported
- [x] `GET /api/venue/account?address=` (validated, weight-budgeted, venue-only)
- [x] Ticket driven by the registry (available / preview-only / unavailable with reasons); actions gated by capabilities
- [x] `docs/TRADING.md` with a supported/unsupported matrix checked by a test
- [ ] Wire Hyperliquid watch-only account into the UI (adapter is ready; needs address entry UX)
- [ ] Hyperliquid `orderUpdates` / `userFills` streams (read-only)
- [ ] Verify account-read schemas with `npm run test:live` against a real address

## Milestone 4 — Private execution
Phase A — workspace and capability discovery
- [x] `/private-execution` workspace: mode selector (hidden / iceberg / RFQ / encrypted), venue capability indicator, size + limit price, displayed quantity (iceberg), counterparty selection + reveal-side option (RFQ)
- [x] Full privacy disclosure (party × data matrix) with required confirmation; confirmation resets when the mode changes
- [x] Execution status, private order history (shown publicly / refills) and fills
- [x] Unavailable state for unsupported modes (encrypted is "Planned"; every private mode is unavailable on Hyperliquid)
- [x] Ticket dialog lists each private mode's availability on the active venue

Phase B — privacy model
- [x] `core/privacy`: execution modes, parties, data classes, exposure cells, `VenuePrivacy` profiles
- [x] `validateVenuePrivacy` consistency rules; the registry refuses inconsistent venues
- [x] `describeExecution` derives every disclosure from capabilities + profiles only
- [x] Matrices per venue × mode in `docs/PRIVACY.md`, checked against the code by a test
- [x] Data minimisation: no limit price or identity sent for RFQ; random session id; retention ≤ 5 min after completion; allow-listed audit log (tested)
- [x] Server-side authorization for RFQ (session ownership, addressed counterparties, same-origin mutations) — unit and E2E HTTP tests

Phase C — implementation boundaries
- [x] Simulator implements hidden and iceberg orders (public book excludes hidden, shows only iceberg slices; slice refills counted)
- [x] Simulated public book includes the account's displayed orders; fills print on the simulated tape without ids; the engine matches the raw book (no self-matching)
- [x] `PrivateExecutionService`: refuses unsupported modes and inconsistent venues before any adapter call (Hyperliquid spy test), requires a confirmation that matches the derived disclosure, refuses RFQ/encrypted as orders
- [x] Private RFQ against simulated counterparties: `RfqDesk` (core) + `/api/session`, `/api/rfq/*` routes + validated browser client; accepted quotes booked as `rfq` orders after a side-effect-free margin check
- [x] Encrypted orders marked planned; no venue may declare them supported (enforced)
- [x] Requirements for a native private matching engine documented (`docs/PRIVACY.md`)
- [ ] RFQ persistence beyond a single in-memory process (needed before any multi-instance deployment)
- [ ] Production counterparty authentication (per-counterparty credentials, rotation, mTLS/signing)
- [ ] Independent review of privacy claims (required before any private mode is offered with real funds)

## Milestone 5 — Deterministic risk engine
- [x] Pure, deterministic `core/risk` module (all inputs incl. `now` passed in); UI only renders results
- [x] Decimal arithmetic (`decimal.js`, 40 digits, half-even) with explicit output rounding; liquidation rounded toward the mark
- [x] Explicit units for prices, quantities, amounts, fractions, leverage, funding and fee rates
- [x] Every figure is available (method, inputs with source + timestamp, assumptions, kind) or unavailable (reason, missing inputs)
- [x] Position notional, entry, mark-based unrealised PnL; realised PnL and fees from fill records; funding projection and paid (where data exists)
- [x] Margin utilisation (initial, maintenance), effective leverage, exposure by instrument and direction, concentration (largest share, HHI)
- [x] Venue-specific rules: simulator rules identical to the paper engine (tested); Hyperliquid never computes maintenance/liquidation (venue-reported only), fees unknown
- [x] Hypothetical uniform price-move scenarios with explicit assumptions
- [x] Stale/missing inputs → unavailable; aggregates never partial
- [x] Configurable pre-trade limits (server env `NOVA_RISK_LIMITS`, validated) with block/warn and fail-closed unverifiable checks
- [x] `RiskGuardedExecutionAdapter` wraps every execution adapter (ticket, hidden/iceberg, RFQ bookings); server enforces notional limits on RFQ creation
- [x] Ticket preview, Private Execution workspace and portfolio risk report show inputs, timestamps and assumptions; no guarantees implied
- [x] `docs/RISK.md` with formulas and worked examples verified independently (Python `decimal`) and asserted by tests
- [ ] Hyperliquid margin tables (tiers) to compute maintenance margin / pre-trade liquidation for Hyperliquid
- [ ] Funding payment history (Hyperliquid `userFunding`) for realised funding
- [ ] Server-side guard with server-fetched account state for live execution (required before any live submission)
- [ ] Re-verify the Hyperliquid margin, liquidation and funding statements against the official docs from a networked environment

## Milestone 6 — AI Trading Analyst (mock accounts)
- [x] Pure analytics in `core/analytics`: equity attribution (with residual), fees and funding, execution summary, UTC periods; single-market scenario in `core/risk`
- [x] Deterministic mock ledger (fictitious): consistent cash, positions, fees, funding and equity; reconciles to zero residual (tested)
- [x] Server-side read-only tool layer (7 tools) with Zod validation and account-level authorization on every call before any data is loaded
- [x] Evidence model: every figure labelled fact / estimate / hypothetical with timestamps, assumptions and unavailable reasons
- [x] Offline rule-based engine (default) writes answers only from tool evidence; Claude engine (manual tool loop, strict tools, refusal fallback) behind `NOVA_ANALYST_ENGINE=claude`
- [x] Guards: order instructions refused before any engine runs; unverified-figure and guarantee-language warnings; disclaimer on every answer
- [x] No order actions: no such tool exists; ESLint forbids execution imports in the analyst
- [x] Mock sign-in (HttpOnly session), same-origin, per-session rate limit, 404 for foreign accounts; disabled in live mode
- [x] `/analyst` UI with suggested questions, verified data under each answer, unavailable states
- [x] Unit, contract and E2E tests (incl. cross-account denial); `docs/ANALYST.md`
- [ ] Run the Claude engine against the live API (no credentials in the build environment)
- [ ] Real account sources (watch-only venue accounts) behind `AccountHistoryGateway`, with real authentication
- [ ] Multi-turn conversation memory

## Milestone 7 — Security hardening and end-to-end verification
- [x] Repository-wide review documented in `docs/SECURITY.md` (all 16 requested areas)
- [x] Size-capped streaming JSON bodies (413 before buffering)
- [x] Bounded session tables (LRU eviction instead of global lockout)
- [x] Per-client / per-session rate limits (sessions, RFQ mutations, venue reads, account lookups, counterparty-token failures with pre-check block)
- [x] `Secure` cookies behind TLS-terminating proxies; COOP / CORP / HSTS headers
- [x] Field-named validation messages for every order-schema issue
- [x] Client-bundle secret scan (`npm run verify:bundle`, part of `npm run check`), negative-tested
- [x] Robustness tests: concurrent duplicate submissions, cancel of partial fills and pending orders, numeric edge cases, live/sim separation
- [x] Playwright scenarios 1–10 (`tests/e2e/verification.spec.ts`, `tests/e2e-live-config/` on a second server in live configuration)
- [x] Opt-in external suite `npm run test:e2e:external` (live Hyperliquid) — written, **not verified** here (no network)
- [ ] Nonce- or SRI-based CSP without `'unsafe-inline'` scripts (conflicts with PPR)
- [ ] Shared store for sessions, RFQ desk and rate limits (multi-instance)
- [ ] Real authentication; penetration test; legal/regulatory review (see SECURITY.md §4)

## Milestone 8 — Own venue with native hidden orders: design and local prototype
Design documents (`docs/venue/`)
- [x] Architecture: components, data structures, instrument rules, publication, audit and reconciliation, recovery, rate limits, public/private separation (`ARCHITECTURE.md`)
- [x] Hidden-order specification: what is concealed, what the engine sees, priority, interaction with displayed liquidity, disclosure, leakage reduction and what still leaks (`ARCHITECTURE.md` §7, `MATCHING-RULES.md` §7); server-side access control only, no cryptographic claim (doc test)
- [x] Threat model (`THREAT-MODEL.md`)
- [x] Order state machine; doc table checked against code (`ORDER-STATE-MACHINE.md`, `docs.test.ts`)
- [x] Matching-rules specification with 43 rule ids, each named by at least one test (`MATCHING-RULES.md`, `docs.test.ts`)
- [x] Performance test plan with an indicative prototype baseline (`PERFORMANCE-PLAN.md`)
- [x] Security review checklist and list of components requiring independent review (`SECURITY-CHECKLIST.md`)

Local prototype (`src/venue/`, synthetic only)
- [x] Integer tick/lot engine: price-time priority, displayed-before-hidden, GTC/IOC/FOK, market with band protection, post-only, STP (3 modes), replace (FIX total-qty), mass cancel, halts, suspension, pre-trade limits
- [x] Separate public feed (strict schemas, own sequence, aggregated prints, optional batched publication) and per-account private events (own sequence, opaque ids)
- [x] Gateway: session-bound accounts, strict Zod input, exact decimal conversion, rate limits, post-only probe throttle, idempotency
- [x] Hash-chained write-ahead journal, snapshot/restore, deterministic replay, fail-stop, consumer de-duplication
- [x] Independent reconciliation (book, conservation, zero-sum, executions, published data)
- [x] Example, property-based (fast-check), adversarial and recovery tests; manual mutation check (4/4 non-equivalent mutants caught)
- [x] `npm run venue:demo` (walkthrough + seeded flow + reconcile + recovery) and `npm run venue:bench`
- [x] Isolation: ESLint forbids network/file-system use in the prototype and any import of it from the app (negative-tested)
- [ ] Icebergs, midpoint pegs, minimum execution quantity, auctions, fees
- [ ] Margin, liquidation, settlement; persistence, replication, failover; external anchoring of journal heads
- [ ] Performance scenarios S5–S8, S10, S11 and the latency side-channel test
- [ ] Independent security review of every component in `SECURITY-CHECKLIST.md` §B; legal/regulatory review

## Milestone 9 — Independent verification and hardening of the venue prototype
Verdict: **verified with limitations** (`docs/venue/VERIFICATION-REPORT.md`). Not deployable.
- [x] Baseline recorded before changes (`docs/venue/verification/baseline/`); brief's "73 venue tests" corrected to the actual 83
- [x] Rule-by-rule audit of all 43 matching rules against code and tests (VERIFICATION-REPORT §4)
- [x] 23 findings with severity, evidence, reproduction and regression status; the regression tests for VR-01/02/03/04/06/19 fail on the original commit (`regression-tests-against-4edf72b.log`) and those for VR-20…23 fail on the pre-fix working tree (`review-notes-against-prefix.log`); all pass after the fixes
- [x] Resolved: VR-01 (High: commands journaled after a fault and replayed on recovery), VR-02, VR-03, VR-04, VR-05, VR-06, VR-07, VR-12, VR-20/21/22/23 (recovery-contract review notes), VR-19 (half-applied state readable after a fault)
- [x] Durable-store boundary (`JournalStore`, in-memory with fault injection) and crash tests at five persistence boundaries (`RECOVERY-TEST-RESULTS.md`)
- [x] Privacy review per adversary class A–E; no protection claimed against compromised service, operator or storage access (`PRIVACY-REVIEW.md`)
- [x] Reproducible synthetic benchmarks with p50/p95/p99 and a timing side-channel probe (`npm run venue:perf`, `PERFORMANCE-RESULTS.md`)
- [ ] Open: VR-08 (FOK absence probe), VR-09 (idempotency not durable), VR-10 (duplicated final line), VR-13 (unbounded growth), VR-14 (id key secrecy), VR-15 (timing channel), VR-18 (poison-command runbook)
- [ ] File-backed or replicated store; independently protected anchor for journal heads; encryption at rest
- [ ] Independent security review (SECURITY-CHECKLIST §B)

## Milestone 10 — Recovery integrity and idempotency (venue prototype)
Scope: VR-09, VR-10 and VR-14, plus the findings of the read-only reviews of this milestone (VR-24 to VR-29). Engine unchanged.
Specification and results: `docs/venue/RECOVERY-INTEGRITY.md`. Not deployable.
- [x] Behavioural specification written before implementation: identical retries, conflicting retries, duplicate journal records, sequence conflicts, id-key policy
- [x] Tests written first: against the Milestone 9 commit, 41 of 46 failed (18 behaviour, 14 classification, 9 new mechanism; 5 pin unchanged behaviour) (`m10-tests-against-27dee34.log`); against the unfixed M10 tree, 12 of the 16 review tests failed (`m10-review-fixes.log`); all pass after the change
- [x] VR-09: venue idempotency ledger (deep-frozen records, fresh copy per replay) rebuilt from the journal and carried in snapshots with its capacity under a verified hash; identical and conflicting retries defined while retained and after eviction; no accepted order journaled or executed twice across restarts, evictions and storage faults (property)
- [x] VR-10 / VR-24: rule D-5 fail-closed. Every duplicate journal record refuses recovery with a precise classification, and the store is left untouched; a store that acknowledges an append but persists the previous entry no longer loses the order silently
- [x] VR-14: rule A-5. Id-key policy enforced by `Venue` and `Venue.recover`; fixture keys only with `allowTestFixtureIdKey`; fixture literals confined to `id-key.ts` and tests
- [x] VR-26: snapshot restore under a different ledger capacity refused; full-replay behaviour under a changed capacity defined (responses only)
- [x] VR-28: only an unparseable final line is a torn write; a complete final line that fails validation (hash, chain, sequence, timestamp, schema) is refused with the store untouched, with or without its newline. 15 of 19 final-review tests failed before the fixes (`m10-final-review-fixes.log`)
- [x] VR-29: routed events and public messages deep-frozen in `Venue.route`; first response, private feed, journaled request reference, public tape and each listener isolated (tests)
- [x] Terminal (filled, cancelled) order evicted from the ledger, then snapshot restore or full replay: retries refused as duplicates, no execution (tests)
- [x] Crash-boundary property unchanged and passing; `engine.ts` unchanged
- [ ] Independently persisted commit record or trust anchor (needed for any automatic repair of duplicate or torn journal tails, and to detect an acknowledged entry truncated or lost by a store that acknowledges before durability)
- [ ] Keep a permanent client-ID index when addressing VR-13 (it alone prevents a second execution after ledger eviction)
- [ ] Id-key management (generation in deployment, storage, rotation)
- [ ] Ledger durability beyond the in-memory store; the ledger hash is not tamper-proof without an anchor
- [ ] Still open from M9: VR-08, VR-13, VR-15, VR-18

## Milestone 11 — Watch-only account UI
- [ ] `HyperliquidAccountDataSource` (public address → `clearinghouseState`, `openOrders`, fills) via server
- [ ] Address input with validation; never request keys/seeds
- [ ] Positions/orders/fills tables; portfolio risk panel wired to `DefaultRiskEngine.portfolio`
- [ ] Fee schedule in pre-trade estimates

## Milestone 12 — Order lifecycle & reconciliation against live venue streams
- [ ] Order state machine over `ORDER_STATUSES` with venue-confirmed transitions only
- [ ] Reconciliation of local intents against venue order/fill streams (idempotent, sequence-aware)
- [ ] Persistence adapter (server-side DB) for order journal and audit log
- [ ] Venue-specific validation (e.g. Hyperliquid 5-significant-figure prices)

## Milestone 13 — Testnet execution (explicitly configured, separately confirmed, security-reviewed)
- [ ] Wallet connection (signing in the user's wallet; no key custody)
- [ ] Testnet-only execution adapter behind config + per-session confirmation
- [ ] Authorization (`orders:submit`) enforced server-side
- [ ] `RiskGuardedExecutionAdapter` running server-side in front of the testnet adapter

## Later
- [~] Nova matching engine behind `ExecutionAdapter` + `MarketDataSource` (engine designed and prototyped locally in M8; not wired to the app)
- [ ] Private execution modes on Nova's venue: hidden limit, iceberg, batch auctions, sealed RFQ, encrypted order flow (requirements in `docs/PRIVACY.md`)
- [ ] Independent review of privacy guarantees before any is advertised
- [ ] Custody, deposits/withdrawals (out of scope until legal/compliance review)

## Known issues / limitations
- Live Hyperliquid integration is implemented to the documented API but **unverified against the
  live service** from the build environment.
- `npm audit` reports high-severity advisories in `braces` via `eslint-config-next` (dev-only lint
  toolchain); the suggested fix is a breaking downgrade, so it is tracked rather than forced.
- Prices are JS numbers. Fine for display and estimates; order wire encoding (M3+) must use
  exact decimal strings.
- Hyperliquid `l2Book` exposes limited depth; impact estimates only cover visible levels.
- Simulator: each chart timeframe's history is generated independently (the 1h path also drives "24h change"),
  so different timeframes do not show the identical path. The demo account resets on page reload.
- Paper engine fills resting orders in full at the limit price once the book crosses (no queue position modelling);
  hidden orders get the same priority as displayed ones, and icebergs fill at most one slice per book update.
- The RFQ service is in-memory and single-process; a server restart drops open requests. Simulated desks price
  around the public mid the browser supplies.
- Simulated account state lives in the browser: a reload resets it, and RFQ trades booked there are not
  reconciled with the server's RFQ record.
