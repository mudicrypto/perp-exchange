import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

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
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      NOVA_MARKET_DATA_SOURCE: "simulation",
      NOVA_ALLOW_SIMULATION_IN_PRODUCTION: "true",
      // Test-only credentials for two simulated RFQ counterparties (see tests/e2e/private-execution.spec.ts).
      NOVA_RFQ_COUNTERPARTY_TOKENS: "sim-desk-b=e2e-desk-b-token-0000000000000,sim-desk-c=e2e-desk-c-token-0000000000000",
    },
  },
});
