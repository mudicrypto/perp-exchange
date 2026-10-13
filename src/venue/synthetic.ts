import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayOptions } from "./gateway.ts";
import { TEST_FIXTURE_ID_KEY } from "./id-key.ts";
import { formatPrice, formatQuantity, SYNTHETIC_INSTRUMENTS, type AccountLimits, type InstrumentSpec } from "./instrument.ts";
import { Venue } from "./venue.ts";

/**
 * Synthetic participants and order flow for the local prototype. Everything
 * here is fictitious: SYN-* instruments, syn-* accounts, seeded randomness.
 */

/** Small, fast, seedable PRNG (mulberry32). Not for anything security-relevant. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const SYNTHETIC_LIMITS: AccountLimits = { maxOpenOrders: 500, maxOrderNotional: 1_000_000_000, maxPositionLots: 5_000_000 };

/** Manually advanced clock, so every run is reproducible. */
export class ManualClock {
  now: number;
  constructor(start = 1_700_000_000_000) {
    this.now = start;
  }
  advance(ms: number) {
    this.now += ms;
  }
  readonly read = () => this.now;
}

export interface LocalVenue {
  readonly venue: Venue;
  readonly gateway: VenueGateway;
  readonly clock: ManualClock;
  readonly tokens: ReadonlyMap<string, string>;
}

export function createLocalVenue(options: {
  accounts: readonly string[];
  instruments?: readonly InstrumentSpec[];
  limits?: AccountLimits;
  publication?: "immediate" | "batched";
  idKey?: string;
  gateway?: Partial<Pick<GatewayOptions, "messages" | "postOnlyRejects">>;
}): LocalVenue {
  const clock = new ManualClock();
  // Synthetic fixture factory: without an explicit key it uses the deterministic test-fixture key,
  // and says so (allowTestFixtureIdKey). A supplied key must satisfy the id-key policy (A-5).
  const venue = new Venue({
    engine: { idKey: options.idKey ?? TEST_FIXTURE_ID_KEY, publication: options.publication ?? "immediate" },
    clock: clock.read,
    allowTestFixtureIdKey: options.idKey === undefined,
  });
  for (const spec of options.instruments ?? SYNTHETIC_INSTRUMENTS) venue.submit({ type: "admin.add-instrument", spec });
  for (const accountId of options.accounts) venue.submit({ type: "admin.add-account", accountId, limits: options.limits ?? SYNTHETIC_LIMITS });
  const gateway = new VenueGateway(venue, { clock: clock.read, ...DEFAULT_GATEWAY_LIMITS, ...options.gateway });
  const tokens = new Map(options.accounts.map((a) => [a, gateway.openSession(a)]));
  return { venue, gateway, clock, tokens };
}

export interface SyntheticMessage {
  readonly accountId: string;
  readonly message: ClientMessage;
}

/**
 * Deterministic synthetic order flow around a random-walk mid price:
 * displayed and hidden limit orders, cancels, replaces, IOC/FOK and market
 * orders, post-only orders. Some messages are deliberately invalid or refer to
 * orders that are already done, as real flow does.
 */
export function syntheticFlow(seed: number, count: number, accounts: readonly string[], spec: InstrumentSpec = SYNTHETIC_INSTRUMENTS[0]!): SyntheticMessage[] {
  const rng = seededRandom(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)]!;
  const sent = new Map<string, string[]>(accounts.map((a) => [a, []]));
  let mid = spec.referencePriceTicks;
  const out: SyntheticMessage[] = [];
  for (let i = 0; i < count; i++) {
    mid = Math.max(spec.minPriceTicks + 50, mid + Math.round((rng() - 0.5) * 2));
    const accountId = pick(accounts);
    const own = sent.get(accountId)!;
    const r = rng();
    const side = rng() < 0.5 ? "buy" : "sell";
    const offset = Math.floor(rng() * 12) - 3; // mostly passive, some aggressive
    const priceTicks = Math.max(spec.minPriceTicks, side === "buy" ? mid - offset : mid + offset);
    const price = formatPrice(spec, priceTicks);
    const lots = 1 + Math.floor(rng() * 400);
    if (r < 0.45 || own.length === 0) {
      const hidden = rng() < 0.25;
      const clientOrderId = `${accountId.slice(4)}-${i}`;
      own.push(clientOrderId);
      out.push({
        accountId,
        message: {
          op: "new",
          clientOrderId,
          instrumentId: spec.id,
          side,
          type: "limit",
          price,
          quantity: formatQuantity(spec, hidden ? Math.max(lots, spec.minHiddenQtyLots) : lots),
          visibility: hidden ? "hidden" : "displayed",
          selfTradePrevention: pick(["cancel-taker", "cancel-maker", "cancel-both"] as const),
        },
      });
    } else if (r < 0.7) {
      out.push({ accountId, message: { op: "cancel", ref: { clientOrderId: pick(own) } } });
    } else if (r < 0.8) {
      out.push({ accountId, message: { op: "replace", ref: { clientOrderId: pick(own) }, price, quantity: formatQuantity(spec, lots) } });
    } else if (r < 0.9) {
      const clientOrderId = `${accountId.slice(4)}-${i}`;
      own.push(clientOrderId);
      const market = rng() < 0.3;
      out.push({
        accountId,
        message: {
          op: "new",
          clientOrderId,
          instrumentId: spec.id,
          side,
          type: market ? "market" : "limit",
          ...(market ? {} : { price: formatPrice(spec, side === "buy" ? mid + 6 : mid - 6) }),
          quantity: formatQuantity(spec, lots),
          timeInForce: rng() < 0.8 ? "ioc" : "fok",
        },
      });
    } else if (r < 0.97) {
      const clientOrderId = `${accountId.slice(4)}-${i}`;
      own.push(clientOrderId);
      out.push({ accountId, message: { op: "new", clientOrderId, instrumentId: spec.id, side, type: "limit", price, quantity: formatQuantity(spec, lots), postOnly: true } });
    } else {
      out.push({ accountId, message: { op: "mass-cancel", instrumentId: spec.id } });
    }
  }
  return out;
}
