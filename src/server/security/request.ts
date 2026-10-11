import "server-only";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { getServerEnv } from "@/config/server-env";
import { jsonError } from "../api-response";
import { pick, type LimiterPair } from "./limits";

/**
 * Identifies the client for rate limiting. Next.js route handlers have no
 * socket address, so the client IP comes from a header set by a trusted
 * reverse proxy (NOVA_CLIENT_IP_HEADER, e.g. "x-forwarded-for"). Without one,
 * every client shares the "shared" key, which has its own larger limits:
 * they protect the server, but one abusive client can slow others down.
 */
export function clientKey(request: NextRequest): string {
  const header = getServerEnv().NOVA_CLIENT_IP_HEADER;
  if (!header) return "shared";
  const first = request.headers.get(header)?.split(",")[0]?.trim();
  return first && first.length <= 64 ? `ip:${first}` : "shared";
}

/** Returns a 429 response (with Retry-After) when the limiter refuses `key`, else null. */
export function rateLimited(limiters: LimiterPair, key: string): Response | null {
  const r = pick(limiters, key).take(key);
  if (r.ok) return null;
  const response = jsonError(429, "rate-limited", "Too many requests; slow down.");
  response.headers.set("retry-after", String(Math.ceil(r.retryAfterMs / 1000)));
  return response;
}

/**
 * Reads at most `maxBytes` of the body (refusing early on Content-Length),
 * parses JSON and validates it. Never buffers an oversized body.
 */
export async function readJson<T>(request: NextRequest, schema: z.ZodType<T>, maxBytes = 4_096): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const tooLarge = () => ({ ok: false as const, response: jsonError(413, "too-large", "Request body too large.") });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return { ok: false, response: jsonError(400, "bad-request", "Body must be JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: jsonError(400, "bad-request", parsed.error.issues[0]?.message ?? "Invalid request.") };
  return { ok: true, value: parsed.data };
}

/**
 * Whether the browser reached us over HTTPS, including behind a TLS-terminating
 * proxy. A spoofed X-Forwarded-Proto can only make cookies *more* restrictive.
 */
export function isHttps(request: NextRequest): boolean {
  return request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}
