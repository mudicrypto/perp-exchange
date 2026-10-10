import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_LABEL, EXECUTION_MODES, PARTY_LABEL, PRIVACY_DATA, PRIVACY_PARTIES, describeExecution, type Exposure, type PrivacyProfile } from "@/core/privacy";
import type { VenueCapabilities } from "@/core/trading";
import { hyperliquidCapabilities } from "./hyperliquid/capabilities";
import { simulationCapabilities } from "./simulation/capabilities";

const SYMBOL: Record<Exposure, string> = { visible: "👁 sees", partial: "◐ partly", "not-visible": "— cannot see", "not-applicable": "n/a" };

/** Markdown matrix for one venue × mode (exposure only; notes live in the code and UI). */
export function privacyTable(profile: PrivacyProfile): string {
  const header = `| Party | ${PRIVACY_DATA.map((d) => DATA_LABEL[d]).join(" | ")} |`;
  const rule = `|---|${PRIVACY_DATA.map(() => "---").join("|")}|`;
  const rows = PRIVACY_PARTIES.map((p) => `| ${PARTY_LABEL[p]} | ${PRIVACY_DATA.map((d) => SYMBOL[profile[p][d].exposure]).join(" | ")} |`);
  return [header, rule, ...rows].join("\n");
}

function section(venue: VenueCapabilities): string {
  return EXECUTION_MODES.map((mode) => {
    const d = describeExecution(venue.capabilities, venue.privacy, mode);
    const title = `#### ${venue.venueName} · ${mode}`;
    return d.profile ? `${title}\n\n${privacyTable(d.profile)}` : `${title}\n\nUnavailable: ${d.details[0]}`;
  }).join("\n\n");
}

/** Keeps docs/PRIVACY.md's matrices identical to the venues' declared privacy profiles. */
describe("docs/PRIVACY.md privacy matrices", () => {
  const doc = readFileSync(join(process.cwd(), "docs/PRIVACY.md"), "utf8");
  for (const venue of [simulationCapabilities, hyperliquidCapabilities]) {
    it(`matches ${venue.venueName}'s declared profiles`, () => {
      const block = doc.split(`<!-- privacy-matrix:${venue.venueId}:start -->`)[1]?.split(`<!-- privacy-matrix:${venue.venueId}:end -->`)[0]?.trim();
      if (process.env.PRINT_PRIVACY_DOCS) console.log(`\n<!-- privacy-matrix:${venue.venueId}:start -->\n${section(venue)}\n<!-- privacy-matrix:${venue.venueId}:end -->\n`);
      expect(block).toBe(section(venue));
    });
  }
});
