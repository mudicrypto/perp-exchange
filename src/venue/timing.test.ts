import { describe, expect, it } from "vitest";
import { timingProbe } from "./perf.ts";
import { timingHarness } from "./timing.ts";
import { ReferenceBookEngine } from "./timing-reference.ts";

// Measurement code only: these tests check the setup (VR-32), never a latency.
describe("timing probes (VR-32)", () => {
  it("VR-32 timingProbe rests every requested hidden-only level beyond one account's maxOpenOrders, on both paths", () => {
    for (const via of ["engine", "gateway"] as const) {
      const rows = timingProbe(1, 5, via, [0, 10_001]);
      expect(rows.map((r) => r.hiddenLevels)).toEqual([0, 10_001]);
      for (const r of rows) expect(r.medianUs).toHaveLength(1);
    }
  }, 120_000);

  it("VR-32 timingHarness rests every requested hidden-only level for the indexed and the reference book", () => {
    for (const engine of [undefined, (c: ConstructorParameters<typeof ReferenceBookEngine>[0]) => new ReferenceBookEngine(c)]) {
      const rows = timingHarness({ hiddenLevels: [0, 10_001], rounds: 1, samples: 5, probes: ["insert-front", "public-book"], ...(engine ? { engine } : {}) });
      expect(rows.map((r) => `${r.probe}:${r.hiddenLevels}`)).toEqual([
        "insert-front:0",
        "insert-front:10001",
        "public-book (hidden in front):0",
        "public-book (hidden in front):10001",
        "public-book (hidden behind):0",
        "public-book (hidden behind):10001",
      ]);
    }
  }, 120_000);
});
