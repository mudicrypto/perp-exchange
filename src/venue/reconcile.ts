import { leaves } from "./book.ts";
import type { PublicBookMirror } from "./public-feed.ts";
import { isLive } from "./state-machine.ts";
import type { Venue } from "./venue.ts";

/**
 * Independent reconciliation of venue state (docs/venue/ARCHITECTURE.md §
 * "Audit and reconciliation"). Recomputes every derived quantity from
 * primary records and reports each disagreement. An empty `violations`
 * list means every check passed.
 */
export interface ReconciliationReport {
  readonly ok: boolean;
  readonly violations: string[];
  readonly checked: { orders: number; liveOrders: number; executions: number; accounts: number; instruments: number };
  /**
   * "complete" only when the audit stores hold every record since seq 1. Otherwise "partial", with the
   * reasons (snapshot restore, audit retention), and the execution-derived checks are skipped (A-6).
   */
  readonly history: "complete" | "partial";
  readonly historyReasons: readonly string[];
}

export function reconcile(venue: Venue, mirror?: PublicBookMirror): ReconciliationReport {
  const violations: string[] = [];
  const v = (message: string) => violations.push(message);
  const engine = venue.engine;
  const snap = engine.snapshot();
  const orders = new Map(snap.orders.map((o) => [o.orderId, o]));

  // 1. Orders: quantities and status agree.
  for (const o of snap.orders) {
    if (o.filledLots < 0 || o.filledLots > o.qtyLots) v(`order ${o.orderId}: filled ${o.filledLots} outside [0, ${o.qtyLots}]`);
    if (o.status === "new" && o.filledLots !== 0) v(`order ${o.orderId}: new with fills`);
    if (o.status === "partially-filled" && (o.filledLots === 0 || o.filledLots === o.qtyLots)) v(`order ${o.orderId}: partially-filled inconsistent`);
    if (o.status === "filled" && o.filledLots !== o.qtyLots) v(`order ${o.orderId}: filled but leaves remain`);
  }

  // 2. Book: aggregates, membership, queue order, no crossing (hidden included).
  if (mirror?.stale) v("public mirror saw a sequence gap and is stale");
  const inBook = new Set<string>();
  for (const instrumentId of engine.instrumentIds()) {
    const levels = engine.inspectBook(instrumentId);
    let bestBid = -Infinity;
    let bestAsk = Infinity;
    for (const level of levels) {
      if (level.displayed.length + level.hidden.length === 0) v(`${instrumentId} ${level.side}@${level.priceTicks}: empty level`);
      for (const [queue, lots, visibility] of [
        [level.displayed, level.displayedLots, "displayed"],
        [level.hidden, level.hiddenLots, "hidden"],
      ] as const) {
        let sum = 0;
        let lastPriority = -Infinity;
        for (const o of queue) {
          sum += leaves(o);
          if (inBook.has(o.orderId)) v(`order ${o.orderId} appears twice in the book`);
          inBook.add(o.orderId);
          const record = orders.get(o.orderId);
          if (!record || !isLive(record.status)) v(`order ${o.orderId} in book but not live`);
          if (o.priceTicks !== level.priceTicks || o.side !== level.side || o.visibility !== visibility) v(`order ${o.orderId} filed under the wrong level/queue`);
          if (o.priority <= lastPriority) v(`${instrumentId} ${level.side}@${level.priceTicks}: queue not in priority order`);
          lastPriority = o.priority;
        }
        if (sum !== lots) v(`${instrumentId} ${level.side}@${level.priceTicks}: ${visibility} lots ${lots} ≠ Σ leaves ${sum}`);
      }
      if (level.side === "buy") bestBid = Math.max(bestBid, level.priceTicks);
      else bestAsk = Math.min(bestAsk, level.priceTicks);
    }
    if (bestBid >= bestAsk) v(`${instrumentId}: book crossed (bid ${bestBid} ≥ ask ${bestAsk})`);

    // 3. Public data: what was published equals the displayed book; a mirror built from the feed agrees.
    const displayed = new Map<string, number>();
    for (const level of levels) if (level.displayedLots > 0) displayed.set(`${level.side}:${level.priceTicks}`, level.displayedLots);
    const published = engine.publishedLevels(instrumentId);
    const pendingFlush = snap.instruments.find((i) => i.spec.id === instrumentId)!.dirty.length > 0;
    if (!pendingFlush && !sameMap(published, displayed)) v(`${instrumentId}: published levels differ from the displayed book`);
    if (mirror && !sameMap(mirror.levels(instrumentId), published)) v(`${instrumentId}: public mirror differs from published levels`);
  }
  for (const o of snap.orders) if (isLive(o.status) && !inBook.has(o.orderId)) v(`live order ${o.orderId} missing from the book`);

  // 4. Accounts: open lots, risk limits, zero-sum positions and cash.
  const positionSum = new Map<string, number>();
  const cashSum = new Map<string, bigint>();
  for (const a of snap.accounts) {
    const live = snap.orders.filter((o) => o.accountId === a.id && isLive(o.status));
    if (live.length > a.limits.maxOpenOrders) v(`account ${a.id}: ${live.length} open orders > limit`);
    for (const [instrumentId, h] of a.holdings) {
      const buy = live.filter((o) => o.instrumentId === instrumentId && o.side === "buy").reduce((s, o) => s + leaves(o), 0);
      const sell = live.filter((o) => o.instrumentId === instrumentId && o.side === "sell").reduce((s, o) => s + leaves(o), 0);
      if (buy !== h.openBuyLots || sell !== h.openSellLots) v(`account ${a.id} ${instrumentId}: open lots disagree with live orders`);
      if (Math.abs(h.position) > a.limits.maxPositionLots) v(`account ${a.id} ${instrumentId}: |position| above limit`);
      positionSum.set(instrumentId, (positionSum.get(instrumentId) ?? 0) + h.position);
      cashSum.set(instrumentId, (cashSum.get(instrumentId) ?? 0n) + BigInt(h.cash));
    }
  }
  for (const [instrumentId, sum] of positionSum) if (sum !== 0) v(`${instrumentId}: positions do not net to zero (${sum})`);
  for (const [instrumentId, sum] of cashSum) if (sum !== 0n) v(`${instrumentId}: cash does not net to zero (${sum})`);

  // 5. Executions (only when the audit history is complete): fills and positions re-derived from executions.
  if (venue.historyComplete) {
    const filled = new Map<string, number>();
    const position = new Map<string, number>();
    const seen = new Set<string>();
    for (const x of venue.executions) {
      if (seen.has(x.execId)) v(`duplicate execution ${x.execId}`);
      seen.add(x.execId);
      if (x.makerAccountId === x.takerAccountId) v(`self-trade executed (${x.execId})`);
      const maker = orders.get(x.makerOrderId);
      const taker = orders.get(x.takerOrderId);
      if (!maker || !taker) {
        v(`execution ${x.execId} references unknown orders`);
        continue;
      }
      filled.set(x.makerOrderId, (filled.get(x.makerOrderId) ?? 0) + x.qtyLots);
      filled.set(x.takerOrderId, (filled.get(x.takerOrderId) ?? 0) + x.qtyLots);
      const signed = (side: string) => (side === "buy" ? x.qtyLots : -x.qtyLots);
      const mk = `${x.makerAccountId}|${x.instrumentId}`;
      const tk = `${x.takerAccountId}|${x.instrumentId}`;
      position.set(mk, (position.get(mk) ?? 0) + signed(maker.side));
      position.set(tk, (position.get(tk) ?? 0) + signed(taker.side));
    }
    for (const o of snap.orders) if ((filled.get(o.orderId) ?? 0) !== o.filledLots) v(`order ${o.orderId}: Σ executions ≠ filled`);
    for (const a of snap.accounts) {
      for (const [instrumentId, h] of a.holdings) {
        if ((position.get(`${a.id}|${instrumentId}`) ?? 0) !== h.position) v(`account ${a.id} ${instrumentId}: position ≠ Σ executions`);
      }
    }
    // Public prints carry exactly the executed volume.
    const printed = venue.publicTape.reduce((s, m) => s + (m.kind === "trade" ? m.qtyLots : 0), 0);
    const executed = venue.executions.reduce((s, x) => s + x.qtyLots, 0);
    const unpublished = snap.pending.reduce((s, p) => s + (p.kind === "trade" ? p.qtyLots : 0), 0);
    if (printed + unpublished !== executed) v(`public prints (${printed} + ${unpublished} pending) ≠ executed volume (${executed})`);
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: {
      orders: snap.orders.length,
      liveOrders: inBook.size,
      executions: venue.executions.length,
      accounts: snap.accounts.length,
      instruments: snap.instruments.length,
    },
    history: venue.historyComplete ? "complete" : "partial",
    historyReasons: venue.historyIncompleteReasons,
  };
}

function sameMap(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
