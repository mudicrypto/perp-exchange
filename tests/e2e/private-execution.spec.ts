import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** Test-only counterparty credentials, configured in playwright.config.ts. */
const DESK_B = { Authorization: "Bearer e2e-desk-b-token-0000000000000" };
const DESK_C = { Authorization: "Bearer e2e-desk-c-token-0000000000000" };

async function openWorkspace(page: Page) {
  await page.goto("/private-execution");
  const workspace = page.getByTestId("private-execution-page");
  await expect(workspace).toBeVisible();
  return workspace;
}

/** Best bid of ALPHA-PERP as shown in the trade page's public order book. */
async function alphaBestBid(page: Page): Promise<number> {
  await page.goto("/");
  await page.getByTestId("market-option-ALPHA-PERP").click();
  await expect(page.getByTestId("market-title")).toHaveText("ALPHA-PERP");
  const best = page.getByTestId("order-book").getByTestId("book-bid").first();
  await expect(best).toHaveAttribute("data-price", /\d/);
  return Number(await best.getAttribute("data-price"));
}

/** Largest size of any level in the visible public book. */
async function maxBookLevel(page: Page): Promise<number> {
  const sizes = await page.getByTestId("order-book").locator("[data-size]").evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-size"))));
  return Math.max(...sizes);
}

test.describe("private execution workspace", () => {
  test("shows each mode's availability, the privacy matrix, and an unavailable state for encrypted orders", async ({ page }) => {
    const ws = await openWorkspace(page);
    await expect(ws.getByTestId("mode-hidden")).toHaveAttribute("data-available", "true");
    await expect(ws.getByTestId("mode-iceberg")).toHaveAttribute("data-available", "true");
    await expect(ws.getByTestId("mode-rfq")).toHaveAttribute("data-available", "true");
    await expect(ws.getByTestId("mode-encrypted")).toContainText("Planned");

    await ws.getByTestId("mode-hidden").click();
    await expect(ws.getByTestId("privacy-disclosure")).toHaveAttribute("data-level", "pre-trade-private");
    await expect(ws.getByTestId("privacy-public-observers-order-details")).toHaveAttribute("data-exposure", "not-visible");
    await expect(ws.getByTestId("privacy-public-observers-execution-details")).toHaveAttribute("data-exposure", "visible");
    await expect(ws.getByTestId("privacy-matching-engine-order-details")).toHaveAttribute("data-exposure", "visible");

    await ws.getByTestId("mode-iceberg").click();
    await expect(ws.getByTestId("privacy-public-observers-order-details")).toHaveAttribute("data-exposure", "partial");
    await expect(ws.getByTestId("privacy-disclosure")).toContainText("not anonymity");

    await ws.getByTestId("mode-encrypted").click();
    await expect(ws.getByTestId("venue-capability")).toHaveAttribute("data-status", "unsupported");
    await expect(ws.getByTestId("venue-capability")).toContainText("Planned");
    await expect(ws.getByTestId("mode-unavailable")).toBeVisible();
    await expect(ws.getByTestId("private-order-form")).toHaveCount(0);
    await expect(ws.getByTestId("privacy-matrix")).toHaveCount(0);
  });

  test("requires the disclosure to be confirmed before submitting", async ({ page }) => {
    const bestBid = await alphaBestBid(page);
    const ws = await openWorkspace(page);
    await ws.getByTestId("mode-hidden").click();
    await ws.getByRole("combobox", { name: "Market" }).selectOption("ALPHA-PERP");
    await ws.getByTestId("private-size").fill("0.01");
    await ws.getByTestId("private-price").fill(String(Number((bestBid * 0.999).toFixed(1))));
    await expect(ws.getByTestId("private-risk")).toHaveAttribute("data-decision", /allow|warn/);
    await expect(ws.getByTestId("private-submit")).toBeDisabled();
    await ws.getByTestId("privacy-confirm").click();
    await expect(ws.getByTestId("private-submit")).toBeEnabled();
    // Switching mode resets the confirmation: it applies to one disclosure only.
    await ws.getByTestId("mode-iceberg").click();
    await expect(ws.getByTestId("privacy-confirm")).not.toBeChecked();
  });

  test("a hidden order rests without appearing in the public book; an iceberg shows only its displayed slice", async ({ page }) => {
    const bestBid = await alphaBestBid(page);
    // ~0.1% under the best bid: inside the visible depth, unlikely to fill during the test.
    const hiddenPrice = Number((bestBid * 0.999).toFixed(1));
    const icebergPrice = Number((bestBid * 0.9985).toFixed(1));

    const ws = await openWorkspace(page);
    await ws.getByTestId("mode-hidden").click();
    await ws.getByRole("combobox", { name: "Market" }).selectOption("ALPHA-PERP");
    await ws.getByTestId("private-size").fill("40");
    await ws.getByTestId("private-price").fill(String(hiddenPrice));
    // The pre-trade risk check needs a fresh venue mark (fail closed until the first tick).
    await expect(ws.getByTestId("private-risk")).toHaveAttribute("data-decision", /allow|warn/);
    await ws.getByTestId("privacy-confirm").click();
    await ws.getByTestId("private-submit").click();
    await expect(ws.getByTestId("execution-status")).toHaveAttribute("data-kind", "success");
    await expect(ws.getByTestId("private-order-row").filter({ hasText: "Hidden" }).first()).toHaveAttribute("data-status", "open");

    await ws.getByTestId("mode-iceberg").click();
    await ws.getByTestId("private-size").fill("40");
    await ws.getByTestId("private-price").fill(String(icebergPrice));
    await ws.getByTestId("private-display-size").fill("4");
    // The pre-trade risk check needs a fresh venue mark (fail closed until the first tick).
    await expect(ws.getByTestId("private-risk")).toHaveAttribute("data-decision", /allow|warn/);
    await ws.getByTestId("privacy-confirm").click();
    await ws.getByTestId("private-submit").click();
    await expect(ws.getByTestId("execution-status")).toHaveAttribute("data-kind", "success");
    await expect(ws.getByTestId("private-order-row").filter({ hasText: "Iceberg" }).first().getByTestId("private-order-shown")).toContainText("4.000");

    // Synthetic levels are ≤ 3.2 ALPHA, so any level ≥ 40 could only come from our hidden or full iceberg size.
    await page.getByTestId("nav-trade").click();
    const book = page.getByTestId("order-book");
    await expect(book.locator(`[data-price="${icebergPrice}"]`)).toHaveCount(1, { timeout: 5_000 });
    const icebergLevel = Number(await book.locator(`[data-price="${icebergPrice}"]`).getAttribute("data-size"));
    expect(icebergLevel).toBeGreaterThanOrEqual(4);
    expect(icebergLevel).toBeLessThan(40);
    expect(await maxBookLevel(page)).toBeLessThan(40);

    await page.getByTestId("tab-orders").click();
    await page.getByTestId("cancel-all").click();
  });

  test("RFQ: selected counterparties get a redacted request, and only the accepted one learns the trade", async ({ page, request }) => {
    const ws = await openWorkspace(page);
    await ws.getByTestId("mode-rfq").click();
    await ws.getByRole("combobox", { name: "Market" }).selectOption("ALPHA-PERP");
    await expect(ws.getByTestId("rfq-reference")).not.toHaveText("—");
    await ws.getByTestId("private-side-buy").click();
    await ws.getByTestId("private-size").fill("0.5");
    await ws.getByTestId("private-price").fill("1500");
    await ws.getByTestId("counterparty-sim-desk-a").click();
    await ws.getByTestId("counterparty-sim-desk-c").click();
    await expect(ws.getByTestId("preview-side")).toContainText("not revealed");
    await ws.getByTestId("privacy-confirm").click();
    await ws.getByTestId("private-submit").click();

    const panel = ws.getByTestId("rfq-panel");
    await expect(panel).toHaveAttribute("data-status", "open");
    const rfqId = (await panel.getAttribute("data-rfq-id"))!;
    await expect(ws.getByTestId("rfq-quote")).toHaveCount(1); // Desk A auto-quotes.

    // Desk C (selected) sees only market, size and timing: no side, limit, identity or competing quotes.
    const inbox = await (await request.get("/api/rfq/inbox", { headers: DESK_C })).json();
    const mine = inbox.find((r: { requestId: string }) => r.requestId === rfqId);
    expect(mine).toEqual({
      requestId: rfqId,
      marketId: "ALPHA-PERP",
      size: 0.5,
      requesterSide: null,
      status: "open",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      yourQuote: null,
      execution: null,
    });
    // Desk B was not selected: the request does not exist for it.
    const inboxB = await (await request.get("/api/rfq/inbox", { headers: DESK_B })).json();
    expect(inboxB.some((r: { requestId: string }) => r.requestId === rfqId)).toBe(false);
    expect((await request.post(`/api/rfq/${rfqId}/quotes`, { headers: DESK_B, data: { bid: 900, ask: 1100 } })).status()).toBe(404);

    expect((await request.post(`/api/rfq/${rfqId}/quotes`, { headers: DESK_C, data: { bid: 900, ask: 1000 } })).status()).toBe(201);
    await expect(ws.getByTestId("rfq-quote")).toHaveCount(2);
    await ws.getByTestId("rfq-quote").filter({ hasText: "Desk C" }).getByTestId("rfq-accept").click();

    await expect(panel).toHaveAttribute("data-status", "accepted");
    await expect(ws.getByTestId("rfq-execution")).toContainText("Simulated Desk C");
    await expect(ws.getByTestId("private-fill-row").filter({ hasText: "rfq" }).first()).toBeVisible();

    const after = await (await request.get("/api/rfq/inbox", { headers: DESK_C })).json();
    expect(after.find((r: { requestId: string }) => r.requestId === rfqId)).toMatchObject({
      status: "traded-with-you",
      execution: { requesterSide: "buy", price: 1000, size: 0.5 },
    });
  });
});

test.describe("RFQ API authorization", () => {
  async function newSession(request: APIRequestContext, baseURL: string) {
    const res = await request.post("/api/session", { headers: { Origin: baseURL } });
    expect(res.status()).toBe(201);
    const cookie = res.headers()["set-cookie"] ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  }

  test("requires a session, a same-origin request and counterparty credentials", async ({ request, baseURL }) => {
    const body = { marketId: "ALPHA-PERP", size: 1, side: null, referencePrice: 1000, counterpartyIds: ["sim-desk-a"] };
    expect((await request.post("/api/rfq", { headers: { Origin: baseURL! }, data: body })).status()).toBe(401);
    expect((await request.get("/api/rfq/counterparties")).status()).toBe(401);
    expect((await request.post("/api/session")).status()).toBe(403);
    expect((await request.post("/api/session", { headers: { Origin: "https://evil.example" } })).status()).toBe(403);
    expect((await request.get("/api/rfq/inbox")).status()).toBe(401);
    expect((await request.get("/api/rfq/inbox", { headers: { Authorization: "Bearer not-a-real-token-000000000000" } })).status()).toBe(401);

    await newSession(request, baseURL!);
    expect((await request.post("/api/rfq", { headers: { Origin: "https://evil.example" }, data: body })).status()).toBe(403);
    expect((await request.post("/api/rfq", { headers: { Origin: baseURL! }, data: { ...body, limitPrice: 990 } })).status()).toBe(400);
    const created = await request.post("/api/rfq", { headers: { Origin: baseURL! }, data: body });
    expect(created.status()).toBe(201);
    const rfq = await created.json();
    expect(JSON.stringify(rfq)).not.toMatch(/session/i);
    expect((await request.get(`/api/rfq/${rfq.id}`)).status()).toBe(200);
  });

  test("another session cannot read, cancel or accept someone else's request", async ({ playwright, baseURL }) => {
    const owner = await playwright.request.newContext({ baseURL });
    const intruder = await playwright.request.newContext({ baseURL });
    await newSession(owner, baseURL!);
    await newSession(intruder, baseURL!);
    const created = await owner.post("/api/rfq", {
      headers: { Origin: baseURL! },
      data: { marketId: "ALPHA-PERP", size: 1, side: null, referencePrice: 1000, counterpartyIds: ["sim-desk-a"] },
    });
    const rfq = await created.json();
    const quoteId = rfq.quotes[0].id;
    expect((await intruder.get(`/api/rfq/${rfq.id}`)).status()).toBe(404);
    expect((await intruder.post(`/api/rfq/${rfq.id}/cancel`, { headers: { Origin: baseURL! } })).status()).toBe(404);
    expect((await intruder.post(`/api/rfq/${rfq.id}/accept`, { headers: { Origin: baseURL! }, data: { quoteId, side: "buy" } })).status()).toBe(404);
    const list = await (await intruder.get("/api/rfq")).json();
    expect(list.some((r: { id: string }) => r.id === rfq.id)).toBe(false);
    expect((await owner.get(`/api/rfq/${rfq.id}`)).status()).toBe(200);
    await owner.dispose();
    await intruder.dispose();
  });
});
