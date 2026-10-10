# Nova Exchange — Architecture

Status: Milestone 1 (read-only market data terminal). See `docs/CHECKLIST.md` for progress.

## Goals that shape the design

1. **Venue independence.** Today market data comes from Hyperliquid's public API. Later, orders may
   route to Hyperliquid *or* to Nova's own matching engine. The UI must not know which.
2. **Honesty by construction.** Simulated data, disabled execution and venue privacy limits are
   represented as explicit types and surfaced in the UI — never inferred or implied.
3. **Fail visibly.** Every external payload is validated; network loss, stale data and duplicate
   events are first-class states, not edge cases.

## Layering

```
src/
  app/                    Next.js App Router: pages + server route handlers (thin)
  components/ui/          shadcn/ui primitives (design system)
  features/terminal/      Trading terminal UI (client components, hooks)
  core/                   Venue-agnostic domain — NO venue formats, NO React, NO fetch
    domain/               Market, OrderBook, Trade, Candle, Position, OrderIntent (+ Zod schemas)
    ports/                Subsystem interfaces (the contracts adapters implement)
    market-data/          Order book / trade / candle state with ordering + de-duplication
    risk/                 Pure risk math: margin, liquidation estimates, book-walk impact, portfolio
    execution/            Order intent validation, safety gate, disabled execution adapter
    private-execution/    Venue visibility capabilities + honest disclosures
  adapters/               Implementations of ports
    hyperliquid/          Wire schemas (Zod), mappers, server-side info client, browser WS source
    simulation/           Deterministic simulated market data (development only, always labelled)
    http/                 Browser client for Nova's own /api routes
  lib/                    Generic utilities (reconnecting socket, formatting, storage)
  config/                 Zod-validated server configuration + public runtime config
tests/e2e/                Playwright tests
```

Dependency rule: `features → core/ports ← adapters`. `core` imports nothing from `adapters`,
`features`, `app` or React. Adapters translate venue formats into `core/domain` types at the
boundary, so a venue's response shape never leaks past its adapter directory.

## Subsystems and their interfaces (`src/core/ports`)

| Subsystem | Port | M1 implementation(s) |
|---|---|---|
| Market data | `MarketDataSource` | `HyperliquidMarketDataSource` (live, public), `SimulatedMarketDataSource` (dev) |
| Market catalog (server) | `MarketCatalogGateway` | `HyperliquidInfoClient`, `SimulatedCatalogGateway` |
| Account data | `AccountDataSource` | `DisconnectedAccountDataSource` (no account in M1) |
| Trading / execution | `ExecutionAdapter` | `DisabledExecutionAdapter` (rejects everything) |
| Order lifecycle & reconciliation | `OrderLifecycle` (types) | planned M3 |
| Risk engine | `RiskEngine` | `DefaultRiskEngine` (pure functions) |
| Private execution | `VenueExecutionCapabilities` | `hyperliquidCapabilities`, `simulationCapabilities` |
| Persistence | `KeyValueStore` | `BrowserStorageStore`, `MemoryStore` |
| AuthN / AuthZ | `SessionProvider` | `AnonymousSessionProvider` |

## Market data flow

```
Hyperliquid REST (/info) ──server──> HyperliquidInfoClient ──Zod──> domain ──> /api/markets, /api/candles
                                                                                   │
Browser: HyperliquidMarketDataSource ── fetch /api/* (Zod again on the domain shape) ┘
         └─ ReconnectingSocket ── wss://api.hyperliquid.xyz/ws ──Zod──> mappers ──> OrderBookState /
                                                                      TradeBuffer / CandleSeries
```

* REST goes through our server so we can cache, rate-limit and later swap the venue without
  touching the browser. Public WebSocket data goes browser → venue directly (no secrets involved).
* **Reconnects:** `ReconnectingSocket` uses exponential backoff with jitter, a ping/pong
  watchdog, and replays subscriptions on reconnect.
* **Stale data:** every stream tracks `lastUpdateAt`; the UI dims panels and labels them stale
  after a threshold, and while disconnected.
* **Duplicates / ordering:** trades are de-duplicated by venue trade id in a bounded set; book
  snapshots older than the current one are dropped; candle updates merge by open time and never
  move backwards.
* **Validation failures** are dropped and counted, never rendered.

## Execution safety (M1)

There is no live execution adapter in the codebase. `NOVA_EXECUTION_MODE` accepts only
`disabled`; any other value fails configuration validation at startup. The order ticket computes a
risk preview but its submit control is disabled and says why. Custody, deposits, withdrawals and
production trading are explicitly out of scope for M1.

## Private execution

Private execution is a product pillar, but privacy is a property of the **venue**, not the UI.
Each venue declares `VenueExecutionCapabilities` (order-book visibility, fill visibility, hidden
order support). The order ticket renders a disclosure derived from those capabilities.

* Hyperliquid publishes resting orders in its public L2 book and fills on a public ledger, so Nova
  shows orders routed there as **public**. Nova will never label such an order hidden/private.
* Genuinely private modes (hidden/iceberg orders, batch auctions, sealed-bid RFQ, encrypted order
  flow) require Nova's own matching engine and are tracked as future milestones in the checklist.

## Security

* Server-only configuration lives in `src/config/server-env.ts` (imports `server-only`); the
  browser receives only a `PublicRuntimeConfig` object with non-secret fields.
* The app never requests seed phrases or private keys; there is no signing code in M1.
* Strict security headers + CSP restrict network access to self and the configured venue sockets.
* API route inputs are validated with Zod; errors returned to the browser carry codes, not stacks.

## Testing

* **Vitest:** schemas against fixtures, mappers, book/trade/candle state, reconnect logic with a
  fake socket, risk math, config parsing, disclosures, simulation determinism.
* **Playwright:** the terminal running against the simulated source (deterministic, no network).
* Hyperliquid fixtures in `src/adapters/hyperliquid/__fixtures__` are hand-written to the
  documented wire format. They are **not** captured live data.
