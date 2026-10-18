import { BookSide, leaves, type Order } from "./book.ts";
import type { AccountLimits, InstrumentSpec } from "./instrument.ts";
import { canonicalJson, sha256 } from "./journal.ts";
import { isAllowedTransition, isLive } from "./state-machine.ts";
import type {
  CancelReason,
  CommandResult,
  EngineCommand,
  Execution,
  NewOrderCommand,
  OrderRef,
  OrderView,
  PrivateEvent,
  PrivateEventBody,
  PublicBook,
  PublicMessage,
  RejectReason,
  SequencedCommand,
  Side,
  StpMode,
  TradingStatus,
  Transition,
} from "./types.ts";

/**
 * Deterministic single-threaded matching engine (docs/venue/MATCHING-RULES.md).
 *
 * - Input: gap-free sequenced commands. The engine never reads a clock, a
 *   random source or the network, so replaying a journal reproduces every
 *   state and output exactly.
 * - Output per command: private events (per account), public market data,
 *   execution records and order transitions (audit).
 * - Fail-stop: an invariant violation stops the engine instead of letting it
 *   continue in an unknown state.
 *
 * Local prototype only: synthetic instruments and accounts, no funds, no
 * connection to any external venue.
 */

export class EngineIntegrityError extends Error {
  override readonly name = "EngineIntegrityError";
}

export interface EngineConfig {
  /** Key for opaque order/fill identifiers (identifiers must not reveal sequence numbers). */
  readonly idKey: string;
  /** `immediate`: publish after every command. `batched`: publish only on `publish` commands. */
  readonly publication: "immediate" | "batched";
}

interface Holding {
  position: number;
  openBuyLots: number;
  openSellLots: number;
  /** Quote balance change in tick·lot units (synthetic; no real funds). */
  cash: bigint;
}

interface AccountState {
  readonly id: string;
  readonly limits: AccountLimits;
  suspended: boolean;
  accountSeq: number;
  readonly holdings: Map<string, Holding>;
  /** Resting orders (live ⇔ resting between commands). */
  readonly live: Set<string>;
}

interface InstrumentState {
  readonly spec: InstrumentSpec;
  status: TradingStatus;
  referencePriceTicks: number;
  readonly bids: BookSide;
  readonly asks: BookSide;
  /** Displayed lots per "side:price" as last published. */
  readonly published: Map<string, number>;
  /** Levels whose displayed quantity changed since the last publication. */
  readonly dirty: Set<string>;
}

type PendingPublic =
  | { kind: "trade"; instrumentId: string; priceTicks: number; qtyLots: number; aggressor: Side }
  | { kind: "status"; instrumentId: string; status: TradingStatus };

type Step = { kind: "fill"; maker: Order; qty: number } | { kind: "stp-cancel-maker"; maker: Order };

interface Plan {
  readonly steps: Step[];
  readonly filled: number;
  /** Matching stopped at the taker's own order and STP cancels the taker. */
  readonly cancelTaker: boolean;
}

interface Ctx {
  readonly seq: number;
  readonly ts: number;
  readonly private: PrivateEvent[];
  readonly executions: Execution[];
  readonly transitions: Transition[];
  adminError?: string;
}

export interface EngineSnapshot {
  readonly version: 1;
  readonly lastSeq: number;
  readonly lastTs: number;
  readonly execCount: number;
  readonly publicSeq: number;
  readonly tradeCount: number;
  readonly instruments: readonly {
    spec: InstrumentSpec;
    status: TradingStatus;
    referencePriceTicks: number;
    published: [string, number][];
    dirty: string[];
  }[];
  readonly accounts: readonly {
    id: string;
    limits: AccountLimits;
    suspended: boolean;
    accountSeq: number;
    holdings: [string, { position: number; openBuyLots: number; openSellLots: number; cash: string }][];
  }[];
  readonly orders: readonly Order[];
  readonly pending: readonly PendingPublic[];
}

export interface BookLevelDetail {
  readonly side: Side;
  readonly priceTicks: number;
  readonly displayedLots: number;
  readonly hiddenLots: number;
  readonly displayed: readonly Readonly<Order>[];
  readonly hidden: readonly Readonly<Order>[];
}

const crosses = (side: Side, limit: number, restingPrice: number) => (side === "buy" ? restingPrice <= limit : restingPrice >= limit);
const levelKey = (side: Side, priceTicks: number) => `${side}:${priceTicks}`;
const clientKey = (accountId: string, clientOrderId: string) => `${accountId}\u0000${clientOrderId}`;

export function orderView(o: Readonly<Order>): OrderView {
  return {
    orderId: o.orderId,
    clientOrderId: o.clientOrderId,
    instrumentId: o.instrumentId,
    side: o.side,
    priceTicks: o.priceTicks,
    qtyLots: o.qtyLots,
    filledLots: o.filledLots,
    leavesLots: leaves(o),
    visibility: o.visibility,
    tif: o.tif,
    postOnly: o.postOnly,
    status: o.status,
  };
}

export class MatchingEngine {
  private readonly config: EngineConfig;
  private readonly instruments = new Map<string, InstrumentState>();
  private readonly accounts = new Map<string, AccountState>();
  private readonly orders = new Map<string, Order>();
  private readonly byClientId = new Map<string, string>();
  private pending: PendingPublic[] = [];
  private lastSeq = 0;
  private lastTs = 0;
  private execCount = 0;
  private publicSeq = 0;
  private tradeCount = 0;
  private stopped: string | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  get sequence() {
    return this.lastSeq;
  }

  get stoppedReason() {
    return this.stopped;
  }

  process(entry: SequencedCommand): CommandResult {
    if (this.stopped) throw new EngineIntegrityError(`engine stopped: ${this.stopped}`);
    if (entry.seq !== this.lastSeq + 1) throw new EngineIntegrityError(`sequence ${entry.seq} after ${this.lastSeq}`);
    if (!Number.isSafeInteger(entry.ts) || entry.ts < this.lastTs) throw new EngineIntegrityError(`timestamp went backwards at ${entry.seq}`);
    const ctx: Ctx = { seq: entry.seq, ts: entry.ts, private: [], executions: [], transitions: [] };
    let published: PublicMessage[];
    try {
      this.dispatch(entry.command, ctx);
      this.lastSeq = entry.seq;
      this.lastTs = entry.ts;
      published = this.config.publication === "immediate" || entry.command.type === "publish" ? this.flush(entry.ts) : [];
    } catch (error) {
      this.stopped = error instanceof Error ? error.message : String(error);
      throw error instanceof EngineIntegrityError ? error : new EngineIntegrityError(this.stopped);
    }
    return {
      seq: entry.seq,
      ts: entry.ts,
      private: ctx.private,
      public: published,
      executions: ctx.executions,
      transitions: ctx.transitions,
      ...(ctx.adminError ? { adminError: ctx.adminError } : {}),
    };
  }

  /**
   * Applies a quarantined (voided) journal entry (MATCHING-RULES D-7): the command takes no effect, the
   * sequence and clock advance, and the submitter gets a definitive answer. Deterministic, and touches
   * nothing the faulting code path touches, so it cannot fault the way the command did.
   * - new order: `rejected` with reason `quarantined` (the client order id is not consumed)
   * - cancel / replace: `request-rejected` with reason `quarantined`
   * - any other command: no private event; `adminError` "quarantined"
   */
  voidEntry(entry: SequencedCommand): CommandResult {
    if (this.stopped) throw new EngineIntegrityError(`engine stopped: ${this.stopped}`);
    if (entry.seq !== this.lastSeq + 1) throw new EngineIntegrityError(`sequence ${entry.seq} after ${this.lastSeq}`);
    if (!Number.isSafeInteger(entry.ts) || entry.ts < this.lastTs) throw new EngineIntegrityError(`timestamp went backwards at ${entry.seq}`);
    const ctx: Ctx = { seq: entry.seq, ts: entry.ts, private: [], executions: [], transitions: [] };
    const c = entry.command;
    if (c.type === "new-order") {
      ctx.transitions.push({ orderId: null, from: "received", to: "rejected", cause: "reject" });
      this.emit(ctx, c.accountId, { kind: "rejected", clientOrderId: c.clientOrderId, reason: "quarantined" });
    } else if (c.type === "cancel" || c.type === "replace") {
      this.emit(ctx, c.accountId, { kind: "request-rejected", request: c.type, ref: c.ref, reason: "quarantined" });
    } else {
      ctx.adminError = "quarantined";
    }
    this.lastSeq = entry.seq;
    this.lastTs = entry.ts;
    return { seq: entry.seq, ts: entry.ts, private: ctx.private, public: [], executions: [], transitions: ctx.transitions, ...(ctx.adminError ? { adminError: ctx.adminError } : {}) };
  }

  private dispatch(command: EngineCommand, ctx: Ctx) {
    switch (command.type) {
      case "new-order":
        return this.newOrder(command, ctx);
      case "cancel":
        return this.cancel(command.accountId, command.ref, ctx);
      case "replace":
        return this.replace(command.accountId, command.ref, command.priceTicks, command.qtyLots, ctx);
      case "mass-cancel":
        return this.massCancel(command.accountId, command.instrumentId, ctx);
      case "publish":
      case "admin.anchor-bootstrap": // audit record only (D-6)
        return;
      case "admin.add-instrument":
        if (this.instruments.has(command.spec.id)) ctx.adminError = "instrument exists";
        else this.addInstrument(command.spec);
        return;
      case "admin.add-account":
        if (this.accounts.has(command.accountId)) ctx.adminError = "account exists";
        else this.addAccount(command.accountId, command.limits);
        return;
      case "admin.set-status": {
        const inst = this.instruments.get(command.instrumentId);
        if (!inst) ctx.adminError = "unknown instrument";
        else if (inst.status !== command.status) {
          inst.status = command.status;
          this.pending.push({ kind: "status", instrumentId: inst.spec.id, status: command.status });
        }
        return;
      }
      case "admin.suspend-account":
        return this.suspend(command.accountId, ctx);
      case "admin.quarantine": // the voided command itself is handled by voidEntry (D-7)
        if (command.suspendAccount) {
          if (command.accountId === undefined) ctx.adminError = "quarantine: no account to suspend";
          else this.suspend(command.accountId, ctx);
        }
        return;
    }
  }

  // ── admin ────────────────────────────────────────────────────────────────

  private suspend(accountId: string, ctx: Ctx) {
    const account = this.accounts.get(accountId);
    if (!account) ctx.adminError = "unknown account";
    else {
      for (const id of [...account.live]) this.cancelResting(ctx, this.orders.get(id)!, "account-suspended");
      account.suspended = true;
    }
  }

  private addInstrument(spec: InstrumentSpec) {
    const dirty = new Set<string>();
    const mark = (side: Side, price: number) => dirty.add(levelKey(side, price));
    this.instruments.set(spec.id, {
      spec,
      status: "continuous",
      referencePriceTicks: spec.referencePriceTicks,
      bids: new BookSide("buy", mark),
      asks: new BookSide("sell", mark),
      published: new Map(),
      dirty,
    });
    this.pending.push({ kind: "status", instrumentId: spec.id, status: "continuous" });
  }

  private addAccount(id: string, limits: AccountLimits) {
    this.accounts.set(id, { id, limits, suspended: false, accountSeq: 0, holdings: new Map(), live: new Set() });
  }

  // ── order entry ──────────────────────────────────────────────────────────

  private newOrder(cmd: NewOrderCommand, ctx: Ctx) {
    const reject = (reason: RejectReason) => {
      ctx.transitions.push({ orderId: null, from: "received", to: "rejected", cause: "reject" });
      this.emit(ctx, cmd.accountId, { kind: "rejected", clientOrderId: cmd.clientOrderId, reason });
    };
    const account = this.accounts.get(cmd.accountId);
    if (!account) return reject("unknown-account");
    if (account.suspended) return reject("account-suspended");
    const inst = this.instruments.get(cmd.instrumentId);
    if (!inst) return reject("unknown-instrument");
    if (inst.status !== "continuous") return reject("trading-halted");
    const spec = inst.spec;
    if (cmd.qtyLots < spec.minQtyLots || cmd.qtyLots > spec.maxQtyLots) return reject("quantity-out-of-range");

    let limit: number;
    if (cmd.orderType === "market") {
      if (cmd.priceTicks !== undefined) return reject("price-not-allowed");
      if (cmd.tif === "gtc") return reject("market-requires-ioc-or-fok");
      if (cmd.visibility === "hidden") return reject("hidden-requires-gtc");
      if (cmd.postOnly) return reject("post-only-requires-gtc");
      limit = this.collar(inst, cmd.side);
    } else {
      if (cmd.priceTicks === undefined) return reject("price-required");
      const priceError = this.checkPrice(inst, cmd.priceTicks);
      if (priceError) return reject(priceError);
      limit = cmd.priceTicks;
    }
    if (cmd.visibility === "hidden") {
      if (cmd.tif !== "gtc") return reject("hidden-requires-gtc");
      if (cmd.qtyLots < spec.minHiddenQtyLots) return reject("hidden-below-minimum");
    }
    if (cmd.postOnly && cmd.tif !== "gtc") return reject("post-only-requires-gtc");
    if (this.byClientId.has(clientKey(cmd.accountId, cmd.clientOrderId))) return reject("duplicate-client-order-id");
    const riskError = this.checkRisk(account, inst, cmd.side, limit, cmd.qtyLots, 0, cmd.tif === "gtc");
    if (riskError) return reject(riskError);
    if (cmd.postOnly && this.crossesBest(inst, cmd.side, limit)) return reject("post-only-would-take");

    const order: Order = {
      orderId: this.opaqueId("o", ctx.seq),
      accountId: cmd.accountId,
      clientOrderId: cmd.clientOrderId,
      instrumentId: cmd.instrumentId,
      side: cmd.side,
      visibility: cmd.visibility,
      tif: cmd.tif,
      postOnly: cmd.postOnly,
      stp: cmd.stp,
      priceTicks: limit,
      qtyLots: cmd.qtyLots,
      filledLots: 0,
      status: "new",
      priority: ctx.seq,
    };
    if (this.orders.has(order.orderId)) throw new EngineIntegrityError("order id collision");
    this.orders.set(order.orderId, order);
    this.byClientId.set(clientKey(order.accountId, order.clientOrderId), order.orderId);
    ctx.transitions.push({ orderId: order.orderId, from: "received", to: "new", cause: "accept" });
    this.emit(ctx, order.accountId, { kind: "accepted", order: orderView(order) });

    const plan = this.plan(inst, order, limit, order.qtyLots);
    if (order.tif === "fok" && plan.filled < order.qtyLots) {
      // All-or-nothing: nothing in the plan (fills or STP cancels) is applied.
      return this.cancelUnrested(ctx, order, "fok-unfilled");
    }
    this.execute(ctx, inst, order, plan);
    this.settleTaker(ctx, order, plan);
  }

  /** After matching: STP cancel, rest (GTC) or cancel the remainder (IOC/FOK/market). */
  private settleTaker(ctx: Ctx, order: Order, plan: Plan) {
    if (!isLive(order.status)) return;
    if (plan.cancelTaker) return this.cancelUnrested(ctx, order, "self-trade-prevention");
    if (leaves(order) === 0) return;
    if (order.tif === "gtc") this.rest(order);
    else this.cancelUnrested(ctx, order, "ioc-remainder");
  }

  private cancel(accountId: string, ref: OrderRef, ctx: Ctx) {
    const order = this.resolve(accountId, ref);
    // Another account's order is indistinguishable from a non-existent one.
    if (!order) return this.emit(ctx, accountId, { kind: "request-rejected", request: "cancel", ref, reason: "unknown-order" });
    if (!isLive(order.status)) return this.emit(ctx, accountId, { kind: "request-rejected", request: "cancel", ref, reason: "order-not-modifiable" });
    this.cancelResting(ctx, order, "user");
  }

  private replace(accountId: string, ref: OrderRef, priceTicks: number, qtyLots: number, ctx: Ctx) {
    const refuse = (reason: RejectReason) => this.emit(ctx, accountId, { kind: "request-rejected", request: "replace", ref, reason });
    const order = this.resolve(accountId, ref);
    if (!order) return refuse("unknown-order");
    if (!isLive(order.status)) return refuse("order-not-modifiable");
    const account = this.accounts.get(accountId)!;
    const inst = this.instruments.get(order.instrumentId)!;
    if (inst.status !== "continuous") return refuse("trading-halted");
    const priceError = this.checkPrice(inst, priceTicks);
    if (priceError) return refuse(priceError);
    if (qtyLots < inst.spec.minQtyLots || qtyLots > inst.spec.maxQtyLots) return refuse("quantity-out-of-range");
    if (qtyLots <= order.filledLots) return refuse("replace-quantity-below-filled");
    if (priceTicks === order.priceTicks && qtyLots === order.qtyLots) return refuse("replace-no-change");
    if (order.visibility === "hidden" && qtyLots < inst.spec.minHiddenQtyLots) return refuse("hidden-below-minimum");
    const oldLeaves = leaves(order);
    const newLeaves = qtyLots - order.filledLots;
    const riskError = this.checkRisk(account, inst, order.side, priceTicks, qtyLots, oldLeaves, false, newLeaves);
    if (riskError) return refuse(riskError);
    if (order.postOnly && this.crossesBest(inst, order.side, priceTicks)) return refuse("post-only-would-take");

    // Priority is kept only for a pure size reduction at the same price.
    const retain = priceTicks === order.priceTicks && newLeaves <= oldLeaves;
    const side = this.sideOf(inst, order.side);
    const holding = this.holding(account, inst.spec.id);
    this.addOpen(holding, order.side, -oldLeaves);
    if (retain) {
      side.reduce(order, oldLeaves - newLeaves);
      order.qtyLots = qtyLots;
    } else {
      side.remove(order);
      account.live.delete(order.orderId);
      order.priceTicks = priceTicks;
      order.qtyLots = qtyLots;
      order.priority = ctx.seq;
    }
    this.setStatus(ctx, order, "replace", order.status);
    this.emit(ctx, accountId, { kind: "replaced", order: orderView(order), priorityRetained: retain });
    if (retain) {
      this.addOpen(holding, order.side, newLeaves);
      return;
    }
    // A replace that crosses trades immediately as a taker, then rests the remainder.
    const plan = this.plan(inst, order, priceTicks, newLeaves);
    this.execute(ctx, inst, order, plan);
    this.settleTaker(ctx, order, plan);
  }

  private massCancel(accountId: string, instrumentId: string | undefined, ctx: Ctx) {
    const account = this.accounts.get(accountId);
    let count = 0;
    for (const id of account ? [...account.live] : []) {
      const order = this.orders.get(id)!;
      if (instrumentId && order.instrumentId !== instrumentId) continue;
      this.cancelResting(ctx, order, "mass-cancel");
      count++;
    }
    this.emit(ctx, accountId, { kind: "mass-cancelled", count });
  }

  // ── validation & risk ────────────────────────────────────────────────────

  private checkPrice(inst: InstrumentState, priceTicks: number): RejectReason | null {
    const { spec } = inst;
    if (priceTicks < spec.minPriceTicks || priceTicks > spec.maxPriceTicks) return "price-out-of-range";
    const ref = inst.referencePriceTicks;
    if (Math.abs(priceTicks - ref) * 10_000 > spec.priceBandBps * ref) return "price-out-of-band";
    return null;
  }

  /** Protection price for market orders: the edge of the price band. */
  private collar(inst: InstrumentState, side: Side): number {
    const { spec } = inst;
    const ref = inst.referencePriceTicks;
    const raw = side === "buy" ? Math.floor((ref * (10_000 + spec.priceBandBps)) / 10_000) : Math.ceil((ref * (10_000 - spec.priceBandBps)) / 10_000);
    return Math.min(spec.maxPriceTicks, Math.max(spec.minPriceTicks, raw));
  }

  /**
   * Pre-trade risk on the worst case: every open order on the order's side
   * fills. `releaseLots` are open lots being replaced; `newLeaves` defaults to
   * the full quantity.
   */
  private checkRisk(
    account: AccountState,
    inst: InstrumentState,
    side: Side,
    priceTicks: number,
    qtyLots: number,
    releaseLots: number,
    willRest: boolean,
    newLeaves = qtyLots,
  ): RejectReason | null {
    const { limits } = account;
    if (willRest && account.live.size >= limits.maxOpenOrders) return "max-open-orders";
    if (priceTicks * qtyLots > limits.maxOrderNotional) return "max-order-notional";
    const h = this.holding(account, inst.spec.id);
    const worst = side === "buy" ? h.position + h.openBuyLots - releaseLots + newLeaves : -(h.position - (h.openSellLots - releaseLots) - newLeaves);
    if (worst > limits.maxPositionLots) return "max-position";
    return null;
  }

  private crossesBest(inst: InstrumentState, side: Side, limit: number) {
    const best = this.sideOf(inst, side === "buy" ? "sell" : "buy").best();
    return best !== undefined && crosses(side, limit, best.priceTicks);
  }

  // ── matching ─────────────────────────────────────────────────────────────

  /**
   * Computes the match without mutating anything. Order of consumption:
   * better price first; at a price, displayed orders before hidden orders;
   * within each, earlier priority first (rules M-3 … M-5).
   */
  private plan(inst: InstrumentState, taker: Order, limit: number, qty: number): Plan {
    const steps: Step[] = [];
    let remaining = qty;
    let cancelTaker = false;
    const stp: StpMode = taker.stp;
    const opposite = this.sideOf(inst, taker.side === "buy" ? "sell" : "buy");
    outer: for (const level of opposite.bestFirst()) {
      if (remaining === 0 || !crosses(taker.side, limit, level.priceTicks)) break;
      for (const queue of [level.displayed, level.hidden]) {
        for (const maker of queue.values()) {
          if (remaining === 0) break outer;
          if (maker.accountId === taker.accountId) {
            if (stp === "cancel-maker") {
              steps.push({ kind: "stp-cancel-maker", maker });
              continue;
            }
            if (stp === "cancel-both") steps.push({ kind: "stp-cancel-maker", maker });
            cancelTaker = true;
            break outer;
          }
          const q = Math.min(remaining, leaves(maker));
          steps.push({ kind: "fill", maker, qty: q });
          remaining -= q;
        }
      }
    }
    return { steps, filled: qty - remaining, cancelTaker };
  }

  private execute(ctx: Ctx, inst: InstrumentState, taker: Order, plan: Plan) {
    let print: { priceTicks: number; qtyLots: number } | null = null;
    const flushPrint = () => {
      if (print) this.pending.push({ kind: "trade", instrumentId: inst.spec.id, aggressor: taker.side, ...print });
      print = null;
    };
    for (const step of plan.steps) {
      if (step.kind === "stp-cancel-maker") {
        this.cancelResting(ctx, step.maker, "self-trade-prevention");
        continue;
      }
      const price = step.maker.priceTicks;
      this.fill(ctx, inst, step.maker, taker, step.qty);
      // One public print per aggressing order and price, however many makers (and of which visibility) filled.
      if (print && print.priceTicks === price) print.qtyLots += step.qty;
      else {
        flushPrint();
        print = { priceTicks: price, qtyLots: step.qty };
      }
      inst.referencePriceTicks = price;
    }
    flushPrint();
  }

  private fill(ctx: Ctx, inst: InstrumentState, maker: Order, taker: Order, qty: number) {
    const price = maker.priceTicks;
    const makerAccount = this.accounts.get(maker.accountId)!;
    const takerAccount = this.accounts.get(taker.accountId)!;
    const book = this.sideOf(inst, maker.side);
    book.reduce(maker, qty);
    maker.filledLots += qty;
    taker.filledLots += qty;
    const makerHolding = this.holding(makerAccount, inst.spec.id);
    const takerHolding = this.holding(takerAccount, inst.spec.id);
    this.addOpen(makerHolding, maker.side, -qty);
    const notional = BigInt(price) * BigInt(qty);
    const sign = (side: Side) => (side === "buy" ? 1 : -1);
    makerHolding.position += sign(maker.side) * qty;
    takerHolding.position += sign(taker.side) * qty;
    makerHolding.cash -= BigInt(sign(maker.side)) * notional;
    takerHolding.cash -= BigInt(sign(taker.side)) * notional;
    if (maker.filledLots === maker.qtyLots) {
      book.remove(maker);
      makerAccount.live.delete(maker.orderId);
    }
    this.setStatus(ctx, maker, "fill", maker.filledLots === maker.qtyLots ? "filled" : "partially-filled");
    this.setStatus(ctx, taker, "fill", taker.filledLots === taker.qtyLots ? "filled" : "partially-filled");

    const n = ++this.execCount;
    const execId = this.opaqueId("x", n);
    for (const [order, liquidity, fillId] of [
      [maker, "maker", this.opaqueId("f", 2 * n)],
      [taker, "taker", this.opaqueId("f", 2 * n + 1)],
    ] as const) {
      this.emit(ctx, order.accountId, {
        kind: "fill",
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        fillId,
        instrumentId: inst.spec.id,
        side: order.side,
        priceTicks: price,
        qtyLots: qty,
        liquidity,
        filledLots: order.filledLots,
        leavesLots: leaves(order),
        status: order.status,
      });
    }
    ctx.executions.push({
      execId,
      seq: ctx.seq,
      ts: ctx.ts,
      instrumentId: inst.spec.id,
      priceTicks: price,
      qtyLots: qty,
      aggressor: taker.side,
      makerOrderId: maker.orderId,
      makerAccountId: maker.accountId,
      makerVisibility: maker.visibility,
      takerOrderId: taker.orderId,
      takerAccountId: taker.accountId,
    });
  }

  private rest(order: Order) {
    const inst = this.instruments.get(order.instrumentId)!;
    const account = this.accounts.get(order.accountId)!;
    this.sideOf(inst, order.side).add(order);
    account.live.add(order.orderId);
    this.addOpen(this.holding(account, inst.spec.id), order.side, leaves(order));
  }

  private cancelResting(ctx: Ctx, order: Order, reason: CancelReason) {
    const inst = this.instruments.get(order.instrumentId)!;
    const account = this.accounts.get(order.accountId)!;
    this.addOpen(this.holding(account, inst.spec.id), order.side, -leaves(order));
    this.sideOf(inst, order.side).remove(order);
    account.live.delete(order.orderId);
    this.cancelUnrested(ctx, order, reason);
  }

  /** Cancels an order that is not (or no longer) in the book. */
  private cancelUnrested(ctx: Ctx, order: Order, reason: CancelReason) {
    this.setStatus(ctx, order, "cancel", "cancelled");
    this.emit(ctx, order.accountId, { kind: "cancelled", orderId: order.orderId, clientOrderId: order.clientOrderId, reason, filledLots: order.filledLots });
  }

  private setStatus(ctx: Ctx, order: Order, cause: Transition["cause"], to: Order["status"]) {
    if (!isAllowedTransition(order.status, cause, to)) {
      throw new EngineIntegrityError(`illegal transition ${order.status} -(${cause})-> ${to} for ${order.orderId}`);
    }
    ctx.transitions.push({ orderId: order.orderId, from: order.status, to, cause });
    order.status = to;
  }

  // ── publication ──────────────────────────────────────────────────────────

  /**
   * Emits pending public messages with the *public* sequence. Hidden orders
   * never mark a level dirty, so their arrival, change or cancellation
   * produces no public message and no public sequence gap.
   */
  private flush(ts: number): PublicMessage[] {
    const out: PublicMessage[] = [];
    for (const p of this.pending) {
      if (p.kind === "status") out.push({ kind: "status", publicSeq: ++this.publicSeq, ts, instrumentId: p.instrumentId, status: p.status });
      else {
        const publicSeq = ++this.publicSeq;
        out.push({ kind: "trade", publicSeq, ts, instrumentId: p.instrumentId, tradeId: `T${++this.tradeCount}`, priceTicks: p.priceTicks, qtyLots: p.qtyLots, aggressor: p.aggressor });
      }
    }
    this.pending = [];
    for (const inst of this.instruments.values()) {
      for (const key of inst.dirty) {
        const [side, price] = key.split(":") as [Side, string];
        const priceTicks = Number(price);
        const current = this.sideOf(inst, side).level(priceTicks)?.displayedLots ?? 0;
        if (current === (inst.published.get(key) ?? 0)) continue;
        if (current === 0) inst.published.delete(key);
        else inst.published.set(key, current);
        out.push({ kind: "level", publicSeq: ++this.publicSeq, ts, instrumentId: inst.spec.id, side, priceTicks, displayedLots: current });
      }
      inst.dirty.clear();
    }
    return out;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** Displayed liquidity only. Levels holding nothing but hidden orders do not exist publicly. */
  publicBook(instrumentId: string, depth = 20): PublicBook | null {
    const inst = this.instruments.get(instrumentId);
    if (!inst) return null;
    const levels = (side: BookSide) => {
      const out: { priceTicks: number; displayedLots: number }[] = [];
      for (const l of side.bestFirst()) {
        if (out.length >= depth) break;
        if (l.displayedLots > 0) out.push({ priceTicks: l.priceTicks, displayedLots: l.displayedLots });
      }
      return out;
    };
    return { instrumentId, bids: levels(inst.bids), asks: levels(inst.asks) };
  }

  /** The owner's view of one of its orders; another account's order is "not found". */
  orderFor(accountId: string, ref: OrderRef): OrderView | null {
    const o = this.resolve(accountId, ref);
    return o ? orderView(o) : null;
  }

  openOrdersFor(accountId: string): OrderView[] {
    const account = this.accounts.get(accountId);
    return account ? [...account.live].map((id) => orderView(this.orders.get(id)!)) : [];
  }

  positionFor(accountId: string, instrumentId: string): number {
    return this.accounts.get(accountId)?.holdings.get(instrumentId)?.position ?? 0;
  }

  instrumentIds(): string[] {
    return [...this.instruments.keys()];
  }

  instrumentSpec(instrumentId: string): InstrumentSpec | null {
    return this.instruments.get(instrumentId)?.spec ?? null;
  }

  /** Operator/audit view of the full book including hidden orders. Not for clients. */
  inspectBook(instrumentId: string): BookLevelDetail[] {
    const inst = this.instruments.get(instrumentId);
    if (!inst) return [];
    const out: BookLevelDetail[] = [];
    for (const side of [inst.bids, inst.asks]) {
      for (const l of side.bestFirst()) {
        out.push({
          side: side.side,
          priceTicks: l.priceTicks,
          displayedLots: l.displayedLots,
          hiddenLots: l.hiddenLots,
          displayed: [...l.displayed.values()].map((o) => ({ ...o })),
          hidden: [...l.hidden.values()].map((o) => ({ ...o })),
        });
      }
    }
    return out;
  }

  /** Displayed levels as last published (what a correct public mirror must hold). */
  publishedLevels(instrumentId: string): Map<string, number> {
    return new Map(this.instruments.get(instrumentId)?.published);
  }

  // ── snapshot / restore ───────────────────────────────────────────────────

  snapshot(): EngineSnapshot {
    if (this.stopped) throw new EngineIntegrityError(`engine stopped: ${this.stopped}`);
    return {
      version: 1,
      lastSeq: this.lastSeq,
      lastTs: this.lastTs,
      execCount: this.execCount,
      publicSeq: this.publicSeq,
      tradeCount: this.tradeCount,
      instruments: [...this.instruments.values()].map((i) => ({
        spec: i.spec,
        status: i.status,
        referencePriceTicks: i.referencePriceTicks,
        published: [...i.published],
        dirty: [...i.dirty],
      })),
      accounts: [...this.accounts.values()].map((a) => ({
        id: a.id,
        limits: a.limits,
        suspended: a.suspended,
        accountSeq: a.accountSeq,
        holdings: [...a.holdings].map(([k, h]) => [k, { position: h.position, openBuyLots: h.openBuyLots, openSellLots: h.openSellLots, cash: h.cash.toString() }]),
      })),
      orders: [...this.orders.values()].map((o) => ({ ...o })),
      pending: this.pending.map((p) => ({ ...p })),
    };
  }

  /** Hash of the full deterministic state; equal hashes ⇔ equal state. */
  stateHash(): string {
    return sha256(canonicalJson(this.snapshot()));
  }

  static restore(config: EngineConfig, snap: EngineSnapshot): MatchingEngine {
    if (snap.version !== 1) throw new EngineIntegrityError("unsupported snapshot version");
    const engine = new MatchingEngine(config);
    engine.lastSeq = snap.lastSeq;
    engine.lastTs = snap.lastTs;
    engine.execCount = snap.execCount;
    engine.publicSeq = snap.publicSeq;
    engine.tradeCount = snap.tradeCount;
    for (const i of snap.instruments) {
      engine.addInstrument(i.spec);
      const inst = engine.instruments.get(i.spec.id)!;
      inst.status = i.status;
      inst.referencePriceTicks = i.referencePriceTicks;
      for (const [k, v] of i.published) inst.published.set(k, v);
    }
    engine.pending = snap.pending.map((p) => ({ ...p }));
    for (const a of snap.accounts) {
      engine.addAccount(a.id, a.limits);
      const account = engine.accounts.get(a.id)!;
      account.suspended = a.suspended;
      account.accountSeq = a.accountSeq;
      for (const [k, h] of a.holdings) account.holdings.set(k, { ...h, cash: BigInt(h.cash) });
    }
    for (const o of snap.orders) {
      const order = { ...o };
      engine.orders.set(order.orderId, order);
      engine.byClientId.set(clientKey(order.accountId, order.clientOrderId), order.orderId);
    }
    // Queue order within a level is ascending priority (an invariant reconcile checks), so
    // re-adding live orders by priority rebuilds every queue exactly.
    const live = [...engine.orders.values()].filter((o) => isLive(o.status)).sort((a, b) => a.priority - b.priority);
    for (const order of live) {
      const inst = engine.instruments.get(order.instrumentId)!;
      engine.sideOf(inst, order.side).add(order);
      engine.accounts.get(order.accountId)!.live.add(order.orderId);
    }
    for (const i of snap.instruments) {
      const inst = engine.instruments.get(i.spec.id)!;
      inst.dirty.clear();
      for (const k of i.dirty) inst.dirty.add(k);
    }
    // Restoring holdings directly keeps open-lot totals; the rebuilt book must agree with them.
    for (const account of engine.accounts.values()) {
      for (const [instrumentId, h] of account.holdings) {
        let buy = 0;
        let sell = 0;
        for (const id of account.live) {
          const o = engine.orders.get(id)!;
          if (o.instrumentId !== instrumentId) continue;
          if (o.side === "buy") buy += leaves(o);
          else sell += leaves(o);
        }
        if (buy !== h.openBuyLots || sell !== h.openSellLots) throw new EngineIntegrityError(`snapshot open lots mismatch for ${account.id}`);
      }
    }
    return engine;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private resolve(accountId: string, ref: OrderRef): Order | undefined {
    const id = "orderId" in ref ? ref.orderId : this.byClientId.get(clientKey(accountId, ref.clientOrderId));
    const order = id === undefined ? undefined : this.orders.get(id);
    return order && order.accountId === accountId ? order : undefined;
  }

  private sideOf(inst: InstrumentState, side: Side) {
    return side === "buy" ? inst.bids : inst.asks;
  }

  private holding(account: AccountState, instrumentId: string): Holding {
    let h = account.holdings.get(instrumentId);
    if (!h) {
      h = { position: 0, openBuyLots: 0, openSellLots: 0, cash: 0n };
      account.holdings.set(instrumentId, h);
    }
    return h;
  }

  private addOpen(h: Holding, side: Side, lots: number) {
    if (side === "buy") h.openBuyLots += lots;
    else h.openSellLots += lots;
    if (h.openBuyLots < 0 || h.openSellLots < 0) throw new EngineIntegrityError("negative open lots");
  }

  private emit(ctx: Ctx, accountId: string, body: PrivateEventBody) {
    const account = this.accounts.get(accountId);
    const accountSeq = account ? ++account.accountSeq : 0;
    ctx.private.push({ ...body, accountId, accountSeq, ts: ctx.ts } as PrivateEvent);
  }

  /**
   * Opaque identifiers: a keyed hash of a counter. Sequential ids would let a
   * client count other participants' (including hidden) activity between two
   * of its own orders.
   */
  private opaqueId(prefix: "o" | "f" | "x", n: number): string {
    return prefix + sha256(`${this.config.idKey}:${prefix}:${n}`).slice(0, 16);
  }
}

