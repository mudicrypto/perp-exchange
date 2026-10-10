import { instrumentFromMarket } from "@/core/domain";
import type { Fill, Instrument, Market, MarketId, Order, OrderRequest, Position, Result, TradingError } from "@/core/domain";
import type {
  AccountConnection,
  AccountDataSource,
  AccountRef,
  AccountState,
  CancelTarget,
  ExecutionAdapter,
  Unsubscribe,
} from "@/core/ports";
import { unsupportedError, validateOrderRequest, type ValidationContext, type VenueCapabilities } from "@/core/trading";
import { simulationCapabilities } from "./capabilities";
import { createDemoPaperEngine } from "./demo-account-fixture";
import type { IcebergState, PaperEngine, RfqTradeRequest, SimulationConfig } from "./paper-engine";
import type { SimulatedMarketDataSource } from "./simulated-market-data-source";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

export const PAPER_ACCOUNT_LABEL = "Simulated paper account (SIMUSD)";

export interface SimulationAdapterOptions {
  now?: () => number;
  config?: Partial<SimulationConfig>;
  /**
   * Delay between accepting a request (pending-new) and the simulated venue
   * deciding it. 0 = synchronous. A small delay makes the lifecycle visible.
   */
  ackLatencyMs?: number;
}

const fail = (error: TradingError): Result<never> => ({ ok: false, error });

/**
 * Execution adapter + account source for the simulator. Orders are matched
 * by `PaperEngine` against the simulated order books; every order, fill and
 * balance is marked `origin: "simulated"`. No wallet, no network, no venue.
 */
export class SimulationAdapter implements ExecutionAdapter, AccountDataSource {
  readonly venueId = SIMULATION_VENUE_ID;
  readonly origin = "simulated" as const;
  readonly connection: AccountConnection = { status: "paper", label: PAPER_ACCOUNT_LABEL };
  private engine: PaperEngine;
  private readonly markets: ReadonlyMap<MarketId, Market>;
  private readonly now: () => number;
  private readonly ackLatencyMs: number;
  private readonly config: Partial<SimulationConfig>;
  private readonly accountListeners = new Set<(state: AccountState | null) => void>();
  private readonly orderListeners = new Set<(order: Order) => void>();
  private readonly fillListeners = new Set<(fill: Fill) => void>();
  private feedUnsubscribers: Unsubscribe[] = [];
  private detachEngine: () => void = () => {};
  private emitScheduled = false;

  constructor(
    private readonly source: SimulatedMarketDataSource,
    options: SimulationAdapterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ackLatencyMs = options.ackLatencyMs ?? 0;
    this.config = options.config ?? {};
    this.markets = new Map([...source.markets.values()].map((m) => [m.id, m.market]));
    this.engine = this.createEngine();
  }

  // -------------------------------------------------------------- capabilities

  getCapabilities(): VenueCapabilities {
    return simulationCapabilities;
  }

  describeInstrument(market: Market): Instrument {
    return instrumentFromMarket(market, {
      venueId: SIMULATION_VENUE_ID,
      priceSignificantFigures: null,
      integerPricesExempt: false,
      minOrderValue: null,
    });
  }

  validateOrder(input: unknown, instrument: Instrument, context?: ValidationContext): Result<OrderRequest> {
    return validateOrderRequest(input, instrument, simulationCapabilities.capabilities, context);
  }

  // -------------------------------------------------------------------- orders

  async submitOrder(request: OrderRequest, instrument: Instrument): Promise<Result<Order>> {
    const validated = this.validateOrder(request, instrument);
    if (!validated.ok) return validated;
    if (this.source.connectionState.status !== "open") {
      return fail({ code: "feed-unavailable", message: "Simulated feed is disconnected; order entry is paused until it recovers." });
    }
    const created = this.engine.createOrder(validated.value, this.now());
    if (!created.ok) return created;
    this.scheduleAccountEmit();
    if (this.ackLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.ackLatencyMs));
    const result = this.engine.processOrder(created.value.id, this.now());
    this.emitAccount();
    return result;
  }

  async cancelOrder(target: CancelTarget): Promise<Result<Order>> {
    const order = "orderId" in target ? this.engine.store.get(target.orderId) : this.engine.store.getByClientOrderId(target.clientOrderId);
    if (!order) return fail({ code: "order-not-found", message: "Order not found" });
    const result = this.engine.cancel(order.id, this.now());
    this.emitAccount();
    return result;
  }

  async cancelAllOrders(marketId?: MarketId): Promise<Result<number>> {
    const count = this.engine.cancelAll(this.now(), marketId);
    this.emitAccount();
    return { ok: true, value: count };
  }

  // --------------------------------------------------------------------- reads

  async fetchOpenOrders(account: AccountRef): Promise<Result<Order[]>> {
    const check = this.checkAccount(account, "read.open-orders");
    if (check) return check;
    return { ok: true, value: this.engine.store.openOrders() };
  }

  async fetchPositions(account: AccountRef): Promise<Result<Position[]>> {
    const check = this.checkAccount(account, "read.positions");
    if (check) return check;
    return { ok: true, value: this.engine.snapshot(this.now()).positions };
  }

  async fetchAccountState(account: AccountRef): Promise<Result<AccountState>> {
    const check = this.checkAccount(account, "read.account");
    if (check) return check;
    return { ok: true, value: this.engine.state(this.now()) };
  }

  subscribeOrderUpdates(account: AccountRef, listener: (order: Order) => void): Result<Unsubscribe> {
    const check = this.checkAccount(account, "stream.order-updates");
    if (check) return check;
    this.orderListeners.add(listener);
    return { ok: true, value: () => this.orderListeners.delete(listener) };
  }

  subscribeFills(account: AccountRef, listener: (fill: Fill) => void): Result<Unsubscribe> {
    const check = this.checkAccount(account, "stream.fills");
    if (check) return check;
    this.fillListeners.add(listener);
    return { ok: true, value: () => this.fillListeners.delete(listener) };
  }

  // ------------------------------------------------------- AccountDataSource

  subscribeAccount(listener: (state: AccountState | null) => void): Unsubscribe {
    this.accountListeners.add(listener);
    if (this.accountListeners.size === 1) this.attachFeeds();
    listener(this.engine.state(this.now()));
    return () => {
      this.accountListeners.delete(listener);
      if (this.accountListeners.size === 0) this.detachFeeds();
    };
  }

  dispose(): void {
    this.accountListeners.clear();
    this.detachFeeds();
  }

  // ------------------------------------------------------- private execution

  /**
   * Books a trade agreed through the simulated RFQ desk on the paper
   * account. Only for executions the RFQ service confirmed.
   */
  recordRfqTrade(trade: RfqTradeRequest): Result<Order> {
    if (simulationCapabilities.capabilities["execution.rfq"].status !== "supported") {
      return fail({ code: "unsupported", capability: "execution.rfq", scope: "venue", message: "RFQ is not supported" });
    }
    const result = this.engine.recordRfqTrade(trade, this.now());
    this.emitAccount();
    return result;
  }

  /** Would `recordRfqTrade` succeed? (checked before accepting a quote) */
  checkRfqTrade(trade: RfqTradeRequest): TradingError | null {
    return this.engine.rfqTradeError(trade, this.now());
  }

  /** Displayed slice and refill count of an iceberg order (null otherwise). */
  icebergState(orderId: string): IcebergState | null {
    return this.engine.icebergState(orderId);
  }

  // -------------------------------------------------------------- demo controls

  /** Restores the demo account to its fixture state. */
  reset(): void {
    this.detachEngine();
    this.engine = this.createEngine();
    this.emitAccount();
  }

  /** The next `count` orders are rejected by the simulated venue with `reason`. */
  rejectNextOrders(reason: string, count = 1): void {
    this.engine.addRejectionRule({ kind: "next", remaining: count, reason });
  }

  // ----------------------------------------------------------------- internals

  private createEngine(): PaperEngine {
    const engine = createDemoPaperEngine(this.markets, this.now(), this.config);
    this.detachEngine = engine.subscribe(({ order, fill }) => {
      for (const l of this.orderListeners) l(order);
      if (fill) {
        for (const l of this.fillListeners) l(fill);
        // Every execution prints on the simulated public tape, anonymously.
        const aggressor = fill.liquidity === "maker" ? (fill.side === "buy" ? "sell" : "buy") : fill.side;
        this.source.printTrade({ marketId: fill.marketId, side: aggressor, price: fill.price, size: fill.size, venueTime: fill.time });
      }
    });
    this.source.setParticipantLiquidity((marketId) => engine.publicLiquidity(marketId));
    return engine;
  }

  private checkAccount(account: AccountRef, capability: Parameters<typeof unsupportedError>[0]): Result<never> | null {
    if (account.kind === "simulated") return null;
    return fail({
      code: "unsupported",
      capability,
      scope: "venue",
      message: "The simulator only has its own simulated paper account; it cannot read external addresses.",
    });
  }

  private attachFeeds(): void {
    for (const marketId of this.markets.keys()) {
      this.feedUnsubscribers.push(
        this.source.subscribeVenueBook(marketId, {
          onData: (book) => {
            this.engine.setBook(marketId, book, this.now());
            this.scheduleAccountEmit();
          },
        }),
        this.source.subscribeMarketStats(marketId, {
          onData: (stats) => {
            this.engine.setMark(marketId, stats.markPrice, this.now());
            this.scheduleAccountEmit();
          },
        }),
      );
    }
  }

  private detachFeeds(): void {
    for (const unsubscribe of this.feedUnsubscribers) unsubscribe();
    this.feedUnsubscribers = [];
  }

  /** Coalesce the many per-market updates of one tick into a single emit. */
  private scheduleAccountEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emitAccount();
    });
  }

  private emitAccount(): void {
    if (this.accountListeners.size === 0) return;
    const state = this.engine.state(this.now());
    for (const listener of this.accountListeners) listener(state);
  }
}
