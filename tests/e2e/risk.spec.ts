import { expect, test } from "@playwright/test";

/** Limits come from NOVA_RISK_LIMITS in playwright.config.ts (maxOrderNotional 500,000 SIMUSD). */

test.describe("risk engine", () => {
  test("ticket preview shows units, fees and calculation inputs, and blocks orders over a limit", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-option-ALPHA-PERP").click();
    await page.getByTestId("input-price").fill("900");
    await page.getByTestId("input-size").fill("1");
    const preview = page.getByTestId("risk-preview");
    await expect(preview.getByTestId("risk-notional")).toContainText("900.00 SIMUSD");
    await expect(preview.getByTestId("risk-fee")).toContainText("SIMUSD");
    await expect(preview.getByTestId("risk-liq").locator("[data-status]")).toHaveAttribute("data-kind", "estimate");
    await preview.getByTestId("risk-details").locator("summary").click();
    await expect(preview.getByTestId("risk-details")).toContainText("Method: notional / leverage (simulator rule)");
    await expect(preview.getByTestId("risk-details")).toContainText("Taker fee rate: 0.00045");
    await expect(preview.getByTestId("risk-details")).toContainText("Existing position");

    // 600 ALPHA × 900 = 540,000 SIMUSD > 500,000: blocked before submission.
    await page.getByTestId("input-size").fill("600");
    const check = page.getByTestId("risk-check").filter({ hasText: "Order notional" });
    await expect(check).toHaveAttribute("data-action", "block");
    await expect(check).toContainText("exceeds the limit of 500000");
    await expect(page.getByTestId("submit-order")).toBeDisabled();
    await expect(page.getByTestId("submit-reason")).toContainText("Blocked by risk limits");
  });

  test("portfolio risk report: exposure, PnL components, scenarios and configured limits", async ({ page }) => {
    await page.goto("/portfolio");
    const report = page.getByTestId("portfolio-page").getByTestId("risk-report");
    await expect(report.getByTestId("exposure-row").first()).toBeVisible();
    await expect(report.getByTestId("exposure-row").first().getByTestId("exposure-liq")).toHaveAttribute("data-kind", "estimate");
    await expect(report.getByTestId("risk-hhi")).toHaveAttribute("data-status", "available");
    await expect(report.getByTestId("risk-rpnl")).toHaveAttribute("data-status", "available");
    // The simulator does not charge funding: zero, not a guess.
    await expect(report.getByTestId("risk-funding-paid")).toHaveAttribute("data-value", "0");
    await expect(report.getByTestId("scenario-row")).toHaveCount(6);
    await expect(report.getByTestId("scenario-row").first()).toHaveAttribute("data-move", "-0.2");
    await expect(report.getByTestId("risk-limits").locator('[data-limit="maxOrderNotional"]')).toContainText("500000");
    await expect(report.getByTestId("risk-limits").locator('[data-limit="maxOrderNotional"]')).toContainText("Blocks");
    await expect(report).toContainText("cannot prevent losses");
  });

  test("the server enforces its own limits on RFQ requests", async ({ request, baseURL }) => {
    expect((await request.post("/api/session", { headers: { Origin: baseURL! } })).status()).toBe(201);
    const res = await request.post("/api/rfq", {
      headers: { Origin: baseURL! },
      // A low reference price cannot understate the notional: the server also uses its own mark.
      data: { marketId: "ALPHA-PERP", size: 600, side: null, referencePrice: 1, counterpartyIds: ["sim-desk-a"] },
    });
    expect(res.status()).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "risk-limit" } });
  });
});
