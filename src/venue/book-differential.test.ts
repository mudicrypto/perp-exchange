import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BookSide, PriceIndex, type BookSideApi, type Order, type PriceLevel, type PriceRange } from "./book";
import { MatchingEngine, type EngineConfig } from "./engine";
import type { InstrumentSpec } from "./instrument";
import { ReferenceBookSide } from "./reference-book";
import { seededRandom, SYNTHETIC_LIMITS } from "./synthetic";
import type { CommandResult, EngineCommand, Side } from "./types";

/**
 * Milestone 12 differential verification (MATCHING-RULES M-3…M-6, D-1).
 *
 * The indexed `BookSide` must change no matching outcome. Every test runs the Milestone 11 reference book
 * (`reference-book.ts`, sorted array) and the indexed book on identical inputs and requires identical results:
 * every command's private events, public messages, executions and transitions, the state hash after every
 * command, the public book and the full (operator) book, snapshot/restore in both directions, and journal replay.
 * Any difference fails the test. Golden hashes produced by the Milestone 11 commit itself are checked in
 * `book-golden.test.ts`.
 */

// ── PriceIndex against a sorted-array model ────────────────────────────────────

class ModelIndex {
  readonly items: number[] = [];
  add(i: number) {
    if (!this.items.includes(i)) {
      this.items.push(i);
      this.items.sort((a, b) => a - b);
    }
  }
  delete(i: number) {
    const k = this.items.indexOf(i);
    if (k >= 0) this.items.splice(k, 1);
  }
  next(i: number) {
    return this.items.find((x) => x > i);
  }
  prev(i: number) {
    return [...this.items].reverse().find((x) => x < i);
  }
}

describe("M-3 / M-6 PriceIndex (indexed book ordering)", () => {
  it.each([
    ["small range", 40],
    ["one word boundary", 64],
    ["2^32 + slack (offsets beyond 32-bit)", 2 ** 32 + 100],
    ["the 10^11-tick instrument ceiling", 100_000_000_000],
  ])("M-3 add, delete, min, max, successor and predecessor equal a sorted model (%s)", (_name, capacity) => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("add", "delete", "next", "prev"),
            fc.oneof(
              fc.integer({ min: 0, max: capacity - 1 }),
              fc.constantFrom(0, 1, 30, 31, 32, 33, 63, 64, 1023, 1024, 1025, capacity - 1, Math.max(0, capacity - 32), Math.floor(capacity / 2)),
            ),
          ),
          { maxLength: 300 },
        ),
        (ops) => {
          const index = new PriceIndex(capacity);
          const model = new ModelIndex();
          for (const [op, raw] of ops) {
            const i = Math.min(capacity - 1, Math.max(0, raw));
            if (op === "add") {
              index.add(i);
              model.add(i);
            } else if (op === "delete") {
              index.delete(i);
              model.delete(i);
            } else if (op === "next") expect(index.next(i)).toBe(model.next(i));
            else expect(index.prev(i)).toBe(model.prev(i));
            expect(index.size).toBe(model.items.length);
            expect(index.min()).toBe(model.items[0]);
            expect(index.max()).toBe(model.items.at(-1));
            expect(index.has(i)).toBe(model.items.includes(i));
          }
          // Full walks in both directions reproduce the model exactly.
          const up: number[] = [];
          for (let x = index.min(); x !== undefined; x = index.next(x)) up.push(x);
          const down: number[] = [];
          for (let x = index.max(); x !== undefined; x = index.prev(x)) down.push(x);
          expect(up).toEqual(model.items);
          expect(down).toEqual([...model.items].reverse());
        },
      ),
      { numRuns: 120 },
    );
  });

  it("M-3 every bit position of a word, and adjacent words, are ordered correctly", () => {
    const index = new PriceIndex(1_000_000);
    const members = [0, 1, 15, 16, 30, 31, 32, 33, 62, 63, 64, 1023, 1024, 32_767, 32_768, 999_999];
    for (const m of [...members].reverse()) index.add(m);
    const up: number[] = [];
    for (let x = index.min(); x !== undefined; x = index.next(x)) up.push(x);
    expect(up).toEqual(members);
    for (const m of members) index.delete(m);
    expect([index.size, index.min(), index.max()]).toEqual([0, undefined, undefined]);
  });

  it("M-3 an index refuses an invalid capacity, and the book refuses a price outside its instrument range", () => {
    expect(() => new PriceIndex(0)).toThrow(/capacity/);
    const side = new BookSide("sell", () => {}, { minPriceTicks: 10, maxPriceTicks: 20 });
    const order = (priceTicks: number): Order => ({ orderId: `o${priceTicks}`, accountId: "a", clientOrderId: "c", instrumentId: "i", side: "sell", visibility: "displayed", tif: "gtc", postOnly: false, stp: "cancel-taker", priceTicks, qtyLots: 1, filledLots: 0, status: "new", priority: 1 });
    expect(() => side.add(order(9))).toThrow(/outside the instrument range/);
    expect(() => side.add(order(21))).toThrow(/outside the instrument range/);
    side.add(order(10));
    side.add(order(20));
    expect([...side.bestFirst()].map((l) => l.priceTicks)).toEqual([10, 20]);
  });
});

// ── BookSide against the reference book ───────────────────────────────────────

describe("M-4 / M-5 indexed BookSide equals the reference book operation by operation", () => {
  it("M-5 random add / reduce / remove sequences: identical levels, queues, totals, callbacks and iteration", () => {
    fc.assert(
      fc.property(fc.constantFrom<Side>("buy", "sell"), fc.integer({ min: 0, max: 1_000_000 }), fc.array(fc.nat(), { minLength: 1, maxLength: 400 }), (side, seed, ops) => {
        const range: PriceRange = { minPriceTicks: 1_000 + (seed % 7), maxPriceTicks: 1_200 };
        const calls: { a: string[]; b: string[] } = { a: [], b: [] };
        const a: BookSideApi = new BookSide(side, (s, p) => calls.a.push(`${s}@${p}`), range);
        const b: BookSideApi = new ReferenceBookSide(side, (s, p) => calls.b.push(`${s}@${p}`), range);
        const live: Order[] = [];
        let n = 0;
        const rnd = seededRandom(seed);
        for (const op of ops) {
          const kind = live.length === 0 ? 0 : op % 3;
          if (kind === 0) {
            const o: Order = {
              orderId: `o${n}`,
              accountId: `a${op % 4}`,
              clientOrderId: `c${n}`,
              instrumentId: "i",
              side,
              visibility: rnd() < 0.4 ? "hidden" : "displayed",
              tif: "gtc",
              postOnly: false,
              stp: "cancel-taker",
              priceTicks: range.minPriceTicks + Math.floor(rnd() * (range.maxPriceTicks - range.minPriceTicks + 1)),
              qtyLots: 1 + Math.floor(rnd() * 50),
              filledLots: 0,
              status: "new",
              priority: n++,
            };
            live.push(o);
            a.add({ ...o });
            b.add({ ...o });
          } else {
            const k = Math.floor(rnd() * live.length);
            const o = live[k]!;
            const left = o.qtyLots - o.filledLots;
            if (kind === 1 && left > 1) {
              const lots = 1 + Math.floor(rnd() * (left - 1));
              a.reduce(o, lots);
              b.reduce(o, lots);
              o.filledLots += lots;
            } else {
              a.remove(o);
              b.remove(o);
              live.splice(k, 1);
            }
          }
          const view = (s: BookSideApi) => ({
            best: s.best()?.priceTicks,
            depth: s.depth,
            levels: [...s.bestFirst()].map(describeLevel),
            shown: [...s.displayedBestFirst()].map(describeLevel),
          });
          expect(view(a)).toEqual(view(b));
        }
        expect(calls.a).toEqual(calls.b);
      }),
      { numRuns: 150 },
    );
  });
});

const describeLevel = (l: PriceLevel) => ({ p: l.priceTicks, d: l.displayedLots, h: l.hiddenLots, dq: [...l.displayed.keys()], hq: [...l.hidden.keys()] });

// ── The whole engine on both books ────────────────────────────────────────────

/** Test-only engine running on the Milestone 11 reference book. */
class ReferenceEngine extends MatchingEngine {
  protected override createBookSide(side: Side, onDisplayedChange: (side: Side, priceTicks: number) => void, range: PriceRange): BookSideApi {
    return new ReferenceBookSide(side, onDisplayedChange, range);
  }
}

const CONFIG: EngineConfig = { idKey: "local-prototype-key", publication: "immediate" };
const ACCOUNTS = ["syn-a", "syn-b", "syn-c", "syn-d"];

type Scenario = "mixed" | "heavy-cancel" | "hidden-only" | "shifting-reference" | "extreme-range" | "dense-ladder";

function instrument(s: Scenario): InstrumentSpec {
  if (s === "extreme-range") {
    // The full 10^11-tick ceiling, reference near the top: offsets far beyond 32 bits.
    return { id: "SYN-X", priceDecimals: 0, tickUnits: 1, sizeDecimals: 0, lotUnits: 1, minPriceTicks: 1, maxPriceTicks: 100_000_000_000, minQtyLots: 1, maxQtyLots: 1_000, priceBandBps: 5_000, minHiddenQtyLots: 5, referencePriceTicks: 99_999_990_000 };
  }
  return { id: "SYN-X", priceDecimals: 0, tickUnits: 1, sizeDecimals: 0, lotUnits: 1, minPriceTicks: 1, maxPriceTicks: 2_000_000, minQtyLots: 1, maxQtyLots: 10_000, priceBandBps: s === "shifting-reference" ? 5_000 : 1_000, minHiddenQtyLots: 5, referencePriceTicks: 10_000 };
}

/** Deterministic adversarial command streams (randomised by seed). */
function stream(s: Scenario, seed: number, n: number): EngineCommand[] {
  const rnd = seededRandom(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const spec = instrument(s);
  // At prices near 10^11 every order exceeds the synthetic notional cap; the extreme range gets limits that let it trade.
  const limits = s === "extreme-range" ? { maxOpenOrders: 500, maxOrderNotional: Number.MAX_SAFE_INTEGER, maxPositionLots: 5_000_000 } : SYNTHETIC_LIMITS;
  const out: EngineCommand[] = [{ type: "admin.add-instrument", spec }, ...ACCOUNTS.map((accountId): EngineCommand => ({ type: "admin.add-account", accountId, limits }))];
  let mid = spec.referencePriceTicks;
  const spread = s === "extreme-range" ? 2_000 : s === "dense-ladder" ? 400 : 60;
  for (let i = 0; i < n; i++) {
    if (s === "shifting-reference" && i % 25 === 0) mid = Math.max(6_000, Math.min(14_000, mid + Math.round((rnd() - 0.5) * 1_500)));
    const accountId = pick(ACCOUNTS);
    const r = rnd();
    const cancelShare = s === "heavy-cancel" ? 0.5 : 0.2;
    if (r < 0.55 - (s === "heavy-cancel" ? 0.15 : 0)) {
      const hidden = s === "hidden-only" ? rnd() < 0.8 : rnd() < 0.3;
      const side = pick(["buy", "sell"] as const);
      const tif = hidden ? "gtc" : pick(["gtc", "gtc", "gtc", "ioc", "fok"] as const);
      const market = !hidden && tif !== "gtc" && rnd() < 0.15;
      // Hidden-only scenario: hidden orders away from the touch build many hidden-only levels.
      const offset = Math.floor(rnd() * spread) - (hidden && s === "hidden-only" ? -spread : spread / 2);
      const price = Math.max(spec.minPriceTicks, Math.min(spec.maxPriceTicks, side === "buy" ? mid - offset : mid + offset));
      out.push({
        type: "new-order",
        accountId,
        clientOrderId: `c${i}`,
        instrumentId: spec.id,
        side,
        orderType: market ? "market" : "limit",
        ...(market ? {} : { priceTicks: price }),
        qtyLots: hidden ? 5 + Math.floor(rnd() * 80) : 1 + Math.floor(rnd() * 60),
        tif,
        visibility: hidden ? "hidden" : "displayed",
        postOnly: !market && tif === "gtc" && rnd() < 0.12,
        stp: pick(["cancel-taker", "cancel-maker", "cancel-both"] as const),
      });
    } else if (r < 0.55 + cancelShare - 0.15) {
      out.push({ type: "cancel", accountId, ref: { clientOrderId: `c${Math.floor(rnd() * (i + 1))}` } });
    } else if (r < 0.93) {
      const side = rnd() < 0.5 ? -1 : 1;
      out.push({ type: "replace", accountId, ref: { clientOrderId: `c${Math.floor(rnd() * (i + 1))}` }, priceTicks: Math.max(1, mid + side * Math.floor(rnd() * spread)), qtyLots: 1 + Math.floor(rnd() * 90) });
    } else if (r < 0.97) {
      out.push({ type: "mass-cancel", accountId, ...(rnd() < 0.5 ? { instrumentId: spec.id } : {}) });
    } else {
      out.push({ type: "admin.set-status", instrumentId: spec.id, status: rnd() < 0.85 ? "continuous" : "halted" });
    }
  }
  out.push({ type: "admin.set-status", instrumentId: spec.id, status: "continuous" });
  return out;
}

const SCENARIOS: Scenario[] = ["mixed", "heavy-cancel", "hidden-only", "shifting-reference", "extreme-range", "dense-ladder"];

function compareRun(commands: EngineCommand[], publication: EngineConfig["publication"], snapshotEvery = 0) {
  const config = { ...CONFIG, publication };
  let a: MatchingEngine = new MatchingEngine(config);
  let b: MatchingEngine = new ReferenceEngine(config);
  let executions = 0;
  for (const [i, command] of commands.entries()) {
    const entry = { seq: i + 1, ts: 1_000 + i, command: publication === "batched" && i % 9 === 8 ? ({ type: "publish" } as const) : command };
    const ra: CommandResult = a.process(entry);
    const rb: CommandResult = b.process(entry);
    expect(ra).toEqual(rb);
    executions += ra.executions.length;
    expect(a.stateHash()).toBe(b.stateHash());
    const id = (commands[0] as Extract<EngineCommand, { type: "admin.add-instrument" }>).spec.id;
    if (i % 10 === 0 || i === commands.length - 1) {
      expect(a.publicBook(id, 20)).toEqual(b.publicBook(id, 20));
      expect(a.publicBook(id, 3)).toEqual(b.publicBook(id, 3));
      expect(a.publicBook(id, 1)).toEqual(b.publicBook(id, 1));
      expect(a.publicBook(id, 0)).toEqual(b.publicBook(id, 0));
      expect(a.inspectBook(id)).toEqual(b.inspectBook(id));
    }
    // Snapshot from one implementation, restored into the other, continues identically.
    if (snapshotEvery && i > 0 && i % snapshotEvery === 0) {
      const snap = a.snapshot();
      a = ReferenceEngine.restore(config, snap);
      b = MatchingEngine.restore(config, b.snapshot());
      expect(a.stateHash()).toBe(b.stateHash());
    }
  }
  return executions;
}

describe("D-1 / M-3…M-6 the engine produces identical outputs on the indexed and the reference book", () => {
  it.each(SCENARIOS)("M-4 %s streams: every command result, state hash, public and full book are identical (immediate and batched)", (scenario) => {
    let executions = 0;
    for (let seed = 1; seed <= 6; seed++) {
      executions += compareRun(stream(scenario, seed * 101, 400), "immediate");
      executions += compareRun(stream(scenario, seed * 103, 300), "batched");
    }
    expect(executions).toBeGreaterThan(50); // the streams really trade
  }, 120_000);

  it("D-1 snapshots taken on one book and restored into the other continue identically", () => {
    for (const scenario of SCENARIOS) compareRun(stream(scenario, 7, 300), "immediate", 37);
  }, 120_000);

  it("D-1 property: random seeds and scenarios never produce a difference", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SCENARIOS), fc.integer({ min: 1, max: 1_000_000 }), (scenario, seed) => {
        compareRun(stream(scenario, seed, 150), seed % 2 ? "immediate" : "batched", seed % 3 ? 0 : 29);
      }),
      { numRuns: 60 },
    );
  }, 240_000);

  it("D-1 a journal of one implementation replays to the same state and outputs on the other", () => {
    const commands = stream("mixed", 4242, 500);
    const a = new MatchingEngine(CONFIG);
    const results = commands.map((command, i) => a.process({ seq: i + 1, ts: i, command }));
    const b = new ReferenceEngine(CONFIG);
    const replayed = commands.map((command, i) => b.process({ seq: i + 1, ts: i, command }));
    expect(replayed).toEqual(results);
    expect(b.stateHash()).toBe(a.stateHash());
  });
});
