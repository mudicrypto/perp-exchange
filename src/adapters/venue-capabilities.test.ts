import { describe, expect, it } from "vitest";
import { describeExecutionVisibility } from "@/core/private-execution";
import { hyperliquidCapabilities } from "./hyperliquid/capabilities";
import { simulationCapabilities } from "./simulation/capabilities";

describe("venue execution capabilities", () => {
  it("presents Hyperliquid orders as public, even when a private mode is requested", () => {
    const plain = describeExecutionVisibility(hyperliquidCapabilities, null);
    expect(plain.level).toBe("public");
    expect(plain.headline).toMatch(/Public order on Hyperliquid/);
    expect(plain.details.join(" ")).toMatch(/public order book/);
    expect(plain.availablePrivateModes).toEqual([]);

    const requested = describeExecutionVisibility(hyperliquidCapabilities, "hidden-limit");
    expect(requested.level).toBe("public");
    expect(requested.details[0]).toMatch(/does not support "hidden-limit"/);
  });

  it("never reports the simulator as private", () => {
    expect(describeExecutionVisibility(simulationCapabilities, "iceberg").level).toBe("public");
  });
});
