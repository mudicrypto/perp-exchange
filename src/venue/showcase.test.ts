import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_FIXTURE_ID_KEY } from "./id-key";
import { buildShowcase, parseShowcase, renderShowcaseHtml, verifyShowcase, type ShowcaseBundle } from "./showcase";

/**
 * Milestone 12 WP1: the reproducible public demonstration (docs/venue/SHOWCASE.md). The bundle must be
 * identical on every build, verify independently of how it was produced, expose any tampering, and
 * render as a self-contained offline page that carries no secrets.
 */

const bundle = buildShowcase();
const clone = (): ShowcaseBundle => JSON.parse(JSON.stringify(bundle)) as ShowcaseBundle;
const scenario = (b: ShowcaseBundle, id: string) => b.scenarios.find((s) => s.id === id)! as { -readonly [K in keyof ShowcaseBundle["scenarios"][number]]: ShowcaseBundle["scenarios"][number][K] };

describe("showcase bundle", () => {
  it("D-1 two builds produce byte-identical bundles and viewer pages", () => {
    const again = buildShowcase();
    expect(again.bundleHash).toBe(bundle.bundleHash);
    expect(JSON.stringify(again)).toBe(JSON.stringify(bundle));
    expect(renderShowcaseHtml(again)).toBe(renderShowcaseHtml(bundle));
  });

  it("D-1 every scenario check passes, and the bundle verifies by replay and by regeneration", () => {
    expect(bundle.scenarios.map((s) => s.id)).toEqual(["hidden-orders", "priority-stp", "abuse-controls", "crash-recovery", "determinism", "unknown-outcome"]);
    for (const s of bundle.scenarios) for (const c of s.checks) expect(c.passed, `${s.id} ${c.rule}: ${c.description}`).toBe(true);
    const result = verifyShowcase(bundle, { regenerate: true });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("D-2 tampering with any recorded part is detected", () => {
    const cases: [string, (b: ShowcaseBundle) => void, RegExp][] = [
      ["journal entry", (b) => (scenario(b, "hidden-orders").journal = scenario(b, "hidden-orders").journal.replace('"qtyLots":2000', '"qtyLots":2001')), /hidden-orders: journal does not match its recorded sha256/],
      ["journal and its hash together", (b) => {
        const s = scenario(b, "hidden-orders");
        const lines = s.journal.trimEnd().split("\n");
        s.journal = `${lines.slice(0, -1).join("\n")}\n`;
        s.journalSha256 = JSON.parse(JSON.stringify(s.journalSha256));
      }, /hidden-orders: journal does not match/],
      ["recorded state hash", (b) => (scenario(b, "determinism").final = { ...scenario(b, "determinism").final, stateHash: "0".repeat(64) }), /determinism: replayed stateHash/],
      ["public feed", (b) => (scenario(b, "hidden-orders").feeds = { ...scenario(b, "hidden-orders").feeds, public: scenario(b, "hidden-orders").feeds.public.slice(1) }), /hidden-orders: recorded public feed differs/],
      ["private feed", (b) => {
        const s = scenario(b, "priority-stp");
        s.feeds = { ...s.feeds, private: { ...s.feeds.private, "syn-taker-c": [] } };
      }, /priority-stp: recorded private feed of syn-taker-c differs/],
      ["failed check marked passed=false", (b) => (scenario(b, "abuse-controls").checks = scenario(b, "abuse-controls").checks.map((c, i) => (i === 0 ? { ...c, passed: false } : c))), /abuse-controls: check H-7 did not pass/],
      ["refusal sample replaced by a clean journal", (b) => (scenario(b, "crash-recovery").refusals = [{ ...scenario(b, "crash-recovery").refusals[0]!, journal: scenario(b, "crash-recovery").journal }]), /crash-recovery: refusal sample/],
      ["narrative text (caught by the bundle hash)", (b) => (scenario(b, "unknown-outcome").summary = "edited"), /bundle hash does not match/],
    ];
    for (const [name, tamper, finding] of cases) {
      const b = clone();
      tamper(b);
      const result = verifyShowcase(b);
      expect(result.ok, name).toBe(false);
      expect(result.findings.join("\n"), name).toMatch(finding);
    }
  });

  it("D-1 a bundle with a recomputed bundle hash still fails regeneration if any content differs", () => {
    const b = clone();
    scenario(b, "unknown-outcome").summary = "edited";
    const forged = { ...b, bundleHash: buildShowcase().bundleHash };
    expect(verifyShowcase(forged, { regenerate: true }).ok).toBe(false);
  });
});

describe("showcase viewer page", () => {
  const html = renderShowcaseHtml(bundle);

  it("A-2 the page is self-contained and offline: a CSP forbids every request, and nothing external is referenced", () => {
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
    expect(html).not.toMatch(/<link\b|\bsrc=|@import|url\(|https?:\/\//i);
    expect(parseShowcase(html)).toEqual(bundle);
  });

  it("A-2 embedded data cannot break out of its script element, and is rendered through textContent only", () => {
    const b = clone();
    scenario(b, "hidden-orders").summary = '</script><script>alert("x")</script> ';
    const page = renderShowcaseHtml(b);
    expect(page.match(/<script\b/g)).toHaveLength(2);
    expect(parseShowcase(page)).toEqual(b);
    expect(page).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("A-5 the bundle carries no secrets: no key material, no session tokens, synthetic accounts only", () => {
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(TEST_FIXTURE_ID_KEY);
    // Gateway session tokens are 43-character base64url; the only long identifiers allowed are 64-hex hashes.
    const long = text.match(/[A-Za-z0-9_-]{30,}/g) ?? [];
    expect(long.filter((t) => !/^[0-9a-f]{64}$/.test(t))).toEqual([]);
    for (const s of bundle.scenarios) for (const account of Object.keys(s.feeds.private)) expect(account).toMatch(/^syn-/);
    expect(bundle.notice).toMatch(/test-fixture key/);
  });

  it("showcase scenarios cite only rules declared in MATCHING-RULES.md", () => {
    const spec = readFileSync(join(__dirname, "..", "..", "docs", "venue", "MATCHING-RULES.md"), "utf8");
    const declared = new Set([...spec.matchAll(/\*\*([IMFPSHRDA]-\d+)\*\*/g)].map((m) => m[1]!));
    const cited = bundle.scenarios.flatMap((s) => [...s.rules, ...s.checks.map((c) => c.rule)]);
    expect(cited.filter((r) => !declared.has(r))).toEqual([]);
  });
});
