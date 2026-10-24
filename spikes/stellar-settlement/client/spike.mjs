// Milestone 12, WP3 — Stellar testnet feasibility spike (measurement only).
//
// Deploys the measurement contract in ../contract to Stellar TESTNET and measures signature
// verification, fills per transaction, fees, storage TTL, anchoring cost and settlement latency, for
// both per-fill and batched transaction shapes. It also exercises the settlement cursor on chain
// (duplicates, retries, gaps, concurrent submission), cross-contract replay and epoch invalidation.
//
// Safety: refuses to run unless the RPC reports the testnet passphrase. All keys are generated in
// memory for this run and never written anywhere; only the operator and channel accounts are funded,
// by friendbot (testnet lumens). No tokens, no customer funds, no production deployment.
//
// Usage (from this directory, after `stellar contract build` in ../contract):
//   NODE_USE_ENV_PROXY=1 node spike.mjs            # behind an HTTP proxy
//   node spike.mjs                                 # direct
// Output: out/results-<timestamp>.json and out/latest.json (ignored by git), plus a summary on stdout.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Address, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder, authorizeEntry, hash, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM = process.env.SPIKE_WASM ?? join(HERE, "../contract/target/wasm32v1-none/release/settlement_spike.wasm");
const RPC_URL = process.env.SPIKE_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const NETWORK_ID = hash(Buffer.from(PASSPHRASE));
const DOMAIN = Buffer.from("venue-order/1");
const server = new rpc.Server(RPC_URL);

const results = { startedAt: new Date().toISOString(), rpcUrl: RPC_URL, passphrase: PASSPHRASE, txs: [] };
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v);
const plain = (o) => JSON.parse(JSON.stringify(o, big));

/** Depth-first search for keys matching `re` in a plain object. */
function find(obj, re, out = {}) {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k) && (typeof v !== "object" || v === null)) out[k] = v;
      find(v, re, out);
    }
  }
  return out;
}

const xo = (v) => plain(v?.toXdrObject ? v.toXdrObject() : v);

// ---------------------------------------------------------------------------------------------
// Network facts

async function networkFacts() {
  const [network, version, latest, feeStats] = await Promise.all([server.getNetwork(), server.getVersionInfo(), server.getLatestLedger(), server.getFeeStats()]);
  if (network.passphrase !== PASSPHRASE) throw new Error(`refusing to run: RPC passphrase is "${network.passphrase}", not testnet`);
  const ids = [
    "configSettingContractComputeV0",
    "configSettingContractLedgerCostV0",
    "configSettingContractLedgerCostExtV0",
    "configSettingContractBandwidthV0",
    "configSettingContractEventsV0",
    "configSettingContractDataEntrySizeBytes",
    "configSettingContractDataKeySizeBytes",
    "configSettingStateArchival",
    "configSettingContractExecutionLanes",
    "configSettingContractParallelComputeV0",
    "configSettingScpTiming",
  ];
  const keys = ids.map((k) => xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId[k] })));
  const r = await server.getLedgerEntries(...keys);
  const config = {};
  for (const e of r.entries) {
    const o = xo(e.val).configSetting;
    const name = Object.keys(o).find((k) => k !== "configSettingID");
    config[name] = o[name];
  }
  const limits = find(config, /^(tx|ledger)Max/);
  return { network: plain(network), version: plain(version), latestLedger: latest.sequence, feeStats: plain(feeStats), config, limits };
}

async function closeTimes(count = 200) {
  const latest = (await server.getLatestLedger()).sequence;
  const r = await server.getLedgers({ startLedger: latest - count, pagination: { limit: count } });
  const t = r.ledgers.map((l) => Number(l.ledgerCloseTime));
  const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  return { ledgers: r.ledgers.length, from: r.ledgers[0]?.sequence, to: r.ledgers.at(-1)?.sequence, meanSec: d.reduce((a, b) => a + b, 0) / d.length, p50Sec: q(0.5), p95Sec: q(0.95), maxSec: d.at(-1) };
}

// ---------------------------------------------------------------------------------------------
// Transactions

async function fund(kp) {
  for (let i = 0; i < 4; i++) {
    try {
      await server.requestAirdrop(kp.publicKey(), "https://friendbot.stellar.org");
      return;
    } catch (e) {
      log("friendbot retry", e.message);
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error("friendbot failed");
}

function costOf(sim, tx) {
  const data = xo(sim.transactionData.build());
  const res = data.resources ?? {};
  return {
    instructions: Number(res.instructions),
    diskReadBytes: Number(res.diskReadBytes ?? res.readBytes ?? 0),
    writeBytes: Number(res.writeBytes),
    readOnlyEntries: res.footprint?.readOnly?.length ?? 0,
    readWriteEntries: res.footprint?.readWrite?.length ?? 0,
    minResourceFee: Number(sim.minResourceFee),
    memBytes: sim.cost?.memBytes !== undefined ? Number(sim.cost.memBytes) : undefined,
    events: sim.events?.length ?? 0,
    envelopeBytes: tx ? tx.toEnvelope().toXDR().length : undefined,
  };
}

const errorOf = (s) => {
  const m = /Error\(Contract, #(\d+)\)/.exec(s);
  if (m) return `contract error #${m[1]}`;
  const h = /HostError: (Error\([^)]*\))/.exec(s);
  return h ? `host ${h[1]}` : String(s).split("\n")[0].slice(0, 200);
};

const invoke = (contract, fn, args) => Operation.invokeContractFunction({ contract, function: fn, args });

// Sequence numbers are tracked locally: right after inclusion the RPC can still report the previous
// sequence, which makes the next transaction fail with txBAD_SEQ. The cache advances only when a
// transaction is accepted, and is dropped (re-read from the RPC) after a txBAD_SEQ.
const seqCache = new Map();

async function peekAccount(source) {
  const id = source.publicKey();
  if (!seqCache.has(id)) seqCache.set(id, (await server.getAccount(id)).sequenceNumber());
  return new Account(id, seqCache.get(id));
}

function noteAccepted(tx) {
  const id = tx.source;
  const cur = seqCache.get(id);
  if (cur === undefined || BigInt(tx.sequence) > BigInt(cur)) seqCache.set(id, tx.sequence);
}

async function build(source, op, account) {
  const acc = account ?? (await peekAccount(source));
  return new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE }).addOperation(op).setTimeout(300).build();
}

/** Simulate only. */
async function simulate(source, op) {
  const tx = await build(source, op);
  const t0 = Date.now();
  const sim = await server.simulateTransaction(tx);
  const ms = Date.now() - t0;
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: errorOf(sim.error), simulateMs: ms };
  // The size that counts against txMaxSizeBytes is the assembled envelope (footprint and auth
  // included), not the bare invocation.
  const cost = costOf(sim, rpc.assembleTransaction(tx, sim).build());
  return { ok: true, cost, retval: sim.result?.retval ? scValToNative(sim.result.retval) : undefined, simulateMs: ms };
}

/**
 * Simulates, assembles and signs a transaction. When `authBy` is given (the operator, with a separate
 * channel account as source), the recorded authorisation entries are signed by it and the
 * transaction is re-simulated in enforcing mode.
 */
async function prepare(source, op, { account, authBy, rebuild } = {}) {
  const t0 = Date.now();
  let tx = await build(source, op, account);
  let sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${errorOf(sim.error)}`);
  if (authBy) {
    const until = (await server.getLatestLedger()).sequence + 100;
    const auth = await Promise.all((sim.result?.auth ?? []).map((e) => authorizeEntry(e, authBy, until, PASSPHRASE)));
    tx = await build(source, rebuild(auth));
    sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`enforcing simulation failed: ${errorOf(sim.error)}`);
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(source);
  return { tx: assembled, cost: costOf(sim, assembled), prepareMs: Date.now() - t0 };
}

async function waitFor(hashHex, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await server.getTransaction(hashHex);
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return { r, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) return { r, ms: Date.now() - t0 };
    await sleep(250);
  }
}

/** Sends a prepared transaction and waits for its outcome. */
async function send(label, prepared) {
  // SDK 17 returns a Uint8Array here; its toString ignores "hex" and yields a comma list.
  const hashHex = Buffer.from(prepared.tx.hash()).toString("hex");
  const ledgerAtSend = (await server.getLatestLedger()).sequence;
  const t0 = Date.now();
  let s;
  try {
    s = await server.sendTransaction(prepared.tx);
  } catch (e) {
    // The RPC refused the request itself (for example invalid_xdr); nothing reached the network.
    const rec = { label, hash: hashHex, sendStatus: "RPC_REJECTED", rpcError: String(e.message ?? e).slice(0, 300), ledgerAtSend, prepareMs: prepared.prepareMs, cost: prepared.cost };
    results.txs.push(rec);
    log(label, "RPC_REJECTED", rec.rpcError, `envelope ${prepared.cost.envelopeBytes} bytes`);
    return rec;
  }
  const rec = { label, hash: hashHex, sendStatus: s.status, ledgerAtSend, prepareMs: prepared.prepareMs, cost: prepared.cost };
  if (s.status === "PENDING" || s.status === "DUPLICATE") noteAccepted(prepared.tx);
  if (s.status !== "PENDING") {
    rec.errorResult = s.errorResult ? xo(s.errorResult) : undefined;
    if (rec.errorResult?.result?.code === -5) seqCache.delete(prepared.tx.source);
    log(label, s.status, hashHex.slice(0, 12), JSON.stringify(rec.errorResult?.result ?? {}));
    results.txs.push(rec);
    return rec;
  }
  const { r } = await waitFor(hashHex);
  rec.status = r.status;
  rec.ledger = r.ledger;
  rec.applicationOrder = r.applicationOrder;
  rec.ledgersWaited = r.ledger ? r.ledger - ledgerAtSend : undefined;
  rec.confirmMs = Date.now() - t0;
  if (r.resultXdr) {
    const res = xo(r.resultXdr);
    rec.feeCharged = Number(res.feeCharged);
    rec.resultCode = find(res.result ?? {}, /code|type/i);
  }
  if (r.resultMetaXdr) rec.fees = find(xo(r.resultMetaXdr), /(rentFeeCharged|totalNonRefundableResourceFeeCharged|totalRefundableResourceFeeCharged)$/);
  if (r.status === "FAILED") {
    const diag = (r.diagnosticEventsXdr ?? []).map((e) => JSON.stringify(xo(e))).join(" ");
    const code = /"host_fn_failed"\},\{"type":2,"error":\{"type":0,"contractCode":(\d+)/.exec(diag) ?? /"contractCode":(\d+)/.exec(diag);
    rec.contractError = code ? Number(code[1]) : undefined;
    if (!code) rec.diagnostic = diag.match(/"(?:str|sym)":"[^"]{0,80}"/g)?.slice(0, 8);
  }
  if (r.returnValue) {
    try {
      const v = scValToNative(r.returnValue);
      rec.returnValue = v instanceof Uint8Array ? Buffer.from(v).toString("hex") : plain(v);
    } catch {
      /* not decodable */
    }
  }
  results.txs.push(rec);
  log(label, rec.status ?? rec.sendStatus, hashHex.slice(0, 12), rec.ledger ?? "", rec.feeCharged ?? "", rec.confirmMs ? `${rec.confirmMs}ms` : "");
  return rec;
}

const isBadSeq = (rec) => rec.sendStatus === "ERROR" && rec.errorResult?.result?.code === -5;

/** prepare + send, with one retry if the transaction was refused for a stale sequence number. */
async function submit(label, source, op, opts) {
  let p = await prepare(source, op, opts);
  let rec = await send(label, p);
  if (isBadSeq(rec)) {
    results.txs.at(-1).retried = true;
    await sleep(2000);
    p = await prepare(source, op, opts);
    rec = await send(`${label} (retry after txBAD_SEQ)`, p);
  }
  Object.defineProperty(rec, "prepared", { value: p, enumerable: false });
  return rec;
}

async function call(label, source, contract, fn, args, opts) {
  const rec = await submit(label, source, invoke(contract, fn, args), opts);
  if ((rec.status ?? rec.sendStatus) !== "SUCCESS") throw new Error(`${label} did not succeed: ${JSON.stringify(rec)}`);
  return rec;
}

// ---------------------------------------------------------------------------------------------
// Encoding (must match the contract: docs/venue/STELLAR-FEASIBILITY.md §2)

const sym = (s) => xdr.ScVal.scvSymbol(s);
const u32 = (n) => nativeToScVal(n, { type: "u32" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const bytes = (b) => xdr.ScVal.scvBytes(Buffer.from(b));
const addr = (a) => new Address(a).toScVal();
const struct = (fields) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })),
  );

const orderScVal = (o) => struct({ account: addr(o.account), pair: u32(o.pair), side: u32(o.side), price: u64(o.price), max_qty: u64(o.maxQty), expiry: u32(o.expiry), epoch: u32(o.epoch), salt: u64(o.salt) });

const sha256 = (b) => createHash("sha256").update(b).digest();
const orderHash = (contract, o) => sha256(Buffer.concat([DOMAIN, NETWORK_ID, new Address(contract).toScVal().toXDR(), orderScVal(o).toXDR()]));

function trader() {
  return { account: Keypair.random().publicKey(), key: Keypair.random() };
}

let saltCounter = 1n;
function order(t, side, price, maxQty, expiry, epoch = 0) {
  return { account: t.account, key: t.key, pair: 1, side, price, maxQty, expiry, epoch, salt: saltCounter++ };
}

function fillScVal(contract, seq, idx, maker, taker, qty) {
  const sign = (o) => bytes(o.key.sign(orderHash(contract, o)));
  return struct({ seq: u64(seq), idx: u32(idx), maker: orderScVal(maker), maker_sig: sign(maker), taker: orderScVal(taker), taker_sig: sign(taker), qty: u64(qty) });
}

/** A fresh maker-sell / taker-buy pair of orders, fully filled at the maker's price. */
function freshFill(contract, seq, makerT, takerT, expiry, qty = 5) {
  const maker = order(makerT, 1, 100, qty, expiry);
  const taker = order(takerT, 0, 101, qty, expiry);
  return { seq, scval: fillScVal(contract, seq, 0, maker, taker, qty), maker, taker };
}


const vec = (items) => xdr.ScVal.scvVec(items);
const keyScVal = (variant, arg) => vec([sym(variant), arg]);

async function upload(operator, wasm) {
  const rec = await submit("upload wasm", operator, Operation.uploadContractWasm({ wasm }));
  if (rec.status !== "SUCCESS") throw new Error("upload failed");
  return Buffer.from(rec.returnValue, "hex");
}

async function create(operator, wasmHash, label) {
  const op = Operation.createCustomContract({ address: new Address(operator.publicKey()), wasmHash, salt: randomBytes(32) });
  const rec = await submit(label, operator, op);
  if (rec.status !== "SUCCESS") throw new Error(`${label} failed`);
  return rec.returnValue;
}

async function liveUntil(contract, key, durability) {
  const lk = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key, durability }));
  const r = await server.getLedgerEntries(lk);
  return r.entries[0] ? { liveUntilLedgerSeq: r.entries[0].liveUntilLedgerSeq, lastModified: r.entries[0].lastModifiedLedgerSeq, latestLedger: r.latestLedger } : { missing: true, latestLedger: r.latestLedger };
}

async function cursorOf(source, contract) {
  const s = await simulate(source, invoke(contract, "cursor", []));
  return BigInt(s.retval[0]);
}

function violations(cost, L) {
  const v = [];
  if (cost.instructions > Number(L.txMaxInstructions)) v.push("instructions");
  if (L.txMaxFootprintEntries !== undefined && cost.readOnlyEntries + cost.readWriteEntries > Number(L.txMaxFootprintEntries)) v.push("footprint entries");
  if (L.txMaxWriteLedgerEntries !== undefined && cost.readWriteEntries > Number(L.txMaxWriteLedgerEntries)) v.push("write entries");
  if (L.txMaxWriteBytes !== undefined && cost.writeBytes > Number(L.txMaxWriteBytes)) v.push("write bytes");
  if (L.txMaxSizeBytes !== undefined && cost.envelopeBytes > Number(L.txMaxSizeBytes)) v.push("tx size");
  if (cost.memBytes !== undefined && L.txMemoryLimit !== undefined && cost.memBytes > Number(L.txMemoryLimit)) v.push("memory");
  return v;
}

const pick = (r) => ({ hash: r.hash, status: r.status ?? r.sendStatus, ledger: r.ledger, applicationOrder: r.applicationOrder, contractError: r.contractError, rpcError: r.rpcError, feeCharged: r.feeCharged, confirmMs: r.confirmMs, ledgersWaited: r.ledgersWaited, prepareMs: r.prepareMs, fees: r.fees, cost: r.cost });

async function main() {
  log("network facts");
  const facts = await networkFacts();
  results.network = facts;
  const L = { ...facts.limits, txMemoryLimit: facts.config.contractCompute?.txMemoryLimit };
  results.closeTimesBefore = await closeTimes();
  log("limits", JSON.stringify(L));

  const wasm = readFileSync(WASM);
  results.wasm = { bytes: wasm.length, sha256: sha256(wasm).toString("hex") };

  const operator = Keypair.random();
  const channels = Array.from({ length: 5 }, () => Keypair.random());
  log("funding operator and channel accounts with friendbot (testnet lumens)");
  await fund(operator);
  for (const c of channels) await fund(c);
  // Verify on chain that every funded account exists before using it.
  const funded = [];
  for (const kp of [operator, ...channels]) {
    const e = xo(await server.getAccountEntry(kp.publicKey()));
    funded.push({ account: kp.publicKey(), balanceStroops: String(e.balance), seqNum: String(e.seqNum) });
  }
  if (funded.some((f) => !(BigInt(f.balanceStroops) > 0n))) throw new Error(`funding not visible on chain: ${JSON.stringify(funded)}`);
  log("funded on chain", JSON.stringify(funded));
  results.accounts = { operator: operator.publicKey(), channels: channels.map((c) => c.publicKey()), fundedOnChain: funded };

  // --- deploy: one upload, three instances
  const wasmHash = await upload(operator, wasm);
  const A = await create(operator, wasmHash, "create A (persistent fill counters)");
  const B = await create(operator, wasmHash, "create B (temporary fill counters)");
  const C = await create(operator, wasmHash, "create C (replay target)");
  results.contracts = { wasmHash: wasmHash.toString("hex"), A, B, C };
  log("contracts", A, B, C);
  for (const [c, temp] of [[A, false], [B, true], [C, false]]) await call(`init ${c.slice(0, 6)}`, operator, c, "init", [addr(operator.publicKey()), xdr.ScVal.scvBool(temp)]);

  // --- traders (random addresses; trading keys held in memory)
  const POOL = 160;
  const traders = Array.from({ length: POOL }, trader);
  const chunk = Math.max(1, Math.min(40, Math.floor(Number(L.txMaxWriteLedgerEntries ?? 50) / 3) - 1));
  const setup = (c, list, label) =>
    call(label, operator, c, "setup", [vec(list.map((t) => addr(t.account))), vec(list.map((t) => bytes(t.key.rawPublicKey()))), i128(10n ** 12n), i128(10n ** 15n)]);
  const setupRecs = [];
  for (const c of [A, B]) for (let i = 0; i < POOL; i += chunk) setupRecs.push(await setup(c, traders.slice(i, i + chunk), `setup ${c.slice(0, 6)} ${i}`));
  setupRecs.push(await setup(C, traders.slice(0, 4), "setup C"));
  results.setup = { chunk, txs: setupRecs.length, perAccountFeeStroops: setupRecs[0].feeCharged / chunk, first: pick(setupRecs[0]) };

  const latest = (await server.getLatestLedger()).sequence;
  const expiry = latest + 17_280; // about one day at 5 s per ledger
  results.orderExpiry = { latestAtSetup: latest, expiry };

  // --- order hash cross-check (client encoding must equal the contract's)
  const probeOrder = order(traders[0], 1, 100, 5, expiry);
  const onChain = await simulate(operator, invoke(A, "order_hash", [orderScVal(probeOrder)]));
  const local = orderHash(A, probeOrder);
  results.orderHashCheck = { local: local.toString("hex"), contract: Buffer.from(onChain.retval).toString("hex") };
  if (!local.equals(Buffer.from(onChain.retval))) throw new Error("order hash mismatch between client and contract");

  // --- signature verification capacity
  log("verify_n sweep");
  const msg = randomBytes(32);
  const vk = traders[0].key;
  const verify = [];
  for (const n of [0, 1, 2, 4, 8, 16, 32, 64]) {
    const s = await simulate(operator, invoke(A, "verify_n", [bytes(vk.rawPublicKey()), bytes(msg), bytes(vk.sign(msg)), u32(n)]));
    verify.push({ n, ok: s.ok, instructions: s.cost?.instructions, error: s.error });
  }
  const v0 = verify[0].instructions;
  const v64 = verify.at(-1).instructions;
  const perVerify = (v64 - v0) / 64;
  results.signatureVerification = { sweep: verify, instructionsPerVerify: perVerify, baseInstructions: v0, txMaxInstructions: Number(L.txMaxInstructions), maxVerifiesPerTx: Math.floor((Number(L.txMaxInstructions) - v0) / perVerify) };
  const nMax = results.signatureVerification.maxVerifiesPerTx;
  const atMax = await simulate(operator, invoke(A, "verify_n", [bytes(vk.rawPublicKey()), bytes(msg), bytes(vk.sign(msg)), u32(nMax)]));
  const overMax = await simulate(operator, invoke(A, "verify_n", [bytes(vk.rawPublicKey()), bytes(msg), bytes(vk.sign(msg)), u32(nMax + Math.ceil(nMax * 0.05))]));
  results.signatureVerification.atComputedMax = { n: nMax, ok: atMax.ok, instructions: atMax.cost?.instructions, error: atMax.error };
  results.signatureVerification.fivePercentOver = { n: nMax + Math.ceil(nMax * 0.05), ok: overMax.ok, error: overMax.error };

  // --- per-fill settlement on A (persistent counters) and B (temporary counters)
  log("per-fill settlement");
  const seq = { [A]: 0n, [B]: 0n };
  const perFill = { A: [], B: [] };
  let lastA;
  for (let i = 0; i < 5; i++) {
    for (const [c, name] of [[A, "A"], [B, "B"]]) {
      seq[c] += 1n;
      const f = freshFill(c, seq[c], traders[2 * i], traders[2 * i + 1], expiry);
      const rec = await submit(`settle ${name} #${i}`, operator, invoke(c, "settle", [f.scval]));
      perFill[name].push(pick(rec));
      if (name === "A") lastA = { f, p: rec.prepared };
      if (i === 0) perFill[`${name}Counter`] = { maker: f.maker, hash: orderHash(c, f.maker) };
    }
  }

  // --- per-fill settlement with the idempotent fill identifier (alternative), on A and B
  log("per-fill settlement, idempotent identifier");
  const idemSeq = { [A]: 1_000_000n, [B]: 1_000_000n };
  perFill.A_idem = [];
  perFill.B_idem = [];
  let lastIdem;
  for (let i = 0; i < 3; i++) {
    for (const [c, name] of [[A, "A"], [B, "B"]]) {
      idemSeq[c] += 1n;
      const f = freshFill(c, idemSeq[c], traders[2 * i], traders[2 * i + 1], expiry);
      const rec = await submit(`settle_idem ${name} #${i}`, operator, invoke(c, "settle_idem", [f.scval]));
      perFill[`${name}_idem`].push(pick(rec));
      if (name === "A") lastIdem = { f, p: rec.prepared };
    }
  }

  // --- batched settlement: simulation sweep for the largest batch within the transaction limits
  log("batch sweep");
  const sweep = {};
  const batchOf = (c, base, k, shape) =>
    Array.from({ length: k }, (_, j) => (shape === "distinct" ? freshFill(c, base + BigInt(j) + 1n, traders[2 * j], traders[2 * j + 1], expiry) : freshFill(c, base + BigInt(j) + 1n, traders[0], traders[1], expiry)));
  const simBatch = async (c, k, shape, fn = "settle_batch") => {
    const fills = batchOf(c, fn === "settle_batch" ? seq[c] : idemSeq[c], k, shape);
    const s = await simulate(operator, invoke(c, fn, [vec(fills.map((f) => f.scval))]));
    const v = s.ok ? violations(s.cost, L) : [];
    return { k, ok: s.ok && v.length === 0, simulated: s.ok, violations: v, error: s.error, cost: s.cost };
  };
  const sweepCases = [
    ["distinct", A, "A", "settle_batch"],
    ["distinct", B, "B", "settle_batch"],
    ["shared", A, "A", "settle_batch"],
    ["shared", B, "B", "settle_batch"],
    ["distinct", A, "A", "settle_batch_idem"],
    ["distinct", B, "B", "settle_batch_idem"],
  ];
  for (const [shape, c, name0, fn] of sweepCases) {
    const name = fn === "settle_batch" ? name0 : `${name0}_idem`;
    {
      const rows = [];
      let lo = 0;
      let hi;
      for (const k of [1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 256]) {
        const r = await simulateSafe(() => simBatch(c, k, shape, fn));
        rows.push(r);
        if (r.ok) lo = k;
        else {
          hi = k;
          break;
        }
      }
      while (hi !== undefined && hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        const r = await simulateSafe(() => simBatch(c, mid, shape, fn));
        rows.push(r);
        if (r.ok) lo = mid;
        else hi = mid;
      }
      rows.sort((a, b) => a.k - b.k);
      const firstFail = rows.find((r) => !r.ok);
      sweep[`${shape}/${name}`] = { maxK: lo, firstFailingK: hi, limitingFactor: firstFail ? (firstFail.violations.length ? firstFail.violations : [firstFail.error]) : undefined, rows };
      log(`batch ${shape}/${name} max k = ${lo}`, firstFail ? JSON.stringify(sweep[`${shape}/${name}`].limitingFactor) : "");
    }
  }
  results.batchSweep = sweep;

  // --- batched settlement: real submissions
  log("batched submissions");
  const batches = [];
  const submitBatch = async (c, name, k, shape, depth = 0) => {
    if (k < 1) return;
    const fills = batchOf(c, seq[c], k, shape);
    try {
      const rec = await submit(`settle_batch ${name} ${shape} k=${k}`, operator, invoke(c, "settle_batch", [vec(fills.map((f) => f.scval))]));
      if ((rec.status ?? rec.sendStatus) === "SUCCESS") seq[c] += BigInt(k);
      batches.push({ contract: name, shape, k, ...pick(rec), feePerFill: rec.feeCharged ? rec.feeCharged / k : undefined });
      if (rec.sendStatus === "RPC_REJECTED" && k > 1 && depth < 6) await submitBatch(c, name, Math.floor(k * 0.8), shape, depth + 1);
    } catch (e) {
      // A batch the simulation accepted was refused at submission: record it and step down, so the
      // submittable maximum is measured rather than assumed from simulation.
      batches.push({ contract: name, shape, k, refusedAtSubmission: true, error: String(e.message).slice(0, 300) });
      log(`settle_batch ${name} ${shape} k=${k} refused:`, String(e.message).slice(0, 120));
      if (k > 1 && depth < 6) await submitBatch(c, name, Math.floor(k * 0.8), shape, depth + 1);
    }
  };
  const kA = sweep["distinct/A"].maxK;
  const kB = sweep["distinct/B"].maxK;
  await submitBatch(A, "A", 2, "distinct");
  await submitBatch(A, "A", Math.max(1, Math.floor(kA / 2)), "distinct");
  await submitBatch(A, "A", kA, "distinct");
  await submitBatch(B, "B", kB, "distinct");
  await submitBatch(A, "A", sweep["shared/A"].maxK, "shared");
  {
    const k = sweep["distinct/A_idem"].maxK;
    const fills = batchOf(A, idemSeq[A], k, "distinct");
    try {
      const rec = await submit(`settle_batch_idem A distinct k=${k}`, operator, invoke(A, "settle_batch_idem", [vec(fills.map((f) => f.scval))]));
      if ((rec.status ?? rec.sendStatus) === "SUCCESS") idemSeq[A] += BigInt(k);
      batches.push({ contract: "A_idem", shape: "distinct", k, ...pick(rec), feePerFill: rec.feeCharged ? rec.feeCharged / k : undefined });
    } catch (e) {
      batches.push({ contract: "A_idem", shape: "distinct", k, error: String(e.message).slice(0, 300) });
    }
  }
  results.batches = batches;

  // --- journal anchoring
  log("anchoring");
  const anchors = [];
  for (let i = 0; i < 3; i++) anchors.push(pick(await call(`anchor #${i}`, operator, A, "anchor", [bytes(randomBytes(32))])));
  results.anchoring = anchors;

  // --- storage TTL
  log("TTL probes");
  const maxTtl = (await simulate(operator, invoke(A, "max_ttl", []))).retval;
  const ttl = { maxTtlFromContract: maxTtl };
  ttl.tempToMax = pick(await call("probe temp to max", operator, A, "probe_put", [u32(0), u32(1), u32(maxTtl)]));
  ttl.tempEntry = await liveUntil(A, keyScVal("Probe", u32(1)), xdr.ContractDataDurability.temporary);
  ttl.persistentToMax = pick(await call("probe persistent to max", operator, A, "probe_put", [u32(1), u32(2), u32(maxTtl)]));
  ttl.persistentEntry = await liveUntil(A, keyScVal("Probe", u32(2)), xdr.ContractDataDurability.persistent);
  ttl.persistentMinimal = pick(await call("probe persistent minimal", operator, A, "probe_put", [u32(1), u32(3), u32(1)]));
  ttl.persistentMinimalEntry = await liveUntil(A, keyScVal("Probe", u32(3)), xdr.ContractDataDurability.persistent);
  const over = await simulate(operator, invoke(A, "probe_put", [u32(0), u32(4), u32(maxTtl + 1)]));
  ttl.overMax = { ok: over.ok, error: over.error };
  ttl.fillCounterA = await liveUntil(A, keyScVal("Filled", bytes(perFill.ACounter.hash)), xdr.ContractDataDurability.persistent);
  ttl.fillCounterB = await liveUntil(B, keyScVal("Filled", bytes(perFill.BCounter.hash)), xdr.ContractDataDurability.temporary);
  ttl.orderExpiry = expiry;
  ttl.instance = await (async () => {
    const lk = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(A).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
    const r = await server.getLedgerEntries(lk);
    return { liveUntilLedgerSeq: r.entries[0]?.liveUntilLedgerSeq, latestLedger: r.latestLedger };
  })();
  results.ttl = ttl;
  delete perFill.ACounter;
  delete perFill.BCounter;
  results.perFill = perFill;

  // --- settlement cursor on chain: duplicates, retries, gaps
  log("cursor behaviour");
  const cur = {};
  cur.duplicateFill = await simulate(operator, invoke(A, "settle", [lastA.f.scval]));
  const resend = await server.sendTransaction(lastA.p.tx);
  cur.resendIdenticalEnvelope = { status: resend.status, errorResult: resend.errorResult ? find(xo(resend.errorResult), /code|type/i) : undefined };
  seq[A] = await cursorOf(operator, A);
  const gapFill = freshFill(A, seq[A] + 10n, traders[20], traders[21], expiry);
  cur.gapOfTen = pick(await call("settle A with a gap of 10", operator, A, "settle", [gapFill.scval]));
  cur.skippedFillAfterGap = await simulate(operator, invoke(A, "settle", [freshFill(A, seq[A] + 5n, traders[22], traders[23], expiry).scval]));
  seq[A] += 10n;
  cur.cursorAfter = (await cursorOf(operator, A)).toString();
  cur.idemDuplicateFill = await simulate(operator, invoke(A, "settle_idem", [lastIdem.f.scval]));
  const resendIdem = await server.sendTransaction(lastIdem.p.tx);
  cur.idemResendIdenticalEnvelope = { status: resendIdem.status, errorResult: resendIdem.errorResult ? find(xo(resendIdem.errorResult), /code|type/i) : undefined };
  results.cursor = cur;

  // --- concurrent submission
  log("concurrency");
  const conc = {};
  {
    // (a) one source account, consecutive sequence numbers, sent back to back
    const base = await cursorOf(operator, A);
    const account = await peekAccount(operator);
    const p1 = await prepare(operator, invoke(A, "settle", [freshFill(A, base + 1n, traders[24], traders[25], expiry).scval]), { account });
    const p2 = await prepare(operator, invoke(A, "settle", [freshFill(A, base + 2n, traders[26], traders[27], expiry).scval]), { account });
    // #2 is sent only after the RPC has accepted #1 (PENDING), but before #1 is included.
    const s1 = await server.sendTransaction(p1.tx);
    const s2 = await server.sendTransaction(p2.tx);
    if (s1.status === "PENDING") noteAccepted(p1.tx);
    if (s2.status === "PENDING") noteAccepted(p2.tx);
    else seqCache.delete(operator.publicKey());
    const out = [];
    for (const [p, st] of [[p1, s1], [p2, s2]]) {
      const h = Buffer.from(p.tx.hash()).toString("hex");
      const row = { hash: h, sendStatus: st.status, errorResult: st.errorResult ? xo(st.errorResult).result : undefined };
      if (st.status === "PENDING") {
        const { r } = await waitFor(h);
        Object.assign(row, { status: r.status, ledger: r.ledger, applicationOrder: r.applicationOrder, feeCharged: r.resultXdr ? Number(xo(r.resultXdr).feeCharged) : undefined });
      }
      results.txs.push({ label: "same source", ...row });
      out.push(row);
    }
    log("same source", JSON.stringify(out.map((o) => [o.sendStatus, o.status, o.ledger])));
    conc.sameSource = out;
  }
  let pairAt = 60;
  const nextPair = () => {
    if (pairAt + 1 >= POOL) pairAt = 60;
    const p = [traders[pairAt], traders[pairAt + 1]];
    pairAt += 2;
    return p;
  };
  const viaChannel = (channel, fn, f) =>
    prepare(channel, invoke(A, fn, [f.scval]), { authBy: operator, rebuild: (auth) => Operation.invokeContractFunction({ contract: A, function: fn, args: [f.scval], auth }) });
  const ROUNDS = 3;
  conc.cursorConcurrent = [];
  conc.idemConcurrent = [];
  for (let round = 0; round < ROUNDS; round++) {
    // (b) N channel accounts, consecutive cursors, sent concurrently; the operator signs the auth
    const base = await cursorOf(operator, A);
    const preps = [];
    for (let i = 0; i < channels.length; i++) preps.push(await viaChannel(channels[i], "settle", freshFill(A, base + BigInt(i) + 1n, ...nextPair(), expiry)));
    const recs = await Promise.all(preps.map((p, i) => send(`cursor round ${round} channel ${i} cursor ${base + BigInt(i) + 1n}`, p)));
    conc.cursorConcurrent.push(recs.map((r, i) => ({ intendedCursor: (base + BigInt(i) + 1n).toString(), ...pick(r), diagnostic: r.diagnostic })));
    // (b') the same shape with idempotent identifiers
    const ibase = idemSeq[A];
    const ipreps = [];
    for (let i = 0; i < channels.length; i++) ipreps.push(await viaChannel(channels[i], "settle_idem", freshFill(A, ibase + BigInt(i) + 1n, ...nextPair(), expiry)));
    idemSeq[A] += BigInt(channels.length);
    const irecs = await Promise.all(ipreps.map((p, i) => send(`idem round ${round} channel ${i} id ${ibase + BigInt(i) + 1n}`, p)));
    conc.idemConcurrent.push(irecs.map((r, i) => ({ fillId: (ibase + BigInt(i) + 1n).toString(), ...pick(r), diagnostic: r.diagnostic })));
  }
  {
    // (d) the same fill submitted twice, concurrently, through two channels (idempotent path)
    const f = freshFill(A, idemSeq[A] + 1n, ...nextPair(), expiry);
    idemSeq[A] += 1n;
    const [p1, p2] = [await viaChannel(channels[0], "settle_idem", f), await viaChannel(channels[1], "settle_idem", f)];
    const [r1, r2] = await Promise.all([send("idem duplicate via channel 0", p1), send("idem duplicate via channel 1", p2)]);
    conc.idemConcurrentDuplicate = [pick(r1), { ...pick(r2), diagnostic: r2.diagnostic }].map((r, i) => ({ ...r, diagnostic: [r1, r2][i].diagnostic }));
  }
  {
    // (c) channels used one after another: send, wait for the result, send the next (cursor path).
    const base = await cursorOf(operator, A);
    const out = [];
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const f = freshFill(A, base + BigInt(i) + 1n, ...nextPair(), expiry);
      out.push(pick(await submit(`sequential ${i}`, channels[i], invoke(A, "settle", [f.scval]), { authBy: operator, rebuild: (auth) => Operation.invokeContractFunction({ contract: A, function: "settle", args: [f.scval], auth }) })));
    }
    conc.sequentialThree = { totalMs: Date.now() - t0, txs: out };
  }
  results.concurrency = conc;

  // --- invalidation and replay
  log("epoch and replay");
  const inv = {};
  const epochFill = freshFill(A, (await cursorOf(operator, A)) + 1n, traders[50], traders[51], expiry);
  inv.beforeBump = await simulate(operator, invoke(A, "settle", [epochFill.scval]));
  inv.bump = pick(await call("bump epoch", operator, A, "bump_epoch", [addr(traders[50].account)]));
  inv.afterBump = await simulate(operator, invoke(A, "settle", [epochFill.scval]));
  const forA = freshFill(A, 1n, traders[0], traders[1], expiry);
  inv.signedForAOnC = await simulate(operator, invoke(C, "settle", [forA.scval]));
  inv.signedForConC = await simulate(operator, invoke(C, "settle", [freshFill(C, 1n, traders[0], traders[1], expiry).scval]));
  results.invalidationAndReplay = inv;

  results.closeTimesAfter = await closeTimes();
  results.finishedAt = new Date().toISOString();
}

async function simulateSafe(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, simulated: false, violations: [], error: `client: ${String(e.message).slice(0, 200)}` };
  }
}

function save() {
  const dir = join(HERE, "out");
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(results, big, 2);
  const file = join(dir, `results-${results.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, body);
  writeFileSync(join(dir, "latest.json"), body);
  return file;
}

main()
  .then(() => {
    const file = save();
    log("results written to", file);
  })
  .catch((e) => {
    results.error = String(e.stack ?? e);
    const file = save();
    log("FAILED; partial results written to", file);
    console.error(e);
    process.exit(1);
  });
