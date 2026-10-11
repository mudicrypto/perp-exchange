#!/usr/bin/env node
// Fails if server-only names or secret material appear in the browser bundle
// (.next/static). Run after `next build`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = ".next/static";
const FORBIDDEN = [
  "NOVA_RFQ_COUNTERPARTY_TOKENS",
  "ANTHROPIC_API_KEY",
  "NOVA_CLIENT_IP_HEADER",
  "rfqCounterpartyTokens",
  "ANALYST_SYSTEM_PROMPT",
  "e2e-desk-", // E2E counterparty tokens
  "sk-ant-",
  "x-api-key",
  "server-only",
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(js|mjs|css|json|html|map)$/.test(name)) yield p;
  }
}

let scanned = 0;
const hits = [];
try {
  for (const f of files(ROOT)) {
    scanned += 1;
    const text = readFileSync(f, "utf8");
    for (const needle of FORBIDDEN) if (text.includes(needle)) hits.push(`${f}: ${needle}`);
  }
} catch (error) {
  console.error(`Cannot scan ${ROOT} (run "next build" first): ${error.message}`);
  process.exit(2);
}
if (hits.length) {
  console.error(`Server-only material found in the client bundle:\n${hits.join("\n")}`);
  process.exit(1);
}
console.log(`Client bundle clean: ${scanned} files scanned, ${FORBIDDEN.length} forbidden patterns.`);
