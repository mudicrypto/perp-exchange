import type { Candle } from "../domain";

export type CandleUpdateResult = "appended" | "replaced" | "ignored-stale";

/**
 * Ordered candle series keyed by open time. Live updates for the current
 * candle replace it; updates for an older candle than the latest are ignored
 * so the chart never moves backwards on duplicated or late events.
 */
export class CandleSeries {
  private candles: Candle[] = [];

  constructor(private readonly maxLength = 2_000) {}

  setHistory(history: readonly Candle[]): void {
    const byTime = new Map<number, Candle>();
    for (const candle of history) byTime.set(candle.openTime, candle);
    this.candles = [...byTime.values()]
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-this.maxLength);
  }

  update(candle: Candle): CandleUpdateResult {
    const last = this.candles.at(-1);
    if (!last || candle.openTime > last.openTime) {
      this.candles.push(candle);
      if (this.candles.length > this.maxLength) this.candles.shift();
      return "appended";
    }
    if (candle.openTime === last.openTime) {
      this.candles[this.candles.length - 1] = candle;
      return "replaced";
    }
    return "ignored-stale";
  }

  list(): readonly Candle[] {
    return this.candles;
  }

  latest(): Candle | null {
    return this.candles.at(-1) ?? null;
  }
}
