import { SYNTHETIC_INSTRUMENTS } from "./instrument.ts";
import { createLocalVenue, syntheticFlow } from "./synthetic.ts";
import { Venue } from "./venue.ts";

/**
 * Local micro-benchmarks for the prototype (docs/venue/PERFORMANCE-PLAN.md).
 * Numbers are indicative only: single-threaded TypeScript, in-memory
 * journal, no I/O, on whatever machine runs them.
 */

const SPEC = SYNTHETIC_INSTRUMENTS[0]!;

export interface BenchResult {
  readonly scenario: string;
  readonly operations: number;
  readonly seconds: number;
  readonly perSecond: number;
  readonly p50us: number;
  readonly p99us: number;
  readonly p999us: number;
  readonly maxUs: number;
}

function summarise(scenario: string, samples: number[], totalNs: bigint): BenchResult {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const seconds = Number(totalNs) / 1e9;
  return {
    scenario,
    operations: samples.length,
    seconds,
    perSecond: samples.length / seconds,
    p50us: q(0.5),
    p99us: q(0.99),
    p999us: q(0.999),
    maxUs: sorted.at(-1) ?? 0,
  };
}

function timeEach(scenario: string, count: number, op: (i: number) => void): BenchResult {
  const samples = new Array<number>(count);
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) {
    const t0 = process.hrtime.bigint();
    op(i);
    samples[i] = Number(process.hrtime.bigint() - t0) / 1_000;
  }
  return summarise(scenario, samples, process.hrtime.bigint() - start);
}

const accounts = (n: number) => Array.from({ length: n }, (_, i) => `syn-b${i}`);
const unlimited = { messages: { limit: 1e9, windowMs: 1_000 }, postOnlyRejects: { limit: 1e9, windowMs: 1_000 } };

export function runBench(scale = 1): BenchResult[] {
  const n = Math.max(1_000, Math.round(50_000 * scale));
  const results: BenchResult[] = [];

  // B1. Mixed synthetic flow through the gateway (validation, idempotency, journal, engine, routing).
  {
    const ids = accounts(16);
    const { gateway, clock, tokens } = createLocalVenue({ accounts: ids, gateway: unlimited, limits: { maxOpenOrders: 10_000, maxOrderNotional: 1e12, maxPositionLots: 1e12 } });
    const flow = syntheticFlow(11, n, ids);
    results.push(
      timeEach("B1 gateway: mixed flow", n, (i) => {
        clock.advance(1);
        gateway.handle(tokens.get(flow[i]!.accountId)!, flow[i]!.message);
      }),
    );
  }

  // B2. Engine path only (sequencer + engine), resting adds far from the touch: book growth.
  {
    const ids = accounts(4);
    const { venue } = createLocalVenue({ accounts: ids, limits: { maxOpenOrders: 10_000, maxOrderNotional: 1e12, maxPositionLots: 1e12 } });
    const count = Math.min(n, 40_000);
    results.push(
      timeEach("B2 engine: resting adds (deep book)", count, (i) => {
        venue.submit({
          type: "new-order",
          accountId: ids[i % 4]!,
          clientOrderId: `d${i}`,
          instrumentId: SPEC.id,
          side: i % 2 ? "buy" : "sell",
          orderType: "limit",
          priceTicks: i % 2 ? 3_900 - (i % 300) : 4_100 + (i % 300),
          qtyLots: 10,
          tif: "gtc",
          visibility: i % 5 === 0 ? "hidden" : "displayed",
          postOnly: false,
          stp: "cancel-taker",
        });
      }),
    );
    // B3. Sweeps through many levels and many hidden orders.
    let k = 0;
    results.push(
      timeEach("B3 engine: IOC takers vs deep book", 2_000, (i) => {
        venue.submit({
          type: "new-order",
          accountId: ids[(i + 1) % 4]!,
          clientOrderId: `s${k++}`,
          instrumentId: SPEC.id,
          side: i % 2 ? "sell" : "buy",
          orderType: "limit",
          priceTicks: i % 2 ? 3_890 : 4_110,
          qtyLots: 50,
          tif: "ioc",
          visibility: "displayed",
          postOnly: false,
          stp: "cancel-maker",
        });
      }),
    );
  }

  // B4. Add/cancel churn at the touch (typical market-maker load).
  {
    const ids = accounts(2);
    const { venue } = createLocalVenue({ accounts: ids });
    const count = Math.min(n, 40_000);
    const placed: string[] = [];
    results.push(
      timeEach("B4 engine: add/cancel churn", count, (i) => {
        if (i % 2 === 0) {
          const r = venue.submit({
            type: "new-order",
            accountId: ids[0]!,
            clientOrderId: `c${i}`,
            instrumentId: SPEC.id,
            side: "buy",
            orderType: "limit",
            priceTicks: 3_990 + (i % 7),
            qtyLots: 5,
            tif: "gtc",
            visibility: i % 4 === 0 ? "hidden" : "displayed",
            postOnly: false,
            stp: "cancel-taker",
          });
          const accepted = r.private.find((e) => e.kind === "accepted");
          if (accepted?.kind === "accepted") placed.push(accepted.order.orderId);
        } else {
          const id = placed.shift();
          if (id) venue.submit({ type: "cancel", accountId: ids[0]!, ref: { orderId: id } });
        }
      }),
    );
  }

  // B5. Recovery: replay a journal from scratch.
  {
    const ids = accounts(8);
    const { venue, gateway, clock, tokens } = createLocalVenue({ accounts: ids, gateway: unlimited });
    for (const { accountId, message } of syntheticFlow(23, n, ids)) {
      clock.advance(1);
      gateway.handle(tokens.get(accountId)!, message);
    }
    const jsonl = venue.journal.toJsonl();
    const t0 = process.hrtime.bigint();
    const { report } = Venue.recover({ engine: { idKey: "local-prototype-key", publication: "immediate" }, clock: clock.read }, jsonl);
    const ns = process.hrtime.bigint() - t0;
    results.push(summarise(`B5 recovery: replay ${report.replayed} journal entries`, new Array<number>(report.replayed).fill(Number(ns) / 1_000 / report.replayed), ns));
  }
  return results;
}

export function formatBench(results: readonly BenchResult[]): string {
  const header = "scenario".padEnd(44) + "ops".padStart(8) + "ops/s".padStart(11) + "p50 µs".padStart(9) + "p99 µs".padStart(9) + "p99.9 µs".padStart(10) + "max µs".padStart(9);
  const rows = results.map(
    (r) =>
      r.scenario.padEnd(44) +
      String(r.operations).padStart(8) +
      Math.round(r.perSecond).toLocaleString("en-US").padStart(11) +
      r.p50us.toFixed(1).padStart(9) +
      r.p99us.toFixed(1).padStart(9) +
      r.p999us.toFixed(1).padStart(10) +
      r.maxUs.toFixed(0).padStart(9),
  );
  return [header, ...rows].join("\n");
}

