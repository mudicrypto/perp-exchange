import { randomBytes } from "node:crypto";
import { z } from "zod";
import { priceToTicks, quantityToLots, type InstrumentSpec } from "./instrument.ts";
import { canonicalJson } from "./journal.ts";
import { WindowLimiter } from "./rate-limit.ts";
import { STP_MODES, SIDES, TIME_IN_FORCE, VISIBILITIES, type EngineCommand, type OrderRef, type OrderView, type PrivateEvent } from "./types.ts";
import { OutcomeUnknownError, VenueUnavailableError, type Venue } from "./venue.ts";

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
 *   post-only rejections of new orders and replaces (the cheapest
 *   hidden-liquidity probes), idempotent retries keyed by client order id,
 *   a bounded refusal log.
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

/**
 * `unavailable`: nothing was recorded; retry later.
 * `outcome-unknown`: the command was, or may have been, journaled and takes effect on recovery if it was;
 * look the order up by its client order id once the venue is back before retrying.
 */
export type GatewayErrorCode = "unauthenticated" | "rate-limited" | "invalid-request" | "idempotency-conflict" | "unavailable" | "outcome-unknown";

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
  /** Individual refusal records kept for monitoring (oldest dropped; totals are always counted). */
  readonly refusalLogCapacity?: number;
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
  /** Most recent gateway-level refusals (never journaled), bounded; codes only, never payloads. */
  readonly refusals: { ts: number; accountId: string | null; code: GatewayErrorCode }[] = [];
  /** Total refusals per code since start (not bounded by the log capacity). */
  readonly refusalCounts = new Map<GatewayErrorCode, number>();

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
          const order = this.venue.engine.orderFor(accountId, message.ref);
          const spec = order && this.venue.engine.instrumentSpec(order.instrumentId);
          // Not the caller's order: let the engine answer, so the response is identical to a non-existent id.
          if (!spec) return this.forward(accountId, { type: "replace", accountId, ref: message.ref, priceTicks: 1, qtyLots: 1 });
          // Replacing a post-only order into the spread is the same free probe as a new post-only order.
          if (order.postOnly) {
            const wait = this.postOnlyLimiter.blockedFor(accountId, now);
            if (wait > 0) return this.refuse(now, accountId, fail("rate-limited", "Too many rejected post-only orders.", wait));
          }
          const converted = this.convert(spec, message.price, message.quantity);
          if (!converted.ok) return this.refuse(now, accountId, converted.response);
          const response = this.forward(accountId, { type: "replace", accountId, ref: message.ref, priceTicks: converted.priceTicks!, qtyLots: converted.qtyLots });
          this.countPostOnlyRejection(response, now, accountId);
          return response;
        }
        case "mass-cancel":
          return this.forward(accountId, { type: "mass-cancel", accountId, ...(message.instrumentId ? { instrumentId: message.instrumentId } : {}) });
      }
    } catch (error) {
      return this.failure(now, accountId, error);
    }
  }

  private failure(now: number, accountId: string, error: unknown): GatewayResponse {
    if (error instanceof OutcomeUnknownError) {
      return this.refuse(now, accountId, fail("outcome-unknown", "The command may have been recorded. Look the order up by its client order id once the venue is available before retrying."));
    }
    // VenueUnavailableError, or anything raised before the command was journaled.
    return this.refuse(now, accountId, fail("unavailable", "The venue is not accepting commands. Nothing was recorded."));
  }

  private countPostOnlyRejection(response: GatewayResponse, now: number, accountId: string) {
    const probe = response.ok && response.events.some((e) => (e.kind === "rejected" || e.kind === "request-rejected") && e.reason === "post-only-would-take");
    if (probe) this.postOnlyLimiter.record(accountId, now);
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
    this.countPostOnlyRejection(response, now, accountId);
    // Only an accepted order consumes the client order id (MATCHING-RULES §11): a rejected request
    // created nothing, so an identical retry is evaluated again rather than answered from a cache.
    if (!response.ok || !response.events.some((e) => e.kind === "accepted")) return response;
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

  private forward(accountId: string, command: EngineCommand): GatewayResponse {
    const result = this.venue.submit(command);
    return { ok: true, replayed: false, events: result.private.filter((e) => e.accountId === accountId) };
  }

  private refuse(ts: number, accountId: string | null, response: GatewayResponse): GatewayResponse {
    if (response.ok) return response;
    const code = response.error.code;
    this.refusalCounts.set(code, (this.refusalCounts.get(code) ?? 0) + 1);
    this.refusals.push({ ts, accountId, code });
    if (this.refusals.length > (this.options.refusalLogCapacity ?? 10_000)) this.refusals.shift();
    return response;
  }

  // ── private queries (own data only) ──────────────────────────────────────

  /**
   * Order state is read from the live engine. After a fault the engine may hold a half-applied
   * command, so these queries refuse (throw `VenueUnavailableError`) until the venue is recovered.
   * `events` stays readable: outboxes only ever contain outputs of fully processed commands.
   */
  private assertRunning() {
    const stopped = this.venue.stoppedReason;
    if (stopped) throw new VenueUnavailableError(`venue stopped: ${stopped}`);
  }

  order(token: string, ref: OrderRef): OrderView | null {
    const accountId = this.sessions.get(token);
    if (!accountId) return null;
    this.assertRunning();
    return this.venue.engine.orderFor(accountId, ref);
  }

  openOrders(token: string): OrderView[] | null {
    const accountId = this.sessions.get(token);
    if (!accountId) return null;
    this.assertRunning();
    return this.venue.engine.openOrdersFor(accountId);
  }

  events(token: string, afterAccountSeq = 0): PrivateEvent[] | null {
    const accountId = this.sessions.get(token);
    return accountId ? this.venue.privateEvents(accountId, afterAccountSeq) : null;
  }
}
