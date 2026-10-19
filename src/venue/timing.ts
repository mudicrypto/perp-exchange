import { MatchingEngine } from "./engine.ts";
import { PERF_FIXTURE_ID_KEY } from "./id-key.ts";
import type { InstrumentSpec } from "./instrument.ts";
import type { EngineCommand, NewOrderCommand } from "./types.ts";

/**
 * Milestone 12 timing harness for hidden-liquidity side channels (VR-15, VR-31; THREAT-MODEL T-H7).
 *
 * Every probe compares books with **identical displayed liquidity** that differ only in the number of
 * hidden-only price levels. Probes run on the engine directly (no journal, routing or gateway), which removes
 * most noise, and every round alternates the configurations. Each configuration's hidden-only levels are
 * spread over enough accounts to stay within `maxOpenOrders`, and the resting count is asserted before
 * measuring (the Milestone 9–11 probe asked for 50 000 levels but rested 10 000: VR-32).
 *
 * Probes:
 * - `insert-front`: add a displayed order at a new price level better than every hidden-only level (VR-15).
 * - `cancel-front`: cancel that order, removing its level (VR-15).
 * - `match-front`: an IOC that takes a one-lot displayed level in front of the hidden-only levels, removing it.
 * - `post-only-accept`: a post-only order that rests at a new level (checks the best opposite price).
 * - `public-book (hidden in front)`: `publicBook(20)` where every hidden-only level is better than the 20
 *   displayed levels (VR-31 worst case).
 * - `public-book (hidden behind)`: `publicBook(20)` with the hidden-only levels behind the displayed ones.
 * - `fok-walk`: an unfilled FOK whose limit reaches through every hidden-only level (inherent: the match plan
 *   visits each level it could fill against; reported, not mitigated).
 *
 * The book implementation is injectable so the Milestone 11 sorted-array book (`reference-book.ts`) and the
 * indexed book can be measured in one process. Results are local measurements, not capacity statements.
 */

export interface TimingOptions {
  readonly hiddenLevels?: readonly number[];
  readonly rounds?: number;
  readonly samples?: number;
  /** Run only the probes whose name starts with one of these prefixes. */
  readonly probes?: readonly string[];
  /** Engine factory (defaults to the production engine). */
  readonly engine?: (config: ConstructorParameters<typeof MatchingEngine>[0]) => MatchingEngine;
}

export interface TimingRow {
  readonly probe: string;
  readonly hiddenLevels: number;
  /** Median of each round, µs. */
  readonly roundMediansUs: number[];
  /** Over all samples of all rounds, µs. */
  readonly p50Us: number;
  readonly p95Us: number;
  readonly p99Us: number;
}

const SPEC: InstrumentSpec = {
  id: "SYN-T",
  priceDecimals: 0,
  tickUnits: 1,
  sizeDecimals: 0,
  lotUnits: 1,
  minPriceTicks: 1,
  maxPriceTicks: 1_000_000,
  minQtyLots: 1,
  maxQtyLots: 1_000_000,
  priceBandBps: 5_000,
  minHiddenQtyLots: 1,
  referencePriceTicks: 200_000,
};
const LIMITS = { maxOpenOrders: 10_000, maxOrderNotional: 1e15, maxPositionLots: 1e12 };
const PER_ACCOUNT = 10_000;

type Layout = "front" | "behind";

/** Asks: displayed levels at fixed prices; hidden-only levels either better ("front") or worse ("behind"). */
function book(hidden: number, layout: Layout, factory: NonNullable<TimingOptions["engine"]>) {
  const engine = factory({ idKey: PERF_FIXTURE_ID_KEY, publication: "immediate" });
  let seq = 0;
  const send = (command: EngineCommand) => engine.process({ seq: ++seq, ts: 0, command });
  send({ type: "admin.add-instrument", spec: SPEC });
  const hiddenAccounts = Math.max(1, Math.ceil(hidden / PER_ACCOUNT));
  for (let a = 0; a < hiddenAccounts; a++) send({ type: "admin.add-account", accountId: `syn-h${a}`, limits: LIMITS });
  for (const a of ["syn-d", "syn-t"]) send({ type: "admin.add-account", accountId: a, limits: LIMITS });
  const order = (o: Partial<NewOrderCommand> & Pick<NewOrderCommand, "accountId" | "clientOrderId">): EngineCommand => ({
    type: "new-order",
    instrumentId: SPEC.id,
    side: "sell",
    orderType: "limit",
    priceTicks: 200_000,
    qtyLots: 1,
    tif: "gtc",
    visibility: "displayed",
    postOnly: false,
    stp: "cancel-taker",
    ...o,
  });
  // 20 displayed levels: identical in every configuration of a layout.
  const displayedBase = layout === "front" ? 260_000 : 200_050;
  for (let i = 0; i < 20; i++) send(order({ accountId: "syn-d", clientOrderId: `d${i}`, priceTicks: displayedBase + i }));
  const hiddenBase = layout === "front" ? 200_100 : 210_000;
  for (let i = 0; i < hidden; i++) {
    send(order({ accountId: `syn-h${Math.floor(i / PER_ACCOUNT)}`, clientOrderId: `h${i}`, priceTicks: hiddenBase + i, visibility: "hidden" }));
  }
  const levels = engine.inspectBook(SPEC.id);
  const hiddenOnly = levels.filter((l) => l.displayedLots === 0).length;
  if (hiddenOnly !== hidden || levels.length !== hidden + 20) throw new Error(`timing setup: expected ${hidden} hidden-only levels, got ${hiddenOnly}`);
  return { engine, send, order, nextSeq: () => seq };
}

function quantile(sorted: Float64Array, q: number) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0;
}

const now = () => process.hrtime.bigint();
const us = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1_000;

/** `heavy`: walks every hidden-only level; sampled 20× less (identically for every implementation). */
type Probe = { name: string; layout: Layout; heavy?: boolean; run: (w: ReturnType<typeof book>, i: number) => number };

const PROBES: Probe[] = [
  {
    name: "insert-front",
    layout: "behind",
    run: (w, i) => {
      const t0 = now();
      w.send(w.order({ accountId: "syn-t", clientOrderId: `i${i}`, priceTicks: 200_001 + (i % 40) }));
      const t = us(t0);
      w.send({ type: "cancel", accountId: "syn-t", ref: { clientOrderId: `i${i}` } });
      return t;
    },
  },
  {
    name: "cancel-front",
    layout: "behind",
    run: (w, i) => {
      w.send(w.order({ accountId: "syn-t", clientOrderId: `c${i}`, priceTicks: 200_001 + (i % 40) }));
      const t0 = now();
      w.send({ type: "cancel", accountId: "syn-t", ref: { clientOrderId: `c${i}` } });
      return us(t0);
    },
  },
  {
    name: "match-front",
    layout: "behind",
    run: (w, i) => {
      w.send(w.order({ accountId: "syn-d", clientOrderId: `m${i}`, priceTicks: 200_010 }));
      const t0 = now();
      w.send(w.order({ accountId: "syn-t", clientOrderId: `x${i}`, side: "buy", priceTicks: 200_010, tif: "ioc" }));
      return us(t0);
    },
  },
  {
    name: "post-only-accept",
    layout: "behind",
    run: (w, i) => {
      const t0 = now();
      w.send(w.order({ accountId: "syn-t", clientOrderId: `p${i}`, side: "buy", priceTicks: 199_000 + (i % 40), postOnly: true }));
      const t = us(t0);
      w.send({ type: "cancel", accountId: "syn-t", ref: { clientOrderId: `p${i}` } });
      return t;
    },
  },
  {
    name: "public-book (hidden in front)",
    layout: "front",
    heavy: true,
    run: (w) => {
      const t0 = now();
      w.engine.publicBook(SPEC.id, 20);
      return us(t0);
    },
  },
  {
    name: "public-book (hidden behind)",
    layout: "behind",
    run: (w) => {
      const t0 = now();
      w.engine.publicBook(SPEC.id, 20);
      return us(t0);
    },
  },
  {
    name: "fok-walk (inherent)",
    layout: "front",
    heavy: true,
    run: (w, i) => {
      const t0 = now();
      w.send(w.order({ accountId: "syn-t", clientOrderId: `f${i}`, side: "buy", priceTicks: 260_019, qtyLots: 1_000_000, tif: "fok" }));
      return us(t0);
    },
  },
];

export function timingHarness(options: TimingOptions = {}): TimingRow[] {
  const hiddenLevels = options.hiddenLevels ?? [0, 1_000, 10_000, 50_000];
  const rounds = options.rounds ?? 5;
  const samples = options.samples ?? 2_000;
  const factory = options.engine ?? ((c) => new MatchingEngine(c));
  const rows: TimingRow[] = [];
  for (const probe of PROBES.filter((p) => !options.probes || options.probes.some((x) => p.name.startsWith(x)))) {
    const perConfig = hiddenLevels.map((n) => ({ n, medians: [] as number[], all: [] as number[] }));
    for (let r = 0; r < rounds; r++) {
      for (const cfg of perConfig) {
        const w = book(cfg.n, probe.layout, factory);
        const n = probe.heavy ? Math.max(100, Math.floor(samples / 20)) : samples;
        for (let i = 0; i < (probe.heavy ? 20 : 200); i++) probe.run(w, -1 - i); // warm-up
        const s = new Float64Array(n);
        for (let i = 0; i < n; i++) s[i] = probe.run(w, i + r * samples);
        s.sort();
        cfg.medians.push(quantile(s, 0.5));
        cfg.all.push(...s);
      }
    }
    for (const cfg of perConfig) {
      const all = Float64Array.from(cfg.all).sort();
      rows.push({ probe: probe.name, hiddenLevels: cfg.n, roundMediansUs: cfg.medians, p50Us: quantile(all, 0.5), p95Us: quantile(all, 0.95), p99Us: quantile(all, 0.99) });
    }
  }
  return rows;
}

export function formatTiming(rows: readonly TimingRow[]): string {
  const lines = ["| Probe | Hidden-only levels | Round medians (µs) | p50 µs | p95 µs | p99 µs |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.probe} | ${r.hiddenLevels} | ${r.roundMediansUs.map((v) => v.toFixed(2)).join(", ")} | ${r.p50Us.toFixed(2)} | ${r.p95Us.toFixed(2)} | ${r.p99Us.toFixed(2)} |`);
  }
  return lines.join("\n");
}
