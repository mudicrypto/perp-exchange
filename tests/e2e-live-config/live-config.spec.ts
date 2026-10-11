import { expect, test } from "@playwright/test";

/**
 * Runs against a second production server in LIVE configuration
 * (NOVA_MARKET_DATA_SOURCE=hyperliquid). No network access to the venue is
 * needed: these checks cover what Nova itself allows in live mode.
 */
test.describe("live configuration", () => {
  test("9. hidden orders are unsupported on Hyperliquid and cannot be submitted", async ({ page }) => {
    await page.goto("/private-execution");
    const ws = page.getByTestId("private-execution-page");
    await expect(ws.getByTestId("private-simulated-banner")).toHaveCount(0);
    for (const mode of ["hidden", "iceberg", "rfq", "encrypted"]) {
      await expect(ws.getByTestId(`mode-${mode}`)).toHaveAttribute("data-available", "false");
    }
    await ws.getByTestId("mode-hidden").click();
    await expect(ws.getByTestId("venue-capability")).toHaveAttribute("data-status", "unsupported");
    await expect(ws.getByTestId("venue-capability")).toContainText("Unavailable on Hyperliquid");
    await expect(ws.getByTestId("mode-unavailable")).toContainText("never substitutes a public order");
    await expect(ws.getByTestId("private-order-form")).toHaveCount(0);
    await expect(ws.getByTestId("private-submit")).toHaveCount(0);
  });

  test("simulation-only services do not exist in live mode", async ({ request, baseURL }) => {
    const origin = { Origin: baseURL! };
    const health = await (await request.get("/api/health")).json();
    expect(health.config).toMatchObject({ marketDataSource: "hyperliquid", executionMode: "disabled" });
    expect((await request.post("/api/session", { headers: origin })).status()).toBe(404);
    expect((await request.get("/api/rfq/counterparties")).status()).toBe(404);
    expect((await request.get("/api/analyst/users")).status()).toBe(404);
    expect((await request.post("/api/analyst/session", { headers: origin, data: { userId: "demo-trader" } })).status()).toBe(404);
  });

  test("the terminal shows no simulation banner or demo controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("data-source-badge")).not.toHaveText("SIMULATION");
    await expect(page.getByTestId("simulation-banner")).toHaveCount(0);
    await expect(page.getByTestId("demo-controls")).toHaveCount(0);
  });
});
