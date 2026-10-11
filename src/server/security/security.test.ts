import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BoundedSessionMap, SlidingWindowLimiter } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit per window, then reports retry-after", () => {
    const l = new SlidingWindowLimiter(3, 1_000);
    expect([0, 1, 2].map((t) => l.take("a", t).ok)).toEqual([true, true, true]);
    expect(l.take("a", 500)).toEqual({ ok: false, retryAfterMs: 500 });
    expect(l.isBlocked("a", 500)).toBe(true);
    expect(l.take("b", 500).ok).toBe(true); // keys are independent
    expect(l.take("a", 1_001).ok).toBe(true); // window slid
  });

  it("bounds memory by evicting the least recently used key", () => {
    const l = new SlidingWindowLimiter(1, 60_000, 3);
    for (const k of ["a", "b", "c", "d"]) l.take(k, 0);
    expect(l.trackedKeys).toBe(3);
    expect(l.take("a", 1).ok).toBe(true); // "a" was evicted, so it starts fresh
  });
});

describe("BoundedSessionMap", () => {
  it("evicts the least recently seen session instead of refusing new ones", () => {
    const m = new BoundedSessionMap<{ lastSeen: number }>(2, 1_000);
    m.set("a", { lastSeen: 0 });
    m.set("b", { lastSeen: 0 });
    expect(m.get("a", 10)).toBeTruthy(); // touch a → b is now oldest
    m.set("c", { lastSeen: 10 });
    expect([m.get("a", 20), m.get("b", 20), m.get("c", 20)].map(Boolean)).toEqual([true, false, true]);
  });

  it("expires idle sessions", () => {
    const m = new BoundedSessionMap<{ lastSeen: number }>(5, 1_000);
    m.set("a", { lastSeen: 0 });
    expect(m.get("a", 1_001)).toBeUndefined();
    expect(m.size).toBe(0);
  });
});

describe("request helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string> = {}) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("./request");
  }
  const post = (body: BodyInit, headers: Record<string, string> = {}) => new NextRequest("http://nova.test/api/x", { method: "POST", body, headers });

  it("refuses oversized bodies by declared length and while streaming, without buffering them", async () => {
    const { readJson } = await load();
    const schema = z.object({ a: z.number() }).strict();
    expect(await readJson(post(JSON.stringify({ a: 1 })), schema)).toEqual({ ok: true, value: { a: 1 } });
    const big = "x".repeat(10_000);
    expect((await readJson(post(big, { "content-length": "10000" }), schema, 4_096)) as { response: Response }).toMatchObject({ ok: false });
    const streamed = new ReadableStream({ start(c) { for (let i = 0; i < 10; i += 1) c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const r = await readJson(new NextRequest("http://nova.test/api/x", { method: "POST", body: streamed, duplex: "half" } as unknown as ConstructorParameters<typeof NextRequest>[1]), schema, 4_096);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(413);
    const bad = await readJson(post("{not json"), schema);
    if (!bad.ok) expect(bad.response.status).toBe(400);
    const extra = await readJson(post(JSON.stringify({ a: 1, b: 2 })), schema);
    if (!extra.ok) expect(extra.response.status).toBe(400);
  });

  it("identifies clients only through the configured proxy header", async () => {
    const shared = await load();
    expect(shared.clientKey(post("", { "x-forwarded-for": "1.2.3.4" }))).toBe("shared");
    const proxied = await load({ NOVA_CLIENT_IP_HEADER: "x-forwarded-for" });
    expect(proxied.clientKey(post("", { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("ip:1.2.3.4");
    expect(proxied.clientKey(post(""))).toBe("shared");
  });

  it("detects HTTPS directly or behind a TLS-terminating proxy", async () => {
    const { isHttps } = await load();
    expect(isHttps(new NextRequest("https://nova.test/"))).toBe(true);
    expect(isHttps(new NextRequest("http://nova.test/", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(isHttps(new NextRequest("http://nova.test/"))).toBe(false);
  });

  it("rate-limit responses carry Retry-After", async () => {
    const { rateLimited } = await load();
    const pair = { client: new SlidingWindowLimiter(1, 60_000), shared: new SlidingWindowLimiter(1, 60_000) };
    expect(rateLimited(pair, "ip:x")).toBeNull();
    const res = rateLimited(pair, "ip:x")!;
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
