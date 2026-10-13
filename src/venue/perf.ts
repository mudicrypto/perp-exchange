import { arch, cpus, platform, release, totalmem } from "node:os";
import { MatchingEngine } from "./engine.ts";
import { PERF_FIXTURE_ID_KEY } from "./id-key.ts";
import { canonicalJson } from "./journal.ts";
import { PublicBookMirror } from "./public-feed.ts";
import { MemoryJournalStore } from "./storage.ts";
import { createLocalVenue, seededRandom, syntheticFlow } from "./synthetic.ts";
import type { EngineCommand, SequencedCommand } from "./types.ts";
import { Venue } from "./venue.ts";

/**
 * Milestone 9 reproducible synthetic benchmarks (docs/venue/PERFORMANCE-RESULTS.md).
 *
 * Every scenario is seeded, runs in one process against an in-memory store,
 * and is repeated; results are local measurements of a TypeScript prototype,
 * not capacity statements. No targets are implied.
 */

export interface PerfResult {
  readonly scenario: string;
  readonly params: string;
  readonly run: number;
  readonly operations: number;
  readonly opsPerSecond: number;
  readonly p50us: number;
  readonly p95us: number;
  readonly p99us: number;
  readonly maxUs: number;
}

const LIMITS = { maxOpenOrders: 10_000, maxOrderNotional: 1e12, maxPositionLots: 1e12 };
const ENGINE = { idKey: PERF_FIXTURE_ID_KEY, publication: "immediate" as const };
/** Benchmarks use the deterministic perf fixture key explicitly (A-5). */
const FIXTURE = { allowTestFixtureIdKey: true } as const;
const ACCOUNTS = Array.from({ length: 16 }, (_, i) => `syn-q${i}`);

function quantile(sorted: Float64Array, q: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}

function summarise(scenario: string, params: string, run: number, samples: Float64Array, seconds: number): PerfResult {
  const sorted = Float64Array.from(samples).sort();
  return {
    scenario,
    params,
    run,
    operations: samples.length,
    opsPerSecond: samples.length / seconds,
    p50us: quantile(sorted, 0.5),
    p95us: quantile(sorted, 0.95),
    p99us: quantile(sorted, 0.99),
    maxUs: sorted.at(-1) ?? 0,
  };
}

/** Times each call; returns per-operation latency in µs and total wall time. */
function measure(count: number, op: (i: number) => void): { samples: Float64Array; seconds: number } {
  const samples = new Float64Array(count);
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    op(i);
    samples[i] = Number(process.hrtime.bigint() - t0) / 1_000;
  }
  return { samples, seconds: Number(process.hrtime.bigint() - start) / 1e9 };
}

/** Engine commands for a mixed flow (adds incl. 25 % hidden, IOC/FOK, cancels, replaces). */
export function engineFlow(seed: number, n: number, accounts = ACCOUNTS): EngineCommand[] {
  const rnd = seededRandom(seed);
  const pick = (k: number) => Math.floor(rnd() * k);
  const out: EngineCommand[] = [];
  for (let i = 0; i < n; i++) {
    const accountId = accounts[pick(accounts.length)]!;
    const r = rnd();
    if (r < 0.55) {
      const hidden = pick(4) === 0;
      out.push({
        type: "new-order",
        accountId,
        clientOrderId: `c${i}`,
        instrumentId: "SYN-ALPHA",
        side: pick(2) ? "buy" : "sell",
        orderType: "limit",
        priceTicks: 3_980 + pick(41),
        qtyLots: hidden ? 100 + pick(300) : 1 + pick(200),
        tif: hidden ? "gtc" : (["gtc", "gtc", "gtc", "ioc", "fok"] as const)[pick(5)]!,
        visibility: hidden ? "hidden" : "displayed",
        postOnly: false,
        stp: "cancel-maker",
      });
    } else if (r < 0.85) out.push({ type: "cancel", accountId, ref: { clientOrderId: `c${pick(i + 1)}` } });
    else out.push({ type: "replace", accountId, ref: { clientOrderId: `c${pick(i + 1)}` }, priceTicks: 3_980 + pick(41), qtyLots: 1 + pick(300) });
  }
  return out;
}

function setupCommands(): EngineCommand[] {
  const { venue } = createLocalVenue({ accounts: ACCOUNTS, limits: LIMITS });
  return venue.journal.entries.map((e) => e.command);
}

function sequenced(commands: EngineCommand[], startSeq = 1): SequencedCommand[] {
  return commands.map((command, i) => ({ seq: startSeq + i, ts: 1_700_000_000_000 + i, command }));
}

export interface PerfOptions {
  readonly scale: number;
  readonly runs: number;
}

export function runPerf({ scale, runs }: PerfOptions): PerfResult[] {
  const n = Math.max(2_000, Math.round(60_000 * scale));
  const results: PerfResult[] = [];
  const setup = setupCommands();

  for (let run = 1; run <= runs; run++) {
    const flow = engineFlow(1_000 + run, n);

    // F1. Matching only: pre-sequenced commands straight into the engine (no journal, no routing, no validation).
    {
      const engine = new MatchingEngine(ENGINE);
      const all = sequenced([...setup, ...flow]);
      for (const e of all.slice(0, setup.length)) engine.process(e);
      const body = all.slice(setup.length);
      const m = measure(body.length, (i) => engine.process(body[i]!));
      results.push(summarise("F1 matching, no persistence", `${n} mixed commands, 16 accounts`, run, m.samples, m.seconds));
    }

    // F2. Matching with journal writes: schema check + hash chain + canonical JSON + store append + routing.
    {
      const store = new MemoryJournalStore();
      const venue = new Venue({ engine: ENGINE, ...FIXTURE, clock: () => 1_700_000_000_000, store });
      for (const c of setup) venue.submit(c);
      const m = measure(flow.length, (i) => venue.submit(flow[i]!));
      results.push(summarise("F2 matching + journal (memory store)", `${n} mixed commands; store ${(store.read().length / 2 ** 20).toFixed(1)} MiB`, run, m.samples, m.seconds));
    }

    // F3. Publication: F2 plus a validating public mirror and private-event polling for every account.
    for (const publication of ["immediate", "batched"] as const) {
      const venue = new Venue({ engine: { ...ENGINE, publication }, ...FIXTURE, clock: () => 1_700_000_000_000, store: new MemoryJournalStore() });
      const mirror = new PublicBookMirror();
      venue.onPublic((msg) => mirror.apply(msg));
      for (const c of setup) venue.submit(c);
      const cursors = new Map<string, number>();
      let published = 0;
      const m = measure(flow.length, (i) => {
        const r = venue.submit(flow[i]!);
        if (publication === "batched" && i % 50 === 49) published += venue.submit({ type: "publish" }).public.length;
        published += r.public.length;
        for (const e of r.private) cursors.set(e.accountId, e.accountSeq);
      });
      results.push(summarise(`F3 publication (${publication})`, `${n} commands; ${published} public msgs; mirror validates each${publication === "batched" ? "; publish every 50" : ""}`, run, m.samples, m.seconds));
    }

    // F4. Mixed order entry through the gateway (auth, Zod, decimal conversion, idempotency, rate limits).
    {
      const { gateway, clock, tokens } = createLocalVenue({ accounts: ACCOUNTS, limits: LIMITS, gateway: { messages: { limit: 1e9, windowMs: 1_000 }, postOnlyRejects: { limit: 1e9, windowMs: 1_000 } } });
      const messages = syntheticFlow(2_000 + run, n, ACCOUNTS);
      const m = measure(messages.length, (i) => {
        clock.advance(1);
        gateway.handle(tokens.get(messages[i]!.accountId)!, messages[i]!.message);
      });
      results.push(summarise("F4 gateway mixed entry/cancel/execution", `${n} synthetic messages (seeded)`, run, m.samples, m.seconds));
    }

    // F5. Bursty traffic, open loop: bursts arrive at once; latency = queueing + service (measured).
    {
      const venue = new Venue({ engine: ENGINE, ...FIXTURE, clock: () => 1_700_000_000_000, store: new MemoryJournalStore() });
      for (const c of setup) venue.submit(c);
      const burst = 2_000;
      const gapUs = 200_000; // 200 ms between bursts (virtual arrival schedule)
      const sojourn = new Float64Array(flow.length);
      let clockUs = 0;
      const start = process.hrtime.bigint();
      for (let i = 0; i < flow.length; i++) {
        const arrival = Math.floor(i / burst) * gapUs;
        const t0 = process.hrtime.bigint();
        venue.submit(flow[i]!);
        const service = Number(process.hrtime.bigint() - t0) / 1_000;
        const begin = Math.max(clockUs, arrival);
        clockUs = begin + service;
        sojourn[i] = clockUs - arrival;
      }
      results.push(summarise("F5 bursty (queueing + service)", `bursts of ${burst} every 200 ms, open loop`, run, sojourn, Number(process.hrtime.bigint() - start) / 1e9));
    }

    // F6. Large book: 100k resting orders over 300 levels per side (outside the flow range), then mixed flow near the touch.
    {
      const venue = new Venue({ engine: ENGINE, ...FIXTURE, clock: () => 1_700_000_000_000, store: new MemoryJournalStore() });
      for (const c of setup) venue.submit(c);
      const depth = Math.round(100_000 * Math.min(1, scale * 1.5));
      for (let i = 0; i < depth; i++) {
        const sell = i % 2 === 1;
        venue.submit({ type: "new-order", accountId: ACCOUNTS[i % 16]!, clientOrderId: `d${i}`, instrumentId: "SYN-ALPHA", side: sell ? "sell" : "buy", orderType: "limit", priceTicks: sell ? 4_021 + (i % 300) : 3_979 - (i % 300), qtyLots: 5, tif: "gtc", visibility: i % 4 === 0 ? "hidden" : "displayed", postOnly: false, stp: "cancel-maker" });
      }
      const m = measure(flow.length, (i) => venue.submit(flow[i]!));
      results.push(summarise("F6 large book", `${depth} resting orders (25 % hidden) + ${n} mixed commands`, run, m.samples, m.seconds));
    }

    // F7. Recovery: replay the F2-sized journal from scratch, and from a mid-run snapshot.
    {
      const store = new MemoryJournalStore();
      const venue = new Venue({ engine: ENGINE, ...FIXTURE, clock: () => 1_700_000_000_000, store });
      for (const c of setup) venue.submit(c);
      let snapshot: ReturnType<Venue["snapshot"]> | undefined;
      flow.forEach((c, i) => {
        venue.submit(c);
        if (i === Math.floor(flow.length / 2)) snapshot = venue.snapshot();
      });
      const text = store.read();
      for (const [label, snap] of [["full replay", undefined], ["snapshot + suffix", snapshot]] as const) {
        const t0 = process.hrtime.bigint();
        const { report } = Venue.recover({ engine: ENGINE, ...FIXTURE, clock: () => 0 }, text, snap);
        const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
        const perEntry = (seconds * 1e6) / Math.max(1, report.replayed);
        results.push(summarise(`F7 recovery (${label})`, `${report.replayed} entries replayed; snapshot ${(canonicalJson(snapshot).length / 2 ** 20).toFixed(1)} MiB`, run, new Float64Array(report.replayed).fill(perEntry), seconds));
      }
    }
  }
  return results;
}

/**
 * Timing side-channel probe (PRIVACY-REVIEW T-H7): latency of the same
 * displayed add/cancel pair against books that differ only in the number of
 * hidden-only price levels. Reports medians of several alternating rounds.
 */
export function timingProbe(rounds = 5, perRound = 4_000, via: "engine" | "gateway" = "engine"): { hiddenLevels: number; medianUs: number[] }[] {
  const configs = [0, 1_000, 50_000];
  const out = configs.map((hiddenLevels) => ({ hiddenLevels, medianUs: [] as number[] }));
  for (let r = 0; r < rounds; r++) {
    for (const cfg of out) {
      const { venue, gateway, tokens } = createLocalVenue({
        gateway: { messages: { limit: 1e9, windowMs: 1_000 }, postOnlyRejects: { limit: 1e9, windowMs: 1_000 } },
        accounts: ["syn-h", "syn-t"],
        limits: LIMITS,
        instruments: [{ id: "SYN-T", priceDecimals: 0, tickUnits: 1, sizeDecimals: 0, lotUnits: 1, minPriceTicks: 1, maxPriceTicks: 1_000_000, minQtyLots: 1, maxQtyLots: 1_000_000, priceBandBps: 5_000, minHiddenQtyLots: 1, referencePriceTicks: 200_000 }],
      });
      const engine = venue.engine;
      let seq = venue.journal.lastSeq;
      const ts = venue.journal.lastTs;
      // Engine path: bypass journal and gateway. Gateway path: everything goes through the sequencer.
      const send = (command: EngineCommand) => (via === "engine" ? engine.process({ seq: ++seq, ts, command }) : venue.submit(command));
      for (let i = 0; i < cfg.hiddenLevels; i++) send({ type: "new-order", accountId: "syn-h", clientOrderId: `h${i}`, instrumentId: "SYN-T", side: "sell", orderType: "limit", priceTicks: 200_100 + i, qtyLots: 1, tif: "gtc", visibility: "hidden", postOnly: false, stp: "cancel-taker" });
      const samples = new Float64Array(perRound);
      for (let i = 0; i < perRound; i++) {
        // A new displayed level in front of every hidden level: the sorted price array must shift all of them.
        const t0 = process.hrtime.bigint();
        if (via === "engine") {
          send({ type: "new-order", accountId: "syn-t", clientOrderId: `t${i}`, instrumentId: "SYN-T", side: "sell", orderType: "limit", priceTicks: 200_001 + (i % 90), qtyLots: 1, tif: "gtc", visibility: "displayed", postOnly: false, stp: "cancel-taker" });
        } else {
          gateway.handle(tokens.get("syn-t")!, { op: "new", clientOrderId: `t${i}`, instrumentId: "SYN-T", side: "sell", type: "limit", price: String(200_001 + (i % 90)), quantity: "1" });
        }
        samples[i] = Number(process.hrtime.bigint() - t0) / 1_000;
        if (via === "engine") send({ type: "cancel", accountId: "syn-t", ref: { clientOrderId: `t${i}` } });
        else gateway.handle(tokens.get("syn-t")!, { op: "cancel", ref: { clientOrderId: `t${i}` } });
      }
      cfg.medianUs.push(quantile(Float64Array.from(samples).sort(), 0.5));
    }
  }
  return out;
}

export function environment(): string {
  const cpu = cpus();
  return `node ${process.version}, ${platform()} ${release()} ${arch()}, ${cpu.length} × ${cpu[0]?.model ?? "unknown CPU"}, ${Math.round(totalmem() / 2 ** 30)} GiB RAM`;
}

export function formatPerf(results: readonly PerfResult[]): string {
  const rows = results.map(
    (r) =>
      `| ${r.scenario} | ${r.run} | ${r.params} | ${r.operations} | ${Math.round(r.opsPerSecond).toLocaleString("en-US")} | ${r.p50us.toFixed(1)} | ${r.p95us.toFixed(1)} | ${r.p99us.toFixed(1)} | ${r.maxUs.toFixed(0)} |`,
  );
  return ["| Scenario | Run | Parameters | Ops | Ops/s | p50 µs | p95 µs | p99 µs | max µs |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}
