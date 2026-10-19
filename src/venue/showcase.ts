import { describePrivate, describePublic } from "./demo.ts";
import { DEFAULT_GATEWAY_LIMITS, VenueGateway, type ClientMessage, type GatewayOptions, type GatewayResponse } from "./gateway.ts";
import { TEST_FIXTURE_ID_KEY } from "./id-key.ts";
import { formatQuantity, SYNTHETIC_INSTRUMENTS } from "./instrument.ts";
import { canonicalJson, readJournal, sha256 } from "./journal.ts";
import { PublicBookMirror } from "./public-feed.ts";
import { reconcile } from "./reconcile.ts";
import { VENUE_RULES_VERSION } from "./rules-version.ts";
import { MemoryCommitRecordStore, MemoryJournalStore } from "./storage.ts";
import { createLocalVenue, ManualClock, SYNTHETIC_LIMITS, syntheticFlow } from "./synthetic.ts";
import type { PrivateEvent, PublicMessage } from "./types.ts";
import { RecoveryRefusedError, Venue, type VenueOptions } from "./venue.ts";

/**
 * Reproducible public demonstration of the venue prototype (Milestone 12, WP1;
 * docs/venue/SHOWCASE.md).
 *
 * `buildShowcase()` runs six fixed, seeded scenarios and returns a bundle:
 *   - a narrative per scenario (what each party did and saw);
 *   - the scenario's journal (JSON Lines) and its final state, output and journal hashes;
 *   - the recorded public tape and every account's private events;
 *   - named checks against MATCHING-RULES, evaluated at generation;
 *   - a bundle hash over all of it.
 *
 * `verifyShowcase()` checks a bundle independently of how it was produced: it re-reads each
 * journal as untrusted input, replays it, and requires the recorded hashes and feeds to be exactly
 * what the journal produces. It can also regenerate the bundle and require byte equality.
 *
 * `renderShowcaseHtml()` embeds a bundle in one self-contained, offline HTML viewer.
 *
 * Everything is synthetic: SYN-* instruments, syn-* accounts, a fixed manual clock, and the
 * registered test-fixture order-ID key (rule A-5, enabled explicitly and labelled). No network, no
 * file system, no keys or secrets, no real market data. Nothing here depends on the host: the bundle
 * is identical on every machine for the same code.
 */

export const SHOWCASE_FORMAT = "nova-venue-showcase/1";
const SPEC = SYNTHETIC_INSTRUMENTS[0]!;
const qty = (lots: number) => formatQuantity(SPEC, lots);

export interface ShowcaseStep {
  readonly actor: string;
  readonly action: string;
  /** Gateway response as seen by the actor (private events or refusal). */
  readonly response: readonly string[];
  /** Public messages published by this step (empty: nothing public happened). */
  readonly published: readonly string[];
  readonly note?: string;
}

export interface ShowcaseCheck {
  readonly rule: string;
  readonly description: string;
  readonly passed: boolean;
}

export interface ShowcaseScenario {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly rules: readonly string[];
  readonly publication: "immediate" | "batched";
  readonly steps: readonly ShowcaseStep[];
  readonly checks: readonly ShowcaseCheck[];
  /** The scenario's final journal as JSON Lines: the input the verifier replays. */
  readonly journal: string;
  readonly journalSha256: string;
  readonly final: { readonly seq: number; readonly journalHead: string; readonly stateHash: string; readonly outputHead: string };
  /** Recorded outputs; the verifier requires them to equal what the journal replays to. */
  readonly feeds: { readonly public: readonly PublicMessage[]; readonly private: Readonly<Record<string, readonly PrivateEvent[]>> };
  /** Journals that recovery must refuse, with the reason it must give (fail-closed demonstrations). */
  readonly refusals: readonly { readonly label: string; readonly journal: string; readonly reason: string }[];
}

export interface ShowcaseBundle {
  readonly format: string;
  readonly rulesVersion: string;
  readonly notice: string;
  readonly scenarios: readonly ShowcaseScenario[];
  /** sha256 over the canonical JSON of every other field. */
  readonly bundleHash: string;
}

const NOTICE =
  "Synthetic local prototype. SYN-* instruments and syn-* accounts only; no network, no funds, no real market data. " +
  "Order IDs use the registered deterministic test-fixture key (rule A-5), enabled explicitly so the bundle is reproducible; " +
  "IDs are therefore not confidential in this demonstration.";

const engineOptions = (publication: "immediate" | "batched"): VenueOptions => ({
  engine: { idKey: TEST_FIXTURE_ID_KEY, publication },
  allowTestFixtureIdKey: true,
  clock: () => 0,
});

type GatewayLimits = Pick<GatewayOptions, "messages" | "postOnlyRejects">;

/** Records what each party sees while a scenario runs. */
class Recorder {
  readonly steps: ShowcaseStep[] = [];
  readonly checks: ShowcaseCheck[] = [];
  venue: Venue;
  gateway: VenueGateway;
  private tokens = new Map<string, string>();
  readonly clock: ManualClock;

  constructor(venue: Venue, clock: ManualClock, gatewayLimits: Partial<GatewayLimits> = {}) {
    this.venue = venue;
    this.clock = clock;
    this.gatewayLimits = { ...DEFAULT_GATEWAY_LIMITS, ...gatewayLimits };
    this.gateway = new VenueGateway(venue, { clock: clock.read, ...this.gatewayLimits });
  }
  private readonly gatewayLimits: GatewayLimits;

  /** Switch to a recovered venue: a fresh gateway, as after a process restart. */
  attach(venue: Venue) {
    this.venue = venue;
    this.gateway = new VenueGateway(venue, { clock: this.clock.read, ...this.gatewayLimits });
    this.tokens = new Map();
  }

  token(actor: string) {
    let t = this.tokens.get(actor);
    if (!t) this.tokens.set(actor, (t = this.gateway.openSession(actor)));
    return t;
  }

  send(actor: string, message: ClientMessage, action: string, note?: string): { response: GatewayResponse; published: PublicMessage[] } {
    this.clock.advance(10);
    const from = this.venue.publicTape.length;
    const response = this.gateway.handle(this.token(actor), message);
    const published = this.venue.publicTape.slice(from);
    this.steps.push({
      actor,
      action,
      response: response.ok ? response.events.map((e) => describePrivate(e)).concat(response.replayed ? ["(replayed from the idempotency ledger, not journaled again)"] : []) : [`gateway: ${response.error.code} — ${response.error.message}`],
      published: published.map(describePublic),
      ...(note ? { note } : {}),
    });
    return { response, published };
  }

  note(actor: string, action: string, note: string, response: readonly string[] = []) {
    this.steps.push({ actor, action, response, published: [], note });
  }

  check(rule: string, description: string, passed: boolean) {
    this.checks.push({ rule, description, passed });
  }
}

const events = (r: GatewayResponse) => (r.ok ? r.events : []);
const order = (clientOrderId: string, side: "buy" | "sell", price: string, quantity: string, extra: Partial<Extract<ClientMessage, { op: "new" }>> = {}): ClientMessage => ({
  op: "new",
  clientOrderId,
  instrumentId: SPEC.id,
  side,
  type: "limit",
  price,
  quantity,
  ...extra,
});

function finish(
  base: { id: string; title: string; summary: string; rules: string[]; publication: "immediate" | "batched" },
  rec: Recorder,
  accounts: readonly string[],
  journal: string,
  refusals: ShowcaseScenario["refusals"] = [],
): ShowcaseScenario {
  const v = rec.venue;
  return {
    ...base,
    steps: rec.steps,
    checks: rec.checks,
    journal,
    journalSha256: sha256(journal),
    final: { seq: v.journal.lastSeq, journalHead: v.journal.head, stateHash: v.engine.stateHash(), outputHead: v.outputHead },
    feeds: { public: [...v.publicTape], private: Object.fromEntries(accounts.map((a) => [a, v.privateEvents(a)])) },
    refusals,
  };
}

// ── Scenario 1 ─────────────────────────────────────────────────────────────

function hiddenOrders(): ShowcaseScenario {
  const accounts = ["syn-maker-a", "syn-maker-b", "syn-taker-c"];
  const lv = createLocalVenue({ accounts });
  const r = new Recorder(lv.venue, lv.clock);
  r.send("syn-maker-a", order("a1", "sell", "2001.00", "0.500"), "displayed ask 0.500 @ 2001.00");
  r.send("syn-maker-a", order("a2", "buy", "1999.00", "0.500"), "displayed bid 0.500 @ 1999.00");
  const seqBefore = lv.venue.publicTape.at(-1)!.publicSeq;
  const hidden = r.send("syn-maker-b", order("b1", "sell", "2000.50", "2.000", { visibility: "hidden" }), "HIDDEN ask 2.000 @ 2000.50, inside the spread", "Nothing is published, and the public sequence does not move.");
  r.check("H-1", "A resting hidden order produces no public message and no public sequence gap", hidden.published.length === 0 && lv.venue.publicTape.at(-1)!.publicSeq === seqBefore);
  const c1 = r.send("syn-taker-c", order("c1", "buy", "2001.00", "1.000", { timeInForce: "ioc" }), "IOC buy 1.000 @ 2001.00", "Price priority: the better-priced hidden ask fills first. The print carries price and size only.");
  r.check("M-3", "The better-priced hidden ask fills before the displayed ask at 2001.00", events(c1.response).filter((e) => e.kind === "fill").every((e) => e.kind === "fill" && e.priceTicks === 4_001));
  r.send("syn-maker-a", order("a3", "sell", "2000.50", "0.300"), "displayed ask 0.300 @ 2000.50 (same price as the hidden remainder, later in time)");
  const fillsBefore = lv.venue.executions.length;
  const c2 = r.send("syn-taker-c", order("c2", "buy", "2000.50", "0.500", { timeInForce: "ioc" }), "IOC buy 0.500 @ 2000.50", "Displayed priority: the later displayed order fills before the earlier hidden one. Both maker fills appear as one aggregated print, from which an observer can infer that at least 0.200 traded against non-displayed liquidity.");
  const makers = lv.venue.executions.slice(fillsBefore).map((x) => x.makerVisibility);
  r.check("M-4", "At one price, displayed liquidity fills before earlier hidden liquidity", makers[0] === "displayed" && makers.includes("hidden"));
  const prints = c2.published.filter((m) => m.kind === "trade");
  r.check("H-5", "The two maker fills are published as one print per aggressor and price", prints.length === 1 && prints[0]!.kind === "trade" && prints[0]!.qtyLots === 500);
  const stp = r.send("syn-maker-b", order("b2", "buy", "2000.50", "0.100", { timeInForce: "ioc" }), "IOC buy against its own hidden ask (self-trade prevention: cancel-taker)");
  r.check("S-2", "Self-trade prevention applies to hidden orders: the taker is cancelled, nothing trades", events(stp.response).some((e) => e.kind === "cancelled" && e.reason === "self-trade-prevention") && stp.published.every((m) => m.kind !== "trade"));
  const probe = r.send("syn-taker-c", order("c4", "buy", "2000.50", "0.100", { postOnly: true }), "post-only bid @ 2000.50 (would take hidden liquidity)", "Known leakage channel: a post-only rejection inside the spread reveals hidden liquidity, so such rejections are throttled per account.");
  r.check("H-7", "A post-only order that would take hidden liquidity is rejected (and counted for the probe throttle)", events(probe.response).some((e) => e.kind === "rejected" && e.reason === "post-only-would-take"));
  const foreign = r.send("syn-taker-c", { op: "cancel", ref: { clientOrderId: "b1" } }, "tries to cancel maker-b's order by its client order id");
  const missing = r.send("syn-taker-c", { op: "cancel", ref: { clientOrderId: "does-not-exist" } }, "tries to cancel an order that does not exist");
  const reason = (x: GatewayResponse) => events(x).map((e) => (e.kind === "request-rejected" ? e.reason : e.kind)).join();
  r.check("P-1", "Another account's order is indistinguishable from a non-existent one", reason(foreign.response) === "unknown-order" && reason(missing.response) === "unknown-order");
  const forbidden = ["accountId", "orderId", "clientOrderId", "visibility"];
  r.check("A-2", "No public message carries account, order, client or visibility data", lv.venue.publicTape.every((m) => forbidden.every((k) => !(k in m))));
  return finish({ id: "hidden-orders", title: "Hidden orders: public versus private view", summary: "A hidden ask rests inside the spread without any public trace, trades by price and displayed priority, and is disclosed only as aggregated prints.", rules: ["H-1", "M-3", "M-4", "H-5", "S-2", "H-7", "P-1", "A-2"], publication: "immediate" }, r, accounts, lv.venue.journal.toJsonl());
}

// ── Scenario 2 ─────────────────────────────────────────────────────────────

function priorityAndStp(): ShowcaseScenario {
  const accounts = ["syn-maker-a", "syn-maker-b", "syn-taker-c"];
  const lv = createLocalVenue({ accounts });
  const r = new Recorder(lv.venue, lv.clock);
  r.send("syn-maker-a", order("a1", "sell", "2000.00", "0.200"), "displayed ask 0.200 @ 2000.00 (first in time)");
  r.send("syn-maker-b", order("b1", "sell", "2000.00", "0.200", { visibility: "hidden" }), "hidden ask 0.200 @ 2000.00 (second in time)");
  r.send("syn-maker-b", order("b2", "sell", "2000.00", "0.100"), "displayed ask 0.100 @ 2000.00 (third in time)");
  const from = lv.venue.executions.length;
  r.send("syn-taker-c", order("c1", "buy", "2000.00", "0.500"), "buy 0.500 @ 2000.00", "Fill order: displayed by time (a1, then b2), then hidden (b1).");
  const fills = lv.venue.executions.slice(from).map((x) => x.makerOrderId);
  const ids = (account: string, clientOrderId: string) => lv.venue.engine.orderFor(account, { clientOrderId })?.orderId;
  r.check("M-5", "Within displayed liquidity, earlier orders fill first; hidden fills after all displayed at that price", canonicalJson(fills) === canonicalJson([ids("syn-maker-a", "a1"), ids("syn-maker-b", "b2"), ids("syn-maker-b", "b1")]));
  for (const [mode, expectMaker, expectTaker] of [
    ["cancel-taker", false, true],
    ["cancel-maker", true, false],
    ["cancel-both", true, true],
  ] as const) {
    const id = mode.replace("cancel-", "");
    r.send("syn-maker-a", order(`rest-${id}`, "buy", "1995.00", "0.100"), `resting bid 0.100 @ 1995.00 (${mode} test)`);
    const t = r.send("syn-maker-a", order(`take-${id}`, "sell", "1995.00", "0.100", { selfTradePrevention: mode }), `own crossing ask with self-trade prevention ${mode}`);
    const cancelled = events(t.response).filter((e) => e.kind === "cancelled").map((e) => (e.kind === "cancelled" ? e.clientOrderId : ""));
    r.check("S-1", `${mode}: maker cancelled ${expectMaker ? "yes" : "no"}, taker cancelled ${expectTaker ? "yes" : "no"}, no trade`, cancelled.includes(`rest-${id}`) === expectMaker && cancelled.includes(`take-${id}`) === expectTaker && t.published.every((m) => m.kind !== "trade"));
    r.send("syn-maker-a", { op: "mass-cancel" }, "mass cancel (clean up)");
  }
  return finish({ id: "priority-stp", title: "Price, displayed and time priority; self-trade prevention", summary: "Fill order at one price follows displayed-before-hidden, then time. Each self-trade-prevention mode cancels exactly the specified side and never trades.", rules: ["M-4", "M-5", "S-1"], publication: "immediate" }, r, accounts, lv.venue.journal.toJsonl());
}

// ── Scenario 3 ─────────────────────────────────────────────────────────────

function abuseControls(): ShowcaseScenario {
  const accounts = ["syn-maker-a", "syn-prober-p", "syn-retry-r"];
  const lv = createLocalVenue({ accounts, gateway: { postOnlyRejects: { limit: 3, windowMs: 60_000 }, messages: { limit: 12, windowMs: 1_000 } } });
  const r = new Recorder(lv.venue, lv.clock, { postOnlyRejects: { limit: 3, windowMs: 60_000 }, messages: { limit: 12, windowMs: 1_000 } });
  r.send("syn-maker-a", order("h1", "sell", "2000.50", "1.000", { visibility: "hidden" }), "hidden ask 1.000 @ 2000.50");
  const probes: GatewayResponse[] = [];
  for (let i = 1; i <= 4; i++) {
    r.clock.advance(1_000);
    probes.push(r.send("syn-prober-p", order(`p${i}`, "buy", "2000.50", "0.010", { postOnly: true }), `post-only probe ${i} at 2000.50`).response);
  }
  r.check("H-7", "After 3 post-only rejections in the window, further post-only orders are throttled before reaching the engine", probes.slice(0, 3).every((p) => events(p).some((e) => e.kind === "rejected")) && !probes[3]!.ok && probes[3]!.error.code === "rate-limited");
  r.clock.advance(1_000);
  const first = r.send("syn-retry-r", order("x1", "buy", "1990.00", "0.100"), "new order x1");
  const again = r.send("syn-retry-r", order("x1", "buy", "1990.00", "0.100"), "identical retry of x1", "Answered from the idempotency ledger with the original events; not journaled again.");
  const conflict = r.send("syn-retry-r", order("x1", "buy", "1991.00", "0.100"), "conflicting reuse of x1 (different price)");
  r.check("A-4", "An identical retry returns the original events; a conflicting reuse is refused", again.response.ok && again.response.replayed && canonicalJson(events(again.response)) === canonicalJson(events(first.response)) && !conflict.response.ok && conflict.response.error.code === "idempotency-conflict");
  r.clock.advance(1_000);
  let limited = 0;
  for (let i = 0; i < 15; i++) {
    const { response } = r.send("syn-retry-r", order(`burst-${i}`, "buy", "1980.00", "0.001"), `burst message ${i + 1} of 15 in one second`);
    if (!response.ok && response.error.code === "rate-limited") limited++;
  }
  r.check("A-3", "A burst above the per-account message limit is refused before journaling", limited === 3);
  return finish({ id: "abuse-controls", title: "Abuse controls: probe throttle, idempotency, rate limits", summary: "Post-only probing is throttled, retries are idempotent, and message bursts are cut off at the gateway before anything is journaled.", rules: ["H-7", "A-4", "A-3"], publication: "immediate" }, r, accounts, lv.venue.journal.toJsonl());
}

// ── Scenario 4 ─────────────────────────────────────────────────────────────

function crashRecovery(): ShowcaseScenario {
  const accounts = ["syn-maker-a", "syn-taker-c"];
  const store = new MemoryJournalStore();
  const records = new MemoryCommitRecordStore();
  const options: VenueOptions = { ...engineOptions("immediate"), store, commitRecords: records };
  const clock = new ManualClock();
  let venue = new Venue({ ...options, clock: clock.read });
  venue.submit({ type: "admin.add-instrument", spec: SPEC });
  for (const accountId of accounts) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  const r = new Recorder(venue, clock);
  const recover = (label: string) => {
    const out = Venue.recover({ ...options, clock: clock.read });
    venue = out.venue;
    r.attach(venue);
    r.note("operator", `recovery after ${label}`, "Recovery verifies the journal and the commit record, replays, then performs only the planned repairs.", [`repairs: ${out.report.repairs.map((s) => s.kind).join(", ") || "none"}`, `commit record at seq ${out.report.commitRecord?.seq}${out.report.commitRecord?.rolledForward ? " (rolled forward)" : ""}`]);
    return out.report;
  };
  r.send("syn-maker-a", order("a1", "sell", "2001.00", "0.500"), "displayed ask 0.500 @ 2001.00");

  store.failNextAppend = "torn-write";
  const torn = r.send("syn-taker-c", order("c1", "buy", "2001.00", "0.200"), "buy c1 — the journal write is torn (simulated crash mid-write)");
  const tornReport = recover("a torn journal write");
  r.check("D-2", "A torn (unparseable) final line is uncommitted: dropped, and the store repaired", !torn.response.ok && torn.response.error.code === "outcome-unknown" && tornReport.repairs.some((s) => s.kind === "truncate-torn-tail") && !venue.engine.orderFor("syn-taker-c", { clientOrderId: "c1" }));
  const retry1 = r.send("syn-taker-c", order("c1", "buy", "2001.00", "0.200"), "client retries c1 after recovery", "Not committed before, so the retry executes, once.");
  r.check("A-4", "The retry of an uncommitted order executes exactly once", retry1.response.ok && !retry1.response.replayed);

  records.failNextWrite = "before-write";
  const lost = r.send("syn-taker-c", order("c2", "buy", "2001.00", "0.100"), "buy c2 — journaled, but the commit-record write fails (simulated)");
  const rollReport = recover("a failed commit-record write");
  r.check("D-6", "A journaled but uncommitted final entry is rolled forward by recovery", !lost.response.ok && lost.response.error.code === "outcome-unknown" && rollReport.commitRecord?.rolledForward === true);
  const retry2 = r.send("syn-taker-c", order("c2", "buy", "2001.00", "0.100"), "client retries c2 after recovery", "Committed by roll-forward, so the retry returns the original events from the ledger.");
  r.check("A-4", "The retry of a committed order is answered with the original events, never executed twice", retry2.response.ok && retry2.response.replayed);

  const journal = store.read();
  const lines = journal.trimEnd().split("\n");
  const duplicate = `${journal}${lines.at(-1)}\n`;
  let refused = "";
  try {
    Venue.recover(engineOptions("immediate"), duplicate);
  } catch (error) {
    refused = error instanceof RecoveryRefusedError ? error.message : "";
  }
  r.note("operator", "recovery from a journal whose last entry was written twice", "Fail-closed: a duplicate cannot be told apart from an acknowledged entry overwritten with the previous bytes (D-5).", [refused]);
  r.check("D-5", "A duplicated final entry refuses recovery instead of being silently repaired", refused.includes("duplicate of the last entry"));

  const replayed = Venue.recover(engineOptions("immediate"), journal).venue;
  r.check("D-1", "A full replay of the final journal reproduces the live state and output hashes", replayed.engine.stateHash() === venue.engine.stateHash() && replayed.outputHead === venue.outputHead);
  return finish(
    { id: "crash-recovery", title: "Crash recovery with commit records", summary: "A torn write is dropped as uncommitted; a missing commit record is rolled forward; retries never execute twice; a duplicated entry is refused, not repaired.", rules: ["D-1", "D-2", "D-5", "D-6", "A-4"], publication: "immediate" },
    r,
    accounts,
    journal,
    [{ label: "final entry written twice", journal: duplicate, reason: "duplicate of the last entry" }],
  );
}

// ── Scenario 5 ─────────────────────────────────────────────────────────────

function determinism(): ShowcaseScenario {
  const accounts = ["syn-p1", "syn-p2", "syn-p3", "syn-p4"];
  const lv = createLocalVenue({ accounts, publication: "batched" });
  const r = new Recorder(lv.venue, lv.clock);
  const mirror = new PublicBookMirror();
  for (const m of lv.venue.publicTape) mirror.apply(m);
  lv.venue.onPublic((m) => mirror.apply(m));
  const flow = syntheticFlow(2_024, 600, accounts);
  let snapshot: ReturnType<Venue["snapshot"]> | undefined;
  const refusals = new Map<string, number>();
  flow.forEach(({ accountId, message }, i) => {
    lv.clock.advance(3);
    const res = lv.gateway.handle(lv.tokens.get(accountId)!, message);
    if (!res.ok) refusals.set(res.error.code, (refusals.get(res.error.code) ?? 0) + 1);
    if (i % 25 === 24) lv.venue.submit({ type: "publish" });
    if (i === 300) snapshot = lv.venue.snapshot();
  });
  lv.venue.submit({ type: "publish" });
  const report = reconcile(lv.venue, mirror);
  const journal = lv.venue.journal.toJsonl();
  const full = Venue.recover(engineOptions("batched"), journal).venue;
  const fromSnapshot = Venue.recover(engineOptions("batched"), journal, snapshot).venue;
  r.note("seeded flow", `600 synthetic messages (seed 2024) from ${accounts.length} accounts, batched publication`, "Includes displayed and hidden orders, IOC/FOK, post-only, cancels, replaces and invalid messages.", [
    `journal entries: ${lv.venue.journal.lastSeq}; executions: ${lv.venue.executions.length} (${lv.venue.executions.filter((x) => x.makerVisibility === "hidden").length} against hidden orders)`,
    `traded volume: ${qty(lv.venue.executions.reduce((s, x) => s + x.qtyLots, 0))}`,
    `gateway refusals (not journaled): ${[...refusals].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `reconciliation: ${report.ok ? "OK" : `FAILED: ${report.violations.join("; ")}`} (${report.checked.orders} orders, ${report.checked.liveOrders} resting)`,
  ]);
  r.note("operator", "replay the journal in full, and from a mid-run snapshot plus the journal suffix", "Both must reproduce the live engine state and the output hash chain exactly.", [
    `full replay:       state ${full.engine.stateHash().slice(0, 16)}…  outputs ${full.outputHead.slice(0, 16)}…`,
    `snapshot + suffix: state ${fromSnapshot.engine.stateHash().slice(0, 16)}…  outputs ${fromSnapshot.outputHead.slice(0, 16)}…`,
  ]);
  r.check("D-1", "Full replay reproduces the live state hash and output hash chain", full.engine.stateHash() === lv.venue.engine.stateHash() && full.outputHead === lv.venue.outputHead);
  r.check("D-1", "Snapshot plus journal suffix reproduces the same state and outputs", fromSnapshot.engine.stateHash() === lv.venue.engine.stateHash() && fromSnapshot.outputHead === lv.venue.outputHead);
  r.check("M-6", "Independent reconciliation passes: book never crossed, conservation, feeds consistent with executions", report.ok);
  r.check("H-9", "Batched publication: the public mirror rebuilt from the feed matches the engine's public book", !mirror.stale && report.ok);
  return finish({ id: "determinism", title: "Deterministic replay and reconciliation", summary: "A seeded synthetic flow is replayed in full and from a snapshot; both reproduce the live state and output hash chain, and reconciliation passes.", rules: ["D-1", "M-6", "H-9"], publication: "batched" }, r, accounts, journal);
}

// ── Scenario 6 ─────────────────────────────────────────────────────────────

function unknownOutcome(): ShowcaseScenario {
  const accounts = ["syn-client-k", "syn-maker-a"];
  const store = new MemoryJournalStore();
  const records = new MemoryCommitRecordStore();
  const clock = new ManualClock();
  const options: VenueOptions = { ...engineOptions("immediate"), store, commitRecords: records, clock: clock.read };
  let venue = new Venue(options);
  venue.submit({ type: "admin.add-instrument", spec: SPEC });
  for (const accountId of accounts) venue.submit({ type: "admin.add-account", accountId, limits: SYNTHETIC_LIMITS });
  const r = new Recorder(venue, clock);
  r.send("syn-client-k", order("k1", "buy", "1995.00", "0.300"), "resting bid k1 0.300 @ 1995.00");
  const lastSeen = venue.privateEvents("syn-client-k").at(-1)!.accountSeq;
  records.failNextWrite = "before-write";
  const cancel = r.send("syn-client-k", { op: "cancel", ref: { clientOrderId: "k1" } }, "cancel k1 — the outcome is unknown (commit-record write fails)");
  venue = Venue.recover(options).venue;
  r.attach(venue);
  r.note("operator", "recovery", "The cancel was journaled, so it is committed by roll-forward and applied exactly once.");
  const page = r.gateway.eventsPage(r.token("syn-client-k"), lastSeen)!;
  r.note("syn-client-k", `reconcile: eventsPage after accountSeq ${lastSeen}`, "The client catches up on its private feed before sending anything else.", [
    ...page.events.map((e) => describePrivate(e)),
    `gap: ${page.gap ? `${page.gap.fromAccountSeq}–${page.gap.toAccountSeq}` : "none"}; high-water accountSeq ${page.highWaterAccountSeq}`,
  ]);
  r.check("A-6", "After recovery the private feed resolves the unknown outcome exactly, with no gap", page.gap === null && page.events.length === 1 && page.events[0]!.kind === "cancelled");
  const retry = r.send("syn-client-k", { op: "cancel", ref: { clientOrderId: "k1" } }, "blind retry of the cancel", "A cancel is not request-idempotent: this answer does not say whether the first cancel worked or the order filled. Only the feed or an order lookup tells.");
  r.check("A-4", "A retried cancel gets a different answer than the original (not request-idempotent)", !cancel.response.ok && events(retry.response).some((e) => e.kind === "request-rejected" && e.reason === "order-not-modifiable"));
  return finish({ id: "unknown-outcome", title: "Unknown outcomes and client reconciliation", summary: "A cancel whose outcome is unknown is resolved from the private feed after recovery; a blind retry would give an ambiguous answer.", rules: ["A-6", "A-4", "D-6"], publication: "immediate" }, r, accounts, store.read());
}

// ── Bundle ─────────────────────────────────────────────────────────────────

const hashBundle = (b: Omit<ShowcaseBundle, "bundleHash">) => sha256(canonicalJson({ format: b.format, rulesVersion: b.rulesVersion, notice: b.notice, scenarios: b.scenarios }));

export function buildShowcase(): ShowcaseBundle {
  const content = { format: SHOWCASE_FORMAT, rulesVersion: VENUE_RULES_VERSION, notice: NOTICE, scenarios: [hiddenOrders(), priorityAndStp(), abuseControls(), crashRecovery(), determinism(), unknownOutcome()] };
  // A JSON round trip drops frozen-object identity and undefined fields, so the bundle equals what a reader parses.
  const scenarios = JSON.parse(JSON.stringify(content.scenarios)) as ShowcaseScenario[];
  return { ...content, scenarios, bundleHash: hashBundle({ ...content, scenarios }) };
}

export interface ShowcaseVerification {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly lines: readonly string[];
}

/**
 * Verifies a bundle as untrusted input. For every scenario: the journal hash, a clean journal read,
 * a full replay that reproduces the recorded hashes and both feeds exactly, every recorded check
 * passed, and every refusal sample refused with its stated reason. Then the bundle hash. With
 * `regenerate`, also rebuilds the bundle from this code and requires the same bundle hash.
 */
export function verifyShowcase(input: unknown, options: { regenerate?: boolean } = {}): ShowcaseVerification {
  const findings: string[] = [];
  const lines: string[] = [];
  const bundle = input as ShowcaseBundle;
  if (!bundle || typeof bundle !== "object" || bundle.format !== SHOWCASE_FORMAT || !Array.isArray(bundle.scenarios)) {
    return { ok: false, findings: [`not a ${SHOWCASE_FORMAT} bundle`], lines };
  }
  if (bundle.rulesVersion !== VENUE_RULES_VERSION) findings.push(`bundle rules version ${bundle.rulesVersion} differs from this code (${VENUE_RULES_VERSION})`);
  for (const s of bundle.scenarios) {
    const fail = (message: string) => findings.push(`${s.id}: ${message}`);
    if (sha256(s.journal) !== s.journalSha256) fail("journal does not match its recorded sha256");
    const read = readJournal(s.journal);
    if (!read.ok) {
      fail(`journal refused at line ${read.failedAtLine}: ${read.reason}`);
      continue;
    }
    let replay: Venue;
    try {
      replay = Venue.recover(engineOptions(s.publication), s.journal).venue;
    } catch (error) {
      fail(`replay failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const got = { seq: replay.journal.lastSeq, journalHead: replay.journal.head, stateHash: replay.engine.stateHash(), outputHead: replay.outputHead };
    for (const k of ["seq", "journalHead", "stateHash", "outputHead"] as const) if (got[k] !== s.final[k]) fail(`replayed ${k} ${String(got[k]).slice(0, 16)}… differs from recorded ${String(s.final[k]).slice(0, 16)}…`);
    if (canonicalJson(replay.publicTape) !== canonicalJson(s.feeds.public)) fail("recorded public feed differs from what the journal produces");
    for (const [account, recorded] of Object.entries(s.feeds.private)) if (canonicalJson(replay.privateEvents(account)) !== canonicalJson(recorded)) fail(`recorded private feed of ${account} differs from what the journal produces`);
    for (const c of s.checks) if (c.passed !== true) fail(`check ${c.rule} did not pass: ${c.description}`);
    for (const refusal of s.refusals) {
      const r = readJournal(refusal.journal);
      if (r.ok || !r.reason.includes(refusal.reason)) fail(`refusal sample "${refusal.label}" was not refused with "${refusal.reason}"`);
    }
    lines.push(`${s.id}: journal ${read.entries.length} entries, replay ✓ hashes, public feed (${s.feeds.public.length}), ${Object.keys(s.feeds.private).length} private feeds, ${s.checks.length} checks, ${s.refusals.length} refusal samples`);
  }
  if (hashBundle(bundle) !== bundle.bundleHash) findings.push("bundle hash does not match the bundle content");
  if (options.regenerate) {
    const fresh = buildShowcase();
    if (fresh.bundleHash !== bundle.bundleHash) findings.push(`regenerated bundle hash ${fresh.bundleHash} differs from ${bundle.bundleHash}`);
    else lines.push(`regenerated from this code: identical bundle hash`);
  }
  lines.push(`bundle hash ${bundle.bundleHash}`);
  return { ok: findings.length === 0, findings, lines };
}

const DATA_TAG = '<script type="application/json" id="showcase-data">';

/** Extracts the embedded bundle from a viewer page (or accepts the bundle JSON itself). */
export function parseShowcase(text: string): unknown {
  const at = text.indexOf(DATA_TAG);
  if (at < 0) return JSON.parse(text);
  const end = text.indexOf("</script>", at + DATA_TAG.length);
  if (end < 0) throw new Error("viewer page has no closing data tag");
  return JSON.parse(text.slice(at + DATA_TAG.length, end));
}

/**
 * One self-contained HTML page: the bundle embedded as inert JSON, inline CSS and script, a Content
 * Security Policy that forbids every network request, and rendering through textContent only.
 */
export function renderShowcaseHtml(bundle: ShowcaseBundle): string {
  const data = JSON.stringify(bundle).replace(/</g, "\\u003c").split(String.fromCharCode(0x2028)).join("\\u2028").split(String.fromCharCode(0x2029)).join("\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<title>Venue Showcase</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#5f6368;--line:#e2ded6;--card:#ffffff;--ok:#1b7f3b;--bad:#b3261e;--pub:#1f5fae;--priv:#7a4d00;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececee;--muted:#a0a3a8;--line:#2c2c31;--card:#1c1c20;--ok:#5bc27c;--bad:#ff8a80;--pub:#8ab4f8;--priv:#e6b35c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header,main{max-width:1100px;margin:0 auto;padding:16px}header h1{font-size:22px;margin:8px 0}
.notice{color:var(--muted);font-size:13px}.hash{font-family:var(--mono);font-size:12px;word-break:break-all}
nav{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}nav button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px}
nav button[aria-current="true"]{border-color:var(--fg);font-weight:600}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
h2{font-size:18px;margin:0 0 4px}h3{font-size:14px;margin:16px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.rules span{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin:2px 4px 2px 0;font-family:var(--mono);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-top:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
.step{border-top:1px solid var(--line);padding:8px 0}.actor{font-family:var(--mono);font-size:12px;color:var(--muted)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:720px){.cols{grid-template-columns:1fr}}
.mono{font-family:var(--mono);font-size:12px;white-space:pre-wrap;word-break:break-word}
.pub{color:var(--pub)}.priv{color:var(--priv)}.note{color:var(--muted);font-style:italic}
details summary{cursor:pointer;color:var(--muted)}
</style>
</head>
<body>
<header>
<h1>Venue Showcase</h1>
<p class="notice" id="notice"></p>
<p class="notice">Bundle hash <span class="hash" id="bundle-hash"></span> · rules version <span class="hash" id="rules-version"></span></p>
<p class="notice">Reproduce and verify locally: <span class="hash">npm run --silent venue:showcase &gt; showcase.html</span> then <span class="hash">npm run --silent venue:showcase:verify &lt; showcase.html</span>. The verifier replays every embedded journal and checks every recorded hash and feed.</p>
<nav id="nav"></nav>
</header>
<main id="main"></main>
${DATA_TAG}${data}</script>
<script>
(function(){
  var b=JSON.parse(document.getElementById("showcase-data").textContent);
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
  document.getElementById("notice").textContent=b.notice;
  document.getElementById("bundle-hash").textContent=b.bundleHash;
  document.getElementById("rules-version").textContent=b.rulesVersion;
  var nav=document.getElementById("nav"),main=document.getElementById("main"),buttons=[];
  function show(i){
    buttons.forEach(function(x,j){x.setAttribute("aria-current",String(i===j));});
    var s=b.scenarios[i];main.textContent="";var sec=el("section");main.appendChild(sec);
    sec.appendChild(el("h2",null,s.title));sec.appendChild(el("p",null,s.summary));
    var rules=el("p","rules");s.rules.forEach(function(r){rules.appendChild(el("span",null,r));});sec.appendChild(rules);
    sec.appendChild(el("h3",null,"Checks"));var t=el("table");
    s.checks.forEach(function(c){var tr=el("tr");tr.appendChild(el("td",c.passed?"ok":"bad",c.passed?"pass":"FAIL"));tr.appendChild(el("td","mono",c.rule));tr.appendChild(el("td",null,c.description));t.appendChild(tr);});
    sec.appendChild(t);
    sec.appendChild(el("h3",null,"What each party did and saw"));
    s.steps.forEach(function(st){var d=el("div","step");d.appendChild(el("div","actor",st.actor));d.appendChild(el("div",null,st.action));
      var cols=el("div","cols");var p=el("div");p.appendChild(el("div","notice","private (to "+st.actor+")"));
      if(st.response.length===0)p.appendChild(el("div","mono note","—"));st.response.forEach(function(x){p.appendChild(el("div","mono priv",x));});
      var q=el("div");q.appendChild(el("div","notice","public feed"));if(st.published.length===0)q.appendChild(el("div","mono note","(nothing published)"));
      st.published.forEach(function(x){q.appendChild(el("div","mono pub",x));});cols.appendChild(p);cols.appendChild(q);d.appendChild(cols);
      if(st.note)d.appendChild(el("div","note",st.note));sec.appendChild(d);});
    sec.appendChild(el("h3",null,"Final hashes (replay must reproduce them)"));
    ["seq","journalHead","stateHash","outputHead"].forEach(function(k){sec.appendChild(el("div","mono",k+": "+s.final[k]));});
    sec.appendChild(el("div","mono","journal sha256: "+s.journalSha256));
    var det=el("details");det.appendChild(el("summary",null,"Recorded feeds and journal ("+s.journal.trim().split("\\n").length+" entries)"));
    det.appendChild(el("div","notice","public tape"));s.feeds.public.forEach(function(m){det.appendChild(el("div","mono pub",JSON.stringify(m)));});
    Object.keys(s.feeds.private).forEach(function(a){det.appendChild(el("div","notice","private events of "+a));s.feeds.private[a].forEach(function(e){det.appendChild(el("div","mono priv",JSON.stringify(e)));});});
    det.appendChild(el("div","notice","journal"));det.appendChild(el("div","mono",s.journal));
    s.refusals.forEach(function(r){det.appendChild(el("div","notice","must be refused ("+r.label+"): "+r.reason));});
    sec.appendChild(det);
  }
  b.scenarios.forEach(function(s,i){var x=el("button",null,s.title);x.type="button";x.onclick=function(){show(i);};nav.appendChild(x);buttons.push(x);});
  show(0);
})();
</script>
</body>
</html>
`;
}
