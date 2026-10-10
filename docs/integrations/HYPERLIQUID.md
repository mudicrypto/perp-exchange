# Hyperliquid market-data integration

Status: implemented and unit/E2E tested against recorded-format fixtures and the simulator.
**Not yet verified against the live API from the build environment** (egress to Hyperliquid
hosts, including the docs site, is blocked there). Run `npm run test:live` anywhere the API is
reachable before relying on it. See [Verification](#verification).

Scope: public market data, plus read-only account data by public address (Milestone 3). No
authentication, no keys, no signing, no order placement. Execution capabilities are listed in
[`docs/TRADING.md`](../TRADING.md).

## Sources of truth

The task specifies Hyperliquid's official documentation as the source of truth. The docs site
(`hyperliquid.gitbook.io`) could not be reached from the build environment (HTTP 403 from the
egress policy), so the implementation was built from the closest reachable sources, in this order:

| Source | Authority | Used for |
|---|---|---|
| `hyperliquid-dex/hyperliquid-rust-sdk` (`ws/sub_structs.rs`, `ws/message_types.rs`, `ws/ws_manager.rs`) | Official SDK | WS message shapes (`l2Book`, `trades`, `candle`, `allMids`, `activeAssetCtx`), ping/pong, channel names |
| `hyperliquid-dex/hyperliquid-python-sdk` (`utils/types.py`, `websocket_manager.py`, `info.py`) | Official SDK | Subscription request shapes, info request types, `PerpAssetCtx` fields, keep-alive |
| `@nktkas/hyperliquid` 0.33.3 (typed schemas linking each type to its official docs page) | Community, cross-check | `metaAndAssetCtxs`, `candleSnapshot` request/response, `error` channel string formats, optional fields |
| Hyperliquid "Rate limits and user limits" docs page | Official, **from prior knowledge, not re-checked** | Rate-limit figures below |

Nova never requires a field it does not use, and `npm run test:live` checks each schema against the real API.

## Endpoints

| Network | REST (`POST`) | WebSocket |
|---|---|---|
| mainnet | `https://api.hyperliquid.xyz/info` | `wss://api.hyperliquid.xyz/ws` |
| testnet | `https://api.hyperliquid-testnet.xyz/info` | `wss://api.hyperliquid-testnet.xyz/ws` |

Selected with `NOVA_HYPERLIQUID_NETWORK` (default `mainnet`).

## REST (server-side only, via `HyperliquidInfoClient`)

| Request body | Purpose | Nova route |
|---|---|---|
| `{"type":"metaAndAssetCtxs"}` | Perp universe (`name`, `szDecimals`, `maxLeverage`, `onlyIsolated?`, `isDelisted?`) + parallel asset contexts (`markPx`, `oraclePx`, `midPx?`, `funding`, `openInterest`, `prevDayPx`, `dayNtlVlm`, …) | `GET /api/markets` |
| `{"type":"candleSnapshot","req":{"coin","interval","startTime","endTime"}}` | Candle history (`t`,`T`,`s`,`i`,`o`,`h`,`l`,`c`,`v`,`n`) | `GET /api/candles?market=&interval=` |

| `{"type":"clearinghouseState","user"}` | Positions, margin summary, withdrawable (SDK `user_state`) | `GET /api/venue/account?address=` |
| `{"type":"frontendOpenOrders","user"}` | Open orders incl. type, tif, trigger, reduce-only (SDK `frontend_open_orders`) | same |

Browser code never calls the venue's REST API directly. The server validates the response with Zod,
maps it to domain types, caches it briefly (2s), and shares in-flight requests.

## WebSocket (browser, via `HyperliquidMarketDataSource`)

Client → server: `{"method":"subscribe"|"unsubscribe","subscription":{…}}`, `{"method":"ping"}`.
Server → client: `{"channel":…, "data":…}`.

| Subscription | Channel / data | Nova use |
|---|---|---|
| `{"type":"l2Book","coin"}` | `l2Book` `{coin,time,levels:[bids,asks]}` (each `{px,sz,n}`) | Order book (selected market) |
| `{"type":"trades","coin"}` | `trades` `[{coin,side,px,sz,time,hash,tid,…}]` | Recent trades |
| `{"type":"candle","coin","interval"}` | `candle` `{t,T,s,i,o,h,l,c,v,n}` | Live chart candle |
| `{"type":"activeAssetCtx","coin"}` | `activeAssetCtx` `{coin,ctx:{…PerpAssetCtx}}` | Market header stats |
| `{"type":"allMids"}` | `allMids` `{mids:{coin:px}}` | Market list prices |
| — | `subscriptionResponse`, `pong` | Acknowledgements / keep-alive |
| — | `error` (string, e.g. `Invalid subscription {…}`, `Already subscribed {…}`) | Routed to the affected stream |

Nova does not use the user-specific channels.

## Normalisation (`mappers.ts`)

- Market id: `<COIN>-PERP` for main-dex perps matching `^[A-Z0-9]{1,20}$`. Delisted assets, HIP-3
  `dex:COIN` names and spot keys (`@123`, `PURR/USDC`) are excluded.
- Price decimals: `6 - szDecimals` (perp rule). Maintenance-margin rate: `1 / (2 × maxLeverage)` (base tier only).
- Decimal strings become numbers only after a decimal-format check. Missing values (`midPx: null`) stay `null`.
- Book levels with size 0 are dropped. Crossed books are rejected.
- Trade side: `B` = buy (taker), `A` = sell. Trade id = `tid:hash` (robust to `tid` precision loss).
- Funding is hourly (`fundingIntervalHours: 1`).
- `allMids` entries are validated one by one; malformed ones are skipped and counted.

## Validation and error handling

- `protocol.ts#parseWsMessage` is pure and never throws. Each frame becomes a typed message, `ignored`
  (a channel Nova doesn't use), or `invalid` (with the failing field path).
- Invalid frames are counted and the last reason is kept (shown under Connection details). They are never rendered.
- A throwing mapper or UI handler is contained per stream; other streams keep working.
- `Invalid subscription` errors go to that stream's `onError`. The panel shows **Error**, and the
  subscription is not replayed on reconnect. `Already subscribed` is ignored, because Nova never sends duplicates.
- REST failures map to typed `VenueError`s, and then to API responses: `502` (unavailable / invalid
  data), `504` (timeout), `503` + `Retry-After` (rate limited). The UI shows an error with Retry and keeps
  any data already loaded.

## Connection, reconnects and cleanup

- One socket for all streams, opened lazily on the first subscription.
- Exponential backoff with jitter: 0.5s doubling to a 30s cap. The browser `online` event triggers an immediate reconnect.
- Keep-alive: ping every 30s (the official SDKs use 50s). No reply within 10s → reconnect.
- On reconnect every stream receives `onReset` (order book cleared, chart history reloaded) and
  subscriptions are replayed.
- `dispose()` closes the socket, clears all timers and removes the `online` listener (tested).

## Duplicate and stale-update protection

| Concern | Mechanism |
|---|---|
| Duplicate venue subscriptions | Canonical subscription key + reference counting; one `subscribe` per key |
| Late frames after unsubscribe | Dropped (no matching stream) |
| Duplicate trades (replays after reconnect) | `TradeBuffer` de-duplicates by trade id |
| Out-of-order book snapshots | `OrderBookState` drops snapshots with `time ≤` the current one |
| Out-of-order candles | `CandleSeries` ignores updates older than the latest candle |
| REST snapshot racing WS updates | `newerStats` / `mergeMarketSummaries` keep the newer `observedAt` |

## Freshness indicators

`streamStatus()` (core) decides what each panel shows: `waiting`, `live`, `stale`, `disconnected` or `error`.

| Stream | Stale after | Notes |
|---|---|---|
| Order book | 10s without an update | Expected to update continuously on active markets |
| Market stats | 30s | |
| Market list mids | 30s | Falls back to a labelled snapshot age when not streaming |
| Trades, candles | never while connected | Event-driven; a quiet market is not stale |

Any stream is `disconnected` while the socket is down; its badge shows the age of the last update.
The connection popover shows status, last message, subscriptions, reconnects and dropped frames.

## Rate limits

As documented by Hyperliquid (per IP; **not re-verified in this environment**):
- REST: a 1200 weight/minute budget. Most info requests weigh 20 (including `frontendOpenOrders`); `l2Book`, `allMids` and `clearinghouseState` weigh 2; and
  `candleSnapshot` adds weight per 60 items returned.
- WebSocket: up to 1000 subscriptions and 100 connections.

Nova's own limits stay well below that:
- REST: 600 weight per sliding minute, enforced on the server (`WeightBudget`). This is checked
  *before* calling the venue. Once it is exhausted, the server answers `503` with `Retry-After`
  without calling Hyperliquid.
- HTTP 429 from the venue is surfaced, never retried. Network, timeout and 5xx errors are retried once.
- The market list refreshes every 30s (prices stream via `allMids`), and requests are cached for 2s and shared.
- At most 100 WebSocket subscriptions per connection. A typical session uses about 6.

## Mock vs live separation

- `NOVA_MARKET_DATA_SOURCE` picks `hyperliquid` or `simulation` on the server, per request. The browser
  receives it in the public runtime config and builds exactly one source.
- Simulation is always labelled (banner, badge, Connection details) and uses fictitious markets.
- If live mode cannot reach the venue, the UI shows an error. There is no simulated fallback.
- `NovaApiClient` (live mode) rejects `/api/markets` responses whose `source.kind` is not `live`
  (`source-mismatch`). A misconfigured server therefore can't feed simulated data into the live UI.
- Simulation is refused in production builds unless `NOVA_ALLOW_SIMULATION_IN_PRODUCTION=true`.

## Verification

| Check | Command | Where |
|---|---|---|
| Unit: parsing, normalisation, reconnects, staleness, rate budget, mode guard | `npm test` | Anywhere (fixtures + fakes) |
| Browser: status UI, outage/recovery, diagnostics (simulated source) | `npm run test:e2e` | Anywhere |
| **Live contract**: REST schemas, every WS channel, ping/pong, error format | `npm run test:live` | Needs access to Hyperliquid |

In the build environment `npm run test:live` fails at the network layer (`fetch failed` /
websocket error), as the egress policy requires. It has not passed against the real API yet.

## Known limitations

- **Unverified live behaviour.** None of this has run against the real API. The fixtures are
  hand-written to the documented shapes.
- Rate-limit figures come from the docs as previously known and have not been re-checked.
- Only the main-dex perps are supported. HIP-3 dexes and spot are excluded.
- Order-book depth is what the default `l2Book` subscription provides. Aggregation (`nSigFigs`) is not exposed.
- Hyperliquid does not document a snapshot flag for `trades`, so the first message after
  subscribing is treated like any other batch and de-duplicated.
- `activeAssetCtx` carries no venue timestamp, so freshness for stats uses receive time.
- Prices are JS numbers. That's fine for display; order encoding (a later milestone) must use exact decimal strings.
