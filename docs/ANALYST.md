# Nova Exchange — AI Trading Analyst

Status: Milestone 6.

- Works with **mock accounts only**, in the simulated demo environment. Every analyst route
  answers 404 in live mode.
- No real-money account, venue or trading agent is connected.

## What it does

The analyst answers questions about the signed-in user's own account. For example:

- Why did my equity change today?
- How much did I pay in fees and funding?
- Which position contributes most to my portfolio exposure?
- What would happen to my unrealised P&L if this market moved 3 %?
- Summarise my recent executions.

Every figure comes from a **read-only, authorized server tool** that computes it with tested
application code (`src/core/analytics`, `src/core/risk`). The language model only chooses tools and
narrates their results. The verified results are shown under every answer, and they are the
source of truth.

## Architecture

```
browser /analyst ──POST /api/analyst/ask──▶ route (session, same-origin, rate limit, account check)
                                              │
                                              ▼
                                   askAnalyst (guards)
                          ┌───────────────────┴───────────────────┐
                 OfflineAnalystEngine                   ClaudeAnalystEngine (manual tool loop)
                          └───────────────────┬───────────────────┘
                                              ▼
                     executeTool: known tool → Zod input → authorize(account) → run (read-only)
                                              ▼
                     AccountHistoryGateway (mock ledger) + core/analytics + core/risk
```

| Layer | File |
|---|---|
| Pure calculations | `src/core/analytics/` (equity attribution, fees and funding, execution summary, periods); `src/core/risk/scenarios.ts` (`marketMoveScenario`) |
| Data source port | `src/core/analytics/source.ts` (`AccountHistoryGateway`) |
| Mock accounts | `src/adapters/mock-accounts/` (deterministic ledger, mock venue rules, mock users) |
| Tool layer | `src/server/analyst/tools.ts`, `executor.ts`, `principal.ts`, `evidence.ts` |
| Engines | `offline-engine.ts` (rule-based) and `claude-engine.ts` (Claude) |
| Guards and orchestration | `guards.ts`, `analyst.ts` |
| HTTP | `src/app/api/analyst/{users,session,ask}` and `src/server/analyst/service.ts` |
| UI | `src/features/terminal/analyst-view.tsx` and `src/adapters/http/analyst-client.ts` |

## Tools (all read-only)

| Tool | Returns | Kind of figures |
|---|---|---|
| `list_accounts` | the caller's own accounts | facts |
| `get_account_overview` | equity, cash, unrealised PnL, margin in use, positions | facts |
| `explain_equity_change` | the equity change over `today` / `24h` / `7d` (UTC), split as realised − fees + funding + transfers + Δunrealised, plus any residual | facts |
| `get_fees_and_funding` | fees, funding paid and received, net cost, per market | facts |
| `get_exposure_breakdown` | notional and share per instrument, gross and net exposure, largest contributor, HHI, leverage | facts; liquidation prices are **estimates** |
| `simulate_price_move` | one market moved ±*x* % (|*x*| ≤ 50) with other marks fixed | price now and current PnL are facts; the moved price and PnL are **hypothetical** |
| `get_recent_executions` | count, notional, fees, realised PnL, maker/taker split, VWAPs per market, recent fills | facts |

How the tools stay read-only:

- No tool can place, cancel or modify orders.
- An unknown tool name (for example `place_order`) is rejected.
- ESLint forbids `src/server/analyst/**` from importing execution code (`@/core/trading`, execution
  adapters, client code).

## Authorization

- **Identity:** mock sign-in only. `POST /api/analyst/session` binds a random 256-bit id in an
  `HttpOnly`, `SameSite=Strict` cookie (path `/api/analyst`) to a mock user. There are no
  passwords, wallets or personal data.
- **Per request:** the route requires a session and a same-origin `Origin`. It returns 404 for any
  selected account outside the user's own set (no existence oracle). Each session may ask 20
  questions per minute.
- **Per tool call:** `executeTool` validates the input, and every account tool calls
  `authorize(principal, accountId)` before loading any data. A model that asks for another account,
  whether through a prompt-injection attempt or a mistake, gets `not-authorized` as an error tool
  result. The user is told that the request was refused.
- **Audit:** each tool call logs its name, outcome and duration. It never logs users, accounts or
  figures.

## Facts, estimates and hypotheticals

Each tool returns `ToolEvidence`:

- items, each with an exact value, a display string, a unit, a **kind** (`fact` / `estimate` /
  `hypothetical`) and an observation time
- assumptions
- an `unavailable` list, with reasons

The UI renders each item with its kind badge and time. The offline analyst groups its text by kind.
The Claude system prompt tells the model to keep the distinction, to state times (UTC) and
assumptions, and to say plainly when data is unavailable.

## Guards

1. **Order instructions** ("buy 2 ALPHA", "close my position", "cancel all my orders") are refused
   before any engine runs. Questions *about* activity are not affected.
2. **Unverified figures.** Every number in the written answer is compared with the verified
   values, the user's question and assumption texts. Dates, times and market ids are ignored, and
   small integers (≤ 10) are treated as counts. A number matches if it equals a verified value at
   the precision shown, as a magnitude, or as a percentage. Any number that matches nothing produces
   a warning telling the user to rely on the verified figures. The offline engine is tested to
   produce no such numbers.
3. **Guarantee language** ("guaranteed", "risk-free", "will definitely profit") produces a warning.
   Disclaimers such as "not a guarantee" do not.
4. Every answer carries a disclaimer: mock data, not financial advice, scenarios are hypothetical,
   estimates are not guarantees.

## Data availability

- The mock account `mock-acct-b2` simulates a source outage. Every tool reports
  `Account data: unavailable` with the reason, and no figures.
- A period that starts before the account's first record is measured from that first record, and
  this is stated as an assumption.
- Records later than "now" are never returned.

## Mock data

Mock history is **fictitious** and deterministic:

- scripted deposits, withdrawals and fills
- a closed-form price path
- hourly funding on open positions
- average-cost realised PnL

Cash, positions, fees, funding and equity are all derived from the same events, so the equity
identity reconciles to zero residual (tested). Times are anchored to the server start (floored to
the hour). Accounts:

| User | Accounts |
|---|---|
| `demo-trader` | `mock-acct-a1` |
| `demo-hedger` | `mock-acct-b1`, `mock-acct-b2` (data source offline) |

## Engines and configuration

| `NOVA_ANALYST_ENGINE` | Behaviour |
|---|---|
| `offline` (default) | Deterministic rule-based analyst. It maps the question to one tool and writes the answer only from that tool's evidence. No network access. |
| `claude` | Claude via `@anthropic-ai/sdk`. Credentials are server-side only (for example `ANTHROPIC_API_KEY`) and never sent to the browser. |

Claude request settings:

- **Model and effort:** `claude-opus-5-5`, effort `medium`.
- **Loop:** a manual tool-use loop of at most 6 rounds, with `strict` tool schemas.
- **Prompt caching:** a stable system prompt, cached.
- **Refusal fallbacks:** server-side refusal fallback is enabled (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`). If the model still refuses, the user is told it declined.
- **Errors:** API errors return HTTP 503 ("AI model unavailable"). No answer is made up.

**Verification status:** the Claude engine is tested with a scripted model (tool routing, the
authorization denial path, one-message tool results, refusal and the round limit). It type-checks
against SDK 0.127.0. It has **not** been run against the live API from the build environment,
because no credentials were available.

## Tests

| What | File |
|---|---|
| Attribution identity, fees and funding, execution summary, UTC periods (hand-checkable numbers) | `src/core/analytics/analytics.test.ts` |
| Single-market scenario | `src/core/risk/portfolio.test.ts` |
| Mock ledger: determinism, reconciliation, average-cost PnL, no future records, unavailable source | `src/adapters/mock-accounts/mock-ledger.test.ts` |
| Tool layer: read-only registry, authorization on every tool (no data loaded), validation, audit, evidence kinds, five example questions, order refusal, scripted Claude loop, guards, client contract | `src/server/analyst/analyst.test.ts` |
| UI flows and API authorization (401, 403, 404, cookie flags, no cross-account data) | `tests/e2e/analyst.spec.ts` |

## Limitations

- Mock accounts only. Watch-only Hyperliquid accounts could implement `AccountHistoryGateway` later.
  That would need real authentication tying a user to an address, and funding history from the
  venue.
- The offline engine understands only the supported question types, using keyword matching.
- The unverified-figure check is a heuristic. It catches invented numbers, but not wrong wording
  around correct numbers. This is why the verified evidence is always displayed with the answer.
- The conversation is single-turn: there is no memory between questions.
