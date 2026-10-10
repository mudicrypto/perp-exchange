import type { Market, MarketId, OrderIntent } from "@/core/domain";
import type {
  AccountConnection,
  AccountDataSource,
  AccountState,
  ExecutionAdapter,
  SubmitResult,
  Unsubscribe,
} from "@/core/ports";
import { createDemoPaperEngine } from "./demo-account-fixture";
import type { PaperEngine } from "./paper-engine";
import type { SimulatedMarketDataSource } from "./simulated-market-data-source";
import { SIMULATION_VENUE_ID } from "./simulation-engine";

export const PAPER_ACCOUNT_LABEL = "Simulated paper account (SIMUSD)";

/**
 * Simulated venue: an execution adapter and an account source backed by the
 * paper engine, fed by the simulated market data source. Orders never leave
 * the browser.
 */
export class PaperVenue implements ExecutionAdapter, AccountDataSource {
  readonly venueId = SIMULATION_VENUE_ID;
  readonly mode = "paper" as const;
  readonly connection: AccountConnection = { status: "paper", label: PAPER_ACCOUNT_LABEL };
  private engine: PaperEngine;
  private readonly markets: ReadonlyMap<MarketId, Market>;
  private readonly listeners = new Set<(state: AccountState | null) => void>();
  private feedUnsubscribers: Unsubscribe[] = [];
  private emitScheduled = false;

  constructor(
    private readonly source: SimulatedMarketDataSource,
    private readonly now: () => number = Date.now,
  ) {
    this.markets = new Map([...source.markets.values()].map((m) => [m.id, m.market]));
    this.engine = createDemoPaperEngine(this.markets, this.now());
  }

  subscribeAccount(listener: (state: AccountState | null) => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.attachFeeds();
    listener(this.engine.state(this.now()));
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachFeeds();
    };
  }

  async submit(intent: OrderIntent): Promise<SubmitResult> {
    if (this.source.connectionState.status !== "open") {
      return {
        ok: false,
        code: "feed-unavailable",
        message: "Market data feed is disconnected; order entry is paused until it recovers.",
        order: null,
      };
    }
    const result = this.engine.submit(intent, this.now());
    this.emit();
    return result;
  }

  async cancel(orderId: string): Promise<SubmitResult> {
    const result = this.engine.cancel(orderId, this.now());
    this.emit();
    return result;
  }

  async cancelAll(): Promise<number> {
    const count = this.engine.cancelAll(this.now());
    this.emit();
    return count;
  }

  /** Restores the demo account to its fixture state. */
  reset(): void {
    this.engine = createDemoPaperEngine(this.markets, this.now());
    this.emit();
  }

  dispose(): void {
    this.listeners.clear();
    this.detachFeeds();
  }

  private attachFeeds(): void {
    for (const marketId of this.markets.keys()) {
      this.feedUnsubscribers.push(
        this.source.subscribeOrderBook(marketId, {
          onData: (book) => {
            this.engine.setBook(marketId, book, this.now());
            this.scheduleEmit();
          },
        }),
        this.source.subscribeMarketStats(marketId, {
          onData: (stats) => {
            this.engine.setMark(marketId, stats.markPrice, this.now());
            this.scheduleEmit();
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
  private scheduleEmit(): void {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    queueMicrotask(() => {
      this.emitScheduled = false;
      this.emit();
    });
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.engine.state(this.now());
    for (const listener of this.listeners) listener(state);
  }
}
