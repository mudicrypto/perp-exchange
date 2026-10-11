import { describe, expect, it } from "vitest";
import { runBench } from "./bench";
import { runDemo } from "./demo";

describe("local prototype demo", () => {
  it("D-1 is deterministic, reconciles, and recovers to identical state and outputs", () => {
    const a = runDemo(7, 1_500);
    const b = runDemo(7, 1_500);
    expect(a.reconciliation.violations).toEqual([]);
    expect(a.stateHash).toBe(a.recoveredStateHash);
    expect(a.outputHead).toBe(a.recoveredOutputHead);
    expect(b.journalHead).toBe(a.journalHead);
    expect(b.outputHead).toBe(a.outputHead);
    expect(a.trades).toBeGreaterThan(50);
    expect(a.hiddenExecutions).toBeGreaterThan(0);
    expect(runDemo(8, 1_500).journalHead).not.toBe(a.journalHead);
  });

  it("H-1 the walkthrough shows that a hidden order publishes nothing", () => {
    const { lines } = runDemo(7, 100);
    const i = lines.findIndex((l) => l.includes("HIDDEN ask"));
    expect(lines[i + 2]).toContain("public: (nothing published)");
    expect(lines[i + 3]).toContain("asks [0.500@2001.00]");
  });

  it("benchmark harness runs end to end at a small scale", () => {
    const results = runBench(0.02);
    expect(results.map((r) => r.scenario.slice(0, 2))).toEqual(["B1", "B2", "B3", "B4", "B5"]);
    for (const r of results) expect(r.operations).toBeGreaterThan(0);
  });
});
