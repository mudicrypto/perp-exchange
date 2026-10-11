import { describe, expect, it } from "vitest";
import { attributeEquityChange, periodWindow, type AccountHistory } from "@/core/analytics";
import { dec, reconstructPosition, toPlain } from "@/core/risk";
import { MOCK_OFFLINE_ACCOUNT, MockAccountGateway } from "./mock-accounts";
import { mockPrice } from "./mock-ledger";

const ANCHOR = Date.UTC(2026, 9, 10, 14, 0, 0);
const gateway = new MockAccountGateway(ANCHOR);
const load = async (id: string, now = ANCHOR) => {
  const r = await gateway.load(id, now);
  if (!r.ok) throw new Error(r.reason);
  return r.history;
};
const obs = (h: AccountHistory, t: number) => {
  const s = h.snapshotAt(t)!;
  return { time: t, equity: s.equity, unrealizedPnl: s.unrealizedPnl, source: h.source };
};

describe("mock ledger", () => {
  it("is deterministic", async () => {
    const a = new MockAccountGateway(ANCHOR);
    const [x, y] = [await load("mock-acct-a1"), (await a.load("mock-acct-a1", ANCHOR)) as { ok: true; history: AccountHistory }];
    expect(y.history.fills).toEqual(x.fills);
    expect(y.history.snapshotAt(ANCHOR)).toEqual(x.snapshotAt(ANCHOR));
  });

  it("reconciles: equity change is fully explained by fills, fees, funding, transfers and unrealised PnL", async () => {
    for (const id of ["mock-acct-a1", "mock-acct-b1"]) {
      const h = await load(id, ANCHOR + 90 * 60_000);
      const now = ANCHOR + 90 * 60_000;
      for (const period of ["today", "24h", "7d"] as const) {
        const w = periodWindow(period, now);
        const from = Math.max(w.from, h.openedAt);
        const a = attributeEquityChange({ window: { ...w, from }, start: obs(h, from), end: obs(h, now), fills: h.fills, funding: h.funding, transfers: h.transfers });
        expect(Math.abs(Number(a.residual)), `${id} ${period}`).toBeLessThan(1e-6);
      }
    }
  });

  it("fills carry average-cost realised PnL that an independent replay reproduces per market", async () => {
    const h = await load("mock-acct-a1");
    for (const marketId of ["ALPHA-PERP", "BETA-PERP", "GAMMA-PERP"]) {
      const fills = h.fills.filter((f) => f.marketId === marketId);
      const reported = fills.reduce((s, f) => s.add(dec(f.realizedPnl)), dec(0));
      expect(reported.sub(reconstructPosition(fills).realizedPnl).abs().lt(dec("1e-9")), marketId).toBe(true);
      const snap = h.snapshotAt(ANCHOR)!.positions.find((p) => p.marketId === marketId);
      expect(snap?.size ?? 0).toBe(Number(toPlain(reconstructPosition(fills).size)));
    }
  });

  it("fills execute at the mock price path, and never exist after `now`", async () => {
    const h = await load("mock-acct-a1", ANCHOR - 3_600_000 + 1);
    for (const f of h.fills) expect(f.price).toBe(mockPrice(f.marketId, f.time));
    expect(h.fills.every((f) => f.time <= ANCHOR - 3_600_000 + 1)).toBe(true);
    expect(h.funding.every((p) => p.time <= ANCHOR - 3_600_000 + 1)).toBe(true);
  });

  it("reports unavailable data instead of inventing it", async () => {
    expect(await gateway.load(MOCK_OFFLINE_ACCOUNT.id, ANCHOR)).toMatchObject({ ok: false, reason: expect.stringMatching(/unavailable/) });
    expect(await gateway.load("someone-else", ANCHOR)).toMatchObject({ ok: false });
    const h = await load("mock-acct-a1");
    expect(h.snapshotAt(h.openedAt - 1)).toBeNull();
  });
});
