# Nova Exchange

A perpetual futures trading terminal focused on risk transparency, analytics and — longer term —
private execution. **Milestone 1:** real-time public market data (read-only for live venues), a
complete trading terminal, and a clearly-labelled demo environment where orders are matched
locally by a paper-trading simulator. **Milestone 4:** a Private Execution workspace (hidden,
iceberg and private RFQ on the simulated venue, encrypted orders planned) with a privacy matrix
for every mode. **Milestone 5:** a deterministic, decimal risk engine with venue-specific margin
rules, configurable pre-trade limits enforced in the execution layer, and a risk report. No real orders, custody, deposits or withdrawals.

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Trading domain & execution adapters (supported/unsupported features): [`docs/TRADING.md`](docs/TRADING.md)
- Hyperliquid integration: [`docs/integrations/HYPERLIQUID.md`](docs/integrations/HYPERLIQUID.md)
- Private execution & privacy model: [`docs/PRIVACY.md`](docs/PRIVACY.md)
- Risk calculations, limits and worked examples: [`docs/RISK.md`](docs/RISK.md)
- Progress and roadmap: [`docs/CHECKLIST.md`](docs/CHECKLIST.md)

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; defaults are safe

npm run dev:sim    # demo environment: simulated data + paper trading (no network needed)
npm run dev        # live public market data from Hyperliquid mainnet (read-only)
```

Open http://localhost:3000. Production-like demo run:

```bash
npm run build
NOVA_MARKET_DATA_SOURCE=simulation NOVA_ALLOW_SIMULATION_IN_PRODUCTION=true npm start
```

In the demo, the header's **Demo** menu can simulate a connection loss, a chart data failure, or
reset the demo account.

## Configuration

All configuration is server-side and validated at startup (`src/config/parse-server-env.ts`).

| Variable | Values | Default | Notes |
|---|---|---|---|
| `NOVA_MARKET_DATA_SOURCE` | `hyperliquid`, `simulation` | `hyperliquid` | Simulation is refused in production unless allowed below |
| `NOVA_HYPERLIQUID_NETWORK` | `mainnet`, `testnet` | `mainnet` | Public market data only |
| `NOVA_EXECUTION_MODE` | `disabled` | `disabled` | Any other value fails startup |
| `NOVA_ALLOW_SIMULATION_IN_PRODUCTION` | `true`, `false` | `false` | For demos and E2E only |

No secrets are needed. Nova never asks for seed phrases or private keys.

## Scripts

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint incl. architecture-boundary rules |
| `npm test` | Vitest unit tests |
| `npm run build` | Production build |
| `npm run test:e2e` | Playwright (builds must exist; runs `next start` in simulation mode) |
| `npm run test:live` | Live contract test against Hyperliquid's public API (needs network access; read-only) |
| `npm run check` | typecheck + lint + unit tests + build |

Playwright uses Chromium. If your environment provides a browser at a custom path, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Honesty rules (enforced in code)

- Simulated data is always labelled (banner + badge) and uses fictitious markets (ALPHA, BETA, GAMMA).
- Every external payload is validated with Zod; invalid payloads are dropped, never rendered.
- Account panels show explicit empty states; no placeholder balances or positions.
- Order visibility disclosures come from the venue's declared, consistency-checked privacy
  profiles. Orders routed to Hyperliquid are shown as public because Hyperliquid publishes its order
  book and fills. Private modes are refused before reaching any venue that cannot honour them.
- RFQ requests are authorised on the server (only the requester and the selected counterparties
  can read them). They never carry your limit price, and they are deleted ≤ 5 minutes after
  completion.
