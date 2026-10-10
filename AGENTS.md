<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Nova Exchange project rules

- Read `docs/ARCHITECTURE.md` and keep `docs/CHECKLIST.md` current; only tick items backed by tests or a real run.
- `src/core` is venue- and framework-agnostic (enforced by ESLint). Venue wire formats stay inside `src/adapters/<venue>`.
- Validate every external payload with Zod. Never fabricate market data, balances, fills or privacy guarantees.
- Simulation (`src/adapters/simulation`) must stay labelled and separate from live integrations.
- No live order submission: `NOVA_EXECUTION_MODE` only accepts `disabled` until a milestone explicitly adds execution.
- Run `npm run check` and `npm run test:e2e` before committing.
