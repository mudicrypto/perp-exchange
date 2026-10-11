import { randomBytes } from "node:crypto";
import { z } from "zod";
import { priceToTicks, quantityToLots, type InstrumentSpec } from "./instrument.ts";
import { canonicalJson } from "./journal.ts";
import { WindowLimiter } from "./rate-limit.ts";
import { STP_MODES, SIDES, TIME_IN_FORCE, VISIBILITIES, type EngineCommand, type OrderRef, type OrderView, type PrivateEvent } from "./types.ts";
import type { Venue } from "./venue.ts";

/**
 * Order-entry gateway: the only path from (synthetic) clients to the
 * sequencer.
 *
 * - Authentication: a session token issued locally maps to exactly one
 *   account. The account is never taken from the message body (a body field
 *   named `accountId` is refused by the strict schema).
 * - Validation: strict Zod schemas; prices and sizes are decimal strings,
 *   converted exactly to ticks and lots or refused.
 * - Abuse controls: per-account message rate, a separate throttle on
 *   post-only rejections (the cheapest hidden-liquidity probe), idempotent
 *   retries keyed by client order id.
 * - Output: a response carries only the caller's own private events.
 *
 * There is no network listener; tests and the demo call `handle` directly.
 */

const decimal = z.string().max(40);
const clientOrderId = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);
const orderId = z.string().regex(/^o[0-9a-f]{16}$/);

const refSchema = z.union([z.object({ orderId }).strict(), z.object({ clientOrderId }).strict()]);

export const clientMessageSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("new"),
      clientOrderId,
      instrumentId: z.string().min(1).max(32),
      side: z.enum(SIDES),
      type: z.enum(["limit", "market"]),
      price: decimal.optional(),
      quantity: decimal,
      timeInForce: z.enum(TIME_IN_FORCE).default("gtc"),
      visibility: z.enum(VISIBILITIES).default("displayed"),
      postOnly: z.boolean().default(false),
      selfTradePrevention: z.enum(STP_MODES).default("cancel-taker"),
    })
    .strict(),
  z.object({ op: z.literal("cancel"), ref: refSchema }).strict(),
  z.object({ op: z.literal("replace"), ref: refSchema, price: decimal, quantity: decimal }).strict(),
  z.object({ op: z.literal("mass-cancel"), instrumentId: z.string().min(1).max(32).optional() }).strict(),
]);

export type ClientMessage = z.input<typeof clientMessageSchema>;

export type GatewayErrorCode = "unauthenticated" | "rate-limited" | "invalid-request" | "idempotency-conflict" | "unavailable";

export type GatewayResponse =
  | { ok: true; replayed: boolean; events: PrivateEvent[] }
  | { ok: false; error: { code: GatewayErrorCode; message: string; retryAfterMs?: number } };

export interface GatewayOptions {
  readonly clock: () => number;
  /** Messages (any op) per account per window. */
  readonly messages: { readonly limit: number; readonly windowMs: number };
  /** Post-only rejections per account per window before post-only orders are throttled. */
  readonly postOnlyRejects: { readonly limit: number; readonly windowMs: number };
  /** Idempotency records kept (oldest dropped; the engine still refuses duplicate client ids). */
  readonly idempotencyCapacity?: number;
}

export const DEFAULT_GATEWAY_LIMITS = {
  messages: { limit: 200, windowMs: 1_000 },
  postOnlyRejects: { limit: 20, windowMs: 60_000 },
} as const;

const fail = (code: GatewayErrorCode, message: string, retryAfterMs?: number): GatewayResponse => ({
  ok: false,
  error: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
});

const CONVERSION_MESSAGE = {
  "invalid-number": "must be a plain positive decimal",
  "not-on-tick": "is not a multiple of the tick size",
  "not-on-lot": "is not a multiple of the lot size",
} as const;

export class VenueGateway {
  private readonly venue: Venue;
  private readonly options: GatewayOptions;
  private readonly sessions = new Map<string, string>();
  private readonly messageLimiter: WindowLimiter;
  private readonly postOnlyLimiter: WindowLimiter;
  private readonly idempotency = new Map<string, { fingerprint: string; response: GatewayResponse }>();
  /** Gateway-level refusals (never reach the journal); kept for abuse monitoring. */
  readonly refusals: { ts: number; accountId: string | null; code: GatewayErrorCode }[] = [];

  constructor(venue: Venue, options: GatewayOptions) {
    this.venue = venue;
    this.options = options;
    this.messageLimiter = new WindowLimiter(options.messages.limit, options.messages.windowMs);
    this.postOnlyLimiter = new WindowLimiter(options.postOnlyRejects.limit, options.postOnlyRejects.windowMs);
  }

  /** Issues a 256-bit session token bound to one synthetic account. */
  openSession(accountId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, accountId);
    return token;
  }

  closeSession(token: string): void {
    this.sessions.delete(token);
  }

  handle(token: string, payload: unknown): GatewayResponse {
    const now = this.options.clock();
    const accountId = this.sessions.get(token);
    if (!accountId) return this.refuse(now, null, fail("unauthenticated", "Unknown or closed session."));
    const wait = this.messageLimiter.blockedFor(accountId, now);
    if (wait > 0) return this.refuse(now, accountId, fail("rate-limited", "Message rate limit exceeded.", wait));
    this.messageLimiter.record(accountId, now);

    const parsed = clientMessageSchema.safeParse(payload);
    if (!parsed.success) {
      // Name the offending field; never echo submitted values.
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "message";
      return this.refuse(now, accountId, fail("invalid-request", `Invalid ${where}.`));
    }
    const message = parsed.data;
    try {
      switch (message.op) {
        case "new":
          return this.newOrder(now, accountId, message);
        case "cancel":
          return this.forward(accountId, { type: "cancel", accountId, ref: message.ref });
        case "replace": {
          const spec = this.specForRef(accountId, message.ref);
          // Not the caller's order: let the engine answer, so the response is identical to a non-existent id.
          if (!spec) return this.forward(accountId, { type: "replace", accountId, ref: message.ref, priceTicks: 1, qtyLots: 1 });
          const converted = this.convert(spec, message.price, message.quantity);
          if (!converted.ok) return this.refuse(now, accountId, converted.response);
          return this.forward(accountId, { type: "replace", accountId, ref: message.ref, priceTicks: converted.priceTicks!, qtyLots: converted.qtyLots });
        }
        case "mass-cancel":
          return this.forward(accountId, { type: "mass-cancel", accountId, ...(message.instrumentId ? { instrumentId: message.instrumentId } : {}) });
      }
    } catch {
      // Engine stopped (fail-stop) or the command was refused by the sequencer.
      return fail("unavailable", "The venue is not accepting commands.");
    }
  }

  private newOrder(now: number, accountId: string, message: Extract<z.output<typeof clientMessageSchema>, { op: "new" }>): GatewayResponse {
    const key = `${accountId}\u0000${message.clientOrderId}`;
    const fingerprint = canonicalJson(message);
    const previous = this.idempotency.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return this.refuse(now, accountId, fail("idempotency-conflict", "This client order id was already used for a different order."));
      return previous.response.ok ? { ...previous.response, replayed: true } : previous.response;
    }
    const spec = this.venue.engine.instrumentSpec(message.instrumentId);
    if (!spec) return this.refuse(now, accountId, fail("invalid-request", "Unknown instrument."));
    if (message.postOnly) {
      const wait = this.postOnlyLimiter.blockedFor(accountId, now);
      if (wait > 0) return this.refuse(now, accountId, fail("rate-limited", "Too many rejected post-only orders.", wait));
    }
    const converted = this.convert(spec, message.price, message.quantity);
    if (!converted.ok) return this.refuse(now, accountId, converted.response);
    const response = this.forward(accountId, {
      type: "new-order",
      accountId,
      clientOrderId: message.clientOrderId,
      instrumentId: message.instrumentId,
      side: message.side,
      orderType: message.type,
      ...(converted.priceTicks !== undefined ? { priceTicks: converted.priceTicks } : {}),
      qtyLots: converted.qtyLots,
      tif: message.timeInForce,
      visibility: message.visibility,
      postOnly: message.postOnly,
      stp: message.selfTradePrevention,
    });
    if (response.ok && response.events.some((e) => e.kind === "rejected" && e.reason === "post-only-would-take")) {
      this.postOnlyLimiter.record(accountId, now);
    }
    this.idempotency.set(key, { fingerprint, response });
    if (this.idempotency.size > (this.options.idempotencyCapacity ?? 100_000)) this.idempotency.delete(this.idempotency.keys().next().value!);
    return response;
  }

  private convert(
    spec: InstrumentSpec,
    price: string | undefined,
    quantity: string,
  ): { ok: true; priceTicks: number | undefined; qtyLots: number } | { ok: false; response: GatewayResponse } {
    let priceTicks: number | undefined;
    if (price !== undefined) {
      const p = priceToTicks(spec, price);
      if (!p.ok) return { ok: false, response: fail("invalid-request", `Price ${CONVERSION_MESSAGE[p.error]}.`) };
      if (p.value === 0) return { ok: false, response: fail("invalid-request", "Price must be positive.") };
      priceTicks = p.value;
    }
    const q = quantityToLots(spec, quantity);
    if (!q.ok) return { ok: false, response: fail("invalid-request", `Quantity ${CONVERSION_MESSAGE[q.error]}.`) };
    if (q.value === 0) return { ok: false, response: fail("invalid-request", "Quantity must be positive.") };
    return { ok: true, priceTicks, qtyLots: q.value };
  }

  /** Instrument of the caller's own order, if any (others' orders resolve to nothing). */
  private specForRef(accountId: string, ref: OrderRef): InstrumentSpec | null {
    const order = this.venue.engine.orderFor(accountId, ref);
    return order ? this.venue.engine.instrumentSpec(order.instrumentId) : null;
  }

  private forward(accountId: string, command: EngineCommand): GatewayResponse {
    const result = this.venue.submit(command);
    return { ok: true, replayed: false, events: result.private.filter((e) => e.accountId === accountId) };
  }

  private refuse(ts: number, accountId: string | null, response: GatewayResponse): GatewayResponse {
    if (!response.ok) this.refusals.push({ ts, accountId, code: response.error.code });
    return response;
  }

  // ── private queries (own data only) ──────────────────────────────────────

  order(token: string, ref: OrderRef): OrderView | null {
    const accountId = this.sessions.get(token);
    return accountId ? this.venue.engine.orderFor(accountId, ref) : null;
  }

  openOrders(token: string): OrderView[] | null {
    const accountId = this.sessions.get(token);
    return accountId ? this.venue.engine.openOrdersFor(accountId) : null;
  }

  events(token: string, afterAccountSeq = 0): PrivateEvent[] | null {
    const accountId = this.sessions.get(token);
    return accountId ? this.venue.privateEvents(accountId, afterAccountSeq) : null;
  }
}
