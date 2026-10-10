import type { Candle, CandleInterval, MarketId, MarketSummary } from "@/core/domain";
import type { MarketCatalogGateway } from "@/core/ports";
import { SIMULATION_DESCRIPTOR, SIM_HISTORY_LENGTH } from "./simulated-market-data-source";
import { SimulationEngine } from "./simulation-engine";

/** Server-side simulated catalog, used by /api routes in simulation mode. */
export class SimulatedCatalogGateway implements MarketCatalogGateway {
  readonly descriptor = SIMULATION_DESCRIPTOR;
  private readonly engine: SimulationEngine;

  constructor(seed = 42, private readonly now: () => number = Date.now) {
    this.engine = new SimulationEngine(seed);
  }

  async listMarkets(): Promise<MarketSummary[]> {
    return this.engine.summaries(this.now());
  }

  async getCandles(marketId: MarketId, interval: CandleInterval, range: { endTime: number }): Promise<Candle[]> {
    const market = this.engine.get(marketId);
    if (!market) return [];
    return market.history(interval, range.endTime, SIM_HISTORY_LENGTH);
  }
}
