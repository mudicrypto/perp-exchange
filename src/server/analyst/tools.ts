import { z } from "zod";
import {
  attributeEquityChange,
  feesAndFunding,
  periodWindow,
  PERIODS,
  summarizeExecutions,
  type AccountHistory,
  type AccountHistoryGateway,
  type AccountRecord,
  type Period,
} from "@/core/analytics";
import { MarketIdSchema } from "@/core/domain";
import { amount, assessPortfolio, dec, marketMoveScenario, price, quantity, toPlain, type PortfolioRiskReport } from "@/core/risk";
import { item, fromRiskValue, type ToolEvidence } from "./evidence";
import { authorize, type AnalystPrincipal } from "./principal";

export interface ToolContext {
  principal: AnalystPrincipal;
  gateway: AccountHistoryGateway;
  /** Directory of account labels (not data); only entries the principal may read are ever returned. */
  accounts: readonly AccountRecord[];
  now: number;
}

/**
 * A read-only analyst tool. There is deliberately no tool that places,
 * cancels or modifies orders, and this module imports no execution code
 * (enforced by ESLint).
 */
export interface AnalystTool<I> {
  name: string;
  description: string;
  readOnly: true;
  input: z.ZodType<I>;
  /** JSON Schema sent to the model (strict: every property required, no extras). */
  jsonSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  run(ctx: ToolContext, input: I): Promise<ToolEvidence>;
}

const accountIdProp = { accountId: { type: "string", description: "Account id from list_accounts. Only the signed-in user's accounts are readable." } };
const periodProp = { period: { type: "string", enum: [...PERIODS], description: 'Time window in UTC: "today" (since 00:00 UTC), "24h" or "7d".' } };
const AccountId = z.string().min(1).max(64);
const PeriodSchema = z.enum(PERIODS);

function evidence(tool: string, title: string, accountId: string | null, ctx: ToolContext, dataSource: string): ToolEvidence {
  return { tool, title, accountId, asOf: ctx.now, dataSource, items: [], assumptions: [], unavailable: [] };
}

/** Authorizes, then loads. Unavailable data is reported in the evidence, never filled in. */
async function load(ctx: ToolContext, accountId: string, ev: ToolEvidence): Promise<AccountHistory | null> {
  authorize(ctx.principal, accountId);
  const loaded = await ctx.gateway.load(accountId, ctx.now);
  if (!loaded.ok) {
    ev.unavailable.push({ label: "Account data", reason: loaded.reason });
    return null;
  }
  ev.dataSource = loaded.history.source;
  return loaded.history;
}

function portfolio(history: AccountHistory, now: number): PortfolioRiskReport | null {
  const snapshot = history.snapshotAt(now);
  if (!snapshot) return null;
  return assessPortfolio({
    now,
    venue: history.rules,
    account: { value: snapshot, observedAt: snapshot.observedAt, source: history.source },
    markets: history.markets,
    marks: history.marks(now),
    funding: history.fundingRates(now),
    fills: { value: history.fills, observedAt: now, source: history.source },
  });
}

const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

export const listAccounts: AnalystTool<Record<string, never>> = {
  name: "list_accounts",
  description: "Lists the trading accounts the signed-in user is authorized to read (id, label, currency). Call this first if no account is selected.",
  readOnly: true,
  input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  jsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  async run(ctx) {
    const ev = evidence("list_accounts", "Your accounts", null, ctx, "Account directory");
    for (const a of ctx.accounts.filter((x) => ctx.principal.accountIds.includes(x.id))) {
      ev.items.push({ label: a.label, value: a.id, unit: null, display: `${a.id} (${a.currency}${a.origin === "mock" ? ", mock data" : ""})`, kind: "fact", asOf: null });
    }
    return ev;
  },
};

export const getAccountOverview: AnalystTool<{ accountId: string }> = {
  name: "get_account_overview",
  description: "Current equity, cash balance, unrealised PnL, margin in use and open positions (size, entry, mark, unrealised PnL) for one authorized account, with data timestamps.",
  readOnly: true,
  input: z.object({ accountId: AccountId }).strict(),
  jsonSchema: { type: "object", properties: { ...accountIdProp }, required: ["accountId"], additionalProperties: false },
  async run(ctx, { accountId }) {
    const ev = evidence("get_account_overview", "Account overview", accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    const s = h.snapshotAt(ctx.now);
    if (!s) {
      ev.unavailable.push({ label: "Account snapshot", reason: "No account state is recorded for the current time" });
      return ev;
    }
    const u = amount(s.currency);
    const t = s.observedAt;
    ev.items.push(
      item("Equity", toPlain(dec(s.equity)), u, "fact", t),
      item("Cash balance", toPlain(dec(s.balance ?? 0)), u, "fact", t),
      item("Unrealised PnL (at mark)", toPlain(dec(s.unrealizedPnl)), u, "fact", t),
      item("Margin in use", toPlain(dec(s.marginUsed)), u, "fact", t, "Collateral allocated to positions — not a maximum loss."),
      item("Available collateral", toPlain(dec(s.available)), u, "fact", t),
    );
    for (const p of s.positions) {
      const m = h.markets.get(p.marketId)!;
      ev.items.push(
        item(`${p.marketId} position size`, toPlain(dec(p.size)), quantity(m.base), "fact", t, p.size > 0 ? "Long" : "Short"),
        item(`${p.marketId} entry price`, toPlain(dec(p.entryPrice)), price(s.currency, m.base), "fact", t),
        item(`${p.marketId} mark price`, toPlain(dec(p.markPrice ?? 0)), price(s.currency, m.base), "fact", t),
        item(`${p.marketId} unrealised PnL`, toPlain(dec(p.unrealizedPnl)), u, "fact", t),
      );
    }
    if (s.positions.length === 0) ev.assumptions.push("The account has no open positions.");
    ev.assumptions.push("Unrealised PnL is valued at the mark price; closing would execute at book prices and pay fees.");
    return ev;
  },
};

export const explainEquityChange: AnalystTool<{ accountId: string; period: Period }> = {
  name: "explain_equity_change",
  description:
    "Explains an account's equity change over a period using recorded fills, fees, funding payments and transfers: Δequity = realised PnL − fees + funding + transfers + Δunrealised PnL. Any unexplained amount is reported as a residual.",
  readOnly: true,
  input: z.object({ accountId: AccountId, period: PeriodSchema }).strict(),
  jsonSchema: { type: "object", properties: { ...accountIdProp, ...periodProp }, required: ["accountId", "period"], additionalProperties: false },
  async run(ctx, { accountId, period }) {
    const ev = evidence("explain_equity_change", "Equity change", accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    const window = periodWindow(period, ctx.now);
    let from = window.from;
    if (from < h.openedAt) {
      from = h.openedAt;
      ev.assumptions.push(`Records start at ${iso(h.openedAt)}, after the start of ${window.label}; the change is measured from the first record.`);
    }
    const start = h.snapshotAt(from);
    const end = h.snapshotAt(ctx.now);
    if (!start || !end) {
      ev.unavailable.push({ label: "Equity history", reason: "Equity is not recorded at the start or end of the period" });
      return ev;
    }
    const a = attributeEquityChange({
      window: { ...window, from },
      start: { time: from, equity: start.equity, unrealizedPnl: start.unrealizedPnl, source: h.source },
      end: { time: ctx.now, equity: end.equity, unrealizedPnl: end.unrealizedPnl, source: h.source },
      fills: h.fills,
      funding: h.funding,
      transfers: h.transfers,
    });
    const u = amount(h.account.currency);
    ev.title = `Equity change, ${window.label}`;
    ev.items.push(
      item("Equity at start", toPlain(dec(start.equity)), u, "fact", from),
      item("Equity now", toPlain(dec(end.equity)), u, "fact", ctx.now),
      item("Equity change", a.change, u, "fact", ctx.now),
      item("Realised PnL from closing trades", a.realizedPnl, u, "fact", ctx.now, `${a.fillCount} fill(s) in the period`),
      item("Fees paid (reduce equity)", a.fees, u, "fact", ctx.now),
      item("Funding (positive = received)", a.funding, u, "fact", ctx.now, `${a.fundingCount} payment(s)`),
      item("Deposits and withdrawals", a.transfers, u, "fact", ctx.now, a.transferCount ? "Transfers change equity but are not trading performance." : "None"),
      item("Change in unrealised PnL (price moves on open positions)", a.unrealizedChange, u, "fact", ctx.now),
      item("Unexplained residual", a.residual, u, "fact", ctx.now),
    );
    if (!dec(a.residual).isZero()) ev.assumptions.push("The records do not fully explain the change; the residual is shown rather than attributed to a component.");
    ev.assumptions.push(`Period boundaries are in UTC (${iso(from)} to ${iso(ctx.now)}).`, "Unrealised PnL is valued at the mark price at each boundary.");
    return ev;
  },
};

export const getFeesAndFunding: AnalystTool<{ accountId: string; period: Period }> = {
  name: "get_fees_and_funding",
  description: "Trading fees paid and funding paid/received over a period, in total and per market, from fill and funding-payment records.",
  readOnly: true,
  input: z.object({ accountId: AccountId, period: PeriodSchema }).strict(),
  jsonSchema: { type: "object", properties: { ...accountIdProp, ...periodProp }, required: ["accountId", "period"], additionalProperties: false },
  async run(ctx, { accountId, period }) {
    const ev = evidence("get_fees_and_funding", "Fees and funding", accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    const window = periodWindow(period, ctx.now);
    const r = feesAndFunding(h.fills, h.funding, window);
    const u = amount(h.account.currency);
    ev.title = `Fees and funding, ${window.label}`;
    ev.items.push(
      item("Fees paid", r.feesPaid, u, "fact", ctx.now, `${r.fillCount} fill(s)`),
      item("Funding paid", r.fundingPaid, u, "fact", ctx.now),
      item("Funding received", r.fundingReceived, u, "fact", ctx.now),
      item("Net funding (positive = received)", r.fundingNet, u, "fact", ctx.now, `${r.fundingCount} payment(s)`),
      item("Total fees and net funding cost", r.totalCost, u, "fact", ctx.now, "Fees paid minus net funding received"),
    );
    for (const m of r.byMarket) {
      ev.items.push(item(`${m.marketId} fees`, m.fees, u, "fact", ctx.now), item(`${m.marketId} funding (positive = received)`, m.funding, u, "fact", ctx.now));
    }
    if (h.openedAt > window.from) ev.assumptions.push(`Records start at ${iso(h.openedAt)}; nothing earlier exists.`);
    ev.assumptions.push(`Period in UTC: ${iso(window.from)} to ${iso(window.to)}.`);
    return ev;
  },
};

export const getExposureBreakdown: AnalystTool<{ accountId: string }> = {
  name: "get_exposure_breakdown",
  description: "Portfolio exposure by instrument and direction (notional at mark, share of gross), gross/net exposure, concentration and liquidation estimates. Notional is exposure, not collateral or maximum loss.",
  readOnly: true,
  input: z.object({ accountId: AccountId }).strict(),
  jsonSchema: { type: "object", properties: { ...accountIdProp }, required: ["accountId"], additionalProperties: false },
  async run(ctx, { accountId }) {
    const ev = evidence("get_exposure_breakdown", "Exposure", accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    const report = portfolio(h, ctx.now);
    if (!report) {
      ev.unavailable.push({ label: "Account snapshot", reason: "No account state is recorded for the current time" });
      return ev;
    }
    fromRiskValue("Gross exposure", report.exposure.gross, ev);
    fromRiskValue("Net exposure (long − short)", report.exposure.net, ev);
    fromRiskValue("Long exposure", report.exposure.long, ev);
    fromRiskValue("Short exposure", report.exposure.short, ev);
    for (const e of [...report.exposure.byInstrument].sort((a, b) => (a.notional.status === "available" && b.notional.status === "available" ? dec(b.notional.value).cmp(dec(a.notional.value)) : 0))) {
      fromRiskValue(`${e.marketId} ${e.direction} notional`, e.notional, ev);
      fromRiskValue(`${e.marketId} share of gross exposure`, e.share, ev);
    }
    if (report.concentration.largestMarketId) fromRiskValue(`Largest contributor: ${report.concentration.largestMarketId} (share of gross)`, report.concentration.largestShare, ev);
    fromRiskValue("Concentration index (HHI; 1 = single instrument)", report.concentration.hhi, ev);
    fromRiskValue("Effective leverage (gross / equity)", report.margin.effectiveLeverage, ev);
    for (const p of report.positions) fromRiskValue(`${p.marketId} estimated liquidation price`, p.liquidationPrice, ev);
    return ev;
  },
};

export const simulatePriceMove: AnalystTool<{ accountId: string; marketId: string; movePercent: number }> = {
  name: "simulate_price_move",
  description:
    "HYPOTHETICAL scenario: moves one market's mark price by movePercent (e.g. 3 or -3; between -50 and 50) with all other marks fixed, and returns the change in unrealised PnL. Not a forecast.",
  readOnly: true,
  input: z.object({ accountId: AccountId, marketId: MarketIdSchema, movePercent: z.number().finite().gt(-50.0001).lt(50.0001) }).strict(),
  jsonSchema: {
    type: "object",
    properties: { ...accountIdProp, marketId: { type: "string", description: 'Market id such as "ALPHA-PERP".' }, movePercent: { type: "number", description: "Percent move, e.g. 3 for +3%, -3 for −3%. Between -50 and 50." } },
    required: ["accountId", "marketId", "movePercent"],
    additionalProperties: false,
  },
  async run(ctx, { accountId, marketId, movePercent }) {
    const ev = evidence("simulate_price_move", `Hypothetical: ${marketId} ${movePercent >= 0 ? "+" : ""}${movePercent}%`, accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    if (!h.markets.has(marketId)) {
      ev.unavailable.push({ label: "Market", reason: `${marketId} is not a market on this account's venue` });
      return ev;
    }
    const report = portfolio(h, ctx.now);
    if (!report) {
      ev.unavailable.push({ label: "Account snapshot", reason: "No account state is recorded for the current time" });
      return ev;
    }
    const s = marketMoveScenario(report, marketId, dec(movePercent).div(100));
    const m = h.markets.get(marketId)!;
    if (s.priceBefore !== null) ev.items.push(item(`${marketId} mark now`, s.priceBefore, price(h.account.currency, m.base), "fact", ctx.now));
    if (s.priceAfter !== null) ev.items.push(item(`${marketId} mark in the scenario`, s.priceAfter, price(h.account.currency, m.base), "hypothetical", null));
    fromRiskValue("Current unrealised PnL", report.pnl.unrealized, ev);
    fromRiskValue("Change in unrealised PnL", s.unrealizedPnlChange, ev, "hypothetical");
    fromRiskValue("Unrealised PnL in the scenario", s.unrealizedPnlAfter, ev, "hypothetical");
    if (s.noPosition) ev.assumptions.push(`The account has no ${marketId} position, so this move does not change its unrealised PnL.`);
    if (s.reachesLiquidationEstimate === true) ev.assumptions.push(`In this scenario ${marketId} reaches its estimated liquidation price.`);
    ev.assumptions.push("A hypothetical scenario, not a prediction: markets can move by any amount, and correlated markets usually move together.");
    return ev;
  },
};

export const getRecentExecutions: AnalystTool<{ accountId: string; period: Period; limit: number }> = {
  name: "get_recent_executions",
  description: "Summarises recorded fills (executions) over a period: count, notional, fees, realised PnL, maker/taker split, per-market buys/sells and VWAPs, and the most recent fills (limit 1–25).",
  readOnly: true,
  input: z.object({ accountId: AccountId, period: PeriodSchema, limit: z.number().int().min(1).max(25) }).strict(),
  jsonSchema: {
    type: "object",
    properties: { ...accountIdProp, ...periodProp, limit: { type: "integer", description: "How many recent fills to list (1–25)." } },
    required: ["accountId", "period", "limit"],
    additionalProperties: false,
  },
  async run(ctx, { accountId, period, limit }) {
    const ev = evidence("get_recent_executions", "Executions", accountId, ctx, "");
    const h = await load(ctx, accountId, ev);
    if (!h) return ev;
    const window = periodWindow(period, ctx.now);
    const s = summarizeExecutions(h.fills, window, limit);
    const u = amount(h.account.currency);
    ev.title = `Executions, ${window.label}`;
    ev.items.push(
      { label: "Fills", value: String(s.count), unit: null, display: `${s.count} (maker ${s.makerCount}, taker ${s.takerCount})`, kind: "fact", asOf: ctx.now },
      item("Traded notional", s.notional, u, "fact", ctx.now),
      item("Fees", s.fees, u, "fact", ctx.now),
      item("Realised PnL (before fees)", s.realizedPnl, u, "fact", ctx.now),
    );
    for (const m of s.byMarket) {
      const base = h.markets.get(m.marketId)?.base ?? m.marketId;
      ev.items.push({ label: `${m.marketId} activity`, value: null, unit: null, display: `${m.buys} buy(s) for ${m.boughtSize} ${base}${m.vwapBuy ? ` (VWAP ${m.vwapBuy})` : ""}; ${m.sells} sell(s) for ${m.soldSize} ${base}${m.vwapSell ? ` (VWAP ${m.vwapSell})` : ""}`, kind: "fact", asOf: ctx.now });
    }
    for (const f of s.recent) {
      const base = h.markets.get(f.marketId)?.base ?? f.marketId;
      ev.items.push({
        label: `Fill ${iso(f.time)}`,
        value: null,
        unit: null,
        display: `${f.side.toUpperCase()} ${f.size} ${base} @ ${f.price} (${f.liquidity}), fee ${f.fee.toFixed(4)} ${h.account.currency}`,
        kind: "fact",
        asOf: f.time,
      });
    }
    if (s.count === 0) ev.assumptions.push(`No fills are recorded for ${window.label}.`);
    ev.assumptions.push(`Period in UTC: ${iso(window.from)} to ${iso(window.to)}.`);
    return ev;
  },
};

export const ANALYST_TOOLS = [listAccounts, getAccountOverview, explainEquityChange, getFeesAndFunding, getExposureBreakdown, simulatePriceMove, getRecentExecutions] as const;
