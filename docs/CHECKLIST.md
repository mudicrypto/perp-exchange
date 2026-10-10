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
- [ ] **Verify against the live Hyperliquid API** — not possible in the build environment
      (egress to `api.hyperliquid.xyz` blocked). Unit tests use hand-written fixtures.
- [ ] Record live fixtures and add a contract test that can be run where egress is allowed

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

## Milestone 2 — Watch-only account data (next)
- [ ] `HyperliquidAccountDataSource` (public address → `clearinghouseState`, `openOrders`, fills) via server
- [ ] Address input with validation; never request keys/seeds
- [ ] Positions/orders/fills tables; portfolio risk panel wired to `DefaultRiskEngine.portfolio`
- [ ] Tiered margin tables from venue meta in liquidation estimates
- [ ] Fee schedule in pre-trade estimates

## Milestone 3 — Order lifecycle & reconciliation (no live submission)
- [ ] Order state machine over `ORDER_STATUSES` with venue-confirmed transitions only
- [ ] Reconciliation of local intents against venue order/fill streams (idempotent, sequence-aware)
- [ ] Persistence adapter (server-side DB) for order journal and audit log
- [ ] Venue-specific validation (e.g. Hyperliquid 5-significant-figure prices)

## Milestone 4 — Testnet execution (explicitly configured, separately confirmed)
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
