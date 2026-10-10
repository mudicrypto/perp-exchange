# Nova Exchange

A perpetual futures trading terminal focused on risk transparency, analytics and — longer term —
private execution. **Milestone 1 is read-only:** real-time public market data, charting and
pre-trade risk estimates. There is no order submission, custody, deposits or withdrawals.

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Progress and roadmap: [`docs/CHECKLIST.md`](docs/CHECKLIST.md)

## Quick start

```bash
npm install
cp .env.example .env.local   # optional; defaults are safe

npm run dev        # live public market data from Hyperliquid mainnet
npm run dev:sim    # simulated data (no network), clearly labelled in the UI
```

Open http://localhost:3000.

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
| `npm run check` | typecheck + lint + unit tests + build |

Playwright uses Chromium. If your environment provides a browser at a custom path, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Honesty rules (enforced in code)

- Simulated data is always labelled (banner + badge) and uses fictitious markets (ALPHA, BETA, GAMMA).
- Every external payload is validated with Zod; invalid payloads are dropped, never rendered.
- Account panels show explicit empty states; no placeholder balances or positions.
- Order visibility disclosures come from the venue's declared capabilities. Orders routed to
  Hyperliquid are shown as public because Hyperliquid publishes its order book and fills.
