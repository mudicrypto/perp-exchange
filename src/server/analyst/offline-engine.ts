import type { Period } from "@/core/analytics";
import type { AnalystEngine, AnalystRequest, EngineResult } from "./engine";
import type { EvidenceItem, ToolEvidence } from "./evidence";
import { executeTool, type ToolAuditEntry } from "./executor";
import type { ToolContext } from "./tools";

type Intent = "equity" | "fees" | "exposure" | "scenario" | "executions" | "overview";

const INTENTS: [Intent, RegExp][] = [
  ["scenario", /\b(what\s+(would|if)|if\s+.*\bmov|scenario|moved?|drops?|falls?|rises?|rallies|crash|pump)\b[^%]*-?\d+(\.\d+)?\s*%|-?\d+(\.\d+)?\s*%\s*(move|drop|fall|rise|up|down)/i],
  ["equity", /\b(equity|account value|net worth|why .*(up|down|change)|p&?l today|pnl today)\b/i],
  ["fees", /\b(fees?|funding|commissions?)\b/i],
  ["exposure", /\b(exposure|concentrat\w*|contribut\w*|largest|biggest|riskiest|allocation)\b/i],
  ["executions", /\b(executions?|fills?|trades?|traded|recent activity)\b/i],
  ["overview", /\b(positions?|balance|overview|summary|account|margin|holdings?)\b/i],
];

function detectIntent(q: string): Intent | null {
  return INTENTS.find(([, re]) => re.test(q))?.[0] ?? null;
}

function detectPeriod(q: string): Period {
  if (/\b(7\s*d|week|seven days)\b/i.test(q)) return "7d";
  if (/\b(24\s*h|24 hours|last day)\b/i.test(q)) return "24h";
  return "today";
}

function detectMove(q: string): number | null {
  const m = q.match(/(-|\+|minus\s+|plus\s+)?(\d+(?:\.\d+)?)\s*%/i);
  if (!m) return null;
  const magnitude = Number(m[2]);
  const negative = m[1]?.trim().startsWith("-") || /minus/i.test(m[1] ?? "") || /\b(drop\w*|fall\w*|fell|down|declin\w*|crash\w*|lower)\b/i.test(q);
  return negative ? -magnitude : magnitude;
}

function detectMarket(q: string, context: string | null): string | null {
  const m = q.match(/\b(alpha|beta|gamma)(?:-perp)?\b/i);
  if (m) return `${m[1]!.toUpperCase()}-PERP`;
  return context;
}

const fmtTime = (t: number | null) => (t === null ? "" : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`);

function lines(items: EvidenceItem[]): string {
  return items.map((i) => `- ${i.label}: ${i.display}${i.note ? ` (${i.note})` : ""}`).join("\n");
}

/** Renders evidence as text, grouped by kind. Every figure comes from evidence verbatim. */
function render(ev: ToolEvidence, lead: string): string {
  const facts = ev.items.filter((i) => i.kind === "fact");
  const estimates = ev.items.filter((i) => i.kind === "estimate");
  const hypotheticals = ev.items.filter((i) => i.kind === "hypothetical");
  const parts = [lead];
  if (ev.unavailable.length) parts.push(`Unavailable:\n${ev.unavailable.map((u) => `- ${u.label}: ${u.reason}`).join("\n")}`);
  if (facts.length) parts.push(`Facts (from ${ev.dataSource || "account records"}, as of ${fmtTime(ev.asOf)}):\n${lines(facts)}`);
  if (estimates.length) parts.push(`Estimates (not guarantees):\n${lines(estimates)}`);
  if (hypotheticals.length) parts.push(`Hypothetical scenario (not a forecast):\n${lines(hypotheticals)}`);
  if (ev.assumptions.length) parts.push("Assumptions and data timestamps are listed with the verified data below.");
  return parts.join("\n\n");
}

const find = (ev: ToolEvidence, label: string) => ev.items.find((i) => i.label === label);

/**
 * Deterministic, rule-based analyst used when no language model is
 * configured (and in tests). It maps a question to one read-only tool and
 * writes the answer only from that tool's evidence.
 */
export class OfflineAnalystEngine implements AnalystEngine {
  readonly name = "offline" as const;
  readonly label = "Offline rule-based analyst (no language model)";

  async answer(ctx: ToolContext, req: AnalystRequest, audit: (e: ToolAuditEntry) => void): Promise<EngineResult> {
    const result: EngineResult = { text: "", evidence: [], toolErrors: [] };
    const call = async (tool: string, input: unknown) => {
      const out = await executeTool(ctx, tool, input, audit);
      if (out.ok) result.evidence.push(out.evidence);
      else result.toolErrors.push({ tool, error: out.error, message: out.message });
      return out.ok ? out.evidence : null;
    };

    const accountId = req.accountId;
    if (!accountId) {
      const list = await call("list_accounts", {});
      result.text = `Select one of your accounts first.${list ? `\n\n${lines(list.items)}` : ""}`;
      return result;
    }
    const intent = detectIntent(req.question);
    const period = detectPeriod(req.question);
    switch (intent) {
      case "equity": {
        const ev = await call("explain_equity_change", { accountId, period });
        if (!ev) break;
        const change = find(ev, "Equity change");
        const components = ["Change in unrealised PnL", "Realised PnL", "Fees paid", "Funding", "Deposits and withdrawals"];
        const largest = ev.items
          .filter((i) => i.value !== null && components.some((c) => i.label.startsWith(c)))
          .sort((x, y) => Math.abs(Number(y.value)) - Math.abs(Number(x.value)))
          .map((i) => ({ i }))[0];
        const lead = change
          ? `Your equity changed by ${change.display} over ${ev.title.replace(/^Equity change, /, "")}. The largest component was "${largest?.i.label ?? "—"}" (${largest?.i.display ?? "—"}). The figures below reconcile the change exactly from your recorded fills, fees, funding payments and transfers.`
          : "Equity change is unavailable for this period.";
        result.text = render(ev, lead);
        break;
      }
      case "fees": {
        const ev = await call("get_fees_and_funding", { accountId, period });
        if (!ev) break;
        const fees = find(ev, "Fees paid");
        const funding = find(ev, "Net funding (positive = received)");
        result.text = render(ev, fees && funding ? `Over ${ev.title.replace(/^Fees and funding, /, "")} you paid ${fees.display} in fees; net funding was ${funding.display} (positive means you received funding).` : "Fees and funding are unavailable.");
        break;
      }
      case "exposure": {
        const ev = await call("get_exposure_breakdown", { accountId });
        if (!ev) break;
        const largest = ev.items.find((i) => i.label.startsWith("Largest contributor"));
        result.text = render(
          ev,
          largest ? `${largest.label.replace("Largest contributor: ", "").replace(" (share of gross)", "")} contributes most to your exposure: ${largest.display} of gross notional. Notional is exposure, not collateral and not a maximum loss.` : "There is no open exposure to break down.",
        );
        break;
      }
      case "scenario": {
        const move = detectMove(req.question);
        const marketId = detectMarket(req.question, req.contextMarketId);
        if (move === null || !marketId) {
          result.text = "Tell me which market (ALPHA, BETA or GAMMA) and the percentage move, e.g. “What if GAMMA moved −3%?”.";
          break;
        }
        const ev = await call("simulate_price_move", { accountId, marketId, movePercent: move });
        if (!ev) break;
        const change = find(ev, "Change in unrealised PnL");
        result.text = render(ev, change ? `Hypothetically, if ${marketId} moved ${move >= 0 ? "+" : ""}${move}% with every other price unchanged, your unrealised PnL would change by ${change.display}. This is a what-if calculation, not a forecast.` : "The scenario could not be calculated.");
        break;
      }
      case "executions": {
        const ev = await call("get_recent_executions", { accountId, period: /recent|latest|last/i.test(req.question) && period === "today" ? "7d" : period, limit: 10 });
        if (!ev) break;
        const count = find(ev, "Fills");
        const notional = find(ev, "Traded notional");
        result.text = render(ev, count && notional ? `You had ${count.display} fills over ${ev.title.replace(/^Executions, /, "")}, trading ${notional.display} of notional.` : "No execution summary is available.");
        break;
      }
      case "overview": {
        const ev = await call("get_account_overview", { accountId });
        if (!ev) break;
        result.text = render(ev, "Here is your account as currently recorded.");
        break;
      }
      default:
        result.text =
          "I can answer questions about your equity changes, fees and funding, exposure by instrument, hypothetical price moves, recent executions and your current positions. Try one of the suggested questions.";
    }
    if (!result.text && result.toolErrors.length) result.text = `I couldn't get that data: ${result.toolErrors[0]!.message}`;
    return result;
  }
}
