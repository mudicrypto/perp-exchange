# Stellar settlement feasibility spike (Milestone 12, WP3)

**Measurement only. Testnet only. Not a vault.** The contract holds no tokens, accepts no deposits and
has no withdrawal. Balances are internal numbers seeded by the client. Key registration, balance
seeding and the epoch bump are deliberately unauthenticated so the costs can be measured; a real
design needs the account's own authorisation for each. Nothing here is wired into the application or
the venue engine (`src/venue/engine.ts` is unchanged).

Results, analysis and the recommendation: [`docs/venue/STELLAR-SPIKE-RESULTS.md`](../../docs/venue/STELLAR-SPIKE-RESULTS.md).
Design under test: [`docs/venue/STELLAR-FEASIBILITY.md`](../../docs/venue/STELLAR-FEASIBILITY.md).

| Path | What it is |
|---|---|
| `contract/` | Soroban measurement contract (`soroban-sdk` 29.0.1, pinned). Signed-order checks, cumulative fill limit, two exactly-once rules (strict cursor; idempotent fill identifier), anchoring, TTL and signature probes |
| `contract/src/test.rs` | 9 native tests of the settlement semantics |
| `client/spike.mjs` | Testnet run: deploys three instances and measures everything in the results document |
| `client/summarize.mjs` | Regenerates the summary tables and the transaction list from a results file |

## Toolchain (as used)

- Rust 1.97.0 with target `wasm32v1-none` (`rustup target add wasm32v1-none`)
- `stellar-cli` 28.1.0 (`cargo install --locked stellar-cli@28.1.0`; on Debian/Ubuntu it needs
  `libdbus-1-dev`, `libudev-dev` and `pkg-config`)
- Node 22 with `@stellar/stellar-sdk` 17.2.1 (pinned in `client/package.json`)

## Reproduce

```sh
# 1. Native tests
cd spikes/stellar-settlement/contract
cargo test

# 2. Build (the CLI sets the SDK's spec-shaking flag; a plain `cargo build` produces a different, larger wasm)
stellar contract build
sha256sum target/wasm32v1-none/release/settlement_spike.wasm
# expected: 9a4bebc55ddbc1ba517c66a019a4903cb02b164c696b5b7de762372a76f321e3 (12,421 bytes)

# 3. Testnet run (about 12 minutes; about 86 transactions; refuses any network but testnet)
cd ../client
npm ci
node spike.mjs                      # behind an HTTP proxy: NODE_USE_ENV_PROXY=1 node spike.mjs

# 4. Tables
node summarize.mjs out/latest.json
node summarize.mjs --transactions out/latest.json
```

Every run generates fresh keys in memory, funds the operator and five channel accounts with friendbot
(testnet lumens only), deploys new contract instances, and writes `client/out/results-<time>.json`
(ignored by git). The results of the two runs reported are kept in
`docs/venue/verification/m12/stellar-spike/`. Contract identifiers, accounts, fees and application
order differ between runs; the structure of the results should not.
