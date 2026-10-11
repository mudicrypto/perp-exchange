import { expect, test } from "@playwright/test";

/**
 * Milestone 7 end-to-end verification (scenarios 1–8 and 10) against the
 * production build with SIMULATED market data. Scenario 9 runs against a
 * second server in live configuration: tests/e2e-live-config/.
 * "Live" here means streamed updates from the simulated source; real venue
 * connectivity is covered by the opt-in tests/e2e-external suite.
 */
test.describe("Milestone 7 verification", () => {
  test("1. opens the terminal", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Nova/);
    await expect(page.getByTestId("simulation-banner")).toBeVisible();
    await expect(page.getByTestId("market-title")).not.toBeEmpty();
    await expect(page.getByTestId("order-book")).toBeVisible();
    await expect(page.getByTestId("order-ticket")).toBeVisible();
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open");
  });

  test("2. switches markets", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-option-BETA-PERP").click();
    await expect(page.getByTestId("market-title")).toHaveText("BETA-PERP");
    await expect(page).toHaveURL(/\/$/);
    await page.getByTestId("market-option-GAMMA-PERP").click();
    await expect(page.getByTestId("market-title")).toHaveText("GAMMA-PERP");
    await expect(page.getByTestId("order-ticket")).toContainText("GAMMA");
  });

  test("3. receives streaming market updates", async ({ page }) => {
    await page.goto("/");
    const firstTrade = page.getByTestId("trades-tape").getByTestId("trade-row").first();
    await expect(firstTrade).toBeVisible();
    const before = await firstTrade.textContent();
    await expect.poll(async () => firstTrade.textContent(), { timeout: 15_000 }).not.toBe(before);
    const bestBid = page.getByTestId("order-book").getByTestId("book-bid").first();
    const bidBefore = await bestBid.getAttribute("data-size");
    await expect.poll(async () => bestBid.getAttribute("data-size"), { timeout: 10_000 }).not.toBe(bidBefore);
    await expect(page.getByTestId("stream-badge")).toHaveCount(0);
  });

  test("4. handles a disconnected data feed and recovers", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("book-ask").first()).toBeVisible();
    await page.getByTestId("demo-controls").click();
    await page.getByTestId("demo-outage").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "reconnecting");
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-freshness", "stale");
    // Order entry is refused by the venue while the feed is down.
    await page.getByTestId("type-market").click();
    await page.getByTestId("input-size").fill("0.01");
    await page.getByTestId("submit-order").click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toHaveAttribute("data-tone", "bad");
    await expect(page.getByTestId("submit-result")).toContainText(/disconnected|paused/i);
    await expect(page.getByTestId("connection-indicator")).toHaveAttribute("data-status", "open", { timeout: 15_000 });
    await expect(page.getByTestId("book-panel")).toHaveAttribute("data-freshness", "fresh");
  });

  test("5. refuses invalid orders with clear reasons", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-option-ALPHA-PERP").click();
    const submit = page.getByTestId("submit-order");
    for (const [size, message] of [
      ["0.00001", "Size allows at most 3 decimals"],
      ["-1", "Size must be a positive number"],
      ["abc", "Size must be a positive number"],
    ] as const) {
      await page.getByTestId("input-price").fill("1000");
      await page.getByTestId("input-size").fill(size);
      await expect(page.getByTestId("ticket-errors")).toContainText(message);
      await expect(submit).toBeDisabled();
    }
    // A limit price far from the mark is blocked by the fat-finger limit.
    await page.getByTestId("input-size").fill("0.01");
    await page.getByTestId("input-price").fill("1");
    await expect(page.getByTestId("risk-check").filter({ hasText: "deviation" })).toHaveAttribute("data-action", "block");
    await expect(submit).toBeDisabled();
  });

  test("6. creates and cancels a simulated order", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-option-ALPHA-PERP").click();
    await page.getByTestId("order-book").getByTestId("book-bid").last().click();
    await page.getByTestId("input-size").fill("0.05");
    await page.getByTestId("submit-order").click();
    await expect(page.getByTestId("order-review")).toContainText("Simulated order");
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toContainText("Order resting at");
    await page.getByTestId("tab-orders").click();
    const row = page.getByTestId("open-order-row").filter({ hasText: "ALPHA-PERP" }).filter({ hasText: "0.050" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /Cancel order/ }).click();
    await expect(row).toHaveCount(0);
    await page.getByTestId("tab-history").click();
    await expect(page.getByTestId("history-row").first()).toContainText("Cancelled by user");
  });

  test("7. shows a simulated fill", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("market-option-ALPHA-PERP").click();
    await page.getByTestId("tab-fills").click();
    const fills = page.getByTestId("fill-row");
    const before = await fills.count();
    await page.getByTestId("type-market").click();
    await page.getByTestId("input-size").fill("0.02");
    await page.getByTestId("submit-order").click();
    await page.getByTestId("confirm-order").click();
    await expect(page.getByTestId("submit-result")).toContainText(/fill/i);
    await page.getByTestId("tab-fills").click();
    await expect(fills).toHaveCount(before + 1);
    await expect(fills.first()).toContainText("ALPHA-PERP");
  });

  test("8. opens Private Execution", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-private-execution").click();
    const ws = page.getByTestId("private-execution-page");
    await expect(ws).toBeVisible();
    await expect(ws.getByTestId("private-simulated-banner")).toBeVisible();
    await expect(ws.getByTestId("mode-hidden")).toHaveAttribute("data-available", "true");
    await ws.getByTestId("mode-hidden").click();
    await expect(ws.getByTestId("privacy-matrix")).toBeVisible();
    await expect(ws.getByTestId("private-submit")).toBeDisabled();
  });

  test("10. prevents unauthorized access to private order data", async ({ playwright, baseURL }) => {
    const origin = { Origin: baseURL! };
    const owner = await playwright.request.newContext({ baseURL });
    const intruder = await playwright.request.newContext({ baseURL });
    const anonymous = await playwright.request.newContext({ baseURL });
    for (const ctx of [owner, intruder]) expect((await ctx.post("/api/session", { headers: origin })).status()).toBe(201);

    const created = await owner.post("/api/rfq", { headers: origin, data: { marketId: "ALPHA-PERP", size: 1, side: "buy", referencePrice: 1000, counterpartyIds: ["sim-desk-a"] } });
    expect(created.status()).toBe(201);
    const rfq = await created.json();

    // Private RFQ records: other sessions and anonymous callers get nothing.
    expect((await anonymous.get(`/api/rfq/${rfq.id}`)).status()).toBe(401);
    expect((await intruder.get(`/api/rfq/${rfq.id}`)).status()).toBe(404);
    expect((await intruder.post(`/api/rfq/${rfq.id}/accept`, { headers: origin, data: { quoteId: rfq.quotes[0].id, side: "buy" } })).status()).toBe(404);
    expect(JSON.stringify(await (await intruder.get("/api/rfq")).json())).not.toContain(rfq.id);
    // A cross-site page cannot act with the owner's cookie.
    expect((await owner.post(`/api/rfq/${rfq.id}/cancel`, { headers: { Origin: "https://evil.example" } })).status()).toBe(403);
    // A counterparty that was not selected cannot read or quote it.
    const deskB = { Authorization: "Bearer e2e-desk-b-token-0000000000000" };
    expect(JSON.stringify(await (await anonymous.get("/api/rfq/inbox", { headers: deskB })).json())).not.toContain(rfq.id);
    expect((await anonymous.post(`/api/rfq/${rfq.id}/quotes`, { headers: deskB, data: { bid: 1, ask: 2 } })).status()).toBe(404);

    // Account data through the analyst: another user's account is not found.
    expect((await intruder.post("/api/analyst/session", { headers: origin, data: { userId: "demo-trader" } })).status()).toBe(201);
    expect((await intruder.post("/api/analyst/ask", { headers: origin, data: { question: "Show my positions", accountId: "mock-acct-b1", marketId: null } })).status()).toBe(404);

    // Guessing counterparty tokens is rate-limited per client.
    const prober = { "x-nova-test-client": `prober-${Date.now()}` };
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) codes.push((await anonymous.get("/api/rfq/inbox", { headers: { ...prober, Authorization: `Bearer guess-${i}-000000000000000000000` } })).status());
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // ...and a blocked client is refused even with a valid token (no oracle while blocked).
    expect((await anonymous.get("/api/rfq/inbox", { headers: { ...prober, ...deskB } })).status()).toBe(429);
    for (const ctx of [owner, intruder, anonymous]) await ctx.dispose();
  });
});
