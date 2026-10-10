import { instrumentFromMarket } from "@/core/domain";
import type { Fill, Instrument, Market, MarketId, Order, OrderRequest, Position, Result, TradingError } from "@/core/domain";
import type { AccountRef, AccountState, CancelTarget, ExecutionAdapter, Unsubscribe } from "@/core/ports";
import { unsupportedError, validateOrderRequest, type ValidationContext, type VenueCapabilities } from "@/core/trading";
import { ApiError, type VenueAccountResponse } from "@/adapters/http/nova-api-client";
import { HYPERLIQUID_ORDER_MODEL, hyperliquidCapabilities } from "./capabilities";
import { HYPERLIQUID_VENUE_ID } from "./constants";

/** The subset of NovaApiClient this adapter needs (injectable for tests). */
export interface VenueAccountClient {
  getVenueAccount(address: string, signal?: AbortSignal): Promise<VenueAccountResponse>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Hyperliquid execution adapter — read-only in this milestone.
 *
 * Implemented: venue-rule validation (price significant figures/decimals
 * from the official SDK), open orders / positions / account state for a
 * public address. Not implemented: order signing, submission, cancellation
 * and private streams — these return explicit `unsupported` errors and are
 * deferred to a separate, security-reviewed milestone. This adapter holds no
 * keys and has no code path that signs or sends an order.
 */
export class HyperliquidAdapter implements ExecutionAdapter {
  readonly venueId = HYPERLIQUID_VENUE_ID;
  readonly origin = "venue" as const;

  constructor(private readonly client: VenueAccountClient) {}

  getCapabilities(): VenueCapabilities {
    return hyperliquidCapabilities;
  }

  describeInstrument(market: Market): Instrument {
    // Official SDK (examples/rounding.py): prices may have up to 5 significant
    // figures and at most (6 − szDecimals) decimals; integer prices are always allowed.
    return instrumentFromMarket(market, {
      venueId: HYPERLIQUID_VENUE_ID,
      priceSignificantFigures: 5,
      integerPricesExempt: true,
      // Hyperliquid enforces a minimum order value, but the figure could not
      // be verified against the docs in this build, so it is not enforced.
      minOrderValue: null,
    });
  }

  /** Checks a request against Hyperliquid's order model and price rules (does not imply Nova can submit it). */
  validateOrder(input: unknown, instrument: Instrument, context?: ValidationContext): Result<OrderRequest> {
    return validateOrderRequest(input, instrument, HYPERLIQUID_ORDER_MODEL, context);
  }

  async submitOrder(request: OrderRequest, instrument: Instrument): Promise<Result<Order>> {
    void request;
    void instrument;
    return this.unsupported("action.submit");
  }

  async cancelOrder(target: CancelTarget): Promise<Result<Order>> {
    void target;
    return this.unsupported("action.cancel");
  }

  async cancelAllOrders(marketId?: MarketId): Promise<Result<number>> {
    void marketId;
    return this.unsupported("action.cancel-all");
  }

  async fetchOpenOrders(account: AccountRef): Promise<Result<Order[]>> {
    const result = await this.read(account);
    return result.ok ? { ok: true, value: result.value.openOrders } : result;
  }

  async fetchPositions(account: AccountRef): Promise<Result<Position[]>> {
    const result = await this.read(account);
    return result.ok ? { ok: true, value: result.value.snapshot.positions } : result;
  }

  async fetchAccountState(account: AccountRef): Promise<Result<AccountState>> {
    const result = await this.read(account);
    if (!result.ok) return result;
    // History and fills are not read in this milestone: null (unknown), not empty.
    return { ok: true, value: { snapshot: result.value.snapshot, openOrders: result.value.openOrders, orderHistory: null, fills: null } };
  }

  subscribeOrderUpdates(account: AccountRef, listener: (order: Order) => void): Result<Unsubscribe> {
    void account;
    void listener;
    return this.unsupported("stream.order-updates");
  }

  subscribeFills(account: AccountRef, listener: (fill: Fill) => void): Result<Unsubscribe> {
    void account;
    void listener;
    return this.unsupported("stream.fills");
  }

  private unsupported(capability: Parameters<typeof unsupportedError>[0]): Result<never> {
    const error = unsupportedError(capability, hyperliquidCapabilities.capabilities[capability]);
    if (!error) throw new Error(`${capability} is declared supported but not implemented`);
    return { ok: false, error };
  }

  private async read(account: AccountRef): Promise<Result<VenueAccountResponse>> {
    if (account.kind !== "address") {
      return { ok: false, error: { code: "account-required", message: "Provide a public Hyperliquid address to read an account." } };
    }
    if (!ADDRESS.test(account.address)) {
      const message = "Address must be 0x followed by 40 hex characters";
      return { ok: false, error: { code: "validation", issues: [{ field: "address", message }], message } };
    }
    try {
      return { ok: true, value: await this.client.getVenueAccount(account.address) };
    } catch (error) {
      return { ok: false, error: toTradingError(error) };
    }
  }
}

function toTradingError(error: unknown): TradingError {
  if (error instanceof ApiError) {
    if (error.code === "venue-rate-limited") return { code: "rate-limited", message: error.message };
    if (error.code === "invalid-response" || error.code === "venue-invalid-response" || error.code === "source-mismatch") {
      return { code: "invalid-response", message: error.message };
    }
    return { code: "network", message: error.message };
  }
  return { code: "network", message: error instanceof Error ? error.message : "Request failed" };
}
