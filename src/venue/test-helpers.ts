import { MemoryAnchorStore } from "./storage.ts";
import type { NewOrderCommand } from "./types.ts";
import { createLocalVenue, type LocalVenue } from "./synthetic.ts";
import type { AccountLimits } from "./instrument.ts";

/** Shared fixtures for venue tests (synthetic SYN-ALPHA: reference 4000 ticks, band ±400). */
export const ALPHA = "SYN-ALPHA";

export interface Harness extends LocalVenue {
  order(accountId: string, o?: Partial<Omit<NewOrderCommand, "type" | "accountId">>): ReturnType<LocalVenue["venue"]["submit"]>;
  idOf(accountId: string, clientOrderId: string): string;
}

let counter = 0;

export function harness(options: { accounts?: string[]; limits?: AccountLimits; publication?: "immediate" | "batched" } = {}): Harness {
  const lv = createLocalVenue({ accounts: options.accounts ?? ["syn-a", "syn-b", "syn-c"], limits: options.limits, publication: options.publication });
  return {
    ...lv,
    order(accountId, o = {}) {
      lv.clock.advance(1);
      return lv.venue.submit({
        type: "new-order",
        accountId,
        clientOrderId: `t${++counter}`,
        instrumentId: ALPHA,
        side: "buy",
        orderType: "limit",
        priceTicks: 4_000,
        qtyLots: 10,
        tif: "gtc",
        visibility: "displayed",
        postOnly: false,
        stp: "cancel-taker",
        ...o,
      });
    },
    idOf(accountId, clientOrderId) {
      const view = lv.venue.engine.orderFor(accountId, { clientOrderId });
      if (!view) throw new Error(`no order ${clientOrderId}`);
      return view.orderId;
    },
  };
}

const anchors = new WeakMap<object, MemoryAnchorStore>();
/** One commit anchor per test journal store, stable across restarts of that store (D-6). */
export function anchorFor(store: object): MemoryAnchorStore {
  let a = anchors.get(store);
  if (!a) anchors.set(store, (a = new MemoryAnchorStore()));
  return a;
}
