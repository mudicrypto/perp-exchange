# Nova Exchange — Security Review and Verification (Milestone 7)

Scope: the whole repository as of Milestone 7, covering:

- the market-data terminal (M1–M2)
- the trading domain and adapters (M3)
- private execution and RFQ (M4)
- the risk engine and limits (M5)
- the AI analyst (M6)

**This review does not make Nova production-ready.** Passing tests show that the behaviour below
holds in this codebase and in the simulated environment. They say nothing about deployment,
operations, third parties, or legal and regulatory approval. Section 4 lists what remains.

## 1. Findings and fixes in this milestone

| # | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| F1 | JSON bodies were read in full before the size check (`request.text()`), and the size was measured in characters, not bytes | Medium (memory DoS) | `readJson` rejects early on `Content-Length` and streams with a byte cap (413) | `security.test.ts` |
| F2 | RFQ and analyst session tables refused new sessions when full, so one client could lock everyone out | Medium (DoS) | `BoundedSessionMap` evicts the least recently seen session instead of refusing | `security.test.ts` |
| F3 | No per-client rate limits on session creation, counterparty-token attempts or the venue-backed routes | Medium | Sliding-window limiters with bounded keys: sessions, RFQ mutations, venue reads, account lookups, and token failures. A client blocked for token guessing is refused *before* any token check, so the block cannot be used as an oracle | `security.test.ts`, E2E scenario 10 |
| F4 | Session cookies were `Secure` only when Next saw `https:`, which is never true behind a TLS-terminating proxy | Medium | `isHttps` also honours `X-Forwarded-Proto` (a spoofed header can only add `Secure`) | `security.test.ts` |
| F5 | Order-form schema errors showed raw schema text ("Too small: expected number to be >0") without naming the field | Low (UX/safety) | Every schema issue now names its field ("Size must be a positive number", "Price is required") | E2E scenario 5 |
| F6 | Missing hardening headers | Low | Added `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, and HSTS in production builds | header E2E |
| F7 | Nothing checked that server-only names and secrets stay out of the browser bundle | Low | `npm run verify:bundle` (part of `npm run check`) scans `.next/static` for secret material and server-only names. A negative test with a planted secret confirmed it fails | manual and CI |

## 2. Review by area

**Authentication and account authorization**

- No real user authentication exists yet. There are two anonymous or mock identities:
  - the RFQ session: a random 256-bit id
  - the analyst mock sign-in: anyone may sign in as either demo user, by design
- Both use `HttpOnly`, `SameSite=Strict` cookies scoped to `/api` or `/api/analyst`.
- Authorization is enforced on the server:
  - RFQ: the requester's session must own the request, otherwise 404; counterparties must be
    addressed by the request.
  - Analyst: every tool call checks the account; a foreign account returns 404 at the route.
- Tested in unit tests and E2E (scenario 10, `private-execution.spec.ts`, `analyst.spec.ts`).

**Server-side validation of order requests**

- There is **no server endpoint that submits orders**. Simulated orders are matched in the
  browser, and live execution is disabled. `NOVA_EXECUTION_MODE` accepts only `disabled`.
- Every server input that exists is validated with strict Zod schemas:
  - RFQ create, quote and accept (no unknown fields, 4 KB cap)
  - analyst questions (≤ 500 characters, account and market ids validated)
  - market and candle queries
  - account addresses
- The browser-side guard (`RiskGuardedExecutionAdapter`) re-validates every order before any
  adapter call.
- When live execution is added, the same validation and `assessOrder` must run **on the server**
  (open item, §4).

**Secret and environment-variable exposure**

- Environment variables are read only in `src/config/server-env.ts` (`server-only`).
- The browser receives only `PublicRuntimeConfig`:
  - the data source and network
  - the execution mode
  - the risk limits, which are not secret
- Secrets: `NOVA_RFQ_COUNTERPARTY_TOKENS`, compared as SHA-256 digests in constant time, and
  `ANTHROPIC_API_KEY`. Both are server-only, and the bundle scan (F7) enforces this.
- There are no `NEXT_PUBLIC_*` variables. Tests check that the public config does not leak secrets.

**WebSocket authentication and authorization**

- Nova runs no websocket server.
- The browser connects directly to Hyperliquid's **public** market-data websocket. No
  authentication is involved, and no account streams are subscribed.
- `connect-src` in the CSP restricts sockets to `self` and the two Hyperliquid hosts.
- Every frame is validated with Zod. Invalid frames are counted and dropped.

**XSS and injection**

- Nowhere renders raw HTML: there is no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or
  `new Function`.
- Model output and RFQ data are rendered as text.
- There is no database, so SQL injection does not apply.
- Prompt injection against the analyst can at most choose among read-only tools, which enforce
  authorization. Tool output is marked as data in the system prompt.
- **Open risk:** the CSP still allows `'unsafe-inline'` scripts. Nonce-based CSP is incompatible
  with the Partial Prerendering shell this app uses (Next 16 docs). Moving to nonces (dropping PPR)
  or to experimental SRI is an open item.

**CSRF**

- Every cookie-authenticated mutation requires a same-origin `Origin` header in addition to
  `SameSite=Strict`.
- `GET` handlers have no side effects.
- CORS is not enabled, so cross-origin reads are blocked by the browser.
- Tested: cross-origin RFQ create, cancel and session, and analyst ask, all return 403.

**Rate limiting and abuse controls**

- See F3.
- Additional limits:
  - at most 10 open RFQs per session
  - 20 analyst questions per minute per session
  - a server-side Hyperliquid weight budget, with handling for 429 / `Retry-After`
- **Limitations:**
  - Limiters are per-process and in memory.
  - Without `NOVA_CLIENT_IP_HEADER` and a trusted proxy that overwrites that header, all clients
    share one key with its own larger limits. One abusive client can then slow others down.
  - There is no DDoS protection or WAF.

**Sensitive logging and error responses**

- Clients receive coded, generic errors, with no stack traces.
- Server logs never contain secrets, sizes, prices, sides, sessions, or account ids:
  - RFQ audit lines use an allow-list (tested).
  - Analyst audit lines contain only the tool name, outcome and duration.
  - Venue errors log a code and a fixed message.
  - Unhandled errors log the error object server-side.

**Dependency vulnerabilities**

- `npm audit --omit=dev` reports **0** vulnerabilities.
- `npm audit` reports 5 high-severity advisories, all in the **dev-only** lint toolchain
  (`eslint-config-next` → `fast-glob` → `micromatch` → `braces` ≤ 3.0.3, GHSA-vfj7-8cjw-p6xm). No
  patched `braces` release exists; 3.0.3 is the latest. npm's suggested "fix" is a downgrade to
  `eslint-config-next@14`, which is wrong for Next 16. The risk is limited because it only affects
  lint runs on our own glob patterns. Accepted; re-check on each release.

**Order idempotency and duplicate submissions**

- The client order id is unique per account (`OrderStore`). Two concurrent submissions with the
  same id create exactly one order.
- Duplicate venue events and fills are ignored by event and fill id.
- The confirm button is disabled while a submission is in flight.
- A second RFQ accept returns 409.
- RFQ bookings reuse client order ids, and a duplicate is refused.
- Tested in `hardening.test.ts`, `order-lifecycle.test.ts` and `paper-engine.test.ts`.

**Cancellation and partial fills**

- Cancelling a partially filled order keeps the filled part and releases only the remainder's
  margin.
- A second cancel is refused (`order-not-cancellable`).
- An order cancelled while awaiting acknowledgement is never matched.
- A cancel rejected after a fill returns the order to the correct state.
- Tested in `hardening.test.ts` and the lifecycle tests.

**Stale market data and reconnect**

- Each stream reports its status (live / stale / disconnected).
- Reconnects use backoff with jitter, a heartbeat, and replay of subscriptions.
- Stale marks make risk figures unavailable, and the order guard blocks orders.
- The simulated venue refuses orders while its feed is down.
- Tested in unit tests and E2E scenario 4.

**Incorrect or missing numerical inputs**

- The following are refused before anything reaches a venue:
  - NaN, ±Infinity, zero or negative values, string numbers, missing fields
  - absurd leverage
  - sizes below the step, or with too many decimals
  - unknown markets
- Tested in `hardening.test.ts`, the validation tests and E2E scenario 5.
- Risk figures use decimal arithmetic. Tests cover NaN, Infinity and malformed strings
  (`decimal.test.ts`).

**Access to private RFQ and order records**

- RFQ records are readable only by their requester (404 for others), and by selected
  counterparties in redacted form.
- Records are deleted 5 minutes after completion.
- Simulated orders live only in the user's browser.
- The analyst reads only the user's own mock accounts.
- `/api/venue/account` serves **public** on-chain data by address (Hyperliquid publishes it) and is
  rate-limited.

**Separation of simulation and live execution**

- Data source mismatches are rejected.
- The simulation is refused in production unless explicitly allowed.
- The RFQ, analyst and session routes return 404 in live mode.
- In live mode there is no paper venue, no RFQ desk and no demo controls, and the guard refuses
  submissions before the (disabled) adapter is reached.
- Tested in `hardening.test.ts` and the `live-config` E2E project, which runs a second server in
  live configuration.

**Execution capability restrictions**

- Every capability has an explicit status. Unsupported capabilities return typed errors and are
  never emulated.
- Hidden and iceberg orders are refused before any adapter call on venues that do not support them
  (spy test).
- Encrypted orders cannot be declared supported.
- The ticket and the workspace derive availability from the same declarations.
- E2E scenario 9 runs in live configuration.

## 3. Verification

| Check | Command | Result in this environment |
|---|---|---|
| Typecheck, lint, unit tests, build, bundle scan | `npm run check` | pass |
| End-to-end (simulation + live configuration, 2 servers) | `npm run test:e2e` | pass |
| Dependency audit | `npm audit --omit=dev` / `npm audit` | 0 / 5 dev-only (see above) |
| **External: live Hyperliquid UI** | `npm run test:e2e:external` | **not verified**: fails at the network layer here ("fetch failed"); needs outbound access to `api.hyperliquid.xyz` |
| **External: Hyperliquid API contract** | `npm run test:live` | **not verified** for the same reason |
| **External: Claude analyst engine** | `NOVA_ANALYST_ENGINE=claude` plus credentials | **not verified**: no credentials available; covered only by scripted-model tests |

The Milestone 7 Playwright scenarios are in `tests/e2e/verification.spec.ts` (1–8 and 10) and
`tests/e2e-live-config/live-config.spec.ts` (9).

## 4. Remaining risks (not exhaustive)

### Operational

- **All server state is in memory and single-process:**
  - RFQ desk, sessions, rate limiters, mock accounts.
  - A restart drops it.
  - Horizontal scaling breaks sessions and limits.
  - Production needs a shared store (for example Redis or a database), persistence and backups.
- **No monitoring, alerting or incident response:**
  - no metrics, tracing or log shipping
  - no on-call or runbooks
- **Live venue integration has never run against the real API** from this environment
  (`test:live`, external E2E).
- **No dependency on venue status pages or circuit breakers** beyond the request budget and
  timeouts. Venue outages are reported to the user but not handled operationally.
- **The browser-side simulator is not a trusted component.** The risk guard there protects the demo
  flow, not a real account.
- **Clock assumptions:** freshness checks rely on synchronized clocks, and staleness thresholds are
  untuned.

### Security

- **No real authentication or account binding:**
  - no user accounts or MFA
  - no session revocation across devices
  - mock sign-in only
- **CSP allows `'unsafe-inline'` scripts** (see XSS above).
- **Client identification for rate limits** depends on deploying behind a proxy that sets and
  overwrites `NOVA_CLIENT_IP_HEADER`. There is no WAF or DDoS protection.
- **Counterparty credentials:**
  - static bearer tokens in environment variables
  - no rotation, scoping, mTLS or request signing
  - no secrets manager
- **No independent penetration test or code audit.** Threat modelling has been done only
  informally, in this document.
- **Prompt injection against the AI analyst** is contained by read-only tools and authorization. It
  can still mislead the narrative text, which is why the verified figures are always shown.
- **The `same-origin` check trusts `X-Forwarded-Host`** when present. That is safe only if the
  proxy sets or strips it.
- **Live order submission does not exist.** Adding it needs wallet signing UX, server-side
  enforcement of limits and validation, replay protection, nonce management, and a separate
  security review.
- **Dev-only dependency advisory** (`braces`) is accepted for now.

### Regulatory and legal (requires qualified counsel; not engineering decisions)

- **Licensing:** offering perpetual futures, or routing orders to a venue that does, is regulated
  or restricted in many jurisdictions, and prohibited for retail users in some (for example the
  US). Geo-restrictions, licensing and terms of service have not been addressed.
- **KYC / AML / sanctions screening:** none exists.
- **Market abuse:** there is no surveillance (spoofing, wash trading, insider trading). Private
  execution modes increase this need.
- **Privacy claims:** the claims for hidden, iceberg and RFQ modes are documented and tested in
  simulation only. They need independent review before being offered with real funds (see
  PRIVACY.md).
- **AI analyst:** may fall under investment-advice or financial-promotion rules depending on
  jurisdiction. Its disclaimers have not been legally reviewed.
- **Data protection** (for example GDPR): retention, data-subject rights, processor agreements
  (including the LLM provider) and cross-border transfers are not addressed.
- **Record keeping and audit trails** required for trading activity are not implemented. Logs are
  ephemeral, and RFQ records are deleted after 5 minutes by design. That deletion may itself
  conflict with record-keeping duties.
- **Risk disclosures, suitability or appropriateness assessments, and best-execution obligations**
  are not implemented.
