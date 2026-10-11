import { describe, expect, it } from "vitest";
import { dec, toPlain } from "./decimal";
import { reconstructPosition } from "./pnl";

const f = (side: "buy" | "sell", size: number | string, price: number | string, fee: number | string = 0) => ({ side, size: Number(size), price: Number(price), fee: Number(fee) });

describe("average-cost reconstruction (example D in docs/RISK.md)", () => {
  it("averages entries, realises on reduction, and flips at the fill price", () => {
    const r = reconstructPosition([f("buy", 2, 100, "0.09"), f("buy", 1, 130, "0.0585"), f("sell", 2, 120, "0.108"), f("sell", 3, 90, "0.1215")]);
    // Entry after two buys: (2·100 + 1·130) / 3 = 110. Sell 2 @ 120 realises +20; sell 3 @ 90 closes 1 (−20) and opens short 2 @ 90.
    expect(toPlain(r.realizedPnl)).toBe("0");
    expect(toPlain(r.size)).toBe("-2");
    expect(toPlain(r.entryPrice!)).toBe("90");
    expect(toPlain(r.fees)).toBe("0.378");
  });

  it("short positions realise (entry − exit) × size", () => {
    const r = reconstructPosition([f("sell", "0.3", "61000"), f("buy", "0.1", "60000"), f("buy", "0.2", "62000")]);
    expect(toPlain(r.realizedPnl)).toBe("-100");
    expect(r.size.isZero()).toBe(true);
    expect(r.entryPrice).toBeNull();
  });

  it("starts from a given opening position and rejects invalid fills", () => {
    const r = reconstructPosition([f("sell", 1, 110)], { size: dec(1), entryPrice: dec(100) });
    expect(toPlain(r.realizedPnl)).toBe("10");
    expect(() => reconstructPosition([f("buy", 0, 1)])).toThrow(RangeError);
    expect(() => reconstructPosition([], { size: dec(1), entryPrice: null })).toThrow(RangeError);
  });

  it("keeps decimal precision over many small fills", () => {
    const fills = Array.from({ length: 1000 }, () => f("buy", "0.001", "0.1"));
    const r = reconstructPosition([...fills, f("sell", 1, "0.3")]);
    expect(toPlain(r.size)).toBe("0");
    expect(toPlain(r.realizedPnl)).toBe("0.2");
  });
});
