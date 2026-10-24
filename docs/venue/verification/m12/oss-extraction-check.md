venue showcase: 6 scenarios, 27 checks, 0 failed
bundle hash 7f81ed0d9fa484bec33fbacacede04315797ff67a93536e70838d85d7507bf35
# Open-source extraction check (Milestone 12, WP2)

Status: PROPOSAL — not published, no licence applied. Pending IP/ownership review, dependency review and approval (Milestone 12, WP2).
Proposed licence: Apache-2.0 (decision D1, pending IP and licensing review). **No LICENSE file is created by this check.**
Repository HEAD: 75f7869f25f51ad532bfc9e63fdbabe93d50cd36 (working tree has uncommitted changes)

## Result: no blocking findings

## 1. Files (63; excluded 55)

- `docs/venue/ARCHITECTURE.md`
- `docs/venue/DURABILITY-PROTOCOL.md`
- `docs/venue/MATCHING-RULES.md`
- `docs/venue/ORDER-STATE-MACHINE.md`
- `docs/venue/PERFORMANCE-PLAN.md`
- `docs/venue/PERFORMANCE-RESULTS.md`
- `docs/venue/PRIVACY-REVIEW.md`
- `docs/venue/RECOVERY-INTEGRITY.md`
- `docs/venue/RECOVERY-TEST-RESULTS.md`
- `docs/venue/RUNBOOK-POISON-COMMAND.md`
- `docs/venue/SECURITY-CHECKLIST.md`
- `docs/venue/SHOWCASE.md`
- `docs/venue/STELLAR-FEASIBILITY.md`
- `docs/venue/STELLAR-SPIKE-RESULTS.md`
- `docs/venue/THREAT-MODEL.md`
- `docs/venue/VERIFICATION-REPORT.md`
- `src/venue/adversarial.test.ts`
- `src/venue/bench.ts`
- `src/venue/book.ts`
- `src/venue/cli/bench.ts`
- `src/venue/cli/demo.ts`
- `src/venue/cli/perf.ts`
- `src/venue/cli/showcase-verify.ts`
- `src/venue/cli/showcase.ts`
- `src/venue/commit-record-slots.test.ts`
- `src/venue/commit-record.test.ts`
- `src/venue/commit-record.ts`
- `src/venue/crash-recovery.test.ts`
- `src/venue/demo.test.ts`
- `src/venue/demo.ts`
- `src/venue/docs.test.ts`
- `src/venue/durability-fixtures.ts`
- `src/venue/engine.test.ts`
- `src/venue/engine.ts`
- `src/venue/gateway.ts`
- `src/venue/id-key.ts`
- `src/venue/instrument.ts`
- `src/venue/journal.ts`
- `src/venue/migration.test.ts`
- `src/venue/migration.ts`
- `src/venue/perf.ts`
- `src/venue/poison-diagnostics.test.ts`
- `src/venue/privacy-review.test.ts`
- `src/venue/properties.test.ts`
- `src/venue/public-feed.ts`
- `src/venue/rate-limit.ts`
- `src/venue/reconcile.ts`
- `src/venue/recovery-final.test.ts`
- `src/venue/recovery-integrity.test.ts`
- `src/venue/recovery-review.test.ts`
- `src/venue/recovery.test.ts`
- `src/venue/retention.test.ts`
- `src/venue/retry-semantics.test.ts`
- `src/venue/rules-version.ts`
- `src/venue/showcase.test.ts`
- `src/venue/showcase.ts`
- `src/venue/state-machine.ts`
- `src/venue/storage.ts`
- `src/venue/synthetic.ts`
- `src/venue/test-helpers.ts`
- `src/venue/types.ts`
- `src/venue/venue.ts`
- `src/venue/verification.test.ts`

Excluded:
- `docs/venue/verification/` (54 files): Run logs of this private repository, including application E2E and build output; regenerate evidence in the open repository's CI instead.
- `docs/venue/OPEN-SOURCE-MANIFEST.md` (1 files): Internal release-review record (ownership findings, release blockers); not part of the published package.

## 2. Import closure

Relative imports leaving the manifest: none

| Package | Used by |
|---|---|
| `fast-check` | test |
| `node:crypto` | source, test |
| `node:fs` | test |
| `node:os` | source |
| `node:path` | test |
| `vitest` | test |
| `zod` | source |

## 3. Licences (installed versions, including transitive dependencies)

| Package | Version | Licence | Via |
|---|---|---|---|
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | @jridgewell/trace-mapping |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | @jridgewell/trace-mapping |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | @vitest/mocker |
| `@types/chai` | 5.2.3 | MIT | vitest |
| `@types/deep-eql` | 4.0.2 | MIT | @types/chai |
| `@types/estree` | 1.0.9 | MIT | estree-walker |
| `@vitest/mocker` | 5.0.3 | MIT | vitest |
| `magic-string` | 1.4.3 | MIT | @vitest/mocker |
| `@vitest/spy` | 5.0.3 | MIT | @vitest/mocker |
| `assertion-error` | 2.0.1 | MIT | @types/chai |
| `chai` | 6.3.0 | MIT | vitest |
| `es-module-lexer` | 2.3.2 | MIT | vitest |
| `estree-walker` | 3.0.3 | MIT | @vitest/mocker |
| `expect-type` | 1.4.0 | Apache-2.0 | vitest |
| `fast-check` | 4.10.2 | MIT | direct |
| `obug` | 2.2.1 | MIT | vitest |
| `pure-rand` | 8.4.2 | MIT | fast-check |
| `std-env` | 4.3.0 | MIT | vitest |
| `tinybench` | 6.2.1 | MIT | vitest |
| `tinyexec` | 1.3.1 | MIT | vitest |
| `tinyglobby` | 0.2.17 | MIT | vitest |
| `fdir` | 6.5.0 | MIT | tinyglobby |
| `picomatch` | 4.0.7 | MIT | tinyglobby |
| `vitest` | 5.0.3 | MIT | direct |
| `magic-string` | 1.4.3 | MIT | vitest |
| `picomatch` | 4.0.7 | MIT | vitest |
| `why-is-node-running` | 3.2.1 | MIT | vitest |
| `zod` | 4.6.5 | MIT | direct |

## 4. Secret-pattern scan

Patterns: private key block, Stellar secret seed, Anthropic API key, OpenAI-style key, GitHub token, AWS access key, Slack token, assigned secret.
- Working tree (63 files): no matches
- History of the included paths (5 commits, all branches, added lines only): no matches
Pattern scanning is not proof of absence; a fresh-history extraction is still required.

## 5. Review terms (not blocking; each needs a decision before release)

- `hyperliquid`: 1 — docs/venue/ARCHITECTURE.md:7
- `anthropic`: 0
- `claude`: 1 — docs/venue/VERIFICATION-REPORT.md:53
- `nova`: 26 — docs/venue/ARCHITECTURE.md:1, docs/venue/DURABILITY-PROTOCOL.md:1, docs/venue/DURABILITY-PROTOCOL.md:97, docs/venue/MATCHING-RULES.md:1, docs/venue/ORDER-STATE-MACHINE.md:1, docs/venue/PERFORMANCE-PLAN.md:1, docs/venue/PERFORMANCE-RESULTS.md:1, docs/venue/PRIVACY-REVIEW.md:1, docs/venue/RECOVERY-INTEGRITY.md:1, docs/venue/RECOVERY-TEST-RESULTS.md:1, docs/venue/SECURITY-CHECKLIST.md:1, docs/venue/SECURITY-CHECKLIST.md:27, …
- `openai`: 0
- `/tmp/`: 0
- `@gmail.com`: 0
- `TODO`: 0
- `FIXME`: 0

## 6. Authorship of the included paths (input for the IP and ownership review)

- author: Claude <noreply@anthropic.com>: 5 commit(s)
- co-author trailer: Claude Opus 5.5 <noreply@anthropic.com>: 5 commit(s)

## 7. Standalone staging run

Copied 63 files plus a minimal scaffold (package.json marked private and UNLICENSED, tsconfig, vitest config) to a scratch directory outside the repository; node_modules linked from this repository.
- typecheck: pass
- tests: pass (Tests  319 passed (319))
- showcase page sha256 from the staged copy: `84cdb30e77b921b3b532320de02da001219f843868bf651a9957db488254072f`
