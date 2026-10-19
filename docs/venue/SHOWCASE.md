# Nova Venue — Reproducible Demonstration (Milestone 12, WP1)

A reviewer can regenerate the demonstration, open it offline, and verify it independently: every
embedded journal is replayed, and every recorded hash and feed must match exactly.

- Synthetic data only: SYN-* instruments, syn-* accounts, a fixed manual clock.
- No network, no funds, no keys, no real market data.

## 1. Reproduce and verify

```sh
npm ci
npm run --silent venue:showcase > showcase.html          # offline viewer with the bundle embedded
npm run --silent venue:showcase:verify < showcase.html   # replay + regeneration check; exit 0 = VERIFIED
npm run --silent venue:showcase -- --json > showcase.json   # the bundle alone, for other tools
```

`--silent` keeps npm's banner out of the output. Open `showcase.html` directly in a browser; no server
is needed.

**Expected hashes** for the code at the Milestone 11 (Venue) baseline plus this work package:

| Artifact | sha256 / bundle hash |
|---|---|
| Bundle hash (printed by both commands) | `7f81ed0d9fa484bec33fbacacede04315797ff67a93536e70838d85d7507bf35` |
| `showcase.html` (whole file) | `84cdb30e77b921b3b532320de02da001219f843868bf651a9957db488254072f` |

Any change to the venue code or to the scenarios changes these values. They are recorded here, and
in the evidence log, for this exact tree.

## 2. What the verifier proves

`verifyShowcase` treats the bundle as untrusted input. For each scenario it checks:

1. the journal's sha256 matches the recorded value;
2. the journal reads cleanly: hash chain, schema and sequence (D-2);
3. a full replay reproduces the recorded final seq, journal head, state hash and output head (D-1);
4. the recorded public tape and every recorded private feed are **exactly** what the journal replays
   to, so the narrative's feeds cannot be edited without detection;
5. every recorded check passed;
6. every "must be refused" sample is refused with its stated reason (D-5).

It then checks the bundle hash. Unless `--no-regenerate` is passed, it also rebuilds the bundle from
the code and requires the same bundle hash. That catches edits to the narrative text, which no
journal covers.

**What it does not prove:**

- That the code itself is correct: that is what the test suite and the independent reviews in
  SECURITY-CHECKLIST §B are for.
- That the checks are the right checks: a reviewer should read them.

## 3. Scenarios

| # | Scenario | Rules | What the reviewer sees |
|---|---|---|---|
| 1 | Hidden orders: public versus private view | H-1, M-3, M-4, H-5, S-2, H-7, P-1, A-2 | A hidden ask inside the spread leaves no public trace and no sequence gap. It fills by price, after displayed liquidity at its price, and is disclosed only as aggregated prints; the residual inference from print sizes is stated. Also shown: self-trade prevention on a hidden order, a rejected post-only probe, and a foreign cancel indistinguishable from a missing order. |
| 2 | Price, displayed and time priority; self-trade prevention | M-4, M-5, S-1 | Exact fill order at one price; all three self-trade-prevention modes. |
| 3 | Abuse controls | H-7, A-4, A-3 | The post-only probe throttle triggers after three rejections; idempotent retry versus conflicting reuse; a message burst cut off before journaling. |
| 4 | Crash recovery with commit records | D-1, D-2, D-5, D-6, A-4 | A torn write is dropped; a missing commit record is rolled forward; retries never execute twice; a duplicated entry is refused. |
| 5 | Deterministic replay and reconciliation | D-1, M-6, H-9 | 600 seeded messages; full replay and snapshot plus suffix reproduce the live hashes; reconciliation passes. |
| 6 | Unknown outcomes and client reconciliation | A-6, A-4, D-6 | An unknown cancel is resolved from `eventsPage` after recovery; a blind retry gives an ambiguous answer. |

Totals: 27 checks, all passing.

## 4. Safety properties of the page and the bundle

**The page:**

- One self-contained HTML file with inline CSS and script.
- Its Content Security Policy is `default-src 'none'`, with `connect-src`, `img-src` and
  `form-action` all `'none'`, so the browser makes no request (confirmed in headless Chromium: zero
  requests, zero console errors).
- Data is embedded as inert JSON, with `<` escaped so it cannot close its script element, and is
  rendered only through `textContent`.

**The bundle:**

- No session tokens, no key material. Order IDs use the registered **test-fixture key** (rule A-5),
  enabled explicitly so the demonstration is reproducible. The page says so: IDs are not
  confidential in this demonstration.
- No dependence on the host: the output is byte-identical across runs, timezones, locales and working
  directories (tested).

## 5. Design constraints kept

- `src/venue` still has no network or file-system access. The CLIs write to standard output and read
  standard input only.
- Nothing outside `src/venue` imports the venue (isolation tests unchanged).
- `engine.ts` is unchanged. One small change elsewhere: `demo.ts` exports its two event-describing
  functions so the showcase reuses them.
- The fault injection used in scenarios 4 and 6 is the same public, test-only fault surface the
  durability tests use (`failNextAppend`, `failNextWrite`), labelled as simulated in the narrative.

## 6. Tests

`src/venue/showcase.test.ts` (8 tests):

- deterministic builds;
- all checks pass and the bundle verifies (replay and regeneration);
- tampering with any recorded part is detected: journal, hashes, either feed, a check flag, a
  refusal sample, the narrative text;
- a forged bundle hash still fails regeneration;
- the page is offline and self-contained;
- script break-out is impossible;
- no secrets;
- only declared rules are cited.
