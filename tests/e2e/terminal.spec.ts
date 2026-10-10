import { expect, test } from "@playwright/test";

/**
 * These tests run against the deterministic simulated data source
 * (see playwright.config.ts). They verify terminal behaviour, not venue data.
 */

test.describe("trading terminal (simulation mode)", () => {
  test("clearly labels simulated data and renders live panels", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("simulation-banner")).toContainText("SIMULATED MARKET DATA");
    await expect(page.getByTestId("data-source-badge")).toHaveText("SIMULATION");
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open");

    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await expect(page.getByTestId("book-bid").first()).toBeVisible();
    await expect(page.getByTestId("book-spread")).toBeVisible();
    await expect(page.getByTestId("trade-row").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
    await expect(page.getByTestId("mark-price")).not.toHaveText("—");
  });

  test("switches markets from the selector", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-selector").click();
    await page.getByRole("textbox", { name: "Search markets" }).fill("gam");
    await expect(page.getByTestId("market-option-ALPHA-PERP")).toHaveCount(0);
    await page.getByTestId("market-option-GAMMA-PERP").click();
    await expect(page.getByTestId("market-selector")).toHaveText(/GAMMA-PERP/);
    await expect(page.getByTestId("order-book")).toContainText("Size (GAMMA)");
  });

  test("remembers the selected market and chart interval", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-selector").click();
    await page.getByTestId("market-option-BETA-PERP").click();
    await page.getByTestId("interval-1h").click();
    await expect(page.getByTestId("interval-1h")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByTestId("market-selector")).toHaveText(/BETA-PERP/);
    await expect(page.getByTestId("interval-1h")).toHaveAttribute("aria-pressed", "true");
  });

  test("order ticket previews risk but cannot submit orders", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-selector").click();
    await page.getByTestId("market-option-ALPHA-PERP").click();

    const submit = page.getByTestId("submit-order");
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId("ticket-panel")).toContainText("Order submission is not available");

    await page.getByTestId("input-price").fill("1000");
    await page.getByTestId("input-size").fill("2");
    await page.getByTestId("input-leverage").fill("10");
    await expect(page.getByTestId("risk-notional")).toHaveText("$2,000.00");
    await expect(page.getByTestId("risk-margin")).toHaveText("$200.00");
    // Long 10x, MMR = 1 / (2 * 25) = 2%: (1000 - 100) / 0.98 = 918.367 → shown with 1 decimal
    await expect(page.getByTestId("risk-liq")).toHaveText("918.4");
    await expect(submit).toBeDisabled();

    await page.getByTestId("type-market").click();
    await expect(page.getByTestId("risk-impact")).toBeVisible();

    await page.getByTestId("input-size").fill("0.00001");
    await expect(page.getByTestId("ticket-errors")).toContainText("Size allows at most 3 decimals");
  });

  test("discloses that orders are not private on this venue", async ({ page }) => {
    await page.goto("/");
    const visibility = page.getByTestId("execution-visibility");
    await expect(visibility).toHaveAttribute("data-level", "public");
    await expect(visibility).toContainText("Public order on Simulator");
  });

  test("shows explicit empty account states instead of balances", async ({ page }) => {
    await page.goto("/");
    const panels = page.getByTestId("account-panels");
    await expect(panels).toContainText("No positions to show");
    await expect(panels).toContainText("never ask for your seed phrase or private key");
    await panels.getByRole("tab", { name: "Market risk" }).click();
    await expect(page.getByTestId("market-risk-facts")).toContainText("Maintenance margin rate");
  });
});

test.describe("API", () => {
  test("serves the simulated catalog and validates candle queries", async ({ request }) => {
    const markets = await request.get("/api/markets");
    expect(markets.ok()).toBe(true);
    const body = await markets.json();
    expect(body.source.kind).toBe("simulation");
    expect(body.markets.length).toBeGreaterThan(0);

    const bad = await request.get("/api/candles?market=../../etc&interval=7m");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe("bad-request");

    const good = await request.get("/api/candles?market=ALPHA-PERP&interval=1h");
    expect(good.ok()).toBe(true);
    expect((await good.json()).candles.length).toBeGreaterThan(0);
  });

  test("sends security headers", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("connect-src 'self' wss://api.hyperliquid.xyz");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("health reports execution disabled", async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    expect(health.config).toEqual({
      marketDataSource: "simulation",
      hyperliquidNetwork: "mainnet",
      executionMode: "disabled",
    });
  });
});
