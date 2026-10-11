import type { AccountSnapshot, BookLevel, Instrument, Market, MarketId, Order, OrderRequest, Result } from "../domain";
import type { CancelTarget, ExecutionAdapter } from "../ports";
import { assessOrder, assessPortfolio, type Observed, type PreTradeAssessment, type RiskLimits, type VenueMarginRules } from "../risk";

/** Everything the guard needs to assess an order, read from the execution venue's own state. */
export interface RiskSnapshot {
  now: number;
  venue: VenueMarginRules | null;
  account: Observed<AccountSnapshot> | null;
  markets: ReadonlyMap<MarketId, Market>;
  marks: ReadonlyMap<MarketId, Observed<number>>;
  book: Observed<{ bids: readonly BookLevel[]; asks: readonly BookLevel[] }> | null;
}

export type RiskSnapshotSource = (marketId: MarketId) => RiskSnapshot;

/** Runs the pre-trade assessment for an order against a snapshot (same code path as the UI preview). */
export function assessWithSnapshot(request: OrderRequest, market: Market, snapshot: RiskSnapshot, limits: RiskLimits): PreTradeAssessment {
  const portfolio = snapshot.account
    ? assessPortfolio({ now: snapshot.now, venue: snapshot.venue, account: snapshot.account, markets: snapshot.markets, marks: snapshot.marks, funding: new Map(), fills: null })
    : null;
  return assessOrder({
    now: snapshot.now,
    order: request,
    market,
    venue: snapshot.venue,
    mark: snapshot.marks.get(market.id) ?? null,
    book: snapshot.book,
    position: snapshot.account?.value.positions.find((p) => p.marketId === market.id) ?? null,
    portfolio,
    limits,
  });
}

/**
 * Wraps an execution adapter so that every submission is checked against
 * the configured pre-trade limits first. Orders the limits block never reach
 * the inner adapter. Cancels and reads pass through unchanged.
 *
 * This is where limits are *enforced*; the order ticket only previews the
 * same assessment. The guard must wrap the adapter in whichever layer holds
 * the trusted connection to the venue (for live venues: the server).
 */
export class RiskGuardedExecutionAdapter implements ExecutionAdapter {
  readonly venueId: string;
  readonly origin: ExecutionAdapter["origin"];

  constructor(
    private readonly inner: ExecutionAdapter,
    private readonly snapshot: RiskSnapshotSource,
    private readonly limits: () => RiskLimits,
  ) {
    this.venueId = inner.venueId;
    this.origin = inner.origin;
  }

  /** The assessment the guard would apply now (for previews and tests). */
  assess(request: OrderRequest, market: Market): PreTradeAssessment {
    return assessWithSnapshot(request, market, this.snapshot(market.id), this.limits());
  }

  async submitOrder(request: OrderRequest, instrument: Instrument): Promise<Result<Order>> {
    const validated = this.inner.validateOrder(request, instrument);
    if (!validated.ok) return validated;
    const assessment = this.assess(validated.value, instrument);
    if (assessment.decision === "block") {
      const blocking = assessment.checks.filter((c) => c.action === "block" && c.status !== "pass");
      return {
        ok: false,
        error: { code: "risk-limit", limits: blocking.map((c) => c.limit), message: `Blocked by risk limits: ${blocking.map((c) => c.message).join("; ")}` },
      };
    }
    return this.inner.submitOrder(validated.value, instrument);
  }

  getCapabilities: ExecutionAdapter["getCapabilities"] = () => this.inner.getCapabilities();
  describeInstrument: ExecutionAdapter["describeInstrument"] = (market) => this.inner.describeInstrument(market);
  validateOrder: ExecutionAdapter["validateOrder"] = (input, instrument, context) => this.inner.validateOrder(input, instrument, context);
  cancelOrder = (target: CancelTarget) => this.inner.cancelOrder(target);
  cancelAllOrders: ExecutionAdapter["cancelAllOrders"] = (marketId) => this.inner.cancelAllOrders(marketId);
  fetchOpenOrders: ExecutionAdapter["fetchOpenOrders"] = (account) => this.inner.fetchOpenOrders(account);
  fetchPositions: ExecutionAdapter["fetchPositions"] = (account) => this.inner.fetchPositions(account);
  fetchAccountState: ExecutionAdapter["fetchAccountState"] = (account) => this.inner.fetchAccountState(account);
  subscribeOrderUpdates: ExecutionAdapter["subscribeOrderUpdates"] = (account, listener) => this.inner.subscribeOrderUpdates(account, listener);
  subscribeFills: ExecutionAdapter["subscribeFills"] = (account, listener) => this.inner.subscribeFills(account, listener);
}
