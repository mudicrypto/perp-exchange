import { TEST_FIXTURE_ID_KEY } from "./id-key.ts";
import { SYNTHETIC_INSTRUMENTS } from "./instrument.ts";
import type { CommitRecordStore, JournalStore } from "./storage.ts";
import { seededRandom, SYNTHETIC_LIMITS } from "./synthetic.ts";
import type { EngineCommand } from "./types.ts";
import { Venue, type VenueOptions } from "./venue.ts";

/**
 * Shared fixtures for the Milestone 11 (Venue) durability tests: a deterministic synthetic flow and a
 * reference run to compare recovered venues against. Test support only; no production code imports it.
 */

export const DURABILITY_ACCOUNTS = ["syn-a", "syn-b", "syn-c"] as const;
export const DURABILITY_CLOCK = () => 1_700_000_000_000;
export const DURABILITY_ALPHA = SYNTHETIC_INSTRUMENTS[0]!.id;

export function durableOptions(stores: { store?: JournalStore; records?: CommitRecordStore } = {}, extra: Partial<VenueOptions> = {}): VenueOptions {
  return {
    engine: { idKey: TEST_FIXTURE_ID_KEY, publication: "immediate" },
    allowTestFixtureIdKey: true,
    clock: DURABILITY_CLOCK,
    ...(stores.store ? { store: stores.store } : {}),
    ...(stores.records ? { commitRecords: stores.records } : {}),
    ...extra,
  };
}

export function setupCommands(): EngineCommand[] {
  return [
    { type: "admin.add-instrument", spec: SYNTHETIC_INSTRUMENTS[0]! },
    ...DURABILITY_ACCOUNTS.map((accountId): EngineCommand => ({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS })),
  ];
}

/** Setup plus `n` seeded commands: displayed and hidden limit orders, IOC/FOK, cancels, replaces, mass cancels. */
export function orderFlow(seed: number, n: number): EngineCommand[] {
  const rnd = seededRandom(seed);
  const pick = (k: number) => Math.floor(rnd() * k);
  const out = setupCommands();
  for (let i = 0; i < n; i++) {
    const accountId = DURABILITY_ACCOUNTS[pick(3)]!;
    const r = rnd();
    if (r < 0.6) {
      const hidden = pick(4) === 0;
      out.push({
        type: "new-order",
        accountId,
        clientOrderId: `f${seed}-${i}`,
        instrumentId: DURABILITY_ALPHA,
        side: pick(2) ? "buy" : "sell",
        orderType: "limit",
        priceTicks: 3_995 + pick(11),
        qtyLots: hidden ? 100 + pick(200) : 1 + pick(150),
        tif: hidden ? "gtc" : (["gtc", "gtc", "ioc", "fok"] as const)[pick(4)]!,
        visibility: hidden ? "hidden" : "displayed",
        postOnly: pick(8) === 0,
        stp: (["cancel-taker", "cancel-maker", "cancel-both"] as const)[pick(3)]!,
      });
    } else if (r < 0.8) out.push({ type: "cancel", accountId, ref: { clientOrderId: `f${seed}-${pick(i + 1)}` } });
    else if (r < 0.95) out.push({ type: "replace", accountId, ref: { clientOrderId: `f${seed}-${pick(i + 1)}` }, priceTicks: 3_995 + pick(11), qtyLots: 1 + pick(300) });
    else out.push({ type: "mass-cancel", accountId });
  }
  return out;
}

/** An uninterrupted, store-less run of exactly `commands`. */
export function referenceVenue(commands: readonly EngineCommand[]): Venue {
  const venue = new Venue(durableOptions());
  for (const c of commands) venue.submit(c);
  return venue;
}

/** What two venues must agree on to be "the same committed state". */
export function fingerprint(venue: Venue) {
  return {
    stateHash: venue.engine.stateHash(),
    outputHead: venue.outputHead,
    seq: venue.journal.lastSeq,
    head: venue.journal.head,
    ledger: venue.snapshot().idempotencyHash,
  };
}
