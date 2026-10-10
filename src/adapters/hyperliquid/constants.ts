import type { CandleInterval } from "@/core/domain";

export type HyperliquidNetwork = "mainnet" | "testnet";

export const HYPERLIQUID_ENDPOINTS: Record<HyperliquidNetwork, { info: string; ws: string }> = {
  mainnet: { info: "https://api.hyperliquid.xyz/info", ws: "wss://api.hyperliquid.xyz/ws" },
  testnet: {
    info: "https://api.hyperliquid-testnet.xyz/info",
    ws: "wss://api.hyperliquid-testnet.xyz/ws",
  },
};

export const HYPERLIQUID_VENUE_ID = "hyperliquid";
export const HYPERLIQUID_QUOTE = "USDC";

/** Perp prices may have at most (MAX_DECIMALS - szDecimals) decimals. */
export const HYPERLIQUID_PERP_MAX_DECIMALS = 6;

/** Hyperliquid funding is paid hourly. */
export const HYPERLIQUID_FUNDING_INTERVAL_HOURS = 1;

/**
 * The server closes idle connections; the official SDKs ping every 50s.
 * Nova pings more often and treats a missing reply as a dead connection.
 */
export const HYPERLIQUID_PING_INTERVAL_MS = 30_000;
export const HYPERLIQUID_PONG_TIMEOUT_MS = 10_000;

/**
 * Rate-limit budgets. Hyperliquid documents per-IP limits ("Rate limits and
 * user limits" page): REST requests share a weight budget of 1200/minute
 * (info requests mostly weight 20; l2Book/allMids weight 2; candleSnapshot
 * adds weight per 60 items returned) and websockets allow at most 1000
 * subscriptions. These figures could not be re-checked against the docs
 * from the build environment, so Nova deliberately stays far below them.
 */
export const HYPERLIQUID_DOCUMENTED_WEIGHT_PER_MINUTE = 1200;
/** Nova's own server-side budget: half of the documented limit. */
export const NOVA_INFO_WEIGHT_BUDGET_PER_MINUTE = 600;
export const HYPERLIQUID_INFO_WEIGHT = {
  metaAndAssetCtxs: 20,
  clearinghouseState: 2,
  frontendOpenOrders: 20,
  candleSnapshot: 20,
  /** Extra weight per 60 candles returned. */
  candleSnapshotPer60Items: 1,
} as const;
/** Per-connection cap, far below the documented 1000. */
export const HYPERLIQUID_MAX_SUBSCRIPTIONS = 100;

export const HYPERLIQUID_INTERVALS: Record<CandleInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};
