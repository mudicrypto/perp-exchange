import "server-only";
import { parseServerEnv, toPublicRuntimeConfig, type ServerEnv } from "./parse-server-env";
import type { PublicRuntimeConfig } from "./runtime-config";

let cached: ServerEnv | null = null;

/** Validated server configuration. Throws `ConfigError` on invalid env. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return toPublicRuntimeConfig(getServerEnv());
}
