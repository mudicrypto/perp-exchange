/**
 * Deterministic market simulator for development and automated tests.
 *
 * Everything produced here is synthetic. Market names are deliberately not
 * real assets (ALPHA, BETA, GAMMA) and every consumer must label the data as
 * simulated. Nothing in this file may be used by a live venue integration.
 */
import {
  CANDLE_INTERVAL_MS,
  marketIdFromBase,
  type BookLevel,
  type Candle,
  type CandleInterval,
  type Market,
  type MarketId,
  type MarketStats,
  type MarketSummary,
  type OrderBookSnapshot,
  type Trade,
} from "@/core/domain";

export const SIMULATION_VENUE_ID = "simulation";

export interface SimMarketSpec {
  base: string;
  startPrice: number;
  sizeDecimals: number;
  maxLeverage: number;
  /** Per-tick volatility as a fraction of price. */
  volatility: number;
}

export const SIM_MARKETS: readonly SimMarketSpec[] = [
  { base: "ALPHA", startPrice: 1_000, sizeDecimals: 3, maxLeverage: 25, volatility: 0.0008 },
  { base: "BETA", startPrice: 42.5, sizeDecimals: 1, maxLeverage: 20, volatility: 0.0012 },
  { base: "GAMMA", startPrice: 0.8, sizeDecimals: 0, maxLeverage: 10, volatility: 0.002 },
];

/** mulberry32: small, fast, deterministic PRNG. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function priceDecimalsFor(price: number): number {
  // Keep ~5 significant figures, matching typical perp tick conventions.
  return Math.max(0, Math.min(6, 4 - Math.floor(Math.log10(price))));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class SimulatedMarket {
  readonly market: Market;
  private price: number;
  private readonly rng: () => number;
  private tradeSeq = 0;
  private bookTime = 0;
  private readonly prevDayPrice: number;
  private dayVolume = 0;

  constructor(
    readonly spec: SimMarketSpec,
    seed: number,
  ) {
    this.rng = createRng(seed ^ hashString(spec.base));
    this.price = spec.startPrice;
    this.prevDayPrice = spec.startPrice * (1 - 0.02 + this.rng() * 0.04);
    this.market = {
      id: marketIdFromBase(spec.base),
      base: spec.base,
      quote: "SIMUSD",
      sizeDecimals: spec.sizeDecimals,
      priceDecimals: priceDecimalsFor(spec.startPrice),
      maxLeverage: spec.maxLeverage,
      isolatedOnly: false,
      maintenanceMarginRate: 1 / (2 * spec.maxLeverage),
    };
  }

  get id(): MarketId {
    return this.market.id;
  }

  get mid(): number {
    return this.price;
  }

  /** Advance the random walk one step. */
  step(): number {
    const shock = (this.rng() - 0.5) * 2 * this.spec.volatility;
    this.price = Math.max(this.spec.startPrice * 0.2, this.price * (1 + shock));
    return this.price;
  }

  book(time: number, depth = 15): OrderBookSnapshot {
    const tick = 10 ** -this.market.priceDecimals;
    const halfSpread = Math.max(tick, this.price * 0.0001);
    const bestBid = round(this.price - halfSpread, this.market.priceDecimals);
    const bestAsk = round(Math.max(bestBid + tick, this.price + halfSpread), this.market.priceDecimals);
    const levelGap = Math.max(tick, this.price * 0.0002);
    const sizeUnit = 1_000 / this.price;
    const level = (price: number): BookLevel => ({
      price: round(price, this.market.priceDecimals),
      size: Math.max(10 ** -this.spec.sizeDecimals, round(sizeUnit * (0.2 + this.rng() * 3), this.spec.sizeDecimals)),
      orders: 1 + Math.floor(this.rng() * 8),
    });
    const bids: BookLevel[] = [];
    const asks: BookLevel[] = [];
    for (let i = 0; i < depth; i += 1) {
      bids.push(level(bestBid - i * levelGap));
      asks.push(level(bestAsk + i * levelGap));
    }
    this.bookTime = Math.max(this.bookTime + 1, time);
    return { marketId: this.id, bids, asks, venueTime: this.bookTime };
  }

  maybeTrades(time: number): Trade[] {
    const count = this.rng() < 0.6 ? 1 + Math.floor(this.rng() * 3) : 0;
    const trades: Trade[] = [];
    for (let i = 0; i < count; i += 1) {
      const side = this.rng() < 0.5 ? "buy" : "sell";
      const size = Math.max(
        10 ** -this.spec.sizeDecimals,
        round((200 / this.price) * (0.1 + this.rng() * 4), this.spec.sizeDecimals),
      );
      this.tradeSeq += 1;
      this.dayVolume += size * this.price;
      trades.push({
        marketId: this.id,
        id: `sim-${this.spec.base}-${this.tradeSeq}`,
        side,
        price: round(this.price, this.market.priceDecimals),
        size,
        venueTime: time,
      });
    }
    return trades;
  }

  stats(time: number): MarketStats {
    return {
      marketId: this.id,
      markPrice: round(this.price, this.market.priceDecimals),
      oraclePrice: round(this.price * (1 + (this.rng() - 0.5) * 0.0004), this.market.priceDecimals),
      midPrice: round(this.price, this.market.priceDecimals),
      fundingRate: 0.0000125 + (this.rng() - 0.5) * 0.00001,
      fundingIntervalHours: 1,
      openInterest: round(50_000_000 / this.price, this.spec.sizeDecimals),
      dayNotionalVolume: 25_000_000 + this.dayVolume,
      prevDayPrice: round(this.prevDayPrice, this.market.priceDecimals),
      observedAt: time,
    };
  }

  /**
   * Synthetic history ending at the current price. Generated backwards from
   * the current price with its own RNG so it does not disturb the live walk.
   */
  history(interval: CandleInterval, endTime: number, count: number): Candle[] {
    const step = CANDLE_INTERVAL_MS[interval];
    const rng = createRng(hashString(`${this.spec.base}:${interval}`));
    const lastOpen = Math.floor(endTime / step) * step;
    const vol = this.spec.volatility * Math.sqrt(step / 1_000);
    const candles: Candle[] = [];
    let close = this.price;
    for (let i = 0; i < count; i += 1) {
      const open = close * (1 + (rng() - 0.5) * 2 * vol);
      const high = Math.max(open, close) * (1 + rng() * vol);
      const low = Math.min(open, close) * (1 - rng() * vol);
      const d = this.market.priceDecimals;
      candles.push({
        openTime: lastOpen - i * step,
        open: round(open, d),
        high: round(high, d),
        low: round(low, d),
        close: round(close, d),
        volume: round((5_000 + rng() * 50_000) / this.price, this.spec.sizeDecimals),
      });
      close = open;
    }
    return candles.reverse();
  }

  summary(time: number): MarketSummary {
    return { market: this.market, stats: this.stats(time) };
  }
}

export class SimulationEngine {
  readonly markets: Map<MarketId, SimulatedMarket>;

  constructor(seed = 42, specs: readonly SimMarketSpec[] = SIM_MARKETS) {
    this.markets = new Map(specs.map((spec) => {
      const market = new SimulatedMarket(spec, seed);
      return [market.id, market] as const;
    }));
  }

  get(marketId: MarketId): SimulatedMarket | undefined {
    return this.markets.get(marketId);
  }

  summaries(time: number): MarketSummary[] {
    return [...this.markets.values()].map((market) => market.summary(time));
  }
}
