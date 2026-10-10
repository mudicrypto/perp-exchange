import { describe, expect, it } from "vitest";
import { RfqDesk } from "./desk";
import { RFQ_RETENTION_MS, RfqCounterpartyViewSchema, RfqCreateSchema, type RfqCounterparty } from "./model";

const COUNTERPARTIES: RfqCounterparty[] = [
  { id: "auto", name: "Auto Desk", autoQuoteSpreadBps: 10 },
  { id: "manual", name: "Manual Desk", autoQuoteSpreadBps: null },
  { id: "other", name: "Other Desk", autoQuoteSpreadBps: null },
];

function setup() {
  let now = 1_000_000;
  let seq = 0;
  const desk = new RfqDesk(COUNTERPARTIES, {
    now: () => now,
    randomId: () => `id-${++seq}`,
    quoteWindowMs: 30_000,
    roundPrice: (marketId, price) => (marketId === "ALPHA-PERP" ? Number(price.toFixed(1)) : null),
  });
  return { desk, advance: (ms: number) => (now += ms) };
}

const request = { marketId: "ALPHA-PERP", size: 3, side: null, referencePrice: 1000, counterpartyIds: ["auto", "manual"] };

describe("RfqDesk", () => {
  it("schema never accepts a limit price or identity fields", () => {
    expect(RfqCreateSchema.safeParse({ ...request, limitPrice: 990 }).success).toBe(false);
    expect(RfqCreateSchema.safeParse({ ...request, account: "0xabc" }).success).toBe(false);
    expect(RfqCreateSchema.safeParse({ ...request, counterpartyIds: ["auto", "auto"] }).success).toBe(false);
  });

  it("simulated desks quote two-way around the reference price immediately", () => {
    const { desk } = setup();
    const created = desk.create("session-a", request);
    expect(created).toMatchObject({ ok: true, value: { status: "open", quotes: [{ counterpartyId: "auto", bid: 999, ask: 1001 }] } });
  });

  it("only the requester can read, cancel or accept; others get not-found", () => {
    const { desk } = setup();
    const created = desk.create("session-a", request);
    if (!created.ok) throw new Error("expected ok");
    const id = created.value.id;
    expect(desk.getForRequester("session-b", id)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(desk.cancel("session-b", id)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(desk.accept("session-b", id, { quoteId: created.value.quotes[0]!.id, side: "buy" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(desk.listForRequester("session-b")).toEqual([]);
    expect(desk.getForRequester("session-a", id).ok).toBe(true);
  });

  it("only selected counterparties see the request, and only in redacted form", () => {
    const { desk } = setup();
    const created = desk.create("session-a", request);
    if (!created.ok) throw new Error("expected ok");
    expect(desk.inbox("other")).toEqual([]);
    expect(desk.quote("other", created.value.id, { bid: 990, ask: 1010 })).toMatchObject({ ok: false, error: { code: "not-found" } });
    const [view] = desk.inbox("manual");
    expect(RfqCounterpartyViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual({
      requestId: created.value.id,
      marketId: "ALPHA-PERP",
      size: 3,
      requesterSide: null,
      status: "open",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      yourQuote: null,
      execution: null,
    });
    // No identity, no competing quotes (the auto desk already quoted), no other counterparties.
    const serialized = JSON.stringify(view);
    for (const leak of ["session-a", "auto", "Auto Desk", "999", "1001"]) expect(serialized).not.toContain(leak);
  });

  it("reveals the side to counterparties only when the requester chooses to", () => {
    const { desk } = setup();
    desk.create("session-a", { ...request, side: "sell" });
    expect(desk.inbox("manual")[0]?.requesterSide).toBe("sell");
  });

  it("only the accepted counterparty learns the execution", () => {
    const { desk } = setup();
    const created = desk.create("session-a", request);
    if (!created.ok) throw new Error("expected ok");
    const quoted = desk.quote("manual", created.value.id, { bid: 999.5, ask: 1000.5 });
    expect(quoted).toMatchObject({ ok: true, value: { yourQuote: { bid: 999.5, ask: 1000.5 } } });
    const manualQuote = desk.getForRequester("session-a", created.value.id);
    if (!manualQuote.ok) throw new Error("expected ok");
    const quote = manualQuote.value.quotes.find((q) => q.counterpartyId === "manual")!;
    const accepted = desk.accept("session-a", created.value.id, { quoteId: quote.id, side: "buy" });
    expect(accepted).toMatchObject({ ok: true, value: { status: "accepted", execution: { side: "buy", price: 1000.5, size: 3, counterpartyName: "Manual Desk" } } });
    expect(desk.inbox("manual")[0]).toMatchObject({ status: "traded-with-you", requesterSide: "buy", execution: { price: 1000.5, size: 3, requesterSide: "buy" } });
    // The auto desk (also selected) learns only that the request closed.
    expect(desk.inbox("auto")[0]).toMatchObject({ status: "closed", requesterSide: null, execution: null });
  });

  it("validates quotes and acceptance", () => {
    const { desk } = setup();
    const created = desk.create("session-a", { ...request, side: "buy" });
    if (!created.ok) throw new Error("expected ok");
    expect(desk.quote("manual", created.value.id, { bid: 999.55, ask: null })).toMatchObject({ ok: false, error: { code: "invalid" } });
    const quoteId = created.value.quotes[0]!.id;
    expect(desk.accept("session-a", created.value.id, { quoteId, side: "sell" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(desk.accept("session-a", created.value.id, { quoteId: "nope", side: "buy" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(desk.accept("session-a", created.value.id, { quoteId, side: "buy" }).ok).toBe(true);
    expect(desk.accept("session-a", created.value.id, { quoteId, side: "buy" })).toMatchObject({ ok: false, error: { code: "closed" } });
    expect(desk.create("session-a", { ...request, marketId: "NOPE-PERP" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(desk.create("session-a", { ...request, counterpartyIds: ["ghost"] })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("expires unanswered requests and deletes completed ones after the retention period", () => {
    const { desk, advance } = setup();
    const created = desk.create("session-a", request);
    if (!created.ok) throw new Error("expected ok");
    advance(30_000);
    expect(desk.getForRequester("session-a", created.value.id)).toMatchObject({ ok: true, value: { status: "expired" } });
    expect(desk.quote("manual", created.value.id, { bid: 1, ask: 2 })).toMatchObject({ ok: false, error: { code: "closed" } });
    advance(RFQ_RETENTION_MS - 1);
    expect(desk.size).toBe(1);
    advance(1);
    expect(desk.size).toBe(0);
    expect(desk.getForRequester("session-a", created.value.id)).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(desk.inbox("manual")).toEqual([]);
  });
});
