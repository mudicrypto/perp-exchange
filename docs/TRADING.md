# Trading domain and execution adapters

Status: Milestone 3. Venue-independent trading models, an order lifecycle state machine, a
capability registry, and two execution adapters:
- **Simulation** (full, simulated): every order and fill stays in the browser.
- **Hyperliquid** (read-only): order signing and submission are disabled until a separate
  security-reviewed milestone.

## Domain models (`src/core/domain`)

| Model | File | Notes |
|---|---|---|
| `Instrument` | `instrument.ts` | `Market` plus the venue's trading rules: significant figures, integer exemption, min order value, margin modes, status |
| `OrderRequest` | `order.ts` | Discriminated union by `type`: `limit`, `market`, `stop-market`, `take-profit-market`, `stop-limit`, `take-profit-limit`, `iceberg` (with `displaySize`), `hidden`. Always carries a caller-chosen `clientOrderId` (idempotency). `OrderType` also has `rfq`, for bilateral trades booked from an accepted RFQ quote; it is never a request type |
| `Order` / `OrderStatus` | `order.ts` | Lifecycle state, fills, trigger time, `lastSequence`, **`origin: "simulated" \| "venue"`** |
| `Fill` | `order.ts` | Unique `id` (de-duplication), liquidity (`maker`/`taker`/`liquidation`/`rfq`), fee, realised PnL, `origin` |
| `Position`, `Balance`, `AccountSnapshot` | `account.ts` | Snapshot has `origin`. Fields a venue does not report are **`null`**, never derived |
| `TradingError`, `Result<T>` | `errors.ts` | Typed errors. Includes `unsupported` (names the capability and who lacks it), `simulated-rejection` and `risk-limit` (refused by pre-trade limits, see [RISK.md](RISK.md)) |
| `CapabilityId`, `CapabilityStatus` | `capabilities.ts` | `supported`, or `unsupported` with `scope: "venue" \| "nova"` and a reason |

## Order lifecycle (`src/core/trading/order-lifecycle.ts`)

```
pending-new ──accepted──▶ open ──fill──▶ partially-filled ──fill──▶ filled
     │   └─accepted (trigger types)─▶ waiting-trigger ──triggered──▶ open
     ├──rejected──▶ rejected
     └──fill──▶ partially-filled / filled          (fills may precede the ack)
open | partially-filled | waiting-trigger ──cancel-requested──▶ cancel-pending
cancel-pending ──cancelled──▶ cancelled
cancel-pending ──cancel-rejected──▶ previous working state (incl. waiting-trigger)
cancel-pending ──fill──▶ cancel-pending, or filled if complete
working states ──expired──▶ expired
```

- `transitionOrder` is pure. A transition the table doesn't allow returns `invalid-transition`.
  An overfill, or a fill for another market or side, returns an error and is never forced.
- `OrderStore` applies events idempotently:
  - duplicate `eventId` → ignored
  - same fill id delivered twice → ignored
  - `sequence` ≤ the last applied sequence → ignored as stale
  - unknown order → reported
- The simulator emits every status change through `OrderStore`. If it ever produced an invalid
  transition, it would throw rather than continue.

## `ExecutionAdapter` (`src/core/ports/execution.ts`)

| Method | Purpose |
|---|---|
| `getCapabilities()` | Explicit status for every `CapabilityId`, plus the venue's privacy profiles (`VenuePrivacy`, see [PRIVACY.md](PRIVACY.md)) |
| `describeInstrument(market)` | Adds the venue's trading rules to a market |
| `validateOrder(input, instrument, ctx?)` | Synchronous validation. The unsupported-feature check runs first, then every rule issue is reported together |
| `submitOrder(request, instrument)` | Submit (validated again by the adapter) |
| `cancelOrder({orderId} \| {clientOrderId})`, `cancelAllOrders(marketId?)` | Cancellation |
| `fetchOpenOrders / fetchPositions / fetchAccountState(account)` | Reads. `account` is `{kind:"simulated"}` or `{kind:"address", address}`, never a key |
| `subscribeOrderUpdates / subscribeFills(account, listener)` | Streams. Returns `Result<Unsubscribe>` |

Every method returns a `Result`. An unsupported feature always yields
`{ code: "unsupported", capability, scope, message }`. Adapters never substitute another order
type or emulate a feature.

## Capability registry (`src/core/trading/capability-registry.ts`)

`CapabilityRegistry` registers each venue's capabilities. It refuses a venue that doesn't
declare every capability, and answers `check(venueId, capability)` / `supports(...)`; unknown
venues are unsupported. The UI uses it as follows:

- **Order ticket:**
  - supported types are selectable
  - types the venue offers but Nova doesn't implement are **preview only**: validation and risk
    preview work, submission is disabled with the reason
  - types the venue doesn't offer are disabled and list their reason
- **Account tables** show Close / Cancel / Cancel all only when the matching action is supported.
- **Private Execution workspace** derives each mode's availability and disclosure from the active venue (see [PRIVACY.md](PRIVACY.md)).

### Supported and unsupported features

✅ supported · 🚧 not implemented in Nova (may exist on the venue) · ⛔ not offered by the venue.
This table is checked against the code by `src/adapters/capability-docs.test.ts`.

<!-- capability-matrix:start -->
| Capability | Simulation | Hyperliquid |
|---|---|---|
| `order.limit` | ✅ supported | 🚧 not in Nova |
| `order.market` | ✅ supported | 🚧 not in Nova |
| `order.stop-market` | ✅ supported | 🚧 not in Nova |
| `order.stop-limit` | 🚧 not in Nova | 🚧 not in Nova |
| `order.take-profit-market` | ✅ supported | 🚧 not in Nova |
| `order.take-profit-limit` | 🚧 not in Nova | 🚧 not in Nova |
| `order.iceberg` | ✅ supported | ⛔ venue doesn't offer |
| `order.hidden` | ✅ supported | ⛔ venue doesn't offer |
| `order.twap` | 🚧 not in Nova | 🚧 not in Nova |
| `tif.gtc` | ✅ supported | 🚧 not in Nova |
| `tif.ioc` | ✅ supported | 🚧 not in Nova |
| `tif.post-only` | ✅ supported | 🚧 not in Nova |
| `order.reduce-only` | ✅ supported | 🚧 not in Nova |
| `action.submit` | ✅ supported | 🚧 not in Nova |
| `action.cancel` | ✅ supported | 🚧 not in Nova |
| `action.cancel-all` | ✅ supported | 🚧 not in Nova |
| `read.open-orders` | ✅ supported | ✅ supported |
| `read.positions` | ✅ supported | ✅ supported |
| `read.account` | ✅ supported | ✅ supported |
| `stream.order-updates` | ✅ supported | 🚧 not in Nova |
| `stream.fills` | ✅ supported | 🚧 not in Nova |
| `execution.rfq` | ✅ supported | ⛔ venue doesn't offer |
| `execution.batch-auction` | ⛔ venue doesn't offer | ⛔ venue doesn't offer |
| `execution.encrypted` | 🚧 not in Nova | 🚧 not in Nova |
| `margin.isolated` | ✅ supported | 🚧 not in Nova |
| `margin.cross` | 🚧 not in Nova | 🚧 not in Nova |
<!-- capability-matrix:end -->

## SimulationAdapter (`src/adapters/simulation`)

- **Explicitly simulated:**
  - every `Order`, `Fill` and `AccountSnapshot` carries `origin: "simulated"`, and balances are in fictitious SIMUSD
  - the UI labels the account, the review dialog ("Simulated order … Nothing is sent to a real venue") and results ("Simulated fill")
  - there is no wallet, network or venue code
- **Deterministic:** sequential ids (`SIM-000001`, `SIM-F000001`, `SIM-E1`) and no randomness. The
  same inputs and timestamps produce identical states (tested).
- **Configurable** (`SimulationConfig`, `SimulationAdapterOptions`):
  - `fillModel`: `"book"` (match against the simulated book) or `"none"` (accept, never fill)
  - `liquidityFraction` (0..1]: the share of each visible level available; below 1 produces partial fills
  - rejection rules: `next` N orders, `every-nth`, per `market`. Reported as `simulated-rejection`
  - `ackLatencyMs`: delay between `pending-new` and the decision (the demo uses 150ms)
- **Implements:** limit (GTC/IOC/post-only), market (IOC with a slippage bound), stop-market and
  take-profit-market (triggered on the simulated mark), reduce-only, isolated margin, cancel /
  cancel-all, its own liquidation, order and fill streams.
- **Private order types (Milestone 4):**
  - `hidden`: rests and matches like a limit order but is excluded from the simulated public book
  - `iceberg`: shows only `displaySize` at its price; fills at most one displayed slice per book
    update, then refills (refills are counted and shown)
  - `rfq` trades: booked with `recordRfqTrade` at the price the RFQ service confirmed, after the same
    leverage and margin checks (`checkRfqTrade` runs them first, without side effects)
- **Public data reflects the account:** the simulated public book adds the account's displayed
  resting orders (`PaperEngine.publicLiquidity`), and every fill prints on the simulated trade tape
  without account or order ids. The engine matches against the raw synthetic book
  (`subscribeVenueBook`), so it never matches the account against itself.
- **Does not implement:** stop-limit / take-profit-limit, TWAP, cross margin, encrypted orders (🚧
  above); batch auctions (⛔).
- **Demo controls:** reject next order, reset account, connection loss, chart failure.

## HyperliquidAdapter (`src/adapters/hyperliquid/hyperliquid-adapter.ts`)

Based on Hyperliquid's official Python SDK (`utils/signing.py`, `examples/rounding.py`, `info.py`):

- **Order model, used for validation only:**
  - `limit` with time-in-force `Gtc` / `Ioc` / `Alo` (post-only)
  - `trigger` with `tpsl` (`tp` or `sl`) and `isMarket` → stop / take-profit, market or limit
  - `reduceOnly`
  - no hidden, iceberg or RFQ order types
- **Price rules** (enforced by `validateOrder`): ≤ 5 significant figures and ≤ `6 − szDecimals`
  decimals; integer prices are always allowed.
- **Implemented, read-only, by public address** via `GET /api/venue/account?address=`:
  - positions and account (`clearinghouseState`)
  - open orders (`frontendOpenOrders`)
  - reported as `origin: "venue"`
  - fields the documented response doesn't contain are `null`: cash balance, realised PnL, fees,
    order margin, maintenance margin, mark price, and order leverage
  - order history and fills are `null` ("not available"), not empty
  - order types the adapter can't map are skipped and counted
- **Not implemented**, each returning an explicit `unsupported` error:
  - submit, cancel, cancel-all
  - order and fill streams
  - all order types and TIFs for submission
- **No keys, no signing code, no exchange-endpoint calls.**
- **Not enforced:** a minimum order value. Hyperliquid has one, but the figure couldn't be
  verified against the docs in this build.

## Tests

| Area | File |
|---|---|
| State transitions, duplicate/stale events, cancellations, overfills | `src/core/trading/order-lifecycle.test.ts` |
| Order validation, explicit unsupported results, capability registry | `src/core/trading/validation.test.ts` |
| Simulator: fills, rejections (margin, liquidity, post-only, configured), triggers, cancels, determinism, fixtures | `src/adapters/simulation/paper-engine.test.ts` |
| SimulationAdapter: lifecycle streaming, ack latency, unsupported types, feed loss, account scope | `src/adapters/simulation/simulation-adapter.test.ts` |
| Capability detection for both venues; Hyperliquid never submits | `src/adapters/venue-capabilities.test.ts` |
| Hyperliquid account reads: normalisation, null fields, skipped records, errors | `src/adapters/hyperliquid/account.test.ts` |
| UI: trigger orders, preview-only types, unsupported types, simulated rejection | `tests/e2e/terminal.spec.ts` |
