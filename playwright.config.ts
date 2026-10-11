import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const LIVE_CONFIG_PORT = PORT + 1;

/**
 * E2E tests run the production build against the deterministic simulated
 * data source, so they never depend on (or touch) a live venue.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testDir: "./tests/e2e",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
    {
      // A second server in live configuration (no venue network access needed).
      name: "live-config",
      testDir: "./tests/e2e-live-config",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${LIVE_CONFIG_PORT}`,
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: `npx next start -p ${PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NOVA_MARKET_DATA_SOURCE: "simulation",
        NOVA_ALLOW_SIMULATION_IN_PRODUCTION: "true",
        // Server-configured pre-trade limits (exercised by tests/e2e/risk.spec.ts).
        NOVA_RISK_LIMITS: JSON.stringify({ maxOrderNotional: { value: "500000", action: "block" }, maxPositionNotional: { value: "1000000", action: "block" }, maxGrossExposure: { value: "2000000", action: "block" } }),
        // Test-only credentials for two simulated RFQ counterparties.
        NOVA_RFQ_COUNTERPARTY_TOKENS: "sim-desk-b=e2e-desk-b-token-0000000000000,sim-desk-c=e2e-desk-c-token-0000000000000",
        // Lets API tests act as distinct clients for rate limiting; browsers never send it (shared key).
        NOVA_CLIENT_IP_HEADER: "x-nova-test-client",
      },
    },
    {
      command: `npx next start -p ${LIVE_CONFIG_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${LIVE_CONFIG_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { NOVA_MARKET_DATA_SOURCE: "hyperliquid", NOVA_HYPERLIQUID_NETWORK: "testnet" },
    },
  ],
});
