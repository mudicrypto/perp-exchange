/**
 * Fixture history for the simulated demo account (fictitious SIMUSD, fictitious
 * markets). Entries are replayed through `PaperEngine` so that positions,
 * balances, fills and order history are derived by the same accounting code
 * that handles live paper orders — the fixture cannot be internally
 * inconsistent. Timestamps are relative to session start.
 */
import type { Market, MarketId, OrderIntent, OrderType, Side, TimeInForce } from "@/core/domain";
import { PaperEngine } from "./paper-engine";

export const DEMO_STARTING_BALANCE = 25_000;

interface FixtureOrder {
  minutesAgo: number;
  marketId: MarketId;
  side: Side;
  type: OrderType;
  size: number;
  price: number;
  leverage: number;
  timeInForce?: TimeInForce;
  reduceOnly?: boolean;
}

type FixtureEntry =
  | ({ kind: "filled"; liquidity: "maker" | "taker" } & FixtureOrder)
  | ({ kind: "cancelled"; closedMinutesAgo: number } & FixtureOrder)
  | ({ kind: "rejected-margin" } & FixtureOrder)
  | ({ kind: "resting" } & FixtureOrder);

export const DEMO_ACCOUNT_FIXTURE: readonly FixtureEntry[] = [
  { kind: "filled", liquidity: "maker", minutesAgo: 340, marketId: "ALPHA-PERP", side: "buy", type: "limit", size: 4, price: 992.4, leverage: 10 },
  { kind: "filled", liquidity: "taker", minutesAgo: 290, marketId: "BETA-PERP", side: "sell", type: "market", size: 300, price: 42.812, leverage: 5 },
  { kind: "filled", liquidity: "taker", minutesAgo: 210, marketId: "ALPHA-PERP", side: "buy", type: "market", size: 1.5, price: 997.9, leverage: 10 },
  { kind: "filled", liquidity: "maker", minutesAgo: 150, marketId: "GAMMA-PERP", side: "buy", type: "limit", size: 20_000, price: 0.7912, leverage: 3 },
  { kind: "filled", liquidity: "maker", minutesAgo: 95, marketId: "GAMMA-PERP", side: "sell", type: "limit", size: 20_000, price: 0.8064, leverage: 3 },
  { kind: "rejected-margin", minutesAgo: 60, marketId: "ALPHA-PERP", side: "buy", type: "market", size: 600, price: 1001.2, leverage: 25 },
  { kind: "filled", liquidity: "maker", minutesAgo: 40, marketId: "BETA-PERP", side: "buy", type: "limit", size: 100, price: 42.371, leverage: 5, reduceOnly: true },
  { kind: "cancelled", closedMinutesAgo: 18, minutesAgo: 25, marketId: "GAMMA-PERP", side: "buy", type: "limit", size: 15_000, price: 0.765, leverage: 3 },
  { kind: "resting", minutesAgo: 12, marketId: "ALPHA-PERP", side: "sell", type: "limit", size: 2, price: 1035, leverage: 10, reduceOnly: true },
  { kind: "resting", minutesAgo: 6, marketId: "BETA-PERP", side: "sell", type: "limit", size: 100, price: 43.9, leverage: 5 },
];

function toIntent(entry: FixtureOrder): OrderIntent {
  return {
    marketId: entry.marketId,
    side: entry.side,
    type: entry.type,
    size: entry.size,
    limitPrice: entry.type === "limit" ? entry.price : null,
    timeInForce: entry.timeInForce ?? (entry.type === "market" ? "ioc" : "gtc"),
    reduceOnly: entry.reduceOnly ?? false,
    leverage: entry.leverage,
    marginMode: "isolated",
  };
}

const MINUTE = 60_000;

export function createDemoPaperEngine(markets: ReadonlyMap<MarketId, Market>, now: number): PaperEngine {
  const engine = new PaperEngine(markets, DEMO_STARTING_BALANCE);
  const ordered = [...DEMO_ACCOUNT_FIXTURE].sort((a, b) => b.minutesAgo - a.minutesAgo);
  for (const entry of ordered) {
    const time = now - entry.minutesAgo * MINUTE;
    const intent = toIntent(entry);
    switch (entry.kind) {
      case "filled":
        engine.seedFilledOrder(intent, entry.price, entry.liquidity, time);
        break;
      case "resting":
        engine.seedRestingOrder(intent, time);
        break;
      case "cancelled":
        engine.seedTerminalOrder(intent, "cancelled", "Cancelled by user", time, now - entry.closedMinutesAgo * MINUTE);
        break;
      case "rejected-margin": {
        const required = (entry.size * entry.price) / entry.leverage;
        const available = engine.snapshot(time).available;
        engine.seedTerminalOrder(
          intent,
          "rejected",
          `Insufficient margin: requires ${required.toFixed(2)} SIMUSD, available ${available.toFixed(2)}`,
          time,
          time,
        );
        break;
      }
    }
  }
  return engine;
}
