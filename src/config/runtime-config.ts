import { z } from "zod";

/**
 * Configuration that is safe to send to the browser. Contains no secrets —
 * this object is serialised into the page.
 */
export const PublicRuntimeConfigSchema = z.object({
  marketDataSource: z.enum(["hyperliquid", "simulation"]),
  hyperliquidNetwork: z.enum(["mainnet", "testnet"]),
  /**
   * "paper" only when market data is simulated: orders are matched locally
   * against simulated books. Live venues are always "disabled" in this milestone.
   */
  executionMode: z.enum(["disabled", "paper"]),
});
export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;
