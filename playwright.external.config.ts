import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_EXTERNAL_PORT ?? 3110);

/** Opt-in checks against the real Hyperliquid public API (needs outbound network). */
export default defineConfig({
  testDir: "./tests/e2e-external",
  retries: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 60_000,
    env: { NOVA_MARKET_DATA_SOURCE: "hyperliquid", NOVA_HYPERLIQUID_NETWORK: process.env.NOVA_HYPERLIQUID_NETWORK ?? "mainnet" },
  },
});
