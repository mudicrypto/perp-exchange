# Nova Exchange — Architecture

Status: Milestone 5 (deterministic risk engine). See `docs/CHECKLIST.md` for progress.

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
    risk/                 Pure, decimal risk engine: units, provenance, venue-rule interface, portfolio,
                          pre-trade assessment, limits, scenarios (see docs/RISK.md)
    execution/            Order intent validation, safety gate, disabled execution adapter
    privacy/              Execution modes, privacy profiles, consistency rules, disclosures
    rfq/                  RFQ model, redacted views and the authorization-enforcing RfqDesk
    trading/              Order lifecycle, validation, capability registry, PrivateExecutionService
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
| Account data | `AccountDataSource`, `VenueAccountGateway` (server) | `DisconnectedAccountDataSource` (live UI), `SimulationAdapter` (simulation), `HyperliquidInfoClient` (read-only by address) |
| Trading / execution | `ExecutionAdapter` | `HyperliquidAdapter` (read-only), `SimulationAdapter` (simulation only) |
| Capabilities | `CapabilityRegistry` | explicit status per venue × capability |
| Order lifecycle & reconciliation | `OrderStore` + `transitionOrder` | used by the simulator; ready for venue streams |
| Risk engine | `assessPortfolio`, `assessOrder`, `VenueMarginRules` | `simulationMarginRules`, `hyperliquidMarginRules`; enforced by `RiskGuardedExecutionAdapter` |
| Private execution | `VenuePrivacy` (in `VenueCapabilities`), `PrivateExecutionService` | profiles in `hyperliquidCapabilities`, `simulationCapabilities` |
| RFQ | `RfqDesk` (core) | `server/rfq` + `/api/rfq/*` (simulation only), `RfqClient` (browser) |
| Persistence | `KeyValueStore` | `BrowserStorageStore`, `MemoryStore` |
| AuthN / AuthZ | `SessionProvider` | `AnonymousSessionProvider` |

## Market data flow

Trading domain, lifecycle, adapters and the supported/unsupported matrix:
[`docs/TRADING.md`](TRADING.md).

Full details of the venue integration (sources, message formats, rate limits, freshness rules,
limitations): [`docs/integrations/HYPERLIQUID.md`](integrations/HYPERLIQUID.md).

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
`disabled`; any other value fails configuration validation at startup. With live data the order
ticket computes a risk preview but its submit control is disabled and says why.

With `NOVA_MARKET_DATA_SOURCE=simulation` the browser composes a `PaperVenue`: a local paper
engine (`adapters/simulation/paper-engine.ts`) that matches orders against the *simulated* book in
fictitious SIMUSD. Every surface says so (banner, badge, "SIMULATED" account label, review dialog,
"Simulated fill" results). The paper venue cannot be wired to a live data source: the composition
root only creates it alongside the simulated source. Custody, deposits, withdrawals and production
trading are explicitly out of scope for M1.

## UI composition

`app/(terminal)/layout.tsx` reads the public runtime config per request and mounts
`TerminalProvider`, which owns the market data source, account source and execution adapter for
all pages (Trade, Portfolio, Private Execution), so state survives client navigation.
Design tokens live in `app/globals.css` (semantic colours: `buy`, `sell`, `warning`, `private`,
surface elevation); reusable trading primitives live in `components/trading`.

## Private execution

Privacy is a property of the **venue and protocol**, not the UI. Full model: [`docs/PRIVACY.md`](PRIVACY.md).

* Each venue declares a `VenuePrivacy` profile (party × data exposure) for every execution mode it
  offers. The `CapabilityRegistry` refuses venues whose profiles are incomplete or inconsistent.
  Every disclosure is derived from these declarations by `describeExecution`.
* Hyperliquid publishes resting orders and attributes trades to addresses, so only `public-limit`
  exists there. Nova never labels an order routed there hidden or private.
* The simulator implements hidden and iceberg orders and a private RFQ desk, and its public book
  and tape reflect them, so the disclosures can be tested.
* `PrivateExecutionService` routes hidden and iceberg orders. It refuses unsupported modes before
  calling an adapter. RFQ goes through the server's `RfqDesk`, which enforces authorization.
  Encrypted execution is planned only.

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
