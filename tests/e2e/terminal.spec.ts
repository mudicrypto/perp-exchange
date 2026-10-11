import { expect, test, type Page } from "@playwright/test";

/**
 * Runs against the deterministic simulated source + paper venue
 * (see playwright.config.ts). Verifies terminal behaviour, not venue data.
 */

async function openMarket(page: Page, id: string) {
  await page.getByTestId(`market-option-${id}`).click();
  await expect(page.getByTestId("market-title")).toHaveText(id);
}

test.describe("shell", () => {
  test("labels simulated data and shows header controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("simulation-banner")).toContainText("SIMULATED MARKET DATA");
    await expect(page.getByTestId("data-source-badge")).toHaveText("SIMULATION");
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveText([
      "Trade",
      "Portfolio",
      "Private Execution",
    ]);
  });

  test("wallet placeholder explains there is no wallet connection and never asks for keys", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("wallet-button").click();
    const dialog = page.getByTestId("wallet-dialog");
    await expect(dialog).toContainText("Wallet connection is not available yet");
    await expect(dialog).toContainText("never ask for your seed phrase or private key");
    await expect(dialog.locator("input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("market data", () => {
  test("renders chart, book, trades and the market sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await expect(page.getByTestId("book-bid").first()).toBeVisible();
    await expect(page.getByTestId("book-spread")).toBeVisible();
    await expect(page.getByTestId("trade-row").first()).toBeVisible();
    await expect(page.getByTestId("price-chart").locator("canvas").first()).toBeVisible();
    await expect(page.getByTestId("mark-price")).not.toHaveText("—");
    await expect(page.getByTestId("market-sidebar").getByRole("button")).toHaveCount(3);
  });

  test("searches and switches markets with the keyboard", async ({ page }) => {
    await page.goto("/");
    const search = page.getByTestId("market-search");
    await search.fill("gam");
    await expect(page.getByTestId("market-option-ALPHA-PERP")).toHaveCount(0);
    await search.press("ArrowDown");
    await expect(page.getByTestId("market-option-GAMMA-PERP")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("market-title")).toHaveText("GAMMA-PERP");
    await expect(page.getByTestId("order-book")).toContainText("Size (GAMMA)");

    await search.fill("zzz");
    await expect(page.getByTestId("market-sidebar")).toContainText("No markets match");
  });

  test("remembers market and timeframe across reloads", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "BETA-PERP");
    await page.getByTestId("interval-1h").click();
    await page.reload();
    await expect(page.getByTestId("market-title")).toHaveText("BETA-PERP");
    await expect(page.getByTestId("interval-1h")).toHaveAttribute("aria-pressed", "true");
  });

  test("shows disconnected state during a simulated outage and recovers", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByTestId("demo-controls").click();
    await page.getByTestId("demo-outage").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "reconnecting");
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-freshness", "stale");
    await expect(page.getByTestId("book-panel")).toContainText("Disconnected");
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open", { timeout: 15_000 });
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-freshness", "fresh");
  });

  test("shows a chart error state with a working retry", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await expect(page.getByTestId("chart-loading")).toBeHidden();
    await page.getByTestId("demo-controls").click();
    await page.getByTestId("demo-candle-error").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chart-error")).toBeVisible();
    await page.getByTestId("chart-retry").click();
    await expect(page.getByTestId("chart-error")).toBeHidden();
  });
});

test.describe("market data status", () => {
  test("connection details show the data source, subscriptions and message health", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByTestId("connection-button").click();
    const details = page.getByTestId("connection-details");
    await expect(details).toContainText("Simulated data generated in this browser");
    await expect(page.getByTestId("diag-status")).toContainText("Connected");
    await expect(page.getByTestId("diag-invalid")).toHaveText("0");
    await expect(page.getByTestId("diag-subscriptions")).not.toHaveText("0");
  });

  test("market list shows streamed mids and the market header shows stream status", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("list-freshness")).toContainText("Live mids");
    await expect(page.getByTestId("market-sidebar")).toContainText("Mid");
    await expect(page.getByTestId("stats-stream")).toHaveAttribute("data-stream-status", "live");
  });

  test("panels report disconnection with the age of the last update", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-stream-status", "live");
    await page.getByTestId("demo-controls").click();
    await page.getByTestId("demo-outage").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-stream-status", "disconnected");
    await expect(page.getByTestId("book-panel").getByTestId("stream-badge")).toContainText("Disconnected");
    await expect(page.getByTestId("stats-stream")).toHaveAttribute("data-stream-status", "disconnected");
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-stream-status", "live", { timeout: 15_000 });
  });
});

test.describe("order entry (paper trading)", () => {
  test("previews risk, requires review, and fills a simulated market order", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "GAMMA-PERP");
    await page.getByTestId("type-market").click();
    await page.getByTestId("input-size").fill("1000");
    await expect(page.getByTestId("risk-margin")).not.toHaveText("—");
    await expect(page.getByTestId("risk-impact")).toBeVisible();

    await page.getByTestId("submit-order").click();
    const review = page.getByTestId("order-review");
    await expect(review).toContainText("Simulated order");
    await expect(review).toContainText("Nothing is sent to a real venue");
    await review.getByTestId("confirm-order").click();

    await expect(page.getByTestId("submit-result")).toHaveAttribute("data-tone", "ok");
    await expect(page.getByTestId("submit-result")).toContainText("Simulated fill: 1,000 GAMMA");
    await expect(page.getByTestId("position-GAMMA-PERP")).toBeVisible();

    await page.getByTestId("tab-fills").click();
    await expect(page.getByTestId("fill-row").first()).toContainText("GAMMA-PERP");
  });

  test("rests a limit order, then cancels it", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "GAMMA-PERP");
    // A price far from the mark is refused by the fat-finger limit before it can be submitted.
    await page.getByTestId("input-price").fill("0.5");
    await page.getByTestId("input-size").fill("100");
    await expect(page.getByTestId("risk-check").filter({ hasText: "deviation" })).toHaveAttribute("data-action", "block");
    await expect(page.getByTestId("submit-order")).toBeDisabled();
    // The deepest visible bid rests below the market.
    await page.getByTestId("order-book").getByTestId("book-bid").last().click();
    const restingPrice = await page.getByTestId("input-price").inputValue();
    await page.getByTestId("submit-order").click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toContainText(`Order resting at ${Number(restingPrice).toFixed(5)}`);

    await page.getByTestId("tab-orders").click();
    await expect(page.getByTestId("open-order-row")).toHaveCount(3);
    const row = page.getByTestId("open-order-row").filter({ hasText: "GAMMA-PERP" });
    await row.getByRole("button", { name: /Cancel order/ }).click();
    await expect(page.getByTestId("open-order-row")).toHaveCount(2);
    await page.getByTestId("tab-history").click();
    await expect(page.getByTestId("history-row").first()).toContainText("Cancelled by user");
  });

  test("rejects orders exceeding available margin with a clear reason", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "GAMMA-PERP");
    await page.getByTestId("type-market").click();
    // 600k GAMMA ≈ 480k SIMUSD: under the E2E order-notional limit (500k), over the account's margin.
    await page.getByTestId("input-size").fill("600000");
    await page.getByTestId("submit-order").click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toHaveAttribute("data-tone", "bad");
    await expect(page.getByTestId("submit-result")).toContainText("Insufficient margin");
  });

  test("validates input precision and fills price from the book", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "ALPHA-PERP");
    await page.getByTestId("input-size").fill("0.00001");
    await expect(page.getByTestId("ticket-errors")).toContainText("Size allows at most 3 decimals");
    await expect(page.getByTestId("submit-order")).toBeDisabled();

    await page.getByTestId("book-bid").first().click();
    await expect(page.getByTestId("input-price")).not.toHaveValue("");
    await page.getByTestId("size-preset-25").click();
    await expect(page.getByTestId("input-size")).not.toHaveValue("0.00001");
    await expect(page.getByTestId("submit-order")).toBeEnabled();
  });

  test("closes a position from the positions table", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("position-BETA-PERP")).toBeVisible();
    // The paper venue needs a first book snapshot before it can match.
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByRole("button", { name: "Market close BETA-PERP position" }).click();
    await expect(page.getByTestId("position-BETA-PERP")).toHaveCount(0);
  });

  test("keyboard: side, tabs and leverage are operable", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "GAMMA-PERP");
    await page.getByTestId("side-sell").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("side-sell")).toHaveAttribute("aria-pressed", "true");
    const slider = page.getByRole("slider", { name: "Leverage" });
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    // GAMMA has no open position in the demo fixture, so leverage is adjustable (default 10x).
    await expect(page.getByTestId("leverage-value")).toHaveText("9x");
  });
});

test.describe("capability-driven order entry", () => {
  test("places a simulated stop-market order that waits for its trigger, then cancels it", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "ALPHA-PERP");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByTestId("type-trigger").click();
    await page.getByTestId("type-option-stop-market").click();
    await page.getByTestId("input-trigger").fill("1100");
    await page.getByTestId("input-size").fill("0.5");
    await expect(page.getByTestId("risk-margin")).not.toHaveText("—");
    await page.getByTestId("submit-order").click();
    await expect(page.getByTestId("order-review")).toContainText("Trigger price (mark)");
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toContainText("waiting for trigger at 1,100.0");

    await page.getByTestId("tab-orders").click();
    const row = page.getByTestId("open-order-row").filter({ hasText: "Stop market" });
    await expect(row).toContainText(/waiting trigger/i);
    await row.getByRole("button", { name: /Cancel order/ }).click();
    await expect(page.getByTestId("open-order-row").filter({ hasText: "Stop market" })).toHaveCount(0);
  });

  test("shows unsupported order types with their reason and never offers them", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("type-trigger").click();
    await expect(page.getByTestId("type-option-stop-limit")).toHaveAttribute("data-availability", "preview-only");
    await expect(page.getByTestId("type-option-stop-limit")).toContainText("not implemented in the simulator");
    await page.keyboard.press("Escape");
    await page.getByTestId("advanced-types").locator("summary").click();
    // The simulator supports private types, but only through the Private Execution workspace.
    await expect(page.getByTestId("advanced-hidden")).toHaveAttribute("data-availability", "available");
    await expect(page.getByTestId("advanced-iceberg")).toContainText("Private Execution workspace");
    await expect(page.getByTestId("advanced-execution.rfq")).toContainText("Private Execution workspace");
    await expect(page.getByTestId("type-hidden")).toHaveCount(0);
  });

  test("a preview-only order type validates and previews risk but cannot be submitted", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "ALPHA-PERP");
    await page.getByTestId("type-trigger").click();
    await page.getByTestId("type-option-stop-limit").click();
    await page.getByTestId("input-trigger").fill("1100");
    await page.getByTestId("input-price").fill("1101");
    await page.getByTestId("input-size").fill("0.5");
    await expect(page.getByTestId("type-unsupported")).toContainText("Preview only");
    await expect(page.getByTestId("risk-margin")).not.toHaveText("—");
    await expect(page.getByTestId("submit-order")).toBeDisabled();
    await expect(page.getByTestId("submit-reason")).toContainText("not implemented in the simulator");
  });

  test("a configured simulated rejection is reported as such", async ({ page }) => {
    await page.goto("/");
    await openMarket(page, "GAMMA-PERP");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByTestId("demo-controls").click();
    await page.getByTestId("demo-reject-next").click();
    await page.keyboard.press("Escape");
    await page.getByTestId("type-market").click();
    await page.getByTestId("input-size").fill("100");
    await page.getByTestId("submit-order").click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toHaveAttribute("data-tone", "bad");
    await expect(page.getByTestId("submit-result")).toContainText("Simulated venue rejection");
    await page.getByTestId("tab-history").click();
    await expect(page.getByTestId("history-row").first()).toContainText(/rejected/i);
  });
});

test.describe("portfolio & risk", () => {
  test("shows simulated equity, PnL and labelled risk estimates", async ({ page }) => {
    await page.goto("/");
    const summary = page.getByTestId("portfolio-summary");
    await expect(summary).toContainText("SIMULATED");
    await expect(page.getByTestId("summary-equity")).not.toHaveText("—");
    await page.getByTestId("tab-risk").click();
    await expect(page.getByTestId("risk-summary")).toContainText("Estimate");
    await expect(page.getByTestId("risk-closest-liq")).toContainText("away");
  });

  test("portfolio page shares account state with the trade page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("tab-orders").click();
    await page.getByTestId("cancel-all").click();
    await page.getByTestId("nav-portfolio").click();
    // Next.js keeps the previous route mounted but hidden, so scope to the portfolio page.
    const portfolio = page.getByTestId("portfolio-page");
    await expect(portfolio).toBeVisible();
    await expect(portfolio.getByTestId("tab-orders")).toHaveText("Open orders (0)");
    await expect(portfolio.getByTestId("positions-table")).toBeVisible();
  });
});

test.describe("private execution", () => {
  test("ticket orders are disclosed as public; the dialog lists what the venue supports", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("execution-visibility")).toHaveAttribute("data-level", "public");
    await page.getByTestId("open-private-execution").click();
    const dialog = page.getByTestId("private-execution-dialog");
    await expect(dialog.locator('[data-mode="hidden"]')).toHaveAttribute("data-executable", "true");
    await expect(dialog.locator('[data-mode="encrypted"]')).toHaveAttribute("data-executable", "false");
    await dialog.getByTestId("private-execution-learn-more").click();
    await expect(page).toHaveURL(/\/private-execution$/);
    await expect(page.getByTestId("private-simulated-banner")).toBeVisible();
  });
});

test.describe("responsive", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("mobile layout keeps navigation and order entry reachable", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("nav-private-execution")).toBeVisible();
    await expect(page.getByTestId("market-sidebar")).toBeHidden();
    await page.getByTestId("market-selector").click();
    await page.getByTestId("market-option-BETA-PERP").last().click();
    // The ticket follows the chart and has real height (regression: it once collapsed to 8px).
    const chart = await page.getByTestId("chart-panel").boundingBox();
    const ticket = await page.getByTestId("ticket-panel").boundingBox();
    expect(ticket!.y).toBeGreaterThan(chart!.y);
    expect(ticket!.height).toBeGreaterThan(400);
    await page.getByTestId("submit-order").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("submit-order")).toBeInViewport();
  });
});

test.describe("API", () => {
  test("serves the simulated catalog and validates candle queries", async ({ request }) => {
    const markets = await request.get("/api/markets");
    expect(markets.ok()).toBe(true);
    const body = await markets.json();
    expect(body.source.kind).toBe("simulation");
    expect(body.markets.length).toBe(3);

    const bad = await request.get("/api/candles?market=../../etc&interval=7m");
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe("bad-request");

    const good = await request.get("/api/candles?market=ALPHA-PERP&interval=1h");
    expect((await good.json()).candles.length).toBeGreaterThan(0);
  });

  test("venue account reads are validated and unavailable for the simulator", async ({ request }) => {
    const bad = await request.get("/api/venue/account?address=0x123");
    expect(bad.status()).toBe(400);
    const sim = await request.get("/api/venue/account?address=0x0000000000000000000000000000000000000001");
    expect(sim.status()).toBe(404);
    expect((await sim.json()).error.code).toBe("unsupported");
  });

  test("sends security headers and reports paper mode only for simulation", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-powered-by"]).toBeUndefined();
    const health = await (await request.get("/api/health")).json();
    expect(health.config).toMatchObject({ marketDataSource: "simulation", hyperliquidNetwork: "mainnet", executionMode: "paper" });
    expect(health.config.riskLimits.maxOrderNotional).toEqual({ value: "500000", action: "block" });
  });
});
