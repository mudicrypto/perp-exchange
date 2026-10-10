/**
 * Hyperliquid websocket protocol: typed subscriptions and a pure message
 * parser. No I/O happens here, so every rule is unit-testable.
 *
 * Client → server:  {"method":"subscribe"|"unsubscribe","subscription":{...}}
 *                   {"method":"ping"}
 * Server → client:  {"channel": <name>, "data": <payload>}
 *   - "subscriptionResponse": acknowledgement echoing the request
 *   - "pong":                 reply to ping
 *   - "error":                string, e.g. `Invalid subscription {...}`
 *   - data channels:          l2Book, trades, candle, activeAssetCtx, allMids
 */
import type { z } from "zod";
import {
  HlActiveAssetCtxSchema,
  HlAllMidsSchema,
  HlCandleSchema,
  HlL2BookSchema,
  HlTradesSchema,
  HlWsEnvelopeSchema,
  type HlActiveAssetCtx,
  type HlAllMids,
  type HlCandle,
  type HlL2Book,
  type HlTrade,
} from "./wire-schemas";

export type HlSubscription =
  | { type: "l2Book"; coin: string }
  | { type: "trades"; coin: string }
  | { type: "candle"; coin: string; interval: string }
  | { type: "activeAssetCtx"; coin: string }
  | { type: "allMids" };

/**
 * Canonical identity of a subscription (key order independent), used to
 * de-duplicate venue subscriptions and to route messages.
 */
export function subscriptionKey(subscription: HlSubscription): string {
  switch (subscription.type) {
    case "l2Book":
    case "trades":
    case "activeAssetCtx":
      return `${subscription.type}:${subscription.coin}`;
    case "candle":
      return `candle:${subscription.coin}:${subscription.interval}`;
    case "allMids":
      return "allMids";
  }
}

export function subscribeMessage(subscription: HlSubscription): string {
  return JSON.stringify({ method: "subscribe", subscription });
}

export function unsubscribeMessage(subscription: HlSubscription): string {
  return JSON.stringify({ method: "unsubscribe", subscription });
}

export const PING_MESSAGE = JSON.stringify({ method: "ping" });

export type ParsedMessage =
  | { kind: "l2Book"; key: string; data: HlL2Book }
  | { kind: "trades"; key: string; data: HlTrade[] }
  | { kind: "candle"; key: string; data: HlCandle }
  | { kind: "activeAssetCtx"; key: string; data: HlActiveAssetCtx }
  | { kind: "allMids"; key: string; data: HlAllMids }
  | { kind: "pong" }
  | { kind: "subscriptionResponse" }
  /** `subscriptionKey` is set when the error echoes a subscription we can identify. */
  | { kind: "error"; message: string; subscriptionKey: string | null; errorKind: "invalid-subscription" | "already-subscribed" | "other" }
  | { kind: "ignored"; channel: string }
  | { kind: "invalid"; reason: string; channel: string | null };

function validate<S extends z.ZodType>(schema: S, data: unknown): { ok: true; value: z.infer<S> } | { ok: false; reason: string } {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  return { ok: false, reason: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
}

/** Extracts the subscription echoed in an error string such as `Invalid subscription {"type":"l2Book","coin":"X"}`. */
function echoedSubscriptionKey(message: string): string | null {
  const match = message.match(/\{.*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const sub = (typeof record.subscription === "object" && record.subscription !== null ? record.subscription : record) as Record<string, unknown>;
    const type = sub.type;
    const coin = typeof sub.coin === "string" ? sub.coin : null;
    if (type === "allMids") return "allMids";
    if (type === "candle" && coin && typeof sub.interval === "string") return `candle:${coin}:${sub.interval}`;
    if ((type === "l2Book" || type === "trades" || type === "activeAssetCtx") && coin) return `${type}:${coin}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Parses one raw websocket frame. Never throws: malformed input becomes
 * `{ kind: "invalid" }` so the caller can count and drop it.
 */
export function parseWsMessage(raw: string): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "not JSON", channel: null };
  }
  const envelope = HlWsEnvelopeSchema.safeParse(json);
  if (!envelope.success) return { kind: "invalid", reason: "missing channel", channel: null };
  const { channel, data } = envelope.data;

  switch (channel) {
    case "pong":
      return { kind: "pong" };
    case "subscriptionResponse":
      return { kind: "subscriptionResponse" };
    case "error": {
      const message = typeof data === "string" ? data : JSON.stringify(data ?? null);
      const errorKind = message.startsWith("Invalid subscription")
        ? "invalid-subscription"
        : message.startsWith("Already subscribed")
          ? "already-subscribed"
          : "other";
      return { kind: "error", message, subscriptionKey: echoedSubscriptionKey(message), errorKind };
    }
    case "l2Book": {
      const r = validate(HlL2BookSchema, data);
      return r.ok ? { kind: "l2Book", key: `l2Book:${r.value.coin}`, data: r.value } : { kind: "invalid", reason: r.reason, channel };
    }
    case "trades": {
      const r = validate(HlTradesSchema, data);
      if (!r.ok) return { kind: "invalid", reason: r.reason, channel };
      const coin = r.value[0]?.coin;
      if (!coin) return { kind: "ignored", channel };
      if (r.value.some((t) => t.coin !== coin)) return { kind: "invalid", reason: "mixed coins in trades batch", channel };
      return { kind: "trades", key: `trades:${coin}`, data: r.value };
    }
    case "candle": {
      const r = validate(HlCandleSchema, data);
      return r.ok ? { kind: "candle", key: `candle:${r.value.s}:${r.value.i}`, data: r.value } : { kind: "invalid", reason: r.reason, channel };
    }
    case "activeAssetCtx": {
      const r = validate(HlActiveAssetCtxSchema, data);
      return r.ok ? { kind: "activeAssetCtx", key: `activeAssetCtx:${r.value.coin}`, data: r.value } : { kind: "invalid", reason: r.reason, channel };
    }
    case "allMids": {
      const r = validate(HlAllMidsSchema, data);
      return r.ok ? { kind: "allMids", key: "allMids", data: r.value } : { kind: "invalid", reason: r.reason, channel };
    }
    default:
      return { kind: "ignored", channel };
  }
}
