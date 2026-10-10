import { z } from "zod";
import type { PublicRuntimeConfig } from "./runtime-config";

const ServerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    NOVA_MARKET_DATA_SOURCE: z.enum(["hyperliquid", "simulation"]).default("hyperliquid"),
    NOVA_HYPERLIQUID_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
    /**
     * Live-venue execution. Milestone 1 has none: any value other than
     * "disabled" is a configuration error, so real trading cannot be switched
     * on by accident. (The simulated source always uses local paper matching.)
     */
    NOVA_EXECUTION_MODE: z.literal("disabled").default("disabled"),
    NOVA_ALLOW_SIMULATION_IN_PRODUCTION: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === "production" &&
      env.NOVA_MARKET_DATA_SOURCE === "simulation" &&
      env.NOVA_ALLOW_SIMULATION_IN_PRODUCTION !== "true"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["NOVA_MARKET_DATA_SOURCE"],
        message:
          "Simulated market data is disabled in production. Set NOVA_ALLOW_SIMULATION_IN_PRODUCTION=true for demo deployments.",
      });
    }
  });

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  // Treat empty strings as unset so `FOO=` falls back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = ServerEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid server configuration:\n${details.join("\n")}`);
  }
  return parsed.data;
}

export function toPublicRuntimeConfig(env: ServerEnv): PublicRuntimeConfig {
  return {
    marketDataSource: env.NOVA_MARKET_DATA_SOURCE,
    hyperliquidNetwork: env.NOVA_HYPERLIQUID_NETWORK,
    executionMode: env.NOVA_MARKET_DATA_SOURCE === "simulation" ? "paper" : env.NOVA_EXECUTION_MODE,
  };
}
