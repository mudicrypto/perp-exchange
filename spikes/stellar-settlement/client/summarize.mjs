// Prints the measurement tables of docs/venue/STELLAR-SPIKE-RESULTS.md from a spike results file.
// Usage: node summarize.mjs [out/latest.json]                  # measurement summary
//        node summarize.mjs --transactions [out/latest.json]   # every transaction the run sent
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const listTransactions = args[0] === "--transactions";
const file = listTransactions ? args[1] : args[0];
const r = JSON.parse(readFileSync(file ?? new URL("./out/latest.json", import.meta.url), "utf8"));

if (listTransactions) {
  console.log(`# Transactions, run ${r.startedAt}\n`);
  console.log("Every transaction the run sent, in order. SUCCESS and FAILED were included in a ledger (a FAILED transaction is charged a fee); ERROR and RPC_REJECTED were refused before inclusion. Any hash can be looked up with the RPC method `getTransaction` while testnet retains it, or on a testnet explorer.\n");
  console.log("| # | label | hash | status | ledger | order in ledger | fee (stroops) | contract error |\n|---|---|---|---|---|---|---|---|");
  r.txs.forEach((t, i) => {
    const code = t.errorResult?.result?.code ?? t.errorResult?.code;
    const status = `${t.status ?? t.sendStatus}${code !== undefined ? ` (${code})` : ""}${t.rpcError ? ` (${t.rpcError})` : ""}`;
    console.log(`| ${i + 1} | ${t.label} | \`${t.hash}\` | ${status} | ${t.ledger ?? "—"} | ${t.applicationOrder ?? "—"} | ${t.feeCharged ?? "—"} | ${t.contractError ?? "—"} |`);
  });
  process.exit(0);
}
const XLM = 10_000_000;
const n = (v) => (v === undefined || v === null ? "—" : Number(v).toLocaleString("en-US"));
const xlm = (v) => (v === undefined ? "—" : (Number(v) / XLM).toFixed(5));
const short = (h) => (h ? `\`${h.slice(0, 16)}…\`` : "—");
const row = (...c) => console.log(`| ${c.join(" | ")} |`);
const head = (...c) => {
  row(...c);
  row(...c.map(() => "---"));
};
const stats = (xs) => {
  const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b);
  return s.length ? { min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1), n: s.length } : {};
};

console.log(`Run ${r.startedAt} → ${r.finishedAt ?? "(incomplete)"}; RPC ${r.rpcUrl}`);
console.log(`Protocol ${r.network.network.protocolVersion}; RPC ${r.network.version.version}; core ${r.network.version.captiveCoreVersion ?? "?"}`);
console.log(`wasm ${r.wasm.bytes} bytes, sha256 ${r.wasm.sha256}`);
console.log(`contracts A=${r.contracts.A} B=${r.contracts.B} C=${r.contracts.C}`);
console.log(`operator ${r.accounts.operator}; channels ${r.accounts.channels.join(", ")}`);
console.log(`order hash local=contract: ${r.orderHashCheck.local === r.orderHashCheck.contract}`);
console.log(`ledger close (before) ${JSON.stringify(r.closeTimesBefore)}; (after) ${JSON.stringify(r.closeTimesAfter)}`);
console.log(`fee stats soroban inclusion ${JSON.stringify(r.network.feeStats.sorobanInclusionFee)}`);
console.log(`state archival ${JSON.stringify(r.network.config.stateArchivalSettings ?? r.network.config.stateArchival)}`);
console.log(`limits ${JSON.stringify(r.network.limits)}\n`);

const sv = r.signatureVerification;
console.log("## Signature verification (simulation)");
head("n", "instructions");
for (const s of sv.sweep) row(s.n, n(s.instructions));
console.log(`per verify ${n(Math.round(sv.instructionsPerVerify))}; computed max ${sv.maxVerifiesPerTx}; at max ok=${sv.atComputedMax.ok} (${n(sv.atComputedMax.instructions)}); +5% → ${sv.fivePercentOver.error}\n`);

console.log("## Per-fill settlement (submitted)");
head("variant", "tx", "ledger", "fee (stroops)", "rent", "non-refundable", "instructions", "RO/RW entries", "write bytes", "envelope", "confirm ms");
for (const [k, list] of Object.entries(r.perFill))
  for (const t of list) row(k, short(t.hash), t.ledger, n(t.feeCharged), n(t.fees?.rentFeeCharged), n(t.fees?.totalNonRefundableResourceFeeCharged), n(t.cost.instructions), `${t.cost.readOnlyEntries}/${t.cost.readWriteEntries}`, n(t.cost.writeBytes), n(t.cost.envelopeBytes), n(t.confirmMs));
console.log();

console.log("## Batch sweep (simulation, assembled envelope)");
head("case", "max k", "first failing k", "limit hit", "instr. at max", "RW at max", "envelope at max", "min resource fee at max");
for (const [k, v] of Object.entries(r.batchSweep)) {
  const at = v.rows.find((x) => x.k === v.maxK)?.cost ?? {};
  row(k, v.maxK, v.firstFailingK ?? "—", (v.limitingFactor ?? []).join(", ") || "—", n(at.instructions), n(at.readWriteEntries), n(at.envelopeBytes), n(at.minResourceFee));
}
console.log();

console.log("## Batches (submitted)");
head("case", "k", "tx", "status", "ledger", "fee", "fee/fill", "rent", "instructions", "RW", "envelope", "confirm ms");
for (const b of r.batches) row(`${b.contract}/${b.shape}`, b.k, short(b.hash), b.status ?? b.error, b.ledger ?? "—", n(b.feeCharged), n(b.feePerFill && Math.round(b.feePerFill)), n(b.fees?.rentFeeCharged), n(b.cost?.instructions), n(b.cost?.readWriteEntries), n(b.cost?.envelopeBytes), n(b.confirmMs));
console.log();

console.log("## Anchoring (submitted)");
head("tx", "ledger", "fee", "rent", "instructions");
for (const a of r.anchoring) row(short(a.hash), a.ledger, n(a.feeCharged), n(a.fees?.rentFeeCharged), n(a.cost.instructions));
console.log();

console.log("## TTL");
console.log(JSON.stringify(r.ttl, (k, v) => (k === "cost" ? undefined : v), 1));
console.log();

console.log("## Cursor and duplicates");
console.log(JSON.stringify(r.cursor, (k, v) => (k === "cost" ? undefined : v), 1));
console.log();

console.log("## Concurrency (submitted)");
const c = r.concurrency;
console.log(`same source: ${JSON.stringify(c.sameSource)}`);
for (const [name, rounds] of [["cursor", c.cursorConcurrent], ["idempotent", c.idemConcurrent]]) {
  let ok = 0;
  let all = 0;
  for (const [i, round] of rounds.entries()) {
    const line = round.map((t) => `${t.intendedCursor ?? t.fillId}:${t.status}${t.contractError ? `#${t.contractError}` : ""}@${t.ledger}/${t.applicationOrder ?? "?"}`).join(" ");
    console.log(`${name} round ${i}: ${line}`);
    ok += round.filter((t) => t.status === "SUCCESS").length;
    all += round.length;
  }
  console.log(`${name}: ${ok}/${all} succeeded`);
}
console.log(`idempotent concurrent duplicate: ${JSON.stringify(c.idemConcurrentDuplicate.map((t) => [t.status, t.contractError, t.ledger, t.feeCharged]))}`);
console.log(`sequential three via channels: ${c.sequentialThree.totalMs} ms, ledgers ${c.sequentialThree.txs.map((t) => t.ledger).join(", ")}`);
const failed = r.txs.filter((t) => t.status === "FAILED");
console.log(`failed on chain: ${failed.length}; fee charged ${JSON.stringify(stats(failed.map((t) => t.feeCharged)))}`);
console.log();

console.log("## Latency (all submitted SUCCESS transactions)");
const ok = r.txs.filter((t) => t.status === "SUCCESS");
console.log(`confirm ms ${JSON.stringify(stats(ok.map((t) => t.confirmMs)))}; ledgers waited ${JSON.stringify(stats(ok.map((t) => t.ledgersWaited)))}; prepare ms ${JSON.stringify(stats(ok.map((t) => t.prepareMs)))}`);
console.log();

console.log("## Invalidation and replay (simulation, after the submitted epoch bump)");
const inv = r.invalidationAndReplay;
console.log(`before bump ok=${inv.beforeBump.ok}; bump ${inv.bump.hash} ledger ${inv.bump.ledger} fee ${inv.bump.feeCharged}; after bump ${inv.afterBump.error}; signed for A on C: ${inv.signedForAOnC.error}; signed for C on C ok=${inv.signedForConC.ok}`);
console.log(`\nall transactions: ${r.txs.length}; total fee ${xlm(r.txs.reduce((a, t) => a + (t.feeCharged ?? 0), 0))} XLM (testnet)`);
