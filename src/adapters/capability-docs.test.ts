import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_IDS, type CapabilityId } from "@/core/domain";
import { createCapabilityRegistry } from "@/features/terminal/create-sources";

/** Keeps docs/TRADING.md's supported/unsupported matrix in sync with the code. */
describe("docs/TRADING.md capability matrix", () => {
  const doc = readFileSync(join(process.cwd(), "docs/TRADING.md"), "utf8");
  const section = doc.split("<!-- capability-matrix:start -->")[1]?.split("<!-- capability-matrix:end -->")[0] ?? "";
  const rows = new Map(
    section
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => {
        const cells = line.split("|").map((c) => c.trim());
        return [cells[1]!.replaceAll("`", ""), [cells[2]!, cells[3]!]] as const;
      }),
  );
  const registry = createCapabilityRegistry();
  const symbol = (venue: string, id: CapabilityId) => {
    const s = registry.check(venue, id);
    return s.status === "supported" ? "✅" : s.scope === "venue" ? "⛔" : "🚧";
  };

  it("lists every capability exactly once", () => {
    expect([...rows.keys()]).toEqual([...CAPABILITY_IDS]);
  });

  it("matches the registered statuses", () => {
    for (const id of CAPABILITY_IDS) {
      const [sim, hl] = rows.get(id)!;
      expect(sim.startsWith(symbol("simulation", id)), `simulation ${id}`).toBe(true);
      expect(hl.startsWith(symbol("hyperliquid", id)), `hyperliquid ${id}`).toBe(true);
    }
  });
});
