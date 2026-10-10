import { describe, expect, it } from "vitest";
import { CAPABILITY_IDS, defineCapabilities, notImplemented, supported, venueUnsupported, type CapabilityId, type CapabilityStatus } from "../domain";
import { CapabilityRegistry } from "../trading";
import { describeExecution, validateVenuePrivacy } from "./index";
import { allData, cell, type PrivacyProfile, type VenuePrivacy } from "./model";

function caps(overrides: Partial<Record<CapabilityId, CapabilityStatus>> = {}) {
  const all = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, supported()])) as Record<CapabilityId, CapabilityStatus>;
  return defineCapabilities({
    ...all,
    "order.hidden": venueUnsupported("no"),
    "order.iceberg": venueUnsupported("no"),
    "execution.rfq": venueUnsupported("no"),
    "execution.encrypted": notImplemented("Planned"),
    ...overrides,
  });
}

const base = (): Record<string, Record<string, ReturnType<typeof cell>>> => ({
  "public-observers": allData("visible"),
  "matching-engine": allData("visible"),
  "venue-operator": allData("visible"),
  "rfq-counterparties": allData("not-applicable"),
  "nova-backend": allData("not-visible"),
  "other-nova-users": allData("visible"),
});
const profile = (patch: (p: ReturnType<typeof base>) => void = () => {}): PrivacyProfile => {
  const p = base();
  patch(p);
  return p as unknown as PrivacyProfile;
};
const hiddenProfile = profile((p) => {
  p["public-observers"]!["order-details"] = cell("not-visible");
  p["other-nova-users"]!["order-details"] = cell("not-visible");
});
const privacy = (profiles: VenuePrivacy["profiles"]): VenuePrivacy => ({ venueId: "v", venueName: "Venue", profiles, notes: [] });

describe("validateVenuePrivacy", () => {
  it("accepts a transparent venue with only a public profile", () => {
    expect(validateVenuePrivacy(caps(), privacy({ "public-limit": profile() }))).toEqual([]);
  });

  it("requires a profile for every offered mode, and none for modes not offered", () => {
    const missing = validateVenuePrivacy(caps({ "order.hidden": supported() }), privacy({ "public-limit": profile() }));
    expect(missing).toEqual([{ mode: "hidden", message: expect.stringMatching(/no privacy profile/) }]);
    const extra = validateVenuePrivacy(caps(), privacy({ "public-limit": profile(), hidden: hiddenProfile }));
    expect(extra).toEqual([{ mode: "hidden", message: expect.stringMatching(/not offered/) }]);
  });

  it("refuses a 'hidden' profile that shows the order to the public (no false labels)", () => {
    const leaky = profile();
    const issues = validateVenuePrivacy(caps({ "order.hidden": supported() }), privacy({ "public-limit": profile(), hidden: leaky }));
    expect(issues.map((i) => i.message)).toContain("A hidden order must not be visible to public observers");
  });

  it("refuses to describe an iceberg as anonymous", () => {
    const anonymous = profile((p) => {
      p["public-observers"]!["order-details"] = cell("not-visible");
    });
    const issues = validateVenuePrivacy(caps({ "order.iceberg": supported() }), privacy({ "public-limit": profile(), iceberg: anonymous }));
    expect(issues.map((i) => i.message)).toContain("An iceberg's displayed slice is public: order details must be 'partial'");
  });

  it("refuses to claim the matching engine cannot see orders", () => {
    const blind = profile((p) => {
      p["matching-engine"]!["order-details"] = cell("not-visible");
    });
    expect(validateVenuePrivacy(caps(), privacy({ "public-limit": blind })).map((i) => i.message)).toContain("The matching engine must see order details");
  });

  it("never allows encrypted execution to be supported or profiled", () => {
    const issues = validateVenuePrivacy(caps({ "execution.encrypted": supported() }), privacy({ "public-limit": profile(), encrypted: hiddenProfile }));
    expect(issues.filter((i) => i.mode === "encrypted")).toHaveLength(2);
  });

  it("reports missing cells", () => {
    const incomplete = profile((p) => {
      delete p["nova-backend"]!["account-identity"];
    });
    expect(validateVenuePrivacy(caps(), privacy({ "public-limit": incomplete }))[0]?.message).toMatch(/Missing cell nova-backend × account-identity/);
  });

  it("the capability registry refuses venues with inconsistent privacy declarations", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register({ venueId: "v", venueName: "Venue", origin: "venue", capabilities: caps({ "order.hidden": supported() }), privacy: privacy({ "public-limit": profile(), hidden: profile() }) }),
    ).toThrow(/inconsistent privacy declarations/);
  });
});

describe("describeExecution", () => {
  it("reports unsupported modes as unavailable, with the capability's reason", () => {
    const d = describeExecution(caps(), privacy({ "public-limit": profile() }), "hidden");
    expect(d).toMatchObject({ executable: false, level: "unavailable", details: ["no"], rows: [], profile: null });
  });

  it("derives the level from what public observers can see", () => {
    const c = caps({ "order.hidden": supported() });
    const p = privacy({ "public-limit": profile(), hidden: hiddenProfile });
    expect(describeExecution(c, p, "public-limit").level).toBe("public");
    expect(describeExecution(c, p, "hidden")).toMatchObject({ level: "pre-trade-private", executable: true });
    expect(describeExecution(c, p, "hidden").rows).toHaveLength(6 * 4);
  });

  it("a mode the venue offers but Nova has not implemented is described but not executable", () => {
    const c = caps({ "order.hidden": notImplemented("later") });
    const d = describeExecution(c, privacy({ "public-limit": profile(), hidden: hiddenProfile }), "hidden");
    expect(d).toMatchObject({ executable: false, level: "pre-trade-private" });
  });
});
