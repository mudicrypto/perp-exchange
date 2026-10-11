import { z } from "zod";
import { DEFAULT_RISK_LIMITS, RiskLimitsSchema, type RiskLimits } from "@/core/risk";
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
    /**
     * Bearer tokens for the *simulated* RFQ counterparties' API, as
     * `counterpartyId=token,...` (tokens ≥ 24 chars). Server-only; unset means
     * counterparties can only auto-quote. Ignored outside simulation mode.
     */
    NOVA_RFQ_COUNTERPARTY_TOKENS: z
      .string()
      .regex(/^[a-z0-9-]+=[A-Za-z0-9_-]{24,}(,[a-z0-9-]+=[A-Za-z0-9_-]{24,})*$/, "Expected id=token[,id=token] with tokens of at least 24 characters")
      .optional(),
    /**
     * Pre-trade risk limit overrides as JSON, merged onto DEFAULT_RISK_LIMITS,
     * e.g. {"maxOrderNotional":{"value":"50000","action":"block"}}. Amounts are
     * in the account's collateral currency. Enforced by the execution layer.
     */
    NOVA_RISK_LIMITS: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (raw === undefined) return DEFAULT_RISK_LIMITS;
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          ctx.addIssue({ code: "custom", message: "Must be JSON" });
          return z.NEVER;
        }
        const parsed = RiskLimitsSchema.partial().strict().safeParse(json);
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
          return z.NEVER;
        }
        return { ...DEFAULT_RISK_LIMITS, ...parsed.data } satisfies RiskLimits;
      }),
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

/** Parsed counterparty tokens (server-only). */
export function rfqCounterpartyTokens(env: ServerEnv): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of env.NOVA_RFQ_COUNTERPARTY_TOKENS?.split(",") ?? []) {
    const [id, token] = pair.split("=") as [string, string];
    tokens.set(id, token);
  }
  return tokens;
}

export function toPublicRuntimeConfig(env: ServerEnv): PublicRuntimeConfig {
  return {
    marketDataSource: env.NOVA_MARKET_DATA_SOURCE,
    hyperliquidNetwork: env.NOVA_HYPERLIQUID_NETWORK,
    executionMode: env.NOVA_MARKET_DATA_SOURCE === "simulation" ? "paper" : env.NOVA_EXECUTION_MODE,
    riskLimits: env.NOVA_RISK_LIMITS,
  };
}
