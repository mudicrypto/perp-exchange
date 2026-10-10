import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "unit-test-token-desk-c-00000000";

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  delete (globalThis as { __novaRfq?: unknown }).__novaRfq;
  return import("./rfq-service");
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __novaRfq?: unknown }).__novaRfq;
});

describe("RFQ server gate", () => {
  it("does not exist in live mode", async () => {
    const service = await load({ NOVA_MARKET_DATA_SOURCE: "hyperliquid" });
    expect(service.getRfqState()).toBeNull();
  });

  it("only accepts sessions it issued", async () => {
    const service = await load({ NOVA_MARKET_DATA_SOURCE: "simulation" });
    const state = service.getRfqState()!;
    const id = service.createSession(state)!;
    const withCookie = (value: string) => new NextRequest("http://nova.test/api/rfq", { headers: { cookie: `${service.SESSION_COOKIE}=${value}` } });
    expect(service.requesterSession(state, withCookie(id))).toBe(id);
    expect(service.requesterSession(state, withCookie("forged-session-id"))).toBeNull();
    expect(service.requesterSession(state, new NextRequest("http://nova.test/api/rfq"))).toBeNull();
  });

  it("authenticates counterparties by configured token only", async () => {
    const service = await load({ NOVA_MARKET_DATA_SOURCE: "simulation", NOVA_RFQ_COUNTERPARTY_TOKENS: `sim-desk-c=${TOKEN}` });
    const bearer = (value: string) => new NextRequest("http://nova.test/api/rfq/inbox", { headers: { authorization: `Bearer ${value}` } });
    expect(service.counterpartyFromRequest(bearer(TOKEN))).toBe("sim-desk-c");
    expect(service.counterpartyFromRequest(bearer(`${TOKEN}x`))).toBeNull();
    expect(service.counterpartyFromRequest(new NextRequest("http://nova.test/api/rfq/inbox"))).toBeNull();
  });

  it("requires a same-origin Origin header for mutations", async () => {
    const service = await load({ NOVA_MARKET_DATA_SOURCE: "simulation" });
    const req = (headers: Record<string, string>) => new NextRequest("http://nova.test/api/rfq", { method: "POST", headers });
    expect(service.sameOrigin(req({ host: "nova.test", origin: "http://nova.test" }))).toBe(true);
    expect(service.sameOrigin(req({ host: "nova.test", origin: "https://evil.example" }))).toBe(false);
    expect(service.sameOrigin(req({ host: "nova.test" }))).toBe(false);
    expect(service.sameOrigin(req({ host: "nova.test", origin: "null" }))).toBe(false);
  });
});
