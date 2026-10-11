import { expect, test } from "@playwright/test";

/**
 * EXTERNAL: requires network access to Hyperliquid's public API and
 * websocket. Not part of `npm run test:e2e`; run with `npm run test:e2e:external`.
 * Read-only: no orders, no keys.
 */
test.describe("live Hyperliquid market data (external)", () => {
  test("loads real markets and receives live websocket updates", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("data-source-badge")).not.toHaveText("SIMULATION");
    await expect(page.getByTestId("market-option-BTC-PERP").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("market-option-BTC-PERP").first().click();
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open", { timeout: 30_000 });
    const bid = page.getByTestId("order-book").getByTestId("book-bid").first();
    await expect(bid).toBeVisible({ timeout: 30_000 });
    const before = await bid.getAttribute("data-size");
    await expect.poll(async () => bid.getAttribute("data-size"), { timeout: 60_000 }).not.toBe(before);
  });

  test("execution stays disabled for the live venue", async ({ page, request }) => {
    const health = await (await request.get("/api/health")).json();
    expect(health.config.executionMode).toBe("disabled");
    await page.goto("/");
    await expect(page.getByTestId("submit-reason")).toContainText(/disabled|security-reviewed/i, { timeout: 30_000 });
  });
});
