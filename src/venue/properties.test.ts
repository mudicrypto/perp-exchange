import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatPrice, formatQuantity, priceToTicks, quantityToLots, SYNTHETIC_INSTRUMENTS } from "./instrument";
import { reconcile } from "./reconcile";
import { isAllowedTransition, isTerminal, type OrderState } from "./state-machine";
import { createLocalVenue } from "./synthetic";
import { ALPHA } from "./test-helpers";
import { publicMessageSchema, STP_MODES, type CommandResult, type EngineCommand, type PrivateEvent } from "./types";
import { Venue } from "./venue";

/**
 * Property-based tests: random command sequences over a small, collision-
 * heavy domain (3 accounts, 21 price ticks, reused client ids) so that
 * matching, STP, replaces and cancels interact constantly.
 */

const ACCOUNTS = ["syn-a", "syn-b", "syn-c"] as const;
const account = fc.constantFrom(...ACCOUNTS);
const clientOrderId = fc.integer({ min: 0, max: 40 }).map((i) => `c${i}`);
const price = fc.integer({ min: 3_990, max: 4_010 });

const newOrder = (allowMarket: boolean) =>
  fc
    .record({
      accountId: account,
      clientOrderId,
      side: fc.constantFrom("buy" as const, "sell" as const),
      market: allowMarket ? fc.integer({ min: 0, max: 9 }).map((n) => n === 0) : fc.constant(false),
      priceTicks: price,
      qtyLots: fc.integer({ min: 1, max: 250 }),
      tif: fc.constantFrom("gtc" as const, "gtc" as const, "ioc" as const, "fok" as const),
      visibility: fc.constantFrom("displayed" as const, "displayed" as const, "hidden" as const),
      postOnly: fc.integer({ min: 0, max: 5 }).map((n) => n === 0),
      stp: fc.constantFrom(...STP_MODES),
    })
    .map(({ market, priceTicks, ...o }): EngineCommand =>
      market
        ? { type: "new-order", instrumentId: ALPHA, orderType: "market", ...o, tif: o.tif === "gtc" ? "ioc" : o.tif, visibility: "displayed", postOnly: false }
        : o.visibility === "hidden"
          ? // Mostly valid hidden orders (GTC, ≥ minimum size); every 10th stays as generated to exercise rejections.
            { type: "new-order", instrumentId: ALPHA, orderType: "limit", priceTicks, ...o, ...(o.qtyLots % 10 ? { tif: "gtc", qtyLots: 100 + o.qtyLots } : {}) }
          : { type: "new-order", instrumentId: ALPHA, orderType: "limit", priceTicks, ...o },
    );

const commandArb = (allowMarket = true): fc.Arbitrary<EngineCommand> =>
  fc.oneof(
    { arbitrary: newOrder(allowMarket), weight: 10 },
    { arbitrary: fc.record({ accountId: account, clientOrderId }).map(({ accountId, clientOrderId }): EngineCommand => ({ type: "cancel", accountId, ref: { clientOrderId } })), weight: 3 },
    {
      arbitrary: fc
        .record({ accountId: account, clientOrderId, priceTicks: price, qtyLots: fc.integer({ min: 1, max: 250 }) })
        .map(({ accountId, clientOrderId, priceTicks, qtyLots }): EngineCommand => ({ type: "replace", accountId, ref: { clientOrderId }, priceTicks, qtyLots })),
      weight: 3,
    },
    { arbitrary: account.map((accountId): EngineCommand => ({ type: "mass-cancel", accountId })), weight: 1 },
    { arbitrary: fc.constant<EngineCommand>({ type: "publish" }), weight: 2 },
    { arbitrary: fc.constantFrom<EngineCommand>({ type: "admin.set-status", instrumentId: ALPHA, status: "halted" }, { type: "admin.set-status", instrumentId: ALPHA, status: "continuous" }), weight: 1 },
  );

const LIMITS = { maxOpenOrders: 12, maxOrderNotional: 1_500_000, maxPositionLots: 800 };

function fresh(publication: "immediate" | "batched" = "immediate", extraAccounts: string[] = []) {
  return createLocalVenue({ accounts: [...ACCOUNTS, ...extraAccounts], limits: LIMITS, publication });
}

const RUNS = { numRuns: 150 };
const sequences = (allowMarket = true) => fc.array(commandArb(allowMarket), { minLength: 10, maxLength: 120, size: "max" });

describe("invariants under random command sequences", () => {
  it("M-6 / reconciliation holds after every command (uncrossed book, conservation, zero-sum, open lots, limits, queue order)", () => {
    fc.assert(
      fc.property(sequences(), fc.constantFrom("immediate" as const, "batched" as const), (commands, publication) => {
        const { venue, clock } = fresh(publication);
        for (const command of commands) {
          clock.advance(1);
          venue.submit(command);
          const report = reconcile(venue);
          if (!report.ok) throw new Error(report.violations.join("\n"));
        }
      }),
      RUNS,
    );
  });

  it("state machine: every order follows allowed transitions and terminal states are absorbing", () => {
    fc.assert(
      fc.property(sequences(), (commands) => {
        const { venue, clock } = fresh();
        for (const c of commands) {
          clock.advance(1);
          venue.submit(c);
        }
        const state = new Map<string, OrderState>();
        for (const t of venue.transitions) {
          expect(isAllowedTransition(t.from, t.cause, t.to)).toBe(true);
          if (t.orderId === null) {
            expect(t.to).toBe("rejected");
            continue;
          }
          const current = state.get(t.orderId) ?? "received";
          expect(t.from).toBe(current);
          if (current !== "received") expect(isTerminal(current)).toBe(false);
          state.set(t.orderId, t.to);
        }
      }),
      RUNS,
    );
  });

  it("M-2 … M-5 / H-3 executions follow price, then displayed-before-hidden, then time priority; never beyond the taker's limit", () => {
    fc.assert(
      fc.property(sequences(), (commands) => {
        const { venue, clock } = fresh();
        for (const command of commands) {
          clock.advance(1);
          const priority = new Map<string, number>();
          for (const level of venue.engine.inspectBook(ALPHA)) for (const o of [...level.displayed, ...level.hidden]) priority.set(o.orderId, o.priority);
          const r = venue.submit(command);
          const xs = r.executions;
          for (let i = 1; i < xs.length; i++) {
            const [a, b] = [xs[i - 1]!, xs[i]!];
            expect(b.takerOrderId).toBe(a.takerOrderId);
            if (a.aggressor === "buy") expect(b.priceTicks).toBeGreaterThanOrEqual(a.priceTicks);
            else expect(b.priceTicks).toBeLessThanOrEqual(a.priceTicks);
            if (a.priceTicks !== b.priceTicks) continue;
            expect(a.makerVisibility === "hidden" && b.makerVisibility === "displayed").toBe(false);
            if (a.makerVisibility === b.makerVisibility && a.makerOrderId !== b.makerOrderId) {
              expect(priority.get(a.makerOrderId)!).toBeLessThan(priority.get(b.makerOrderId)!);
            }
          }
          if (command.type === "new-order" && command.orderType === "limit") {
            for (const x of xs) expect(command.side === "buy" ? x.priceTicks <= command.priceTicks! : x.priceTicks >= command.priceTicks!).toBe(true);
            // An IOC remainder is only cancelled when no crossing liquidity is left (absent STP).
            const stp = r.private.some((e) => e.kind === "cancelled" && e.reason === "self-trade-prevention");
            const iocRemainder = r.private.some((e) => e.kind === "cancelled" && e.reason === "ioc-remainder");
            if (iocRemainder && !stp) {
              const opposite = venue.engine.inspectBook(ALPHA).filter((l) => l.side !== command.side);
              const crossing = opposite.filter((l) => (command.side === "buy" ? l.priceTicks <= command.priceTicks! : l.priceTicks >= command.priceTicks!));
              expect(crossing).toEqual([]);
            }
          }
        }
      }),
      RUNS,
    );
  });
});

describe("determinism and recovery", () => {
  it("D-1 replaying the journal (from scratch or from any snapshot) reproduces state and every output", () => {
    fc.assert(
      fc.property(sequences(), fc.nat(), fc.constantFrom("immediate" as const, "batched" as const), (commands, cut, publication) => {
        const { venue, clock } = fresh(publication);
        const k = cut % (commands.length + 1);
        let snapshot: ReturnType<Venue["snapshot"]> | undefined;
        commands.forEach((c, i) => {
          if (i === k) snapshot = venue.snapshot();
          clock.advance(1);
          venue.submit(c);
        });
        const options = { engine: { idKey: "local-prototype-key", publication }, clock: clock.read, allowTestFixtureIdKey: true };
        const jsonl = venue.journal.toJsonl();
        for (const snap of [undefined, snapshot]) {
          const { venue: again } = Venue.recover(options, jsonl, snap);
          expect(again.engine.stateHash()).toBe(venue.engine.stateHash());
          expect(again.outputHead).toBe(venue.outputHead);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("hidden-order confidentiality towards the public and other participants", () => {
  /** Normalises opaque ids (which depend on global sequence numbers) to first-appearance indices. */
  function normalise(events: readonly PrivateEvent[]) {
    const ids = new Map<string, string>();
    const norm = (id: string) => {
      if (!ids.has(id)) ids.set(id, `#${ids.size}`);
      return ids.get(id)!;
    };
    return JSON.parse(JSON.stringify(events), (key, value: unknown) => (typeof value === "string" && (key === "orderId" || key === "fillId") ? norm(value) : value));
  }

  it("H-1 / H-8 non-interference: hidden orders that never trade change no public message, public sequence, timestamp, or other account's events", () => {
    const ghost = fc.record({
      at: fc.nat(),
      side: fc.constantFrom("buy" as const, "sell" as const),
      offset: fc.integer({ min: 0, max: 50 }),
      qtyLots: fc.integer({ min: 100, max: 5_000 }),
      cancelAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(sequences(false), fc.array(ghost, { maxLength: 8 }), fc.constantFrom("immediate" as const, "batched" as const), (commands, ghosts, publication) => {
        // Ghost prices sit 250+ ticks away from every price the flow can reach (market orders excluded).
        const run = (withGhosts: boolean) => {
          const { venue, clock } = fresh(publication, ["syn-ghost"]);
          const results: CommandResult[] = [];
          const schedule = new Map<number, EngineCommand[]>();
          if (withGhosts) {
            ghosts.forEach((g, i) => {
              const at = g.at % (commands.length + 1);
              const cid = `g${i}`;
              const add: EngineCommand = {
                type: "new-order",
                accountId: "syn-ghost",
                clientOrderId: cid,
                instrumentId: ALPHA,
                side: g.side,
                orderType: "limit",
                priceTicks: g.side === "buy" ? 3_700 + g.offset : 4_300 - g.offset,
                qtyLots: g.qtyLots,
                tif: "gtc",
                visibility: "hidden",
                postOnly: false,
                stp: "cancel-taker",
              };
              schedule.set(at, [...(schedule.get(at) ?? []), add]);
              if (g.cancelAfter !== undefined) {
                const when = Math.min(commands.length, at + g.cancelAfter);
                schedule.set(when, [...(schedule.get(when) ?? []), { type: "cancel", accountId: "syn-ghost", ref: { clientOrderId: cid } }]);
              }
            });
          }
          for (let i = 0; i <= commands.length; i++) {
            for (const g of schedule.get(i) ?? []) venue.submit(g); // no clock advance: same timestamps as the base run
            const c = commands[i];
            if (c) {
              clock.advance(1);
              results.push(venue.submit(c));
            }
          }
          return {
            publicTape: venue.publicTape,
            publicBook: venue.engine.publicBook(ALPHA),
            others: ACCOUNTS.map((a) => normalise(venue.privateEvents(a))),
            ghostExecutions: venue.executions.filter((x) => x.makerAccountId === "syn-ghost" || x.takerAccountId === "syn-ghost").length,
          };
        };
        const base = run(false);
        const withGhosts = run(true);
        expect(withGhosts.ghostExecutions).toBe(0);
        expect(withGhosts.publicTape).toEqual(base.publicTape);
        expect(withGhosts.publicBook).toEqual(base.publicBook);
        expect(withGhosts.others).toEqual(base.others);
      }),
      { numRuns: 120 },
    );
  });

  it("A-2 / H-5 public messages are strict and carry no account, order, client-order or visibility data; private events reach only their owner", () => {
    fc.assert(
      fc.property(sequences(), (commands) => {
        const { venue, clock } = fresh();
        for (const c of commands) {
          clock.advance(1);
          venue.submit(c);
        }
        for (const m of venue.publicTape) {
          expect(publicMessageSchema.safeParse(m).success).toBe(true);
          const text = JSON.stringify(m);
          expect(text).not.toMatch(/syn-|"o[0-9a-f]{16}"|"f[0-9a-f]{16}"|"hidden"|"displayed"|"c[0-9]+"/);
        }
        for (const a of ACCOUNTS) for (const e of venue.privateEvents(a)) expect(e.accountId).toBe(a);
      }),
      RUNS,
    );
  });
});

describe("gateway properties", () => {
  const spec = SYNTHETIC_INSTRUMENTS[0]!;

  it("I-1 decimal conversion is exact and round-trips; arbitrary strings never crash and never round", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: spec.maxPriceTicks }), fc.integer({ min: 1, max: spec.maxQtyLots }), (ticks, lots) => {
        expect(priceToTicks(spec, formatPrice(spec, ticks))).toEqual({ ok: true, value: ticks });
        expect(quantityToLots(spec, formatQuantity(spec, lots))).toEqual({ ok: true, value: lots });
      }),
    );
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[0-9]{1,8}(\.[0-9]{0,6})?$/)), (text) => {
        const r = priceToTicks(spec, text);
        if (r.ok) {
          expect(Number.isSafeInteger(r.value)).toBe(true);
          expect(Number(formatPrice(spec, r.value))).toBe(Number(text));
        }
      }),
    );
  });

  it("A-4 an identical retry is answered from the idempotency record without a second order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3_990, max: 4_010 }), fc.integer({ min: 1, max: 250 }), fc.constantFrom("buy" as const, "sell" as const), (ticks, lots, side) => {
        const { venue, gateway, tokens, clock } = fresh();
        const message = { op: "new", clientOrderId: "retry-me", instrumentId: ALPHA, side, type: "limit", price: formatPrice(spec, ticks), quantity: formatQuantity(spec, lots) } as const;
        const first = gateway.handle(tokens.get("syn-a")!, message);
        const journaled = venue.journal.lastSeq;
        clock.advance(5);
        const second = gateway.handle(tokens.get("syn-a")!, message);
        expect(venue.journal.lastSeq).toBe(journaled);
        expect(second).toEqual(first.ok ? { ...first, replayed: true } : first);
      }),
      { numRuns: 50 },
    );
  });
});
