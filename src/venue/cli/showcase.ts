/**
 * `npm run --silent venue:showcase > showcase.html` — writes the reproducible demonstration (six seeded
 * scenarios, embedded in one offline HTML viewer) to standard output. `--json` writes the bundle only.
 * A summary goes to standard error. No network, no file system, no keys (docs/venue/SHOWCASE.md).
 */
import { buildShowcase, renderShowcaseHtml } from "../showcase.ts";

const bundle = buildShowcase();
process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(bundle, null, 2)}\n` : renderShowcaseHtml(bundle));
const failed = bundle.scenarios.flatMap((s) => s.checks.filter((c) => !c.passed).map((c) => `${s.id} ${c.rule}: ${c.description}`));
console.error(`venue showcase: ${bundle.scenarios.length} scenarios, ${bundle.scenarios.reduce((n, s) => n + s.checks.length, 0)} checks, ${failed.length} failed`);
for (const f of failed) console.error(`  FAILED ${f}`);
console.error(`bundle hash ${bundle.bundleHash}`);
process.exitCode = failed.length === 0 ? 0 : 1;
