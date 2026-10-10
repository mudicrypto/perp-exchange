import { z } from "zod";

/**
 * Configuration that is safe to send to the browser. Contains no secrets —
 * this object is serialised into the page.
 */
export const PublicRuntimeConfigSchema = z.object({
  marketDataSource: z.enum(["hyperliquid", "simulation"]),
  hyperliquidNetwork: z.enum(["mainnet", "testnet"]),
  executionMode: z.literal("disabled"),
});
export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;
