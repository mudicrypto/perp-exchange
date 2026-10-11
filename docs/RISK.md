# Nova Exchange — Risk Calculation Reference

Status: Milestone 5. The code is in `src/core/risk` (pure, venue-agnostic), venue rules are in
`src/adapters/<venue>/margin-rules.ts`, and enforcement is in
`src/core/trading/risk-guard.ts`.

> **Limits and estimates reduce some risks. They cannot eliminate losses.** A liquidation price is
> an estimate under stated assumptions, not a guarantee. A venue may liquidate at a different
> price, positions can gap through their liquidation level, and losses can exceed the collateral
> shown.

## 1. Principles

1. **Pure and deterministic.** Every function takes all of its inputs, including the time `now`,
   and returns the same result for the same inputs. There is no I/O and no clock access.
2. **Decimal arithmetic.**
   - Calculations use `decimal.js` with 40 significant digits and banker's rounding
     (`ROUND_HALF_EVEN`).
   - JS numbers coming from the domain are converted on entry. They are converted back to numbers
     only for display formatting.
3. **Explicit units on every figure** (`src/core/risk/units.ts`). See §2.
4. **Available or unavailable, never guessed.**
   - Each figure is a `RiskValue`. It is either *available*, with its method, inputs (source and
     timestamp), assumptions and kind, or *unavailable*, with a reason and the missing inputs.
   - Missing or stale inputs make dependent figures unavailable.
   - An aggregate is unavailable if any component is. A partial sum is never presented as a total.
5. **Kinds of figure:**
   - `calculated`: exact from the listed inputs
   - `estimate`: depends on assumptions that may not hold
   - `venue-reported`: taken from the venue as reported, not computed by Nova
6. **Venue-specific rules only** (§4). There is no default margin formula. A venue without rules
   gets no margin, liquidation or fee figures.
7. **Notional is not collateral and not a maximum loss** (§3).

## 2. Units

| Unit | Meaning | Example |
|---|---|---|
| price | quote currency per 1 base unit | `918.4` USDC/EX |
| quantity | base units. Position sizes are signed: + long, − short | `-3` WHY |
| amount | quote / collateral currency: notional, PnL, fees, funding, margin | `2100` USDC |
| fraction | dimensionless ratio. `0.01` = 1 %. Percentages appear only in the UI | `0.0816` |
| multiple | dimensionless "x" (leverage) | `0.2220463091` |
| rate per interval | funding: fraction of notional per `intervalHours` | `0.0000125` per 1h |
| fee rate | fraction of traded notional per fill | `0.00045` (4.5 bps) |

Limits are configured in the account's collateral currency (the venue's quote asset).

## 3. Definitions and formulas

`q` = |size|, `s` = signed size, `E` = entry price, `M` = mark, `C` = collateral,
`m` = maintenance margin rate, `L` = leverage.

| Figure | Formula | Kind | Notes |
|---|---|---|---|
| Position notional | `q × M` | calculated | **Exposure.** Not the collateral and not the most you can lose |
| Signed exposure | `s × M` | calculated | negative for shorts |
| Unrealised PnL | `s × (M − E)` | calculated | valued at the mark; closing would trade at book prices and pay fees |
| Realised PnL | Σ realised PnL reported on each fill, before fees | calculated | only over the loaded fill history; unavailable without records |
| Fees | Σ fill fees (negative = rebate) | calculated | |
| Funding, next interval | `−s × P_basis × rate` (positive = received) | estimate | `P_basis` is the venue's funding price (mark or oracle); assumes the rate holds |
| Funding paid | from funding payment records | — | unavailable (no records loaded). Exactly 0 for a venue that charges no funding (the simulator) |
| Initial margin (pre-trade) | venue rule. Both current venues use `notional / L` | calculated | |
| Maintenance margin | venue-reported if available, else Σ venue rule per position | calculated or venue-reported | unavailable for Hyperliquid (§4) |
| Liquidation price | venue rule (§4) | estimate or venue-reported | rounded to the tick **toward the mark** (long up, short down), so the shown level is never further away than computed |
| Liquidation distance | `|M − P_liq| / M` (pre-trade: from the reference price) | estimate | |
| Gross / net exposure | Σ `q × M` / Σ `s × M` | calculated | |
| Instrument share | instrument notional / gross | calculated | |
| Concentration (HHI) | Σ share² | calculated | 1 = a single instrument; 1/n = n equal instruments |
| Initial-margin utilisation | collateral in use / equity | calculated | |
| Maintenance utilisation | maintenance margin / equity | calculated | at 1 the account is at its liquidation threshold |
| Effective leverage | gross / equity | calculated | unavailable at equity ≤ 0 |
| Scenario PnL | Σ `s × M × move` | estimate | hypothetical uniform move of every mark; ignores fees, funding, slippage and liquidation |

**Average-cost accounting.** `reconstructPosition` is used to cross-check reported fill PnL:

- An increase re-averages the entry: `E' = (q·E + q_f·P_f)/(q + q_f)`.
- A reduction realises `(P_f − E) × closed × direction`.
- A fill that flips the position opens the remainder at the fill price.

**Constant-rate isolated liquidation.** Used only by venues whose rules match it. Liquidation
happens when equity equals maintenance margin:

```
long:  C + q·(P − E) = m·q·P   ⇒   P = (q·E − C) / (q·(1 − m))
short: C + q·(E − P) = m·q·P   ⇒   P = (q·E + C) / (q·(1 + m))
```

No positive solution means the position cannot be liquidated by price alone. For example, a 1x
long with collateral equal to its notional.

## 4. Venue rules

| | Simulator | Hyperliquid |
|---|---|---|
| Source | Nova's paper engine (exactly what it enforces) | Hyperliquid documentation; **not re-verified against the live docs from the build environment** |
| Margin modes | isolated | cross and isolated |
| Initial margin | notional / L | position value / L |
| Maintenance margin | notional × constant per-market rate (no tiers) | **unavailable**: set by per-asset margin tables (tiers), which Nova does not load |
| Liquidation price | constant-rate isolated formula (§3). The engine uses the same function | **venue-reported `liquidationPx` only**. Nova never computes its own |
| Fees | taker 0.045 %, maker 0.015 % (paper schedule) | **unavailable**: depends on the account's volume tier |
| Funding | not charged (funding paid = 0, projection = 0) | hourly, on the oracle price (projection is an estimate) |

A test checks that the simulator rule produces exactly the liquidation price the paper engine
enforces (`src/adapters/risk-rules.test.ts`).

## 5. Inputs, timestamps and staleness

`FreshnessPolicy` (defaults):

- mark prices: 15 s
- account snapshot: 30 s
- funding rate: 5 min

Behaviour:

- A timestamp more than 1 s in the future counts as invalid.
- Every input shown in "Calculation details" carries its source and observation time. Each value
  carries `asOf`, the calculation time.

## 6. Pre-trade limits and enforcement

Limits are defined by `RiskLimitsSchema` (`src/core/risk/limits.ts`):

- They are configured **on the server** with `NOVA_RISK_LIMITS` (JSON merged onto the defaults;
  invalid configuration fails startup).
- They are delivered to the browser read-only, in the public runtime config.

| Limit | Default | Checked value |
|---|---|---|
| `maxOrderNotional` | 250,000 · block | order size × reference price (market orders: at least size × mark) |
| `maxPositionNotional` | 500,000 · block | resulting position size × reference price |
| `maxGrossExposure` | 1,000,000 · block | other positions at mark + resulting position |
| `maxLeverage` | not set | order leverage |
| `maxConcentration` | 0.8 · warn | resulting instrument notional / gross after the order |
| `minLiquidationDistance` | 0.05 · warn | estimated liquidation distance |
| `maxPriceDeviation` | 0.1 · block | limit-style orders: `|limit − mark| / mark` |
| `maxMarkAgeMs` | 15,000 · always blocks | age of the mark price |
| venue max leverage | always blocks | order leverage > market maximum |

How checks behave:

- **Fail closed.** A check whose inputs are unavailable is `unverifiable`. An unverifiable
  *blocking* check blocks the order. A missing mark blocks.
- **Reduce-only orders** skip the exposure-increasing limits.

**Where limits are enforced:**

- `RiskGuardedExecutionAdapter` wraps every execution adapter (simulator and Hyperliquid) and runs
  `assessOrder` on the venue's own state before `submitOrder`. Blocked orders never reach the venue
  (`TradingError` `risk-limit`).
- The order ticket shows the same assessment, so preview and enforcement cannot disagree.
- Hidden and iceberg orders go through the guard via `PrivateExecutionService`. RFQ trades are
  assessed as the equivalent immediate limit order before a quote is accepted and again when the
  trade is booked.
- **On the server**, `POST /api/rfq` checks the order- and position-notional limits against
  server-held limits. It uses the higher of the client's reference price and the server's own mark,
  so a client cannot understate the notional.
- **Boundary today:** the simulator's paper engine runs in the browser, so its guard protects the
  demo flow but is not a security boundary. Live submission is disabled. When it is added
  (testnet milestone), the guarded adapter must run on the server with server-fetched account
  state. That is a tracked checklist item.

## 7. Rounding

| Output | Precision | Mode |
|---|---|---|
| amounts | 8 dp | half-even |
| fractions / multiples | 10 dp | half-even |
| liquidation prices | market tick (`priceDecimals`) | toward the mark |

Intermediate values are never rounded. A repeating decimal (for example, an average entry of
7290.35 / 3.5…) leaves a residue below 10⁻³⁰, which disappears at output precision.

## 8. Worked examples (independently verifiable)

Every example uses the fictional **Example venue**:

- isolated margin
- maintenance rate `m = 0.02`
- tick 0.1
- taker 0.00045, maker 0.00015
- hourly funding on the oracle price

Each result below is asserted by a unit test (named in brackets) and was checked separately with
Python's `decimal` module at 40 digits.

### A — Long position (`portfolio.test.ts` › "long A")

Long 2 EX at E = 1000, 10x isolated, so C = 2000 / 10 = 200. Mark M = 1050.

- notional = 2 × 1050 = **2100**. Unrealised PnL = 2 × (1050 − 1000) = **100**.
- P = (2·1000 − 200) / (2·0.98) = 1800 / 1.96 = 918.367346938… → tick up → **918.4**.
  - Check: at 918.4, equity = 200 + 2·(918.4 − 1000) = 36.8, and maintenance = 0.02·2·918.4 =
    36.736. Not yet liquidated, so the shown level is conservative.
- distance = (1050 − 918.4) / 1050 = **0.1253333333**.

### B — Short position (`portfolio.test.ts` › "short B")

Short 3 WHY at E = 50, 5x, so C = 150 / 5 = 30. Mark M = 48.

- notional = **144**. Signed exposure = **−144**. Unrealised PnL = −3 × (48 − 50) = **+6**.
- P = (3·50 + 30) / (3·1.02) = 180 / 3.06 = 58.823529… → tick down → **58.8**. Distance =
  10.8 / 48 = **0.225**.

### C — Portfolio of A + B (`portfolio.test.ts` › "exposure…", "margin…", "funding…")

Equity 10,106 (reported), collateral in use 230.

- long **2100**, short **144**, gross **2244**, net **1956**.
- shares: 2100/2244 = **0.935828877**, 144/2244 = **0.064171123**. HHI = 0.9358…² + 0.0641…² =
  **0.8798936201**.
- maintenance margin = 0.02·2100 + 0.02·144 = **44.88**:
  - maintenance utilisation 44.88/10106 = **0.0044409262**
  - initial utilisation 230/10106 = **0.0227587572**
  - effective leverage 2244/10106 = **0.2220463091**
- funding, next hour:
  - A pays −2 × 1049 (oracle) × 0.0000125 = **−0.026225**
  - B: rate −0.00002 means shorts pay: −(−3) × 48.1 × (−0.00002) = **−0.002886**
  - total **−0.029111**

### D — Average-cost realised PnL (`pnl.test.ts`)

The fills, in order:

1. Buy 2 @ 100, then buy 1 @ 130. Entry becomes (200 + 130)/3 = 110.
2. Sell 2 @ 120. Realises (120 − 110)·2 = **+20**.
3. Sell 3 @ 90. Closes 1: (90 − 110)·1 = **−20**. Opens short 2 @ **90**.

Result: total realised **0**; final position −2 @ 90.

### E — Pre-trade (`pre-trade.test.ts` › "example E")

Buy 2 EX limit 1000, 10x, no existing position.

- notional **2000**; initial margin **200**; taker fee 2000 × 0.00045 = **0.9**; post-only maker
  fee **0.3**
- liquidation **918.4** (as in A); distance (1000 − 918.4)/1000 = **0.0816**
- Adding 2 @ 1100 to position A instead:
  - size 4, entry (2000 + 2200)/4 = 1050, collateral 200 + 220 = 420
  - P = (4200 − 420)/(4·0.98) = 964.2857… → **964.3**

### F — Scenarios on portfolio C (`portfolio.test.ts` › "price-move scenarios")

| Move | EX mark | WHY mark | PnL change | Equity after | A reaches liquidation (918.4)? |
|---|---|---|---|---|---|
| −20 % | 840 | 38.4 | 2·(−210) + (−3)·(−9.6) = **−391.2** | **9714.8** | **yes** |
| −10 % | 945 | 43.2 | −210 + 14.4 = **−195.6** | **9910.4** | no |
| +10 % | 1155 | 52.8 | **+195.6** | **10301.6** | no |

## 9. Tests

| Area | File |
|---|---|
| Decimal arithmetic, rounding, extreme and invalid inputs, liquidation formula | `src/core/risk/decimal.test.ts` |
| Portfolio: long/short, exposure, concentration, margin, funding, fees, missing/stale data, scenarios | `src/core/risk/portfolio.test.ts` |
| Average-cost reconstruction | `src/core/risk/pnl.test.ts` |
| Pre-trade figures and every limit, including fail-closed behaviour | `src/core/risk/pre-trade.test.ts` |
| Venue rules (simulator = paper engine; Hyperliquid never guesses), the guard, composition | `src/adapters/risk-rules.test.ts` |
| Limit configuration | `src/config/parse-server-env.test.ts` |
| UI and server enforcement | `tests/e2e/risk.spec.ts` |
