import { describe, expect, it } from "vitest";
import { reconcile } from "./reconcile";
import { ALPHA, harness } from "./test-helpers";
import type { PrivateEvent } from "./types";

/**
 * Example-based tests for docs/venue/MATCHING-RULES.md. Test names start
 * with the rule id they verify.
 */

const kinds = (events: readonly PrivateEvent[]) => events.map((e) => e.kind);
const fills = (events: readonly PrivateEvent[], accountId?: string) =>
  events.filter((e): e is Extract<PrivateEvent, { kind: "fill" }> => e.kind === "fill" && (!accountId || e.accountId === accountId));
const rejection = (events: readonly PrivateEvent[]) => events.find((e) => e.kind === "rejected" || e.kind === "request-rejected") as { reason?: string } | undefined;

describe("instrument rules", () => {
  it("I-2 refuses prices outside the configured range or the band around the reference price", () => {
    const h = harness();
    expect(rejection(h.order("syn-a", { priceTicks: 3_599 }).private)?.reason).toBe("price-out-of-band");
    expect(rejection(h.order("syn-a", { priceTicks: 4_401 }).private)?.reason).toBe("price-out-of-band");
    expect(kinds(h.order("syn-a", { priceTicks: 3_600 }).private)).toEqual(["accepted"]);
    expect(rejection(h.order("syn-a", { priceTicks: 2_000_001 }).private)?.reason).toBe("price-out-of-range");
  });

  it("I-2 the reference price follows the last trade", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_300 });
    h.order("syn-b", { side: "buy", priceTicks: 4_300, tif: "ioc" });
    // Band is now ±430 around 4300: 4_700 is inside, 3_850 outside.
    expect(kinds(h.order("syn-a", { side: "sell", priceTicks: 4_700 }).private)).toEqual(["accepted"]);
    expect(rejection(h.order("syn-a", { priceTicks: 3_850 }).private)?.reason).toBe("price-out-of-band");
  });

  it("I-3 refuses quantities outside [min, max]", () => {
    const h = harness();
    expect(rejection(h.order("syn-a", { qtyLots: 1_000_001 }).private)?.reason).toBe("quantity-out-of-range");
  });
});

describe("matching", () => {
  it("M-1 / M-2 an incoming order matches on arrival at the resting order's price", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    const r = h.order("syn-b", { side: "buy", priceTicks: 4_050, qtyLots: 5 });
    expect(fills(r.private).map((f) => [f.accountId, f.liquidity, f.priceTicks, f.qtyLots])).toEqual([
      ["syn-a", "maker", 4_010, 5],
      ["syn-b", "taker", 4_010, 5],
    ]);
  });

  it("M-3 better prices fill first, whatever the arrival order", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_020, qtyLots: 5 });
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    const r = h.order("syn-b", { side: "buy", priceTicks: 4_020, qtyLots: 8 });
    expect(fills(r.private, "syn-b").map((f) => [f.priceTicks, f.qtyLots])).toEqual([
      [4_010, 5],
      [4_020, 3],
    ]);
  });

  it("M-4 / H-3 at one price, displayed orders fill before hidden orders that arrived earlier", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 200, visibility: "hidden", clientOrderId: "hid" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "disp" });
    const r = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 7, tif: "ioc" });
    expect(fills(r.private).filter((f) => f.liquidity === "maker").map((f) => [f.clientOrderId, f.qtyLots])).toEqual([
      ["disp", 5],
      ["hid", 2],
    ]);
  });

  it("M-3 / H-3 a hidden order at a better price fills before displayed orders at a worse price", () => {
    const h = harness();
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    h.order("syn-a", { side: "sell", priceTicks: 4_005, qtyLots: 100, visibility: "hidden" });
    const r = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 5, tif: "ioc" });
    expect(fills(r.private, "syn-b").map((f) => f.priceTicks)).toEqual([4_005]);
  });

  it("M-5 within a class, earlier orders fill first", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "first" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "second" });
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 100, visibility: "hidden", clientOrderId: "h1" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 100, visibility: "hidden", clientOrderId: "h2" });
    const r = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 120, tif: "ioc" });
    expect(fills(r.private).filter((f) => f.liquidity === "maker").map((f) => f.clientOrderId)).toEqual(["first", "second", "h1", "h2"]);
  });

  it("M-7 GTC remainders rest; IOC remainders are cancelled", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    const gtc = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 8, clientOrderId: "g" });
    expect(h.venue.engine.orderFor("syn-b", { clientOrderId: "g" })).toMatchObject({ status: "partially-filled", leavesLots: 3 });
    expect(kinds(gtc.private.filter((e) => e.accountId === "syn-b"))).toEqual(["accepted", "fill"]);
    h.order("syn-a", { side: "sell", priceTicks: 4_020, qtyLots: 5 });
    const ioc = h.order("syn-c", { side: "buy", priceTicks: 4_020, qtyLots: 9, tif: "ioc" });
    expect(ioc.private.filter((e) => e.accountId === "syn-c").at(-1)).toMatchObject({ kind: "cancelled", reason: "ioc-remainder", filledLots: 5 });
  });

  it("M-8 FOK executes completely or not at all", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    const fail = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 6, tif: "fok" });
    expect(fills(fail.private)).toHaveLength(0);
    expect(fail.private.at(-1)).toMatchObject({ kind: "cancelled", reason: "fok-unfilled" });
    expect(h.venue.engine.publicBook(ALPHA)!.asks).toEqual([{ priceTicks: 4_010, displayedLots: 5 }]);
    const ok = h.order("syn-b", { side: "buy", priceTicks: 4_010, qtyLots: 5, tif: "fok" });
    expect(fills(ok.private, "syn-b")[0]).toMatchObject({ qtyLots: 5, status: "filled" });
  });

  it("M-9 market orders trade up to the band-edge protection price and never rest, hide or post", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_390, qtyLots: 5 });
    h.order("syn-a", { side: "sell", priceTicks: 4_400, qtyLots: 5 });
    const r = h.order("syn-b", { orderType: "market", priceTicks: undefined, tif: "ioc", qtyLots: 20 });
    expect(fills(r.private, "syn-b").map((f) => f.priceTicks)).toEqual([4_390, 4_400]);
    expect(r.private.at(-1)).toMatchObject({ kind: "cancelled", reason: "ioc-remainder" });
    expect(rejection(h.order("syn-b", { orderType: "market", priceTicks: undefined, tif: "gtc" }).private)?.reason).toBe("market-requires-ioc-or-fok");
    expect(rejection(h.order("syn-b", { orderType: "market", tif: "ioc" }).private)?.reason).toBe("price-not-allowed");
    expect(rejection(h.order("syn-b", { orderType: "limit", priceTicks: undefined }).private)?.reason).toBe("price-required");
  });

  it("M-10 post-only orders that would trade are rejected, against displayed and hidden liquidity alike", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    expect(rejection(h.order("syn-b", { priceTicks: 4_010, postOnly: true }).private)?.reason).toBe("post-only-would-take");
    h.order("syn-a", { side: "sell", priceTicks: 4_005, qtyLots: 100, visibility: "hidden" });
    expect(rejection(h.order("syn-b", { priceTicks: 4_005, postOnly: true }).private)?.reason).toBe("post-only-would-take");
    expect(kinds(h.order("syn-b", { priceTicks: 4_004, postOnly: true }).private)).toEqual(["accepted"]);
    expect(rejection(h.order("syn-b", { priceTicks: 4_000, postOnly: true, tif: "ioc" }).private)?.reason).toBe("post-only-requires-gtc");
  });
});

describe("fills", () => {
  it("F-1 a partially filled maker keeps its queue position", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 10, clientOrderId: "m1" });
    h.order("syn-c", { side: "sell", priceTicks: 4_010, qtyLots: 10, clientOrderId: "m2" });
    h.order("syn-b", { priceTicks: 4_010, qtyLots: 4, tif: "ioc" });
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "m1" })).toMatchObject({ status: "partially-filled", filledLots: 4, leavesLots: 6 });
    const r = h.order("syn-b", { priceTicks: 4_010, qtyLots: 7, tif: "ioc" });
    expect(fills(r.private).filter((f) => f.liquidity === "maker").map((f) => [f.clientOrderId, f.qtyLots])).toEqual([
      ["m1", 6],
      ["m2", 1],
    ]);
  });

  it("F-2 both sides get a fill report about their own order only, with distinct opaque fill ids", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    const [maker, taker] = fills(h.order("syn-b", { priceTicks: 4_010, qtyLots: 5 }).private);
    expect(maker!.accountId).toBe("syn-a");
    expect(taker!.accountId).toBe("syn-b");
    expect(maker!.fillId).not.toBe(taker!.fillId);
    expect(maker!.fillId).toMatch(/^f[0-9a-f]{16}$/);
    expect(Object.keys(taker!)).not.toContain("counterparty");
    expect(JSON.stringify(taker)).not.toContain("syn-a");
  });
});

describe("cancel and replace", () => {
  it("P-1 only the owner can cancel; another account's order looks like a non-existent one", () => {
    const h = harness();
    h.order("syn-a", { clientOrderId: "mine" });
    const id = h.idOf("syn-a", "mine");
    const foreign = h.venue.submit({ type: "cancel", accountId: "syn-b", ref: { orderId: id } }).private;
    const missing = h.venue.submit({ type: "cancel", accountId: "syn-b", ref: { orderId: "o0000000000000000" } }).private;
    expect(foreign[0]).toMatchObject({ kind: "request-rejected", reason: "unknown-order" });
    expect({ ...foreign[0], ref: null, accountSeq: 0 }).toEqual({ ...missing[0], ref: null, accountSeq: 0 });
    expect(h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { orderId: id } }).private[0]).toMatchObject({ kind: "cancelled", reason: "user" });
    expect(h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { orderId: id } }).private[0]).toMatchObject({ reason: "order-not-modifiable" });
  });

  it("P-2 a size reduction at the same price keeps priority; a price change or size increase loses it", () => {
    const h = harness();
    for (const [account, id] of [["syn-a", "x"], ["syn-c", "y"]] as const) h.order(account, { side: "sell", priceTicks: 4_010, qtyLots: 10, clientOrderId: id });
    const reduce = h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "x" }, priceTicks: 4_010, qtyLots: 8 });
    expect(reduce.private[0]).toMatchObject({ kind: "replaced", priorityRetained: true });
    let r = h.order("syn-b", { priceTicks: 4_010, qtyLots: 1, tif: "ioc" });
    expect(fills(r.private, "syn-a")).toHaveLength(1);
    const grow = h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "x" }, priceTicks: 4_010, qtyLots: 12 });
    expect(grow.private[0]).toMatchObject({ kind: "replaced", priorityRetained: false });
    r = h.order("syn-b", { priceTicks: 4_010, qtyLots: 1, tif: "ioc" });
    expect(fills(r.private, "syn-c")).toHaveLength(1);
  });

  it("P-3 replace sets the new total quantity; it must exceed the filled quantity", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 10, clientOrderId: "x" });
    h.order("syn-b", { priceTicks: 4_010, qtyLots: 6, tif: "ioc" });
    const below = h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "x" }, priceTicks: 4_010, qtyLots: 6 });
    expect(below.private[0]).toMatchObject({ reason: "replace-quantity-below-filled" });
    const ok = h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "x" }, priceTicks: 4_010, qtyLots: 7 });
    expect(ok.private[0]).toMatchObject({ kind: "replaced", order: { qtyLots: 7, filledLots: 6, leavesLots: 1, status: "partially-filled" } });
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "x" }, priceTicks: 4_010, qtyLots: 7 }).private[0]).toMatchObject({ reason: "replace-no-change" });
  });

  it("P-4 a replace that crosses trades immediately as taker", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5 });
    h.order("syn-b", { priceTicks: 4_000, qtyLots: 8, clientOrderId: "bid" });
    const r = h.venue.submit({ type: "replace", accountId: "syn-b", ref: { clientOrderId: "bid" }, priceTicks: 4_010, qtyLots: 8 });
    expect(fills(r.private, "syn-b")[0]).toMatchObject({ liquidity: "taker", priceTicks: 4_010, qtyLots: 5 });
    expect(h.venue.engine.publicBook(ALPHA)!.bids[0]).toEqual({ priceTicks: 4_010, displayedLots: 3 });
  });

  it("P-5 mass cancel cancels only the caller's resting orders", () => {
    const h = harness();
    h.order("syn-a", { priceTicks: 3_990 });
    h.order("syn-a", { side: "sell", priceTicks: 4_020 });
    h.order("syn-b", { priceTicks: 3_995 });
    const r = h.venue.submit({ type: "mass-cancel", accountId: "syn-a" });
    expect(r.private.at(-1)).toMatchObject({ kind: "mass-cancelled", count: 2 });
    expect(h.venue.engine.openOrdersFor("syn-b")).toHaveLength(1);
  });
});

describe("self-trade prevention", () => {
  it.each([
    ["cancel-taker", { taker: "cancelled", maker: "new" }],
    ["cancel-maker", { taker: "filled", maker: "cancelled" }],
    ["cancel-both", { taker: "cancelled", maker: "cancelled" }],
  ] as const)("S-1 %s", (stp, expected) => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "own" });
    h.order("syn-b", { side: "sell", priceTicks: 4_020, qtyLots: 5 });
    h.order("syn-a", { priceTicks: 4_020, qtyLots: 5, tif: "ioc", stp, clientOrderId: "take" });
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "take" })!.status).toBe(expected.taker);
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "own" })!.status).toBe(expected.maker);
    expect(h.venue.executions.every((x) => x.makerAccountId !== x.takerAccountId)).toBe(true);
  });

  it("S-2 STP applies to the account's hidden orders too", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 100, visibility: "hidden", clientOrderId: "hid" });
    const r = h.order("syn-a", { priceTicks: 4_010, qtyLots: 5, tif: "ioc", stp: "cancel-maker" });
    expect(r.private.find((e) => e.kind === "cancelled")).toMatchObject({ clientOrderId: "hid", reason: "self-trade-prevention" });
    expect(h.venue.executions).toHaveLength(0);
  });

  it("S-3 a FOK that fails leaves resting orders untouched even if STP would have cancelled them", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_010, qtyLots: 5, clientOrderId: "own" });
    h.order("syn-b", { side: "sell", priceTicks: 4_010, qtyLots: 3 });
    h.order("syn-a", { priceTicks: 4_010, qtyLots: 6, tif: "fok", stp: "cancel-maker" });
    expect(h.venue.engine.orderFor("syn-a", { clientOrderId: "own" })!.status).toBe("new");
    expect(h.venue.executions).toHaveLength(0);
  });
});

describe("risk and trading status", () => {
  it("R-1 enforces open-order, order-notional and worst-case position limits", () => {
    const h = harness({ limits: { maxOpenOrders: 2, maxOrderNotional: 400_000, maxPositionLots: 150 } });
    h.order("syn-a", { priceTicks: 3_990, qtyLots: 50 });
    h.order("syn-a", { priceTicks: 3_980, qtyLots: 50 });
    expect(rejection(h.order("syn-a", { priceTicks: 3_970, qtyLots: 10 }).private)?.reason).toBe("max-open-orders");
    expect(rejection(h.order("syn-b", { priceTicks: 4_001, qtyLots: 100 }).private)?.reason).toBe("max-order-notional");
    // Worst case for syn-a buys: 100 open + 60 new > 150, even as IOC.
    expect(rejection(h.order("syn-a", { priceTicks: 3_990, qtyLots: 60, tif: "ioc" }).private)?.reason).toBe("max-position");
    expect(reconcile(h.venue).ok).toBe(true);
  });

  it("R-2 a halted instrument refuses new orders and replaces, accepts cancels, and is announced publicly", () => {
    const h = harness();
    h.order("syn-a", { clientOrderId: "r" });
    const halt = h.venue.submit({ type: "admin.set-status", instrumentId: ALPHA, status: "halted" });
    expect(halt.public).toEqual([expect.objectContaining({ kind: "status", status: "halted" })]);
    expect(rejection(h.order("syn-b").private)?.reason).toBe("trading-halted");
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "r" }, priceTicks: 4_000, qtyLots: 5 }).private[0]).toMatchObject({ reason: "trading-halted" });
    expect(h.venue.submit({ type: "cancel", accountId: "syn-a", ref: { clientOrderId: "r" } }).private[0]).toMatchObject({ kind: "cancelled" });
  });

  it("R-3 suspending an account cancels its orders and refuses new ones", () => {
    const h = harness();
    h.order("syn-a", { priceTicks: 3_990 });
    h.order("syn-a", { side: "sell", priceTicks: 4_100, qtyLots: 100, visibility: "hidden" });
    const r = h.venue.submit({ type: "admin.suspend-account", accountId: "syn-a" });
    expect(r.private.filter((e) => e.kind === "cancelled").map((e) => (e as { reason: string }).reason)).toEqual(["account-suspended", "account-suspended"]);
    expect(rejection(h.order("syn-a").private)?.reason).toBe("account-suspended");
  });
});

describe("hidden orders: engine view", () => {
  it("H-2 the engine (and so the operator) sees hidden orders in full; the public book does not", () => {
    const h = harness();
    h.order("syn-a", { side: "sell", priceTicks: 4_005, qtyLots: 150, visibility: "hidden" });
    expect(h.venue.engine.publicBook(ALPHA)).toEqual({ instrumentId: ALPHA, bids: [], asks: [] });
    expect(h.venue.engine.inspectBook(ALPHA)).toEqual([
      expect.objectContaining({ side: "sell", priceTicks: 4_005, displayedLots: 0, hiddenLots: 150, hidden: [expect.objectContaining({ accountId: "syn-a", qtyLots: 150 })] }),
    ]);
  });

  it("H-4 hidden liquidity trades with displayed liquidity in both directions", () => {
    const h = harness();
    // Hidden resting, displayed taker.
    h.order("syn-a", { side: "sell", priceTicks: 4_005, qtyLots: 100, visibility: "hidden" });
    expect(fills(h.order("syn-b", { priceTicks: 4_005, qtyLots: 10, tif: "ioc" }).private)).toHaveLength(2);
    // Hidden-flagged order arriving marketable takes displayed liquidity, then rests hidden.
    h.order("syn-c", { side: "buy", priceTicks: 3_990, qtyLots: 20 });
    const r = h.order("syn-b", { side: "sell", priceTicks: 3_990, qtyLots: 150, visibility: "hidden", clientOrderId: "hs" });
    expect(fills(r.private, "syn-b")[0]).toMatchObject({ liquidity: "taker", qtyLots: 20 });
    expect(h.venue.engine.orderFor("syn-b", { clientOrderId: "hs" })).toMatchObject({ status: "partially-filled", leavesLots: 130, visibility: "hidden" });
    expect(h.venue.engine.publicBook(ALPHA)!.asks).toEqual([]);
  });

  it("H-6 hidden orders must be GTC limit orders of at least the minimum size", () => {
    const h = harness();
    expect(rejection(h.order("syn-a", { visibility: "hidden", qtyLots: 99 }).private)?.reason).toBe("hidden-below-minimum");
    expect(rejection(h.order("syn-a", { visibility: "hidden", qtyLots: 100, tif: "ioc" }).private)?.reason).toBe("hidden-requires-gtc");
    expect(rejection(h.order("syn-a", { visibility: "hidden", orderType: "market", priceTicks: undefined, tif: "ioc", qtyLots: 100 }).private)?.reason).toBe("hidden-requires-gtc");
    h.order("syn-a", { visibility: "hidden", qtyLots: 100, clientOrderId: "h" });
    expect(h.venue.submit({ type: "replace", accountId: "syn-a", ref: { clientOrderId: "h" }, priceTicks: 4_000, qtyLots: 99 }).private[0]).toMatchObject({ reason: "hidden-below-minimum" });
  });
});
