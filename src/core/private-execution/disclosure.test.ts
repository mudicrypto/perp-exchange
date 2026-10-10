import { describe, expect, it } from "vitest";
import type { VenueExecutionCapabilities } from "../ports";
import { describeExecutionVisibility } from "./disclosure";

const darkVenue: VenueExecutionCapabilities = {
  venueId: "nova",
  venueName: "Nova",
  restingOrderVisibility: "public-book",
  fillVisibility: "private",
  publicAccountAttribution: false,
  supportedPrivateModes: ["hidden-limit"],
  notes: [],
};

describe("describeExecutionVisibility", () => {
  it("only reports private when the venue supports the requested mode", () => {
    expect(describeExecutionVisibility(darkVenue, "hidden-limit").level).toBe("private");
    expect(describeExecutionVisibility(darkVenue, null).level).toBe("public");
    expect(describeExecutionVisibility(darkVenue, "batch-auction").level).toBe("public");
  });

  it("reports partial privacy when fills remain public", () => {
    const venue = { ...darkVenue, fillVisibility: "public-tape" as const };
    const disclosure = describeExecutionVisibility(venue, "hidden-limit");
    expect(disclosure.level).toBe("partially-private");
    expect(disclosure.details.join(" ")).toMatch(/public trade tape/);
  });
});
