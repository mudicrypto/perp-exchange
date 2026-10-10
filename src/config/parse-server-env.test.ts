import { describe, expect, it } from "vitest";
import { ConfigError, parseServerEnv, rfqCounterpartyTokens, toPublicRuntimeConfig } from "./parse-server-env";
import { PublicRuntimeConfigSchema } from "./runtime-config";

describe("parseServerEnv", () => {
  it("defaults to live Hyperliquid mainnet data with execution disabled", () => {
    const env = parseServerEnv({});
    expect(env).toMatchObject({
      NOVA_MARKET_DATA_SOURCE: "hyperliquid",
      NOVA_HYPERLIQUID_NETWORK: "mainnet",
      NOVA_EXECUTION_MODE: "disabled",
    });
  });

  it("treats empty strings as unset", () => {
    expect(parseServerEnv({ NOVA_MARKET_DATA_SOURCE: "" }).NOVA_MARKET_DATA_SOURCE).toBe("hyperliquid");
  });

  it("refuses any execution mode other than disabled", () => {
    expect(() => parseServerEnv({ NOVA_EXECUTION_MODE: "live" })).toThrow(ConfigError);
  });

  it("refuses simulation in production unless explicitly allowed", () => {
    expect(() => parseServerEnv({ NODE_ENV: "production", NOVA_MARKET_DATA_SOURCE: "simulation" })).toThrow(/Simulated market data/);
    expect(
      parseServerEnv({
        NODE_ENV: "production",
        NOVA_MARKET_DATA_SOURCE: "simulation",
        NOVA_ALLOW_SIMULATION_IN_PRODUCTION: "true",
      }).NOVA_MARKET_DATA_SOURCE,
    ).toBe("simulation");
  });

  it("rejects unknown sources and networks", () => {
    expect(() => parseServerEnv({ NOVA_MARKET_DATA_SOURCE: "binance" })).toThrow(ConfigError);
    expect(() => parseServerEnv({ NOVA_HYPERLIQUID_NETWORK: "devnet" })).toThrow(ConfigError);
  });

  it("exposes only whitelisted, non-secret fields to the browser", () => {
    const publicConfig = toPublicRuntimeConfig(
      parseServerEnv({ NOVA_HYPERLIQUID_NETWORK: "testnet", SOME_SECRET: "do-not-leak" }),
    );
    expect(PublicRuntimeConfigSchema.parse(publicConfig)).toEqual({
      marketDataSource: "hyperliquid",
      hyperliquidNetwork: "testnet",
      executionMode: "disabled",
    });
    expect(JSON.stringify(publicConfig)).not.toContain("do-not-leak");
  });
});

describe("toPublicRuntimeConfig execution mode", () => {
  it("uses local paper matching only for simulated data", () => {
    expect(toPublicRuntimeConfig(parseServerEnv({ NOVA_MARKET_DATA_SOURCE: "simulation" })).executionMode).toBe("paper");
    expect(toPublicRuntimeConfig(parseServerEnv({ NOVA_MARKET_DATA_SOURCE: "hyperliquid" })).executionMode).toBe("disabled");
  });
});

describe("RFQ counterparty tokens", () => {
  it("parses id=token pairs and never exposes them in the public config", () => {
    const token = "t".repeat(32);
    const env = parseServerEnv({ NOVA_MARKET_DATA_SOURCE: "simulation", NOVA_RFQ_COUNTERPARTY_TOKENS: `sim-desk-c=${token}` });
    expect(rfqCounterpartyTokens(env).get("sim-desk-c")).toBe(token);
    expect(JSON.stringify(toPublicRuntimeConfig(env))).not.toContain(token);
  });

  it("rejects short or malformed tokens", () => {
    expect(() => parseServerEnv({ NOVA_RFQ_COUNTERPARTY_TOKENS: "sim-desk-c=short" })).toThrow(ConfigError);
    expect(() => parseServerEnv({ NOVA_RFQ_COUNTERPARTY_TOKENS: "nonsense" })).toThrow(ConfigError);
  });
});
