import type { GatewayResponse } from "./gateway.ts";
import { formatPrice, formatQuantity, SYNTHETIC_INSTRUMENTS } from "./instrument.ts";
import { PublicBookMirror } from "./public-feed.ts";
import { reconcile, type ReconciliationReport } from "./reconcile.ts";
import { createLocalVenue, syntheticFlow } from "./synthetic.ts";
import type { PrivateEvent, PublicMessage } from "./types.ts";
import { Venue } from "./venue.ts";

/**
 * Local demonstration of the venue prototype with synthetic orders only.
 *
 * Part 1 walks through hidden-order behaviour and prints what each party
 * sees. Part 2 runs seeded random flow, reconciles, and recovers from a
 * snapshot plus journal to show deterministic replay.
 */

const SPEC = SYNTHETIC_INSTRUMENTS[0]!;
const px = (ticks: number) => formatPrice(SPEC, ticks);
const qty = (lots: number) => formatQuantity(SPEC, lots);

function describePrivate(e: PrivateEvent): string {
  switch (e.kind) {
    case "accepted":
      return `accepted ${e.order.side} ${qty(e.order.qtyLots)} @ ${px(e.order.priceTicks)} (${e.order.visibility}${e.order.postOnly ? ", post-only" : ""})`;
    case "rejected":
      return `rejected ${e.clientOrderId}: ${e.reason}`;
    case "fill":
      return `fill ${e.liquidity} ${e.side} ${qty(e.qtyLots)} @ ${px(e.priceTicks)} → ${e.status}, leaves ${qty(e.leavesLots)}`;
    case "cancelled":
      return `cancelled ${e.clientOrderId}: ${e.reason} (filled ${qty(e.filledLots)})`;
    case "replaced":
      return `replaced → ${qty(e.order.qtyLots)} @ ${px(e.order.priceTicks)} (priority ${e.priorityRetained ? "kept" : "lost"})`;
    case "request-rejected":
      return `${e.request} refused: ${e.reason}`;
    case "mass-cancelled":
      return `mass-cancelled ${e.count}`;
  }
}

function describePublic(m: PublicMessage): string {
  switch (m.kind) {
    case "trade":
      return `#${m.publicSeq} trade ${qty(m.qtyLots)} @ ${px(m.priceTicks)} (aggressor ${m.aggressor})`;
    case "level":
      return `#${m.publicSeq} level ${m.side} ${px(m.priceTicks)} = ${qty(m.displayedLots)}`;
    case "status":
      return `#${m.publicSeq} status ${m.instrumentId} ${m.status}`;
  }
}

export interface DemoSummary {
  readonly lines: string[];
  readonly reconciliation: ReconciliationReport;
  readonly journalHead: string;
  readonly outputHead: string;
  readonly stateHash: string;
  readonly recoveredStateHash: string;
  readonly recoveredOutputHead: string;
  readonly commands: number;
  readonly trades: number;
  readonly hiddenExecutions: number;
}

export function runDemo(seed = 7, flowMessages = 5_000): DemoSummary {
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);

  // ── Part 1: hidden orders, step by step ──────────────────────────────────
  const accounts = ["syn-maker-a", "syn-maker-b", "syn-taker-c"];
  const { venue, gateway, clock, tokens } = createLocalVenue({ accounts });
  const publicSince = () => {
    const from = venue.publicTape.length;
    return () => venue.publicTape.slice(from);
  };
  const send = (accountId: string, message: Parameters<typeof gateway.handle>[1], label: string) => {
    clock.advance(10);
    const next = publicSince();
    const res: GatewayResponse = gateway.handle(tokens.get(accountId)!, message);
    log(`▸ ${accountId}: ${label}`);
    if (!res.ok) log(`    gateway: ${res.error.code} — ${res.error.message}`);
    else for (const e of res.events) log(`    private[${accountId}] ${describePrivate(e)}`);
    const pub = next();
    if (pub.length === 0) log("    public: (nothing published)");
    for (const m of pub) log(`    public ${describePublic(m)}`);
    return res;
  };
  const showBook = () => {
    const b = venue.engine.publicBook(SPEC.id)!;
    log(`    public book: bids [${b.bids.map((l) => `${qty(l.displayedLots)}@${px(l.priceTicks)}`).join(", ")}] asks [${b.asks.map((l) => `${qty(l.displayedLots)}@${px(l.priceTicks)}`).join(", ")}]`);
  };

  log("PART 1 — hidden orders (synthetic SYN-ALPHA, tick 0.50, lot 0.001; local prototype, no funds)");
  log();
  send("syn-maker-a", { op: "new", clientOrderId: "a1", instrumentId: SPEC.id, side: "sell", type: "limit", price: "2001.00", quantity: "0.500" }, "displayed ask 0.500 @ 2001.00");
  send("syn-maker-a", { op: "new", clientOrderId: "a2", instrumentId: SPEC.id, side: "buy", type: "limit", price: "1999.00", quantity: "0.500" }, "displayed bid 0.500 @ 1999.00");
  send("syn-maker-b", { op: "new", clientOrderId: "b1", instrumentId: SPEC.id, side: "sell", type: "limit", price: "2000.50", quantity: "2.000", visibility: "hidden" }, "HIDDEN ask 2.000 @ 2000.50 (inside the spread)");
  showBook();
  log("    → the hidden order produced no public message and no public sequence gap.");
  log();
  send("syn-taker-c", { op: "new", clientOrderId: "c1", instrumentId: SPEC.id, side: "buy", type: "limit", price: "2001.00", quantity: "1.000", timeInForce: "ioc" }, "IOC buy 1.000 @ 2001.00");
  log("    → price priority: the better-priced hidden ask fills first; the print shows price and size only.");
  log();
  send("syn-maker-a", { op: "new", clientOrderId: "a3", instrumentId: SPEC.id, side: "sell", type: "limit", price: "2000.50", quantity: "0.300" }, "displayed ask 0.300 @ 2000.50 (same price as the hidden remainder, later in time)");
  send("syn-taker-c", { op: "new", clientOrderId: "c2", instrumentId: SPEC.id, side: "buy", type: "limit", price: "2000.50", quantity: "0.500", timeInForce: "ioc" }, "IOC buy 0.500 @ 2000.50");
  log("    → displayed priority: at one price the displayed order fills before the earlier hidden one;");
  log("      the two maker fills are published as one aggregated print.");
  log("    → residual inference: the print (0.500) exceeds the displayed quantity removed (0.300), so an");
  log("      observer can infer that ≥ 0.200 traded against non-displayed liquidity at 2000.50.");
  log();
  send("syn-maker-b", { op: "new", clientOrderId: "b2", instrumentId: SPEC.id, side: "buy", type: "limit", price: "2000.50", quantity: "0.100", timeInForce: "ioc" }, "IOC buy against its own hidden ask (STP cancel-taker)");
  send("syn-taker-c", { op: "new", clientOrderId: "c3", instrumentId: SPEC.id, side: "buy", type: "limit", price: "2000.00", quantity: "0.100", postOnly: true }, "post-only bid 0.100 @ 2000.00 (does not cross)");
  send("syn-taker-c", { op: "new", clientOrderId: "c4", instrumentId: SPEC.id, side: "buy", type: "limit", price: "2000.50", quantity: "0.100", postOnly: true }, "post-only bid @ 2000.50 (would take hidden liquidity)");
  log("    → known leakage channel: a post-only rejection inside the spread reveals hidden liquidity;");
  log("      such rejections are throttled per account (docs/venue/MATCHING-RULES.md, rule H-7).");
  log();
  send("syn-taker-c", { op: "cancel", ref: { clientOrderId: "b1" } }, "tries to cancel maker-b's order by its client id");
  log("    → another account's order is indistinguishable from a non-existent one.");
  log();

  // ── Part 2: seeded flow, reconciliation, recovery ────────────────────────
  log(`PART 2 — ${flowMessages} seeded synthetic messages (seed ${seed}), batched publication`);
  const flowAccounts = ["syn-p1", "syn-p2", "syn-p3", "syn-p4", "syn-p5", "syn-p6"];
  const flow = createLocalVenue({ accounts: flowAccounts, publication: "batched" });
  const mirror = new PublicBookMirror();
  for (const m of flow.venue.publicTape) mirror.apply(m);
  flow.venue.onPublic((m) => mirror.apply(m));
  let snapshot: ReturnType<Venue["snapshot"]> | undefined;
  const refused = new Map<string, number>();
  syntheticFlow(seed, flowMessages, flowAccounts).forEach(({ accountId, message }, i) => {
    flow.clock.advance(3);
    const res = flow.gateway.handle(flow.tokens.get(accountId)!, message);
    if (!res.ok) refused.set(res.error.code, (refused.get(res.error.code) ?? 0) + 1);
    if (i % 25 === 24) flow.venue.submit({ type: "publish" });
    if (i === Math.floor(flowMessages / 2)) snapshot = flow.venue.snapshot();
  });
  flow.venue.submit({ type: "publish" });
  const report = reconcile(flow.venue, mirror);
  const executions = flow.venue.executions;
  const hiddenExecutions = executions.filter((x) => x.makerVisibility === "hidden").length;
  const trades = flow.venue.publicTape.filter((m) => m.kind === "trade").length;
  log(`    commands journaled: ${flow.venue.journal.lastSeq}; executions: ${executions.length} (${hiddenExecutions} against hidden orders); public prints: ${trades}`);
  log(`    gateway refusals: ${[...refused].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  log(`    reconciliation: ${report.ok ? "OK" : `FAILED (${report.violations.length})`} — ${report.checked.orders} orders, ${report.checked.liveOrders} resting, ${report.checked.accounts} accounts`);
  for (const violation of report.violations.slice(0, 10)) log(`      ✗ ${violation}`);

  const { venue: recovered, report: recovery } = Venue.recover(
    { engine: { idKey: "local-prototype-key", publication: "batched" }, clock: flow.clock.read },
    flow.venue.journal.toJsonl(),
    snapshot,
  );
  const stateHash = flow.venue.engine.stateHash();
  const recoveredStateHash = recovered.engine.stateHash();
  log(`    recovery: snapshot @ seq ${recovery.fromSnapshotSeq} + ${recovery.replayed} journal entries replayed`);
  log(`    state hash   live ${stateHash.slice(0, 16)}…  recovered ${recoveredStateHash.slice(0, 16)}…  ${stateHash === recoveredStateHash ? "MATCH" : "MISMATCH"}`);
  log(`    output chain live ${flow.venue.outputHead.slice(0, 16)}…  recovered ${recovered.outputHead.slice(0, 16)}…  ${flow.venue.outputHead === recovered.outputHead ? "MATCH" : "MISMATCH"}`);
  log(`    journal head ${flow.venue.journal.head.slice(0, 16)}…`);

  return {
    lines,
    reconciliation: report,
    journalHead: flow.venue.journal.head,
    outputHead: flow.venue.outputHead,
    stateHash,
    recoveredStateHash,
    recoveredOutputHead: recovered.outputHead,
    commands: flow.venue.journal.lastSeq,
    trades,
    hiddenExecutions,
  };
}
