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

## Milestone 4 — Watch-only account UI
- [ ] `HyperliquidAccountDataSource` (public address → `clearinghouseState`, `openOrders`, fills) via server
- [ ] Address input with validation; never request keys/seeds
- [ ] Positions/orders/fills tables; portfolio risk panel wired to `DefaultRiskEngine.portfolio`
- [ ] Tiered margin tables from venue meta in liquidation estimates
- [ ] Fee schedule in pre-trade estimates

## Milestone 5 — Order lifecycle & reconciliation against live venue streams
- [ ] Order state machine over `ORDER_STATUSES` with venue-confirmed transitions only
- [ ] Reconciliation of local intents against venue order/fill streams (idempotent, sequence-aware)
- [ ] Persistence adapter (server-side DB) for order journal and audit log
- [ ] Venue-specific validation (e.g. Hyperliquid 5-significant-figure prices)

## Milestone 6 — Testnet execution (explicitly configured, separately confirmed, security-reviewed)
- [ ] Wallet connection (signing in the user's wallet; no key custody)
- [ ] Testnet-only execution adapter behind config + per-session confirmation
- [ ] Authorization (`orders:submit`) enforced server-side

## Later
- [ ] Nova matching engine behind `ExecutionAdapter` + `MarketDataSource`
- [ ] Private execution modes on Nova's venue: hidden limit, iceberg, batch auctions, sealed RFQ
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
- Paper engine fills resting orders in full at the limit price once the book crosses (no queue position modelling).
