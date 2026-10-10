# Hyperliquid test fixtures

These JSON files are **hand-written samples** shaped after Hyperliquid's documented public API
(info endpoint and websocket subscriptions). They are **not captured live data**: prices, sizes,
hashes and ids are illustrative values chosen for tests. Do not use them as market data.

When live access is available, replace or supplement them with recorded responses
(see `docs/CHECKLIST.md`, "Record live fixtures").

`clearinghouse-state.json` and `frontend-open-orders.json` follow the shapes documented in the official
python SDK (`info.py` docstrings for `user_state` and `frontend_open_orders`). The `orderType` value
`"Some Future Type"` is deliberately unknown, to test that unmapped orders are skipped, not guessed.
