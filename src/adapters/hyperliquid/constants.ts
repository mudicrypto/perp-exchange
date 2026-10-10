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

/** The server closes idle connections; ping well inside that window. */
export const HYPERLIQUID_PING_INTERVAL_MS = 30_000;
export const HYPERLIQUID_PONG_TIMEOUT_MS = 10_000;

export const HYPERLIQUID_INTERVALS: Record<CandleInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
};
