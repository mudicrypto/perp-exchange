#!/usr/bin/env node
// Milestone 12, WP2: checks the proposed open-source extraction of the venue (scripts/oss-manifest.json)
// without publishing anything and without applying a licence. Writes a Markdown report to stdout.
//
//   node scripts/oss-extraction-check.mjs                  # manifest, import closure, licences, scans
//   node scripts/oss-extraction-check.mjs --stage <dir>    # also copy the files to <dir> with a minimal
//                                                          # scaffold and run typecheck + tests there
//
// Exit code 1 if a blocking check fails (an import outside the manifest, a disallowed package, a
// secret-pattern match, a non-permissive licence, or a failing standalone run).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts/oss-manifest.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const out = [];
const log = (s = "") => out.push(s);
const blocking = [];

// 1. File list: tracked and untracked (not ignored) files under the include paths, minus exclusions.
const all = git("ls-files", "--cached", "--others", "--exclude-standard", "--", ...manifest.include).split("\n").filter(Boolean);
const files = [...new Set(all)].filter((f) => existsSync(join(ROOT, f)) && !manifest.exclude.some((e) => f.startsWith(e.path))).sort();
const excluded = [...new Set(all)].filter((f) => manifest.exclude.some((e) => f.startsWith(e.path)));
const fileSet = new Set(files);

// 2. Import closure.
const importRe = /(?:^|\s)(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;
const packages = new Map();
const unresolved = [];
for (const f of files.filter((p) => /\.(ts|mts|mjs)$/.test(p))) {
  const text = readFileSync(join(ROOT, f), "utf8");
  for (const m of text.matchAll(importRe)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith(".")) {
      const target = normalize(join(dirname(f), spec));
      const candidates = [target, `${target}.ts`, join(target, "index.ts")];
      if (!candidates.some((c) => fileSet.has(c))) unresolved.push(`${f} → ${spec}`);
    } else {
      const name = spec.startsWith("node:") || builtinModules.includes(spec) ? (spec.startsWith("node:") ? spec : `node:${spec}`) : spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!packages.has(name)) packages.set(name, new Set());
      packages.get(name).add(f.endsWith(".test.ts") ? "test" : "source");
    }
  }
}
const allowed = new Set([...manifest.allowedPackages.runtime, ...manifest.allowedPackages.test, ...manifest.allowedPackages.builtins]);
const disallowed = [...packages.keys()].filter((p) => !allowed.has(p));
if (unresolved.length) blocking.push(`${unresolved.length} relative import(s) leave the manifest`);
if (disallowed.length) blocking.push(`disallowed packages: ${disallowed.join(", ")}`);
const runtimeFromTests = [...packages].filter(([p, kinds]) => kinds.has("source") && manifest.allowedPackages.test.includes(p)).map(([p]) => p);
if (runtimeFromTests.length) blocking.push(`test-only packages used by non-test source: ${runtimeFromTests.join(", ")}`);

// 3. Licences of the used packages and their transitive dependencies (from the installed node_modules).
const permissive = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"]);
const licences = new Map();
// Node resolution: look in the requiring package's own node_modules first, then upwards to the root.
const locate = (name, fromDir) => {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dir === ROOT || dir === dirname(dir)) return null;
  }
};
const visit = (name, via, fromDir = ROOT) => {
  if (name.startsWith("node:")) return;
  const pj = locate(name, fromDir);
  const key = pj ? relative(ROOT, dirname(pj)) : name;
  if (licences.has(key)) return;
  if (!pj) {
    licences.set(key, { name, version: "?", license: "NOT INSTALLED", via });
    return;
  }
  const p = JSON.parse(readFileSync(pj, "utf8"));
  licences.set(key, { name, version: p.version, license: typeof p.license === "string" ? p.license : JSON.stringify(p.license ?? p.licenses ?? "UNKNOWN"), via });
  for (const dep of Object.keys(p.dependencies ?? {})) visit(dep, name, dirname(pj));
};
for (const p of packages.keys()) visit(p, "direct");
const nonPermissive = [...licences].filter(([, v]) => !permissive.has(v.license));
if (nonPermissive.length) blocking.push(`non-permissive or unknown licences: ${nonPermissive.map(([, v]) => `${v.name} (${v.license})`).join(", ")}`);

// 4. Secret patterns: manifest files in the working tree and every historical version of those paths.
const SECRET_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Stellar secret seed", /\bS[A-Z2-7]{55}\b/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["assigned secret", /(?:secret|password|passwd|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];
const treeHits = [];
for (const f of files) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((line, i) => SECRET_PATTERNS.forEach(([label, re]) => re.test(line) && treeHits.push(`${f}:${i + 1} ${label}`)));
}
const history = git("log", "-p", "--all", "--format=commit %H", "--", ...manifest.include);
const historyHits = [];
let commit = "";
for (const line of history.split("\n")) {
  if (line.startsWith("commit ")) commit = line.slice(7, 19);
  else if (line.startsWith("+") && !line.startsWith("+++")) SECRET_PATTERNS.forEach(([label, re]) => re.test(line) && historyHits.push(`${commit} ${label}`));
}
if (treeHits.length || historyHits.length) blocking.push(`secret-pattern matches: ${treeHits.length} in the tree, ${historyHits.length} in history`);

// 5. Review terms (not blocking): names, internal paths, personal addresses, open notes.
const termHits = [];
for (const f of files) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  lines.forEach((line, i) => manifest.reviewTerms.forEach((t) => line.toLowerCase().includes(t.toLowerCase()) && termHits.push({ term: t, at: `${f}:${i + 1}` })));
}

// 6. Authorship of the manifest paths (input for the IP and ownership review).
const authors = new Map();
for (const line of git("log", "--all", "--format=%an <%ae>%x09%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)", "--", ...manifest.include).split("\n").filter(Boolean)) {
  const [author, co] = line.split("\t");
  authors.set(`author: ${author}`, (authors.get(`author: ${author}`) ?? 0) + 1);
  for (const c of (co ?? "").split(",").map((s) => s.trim()).filter(Boolean)) authors.set(`co-author trailer: ${c}`, (authors.get(`co-author trailer: ${c}`) ?? 0) + 1);
}
const commitsTouching = git("log", "--all", "--format=%h", "--", ...manifest.include).split("\n").filter(Boolean).length;

// 7. Optional standalone staging run.
let staging = null;
const stageAt = process.argv.indexOf("--stage");
if (stageAt > 0) {
  const dir = resolve(process.argv[stageAt + 1]);
  if (dir.startsWith(ROOT)) throw new Error("stage outside the repository");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f));
  }
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "venue-core-staging", private: true, type: "module", license: "UNLICENSED", description: "Staging copy for the extraction check only; not for publication.", scripts: { test: "vitest run", typecheck: "tsc --noEmit", showcase: "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/venue/cli/showcase.ts" } }, null, 2)}\n`);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2023"], module: "esnext", moduleResolution: "bundler", strict: true, noEmit: true, allowImportingTsExtensions: true, isolatedModules: true, skipLibCheck: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true, types: ["node"] }, include: ["src/**/*.ts"] }, null, 2)}\n`);
  writeFileSync(join(dir, "vitest.config.mts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], restoreMocks: true } });\n`);
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const run = (cmd, args) => {
    try {
      return { ok: true, output: execFileSync(cmd, args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26, env: { ...process.env, NO_COLOR: "1" } }) };
    } catch (error) {
      return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  };
  const typecheck = run("npx", ["tsc", "--noEmit", "-p", "."]);
  const tests = run("npx", ["vitest", "run"]);
  const showcase = run("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "src/venue/cli/showcase.ts"]);
  const summary = (tests.output.match(/Tests\s+[^\n]+/) ?? ["(no summary)"])[0].trim();
  staging = { dir, typecheck: typecheck.ok, tests: tests.ok, summary, showcaseSha256: showcase.ok ? execFileSync("sha256sum", { input: showcase.output, encoding: "utf8" }).split(" ")[0] : "FAILED", errors: [typecheck, tests].filter((r) => !r.ok).map((r) => r.output.split("\n").slice(-25).join("\n")) };
  if (!typecheck.ok || !tests.ok || !showcase.ok) blocking.push("standalone staging run failed");
}

// Report.
log("# Open-source extraction check (Milestone 12, WP2)");
log();
log(`Status: ${manifest.status}`);
log(`Proposed licence: ${manifest.proposedLicense}. **No LICENSE file is created by this check.**`);
log(`Repository HEAD: ${git("rev-parse", "HEAD").trim()} (working tree ${git("status", "--porcelain").trim() ? "has uncommitted changes" : "clean"})`);
log();
log(`## Result: ${blocking.length ? "BLOCKED" : "no blocking findings"}`);
for (const b of blocking) log(`- BLOCKING: ${b}`);
log();
log(`## 1. Files (${files.length}; excluded ${excluded.length})`);
log();
for (const f of files) log(`- \`${f}\``);
log();
log("Excluded:");
for (const e of manifest.exclude) log(`- \`${e.path}\` (${excluded.filter((f) => f.startsWith(e.path)).length} files): ${e.reason}`);
log();
log("## 2. Import closure");
log();
log(`Relative imports leaving the manifest: ${unresolved.length ? unresolved.join("; ") : "none"}`);
log();
log("| Package | Used by |");
log("|---|---|");
for (const [p, kinds] of [...packages].sort()) log(`| \`${p}\` | ${[...kinds].sort().join(", ")} |`);
log();
log("## 3. Licences (installed versions, including transitive dependencies)");
log();
log("| Package | Version | Licence | Via |");
log("|---|---|---|---|");
for (const [, v] of [...licences].sort(([a], [b]) => (a < b ? -1 : 1))) log(`| \`${v.name}\` | ${v.version} | ${v.license} | ${v.via} |`);
log();
log("## 4. Secret-pattern scan");
log();
log(`Patterns: ${SECRET_PATTERNS.map(([l]) => l).join(", ")}.`);
log(`- Working tree (${files.length} files): ${treeHits.length ? treeHits.join("; ") : "no matches"}`);
log(`- History of the included paths (${commitsTouching} commits, all branches, added lines only): ${historyHits.length ? historyHits.join("; ") : "no matches"}`);
log("Pattern scanning is not proof of absence; a fresh-history extraction is still required.");
log();
log("## 5. Review terms (not blocking; each needs a decision before release)");
log();
const byTerm = new Map();
for (const h of termHits) byTerm.set(h.term, [...(byTerm.get(h.term) ?? []), h.at]);
for (const t of manifest.reviewTerms) log(`- \`${t}\`: ${byTerm.get(t)?.length ?? 0}${byTerm.get(t)?.length ? ` — ${byTerm.get(t).slice(0, 12).join(", ")}${byTerm.get(t).length > 12 ? ", …" : ""}` : ""}`);
log();
log("## 6. Authorship of the included paths (input for the IP and ownership review)");
log();
for (const [k, n] of [...authors].sort()) log(`- ${k}: ${n} commit(s)`);
log();
if (staging) {
  log("## 7. Standalone staging run");
  log();
  log(`Copied ${files.length} files plus a minimal scaffold (package.json marked private and UNLICENSED, tsconfig, vitest config) to a scratch directory outside the repository; node_modules linked from this repository.`);
  log(`- typecheck: ${staging.typecheck ? "pass" : "FAIL"}`);
  log(`- tests: ${staging.tests ? "pass" : "FAIL"} (${staging.summary})`);
  log(`- showcase page sha256 from the staged copy: \`${staging.showcaseSha256}\``);
  for (const e of staging.errors) log(`\n\`\`\`\n${e}\n\`\`\``);
}
process.stdout.write(`${out.join("\n")}\n`);
process.exitCode = blocking.length ? 1 : 0;
