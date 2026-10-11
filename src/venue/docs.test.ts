import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "./state-machine";

/**
 * Keeps the Milestone 8 documents and the prototype honest:
 * - every rule in MATCHING-RULES.md has a test that names it, and tests cite only real rules;
 * - the state-machine table in the docs equals the code;
 * - the prototype stays disconnected (no network/file-system use; nothing imports it).
 */

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function files(dir: string, filter: (path: string) => boolean): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? files(path, filter) : filter(path) ? [path] : [];
  });
}

const RULE_ID = /\b([IMFPSHRDA]-\d+)\b/g;

describe("documentation traceability", () => {
  const spec = read("docs/venue/MATCHING-RULES.md");
  const declared = new Set([...spec.matchAll(/\*\*([IMFPSHRDA]-\d+)\*\*/g)].map((m) => m[1]!));
  const tests = files("src/venue", (p) => p.endsWith(".test.ts") && !p.endsWith("docs.test.ts")).map(read);
  const testNames = tests.flatMap((t) => [...t.matchAll(/\bit(?:\.each\([\s\S]*?\))?\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!));

  it("declares a sensible set of rules", () => {
    expect(declared.size).toBeGreaterThanOrEqual(40);
  });

  it("every rule in MATCHING-RULES.md is named by at least one test", () => {
    const untested = [...declared].filter((id) => !testNames.some((name) => new RegExp(`(^|[ /])${id}([ /]|$)`).test(name)));
    expect(untested).toEqual([]);
  });

  it("tests cite only rules that exist", () => {
    const cited = new Set(testNames.flatMap((n) => [...n.matchAll(RULE_ID)].map((m) => m[1]!)));
    expect([...cited].filter((id) => !declared.has(id))).toEqual([]);
  });

  it("the documented order state machine equals the implementation", () => {
    const doc = read("docs/venue/ORDER-STATE-MACHINE.md");
    const table = doc.slice(doc.indexOf("## Transition table"), doc.indexOf("## States"));
    const rows = [...table.matchAll(/^\| ([a-z-]+) \| ([a-z-]+) \| ([a-z-]+) \|$/gm)].map((m) => ({ from: m[1], cause: m[2], to: m[3] }));
    expect(rows).toEqual(ORDER_TRANSITIONS.map((t) => ({ ...t })));
  });

  it("the venue documents never claim cryptographic confidentiality for hidden orders", () => {
    for (const path of files("docs/venue", (p) => p.endsWith(".md"))) {
      const text = read(path).toLowerCase();
      for (const claim of ["hidden orders are encrypted", "cryptographically hidden", "cryptographically confidential hidden", "invisible to the operator", "invisible to nova"]) {
        expect(text, `${path}: "${claim}"`).not.toContain(claim);
      }
    }
    expect(read("docs/venue/ARCHITECTURE.md")).toContain("They are **not** cryptographically\n> confidential");
  });
});

describe("prototype isolation", () => {
  it("venue source uses no network, subprocess or file-system APIs", () => {
    const forbidden = /\bfetch\(|\bWebSocket\b|XMLHttpRequest|EventSource|from "(node:)?(http|https|http2|net|tls|dgram|dns|child_process|fs|fs\/promises)"/;
    const offenders = files("src/venue", (p) => p.endsWith(".ts") && !p.endsWith(".test.ts")).filter((p) => forbidden.test(read(p)));
    expect(offenders).toEqual([]);
  });

  it("nothing outside src/venue imports the prototype", () => {
    const importsVenue = /from\s+["'](@\/venue|(\.\.\/)+venue)(\/|["'])/;
    const offenders = files("src", (p) => /\.(ts|tsx)$/.test(p) && !p.startsWith(join("src", "venue"))).filter((p) => importsVenue.test(read(p)));
    expect(offenders.map((p) => relative(ROOT, join(ROOT, p)))).toEqual([]);
  });
});
