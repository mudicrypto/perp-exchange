import "server-only";
import { VenueError } from "@/adapters/hyperliquid/info-client";
import { ConfigError } from "@/config/parse-server-env";

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/** Map internal failures to safe client-facing errors (no stack traces, no internals). */
export function errorResponse(error: unknown): Response {
  if (error instanceof VenueError) {
    console.warn(`Venue request failed (${error.code}): ${error.message}`);
    const status = error.code === "timeout" ? 504 : 502;
    return jsonError(status, `venue-${error.code}`, "Market data venue is unavailable or returned invalid data.");
  }
  if (error instanceof ConfigError) {
    console.error(error.message);
    return jsonError(500, "config", "Server is misconfigured.");
  }
  console.error("Unhandled API error", error);
  return jsonError(500, "internal", "Unexpected server error.");
}
