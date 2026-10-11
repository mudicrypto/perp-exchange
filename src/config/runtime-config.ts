import { z } from "zod";
import { RiskLimitsSchema } from "@/core/risk";

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
  /** Pre-trade limits configured on the server (not secret; shown in the UI and enforced by the execution layer). */
  riskLimits: RiskLimitsSchema,
});
export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;
