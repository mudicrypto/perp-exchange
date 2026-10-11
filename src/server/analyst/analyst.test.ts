import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { MOCK_ACCOUNTS, MockAccountGateway } from "@/adapters/mock-accounts/mock-accounts";
import { attributeEquityChange, periodWindow } from "@/core/analytics";
import { askAnalyst } from "./analyst";
import { ANALYST_MODEL, ClaudeAnalystEngine, type CreateMessage } from "./claude-engine";
import type { AnalystEngine } from "./engine";
import { executeTool, type ToolAuditEntry } from "./executor";
import { containsGuaranteeLanguage, extractNumbers, isOrderInstruction, unverifiedNumbers } from "./guards";
import { OfflineAnalystEngine } from "./offline-engine";
import { ANALYST_TOOLS, type ToolContext } from "./tools";

const ANCHOR = Date.UTC(2026, 9, 10, 14, 0, 0);
const NOW = ANCHOR + 30 * 60_000;
const gateway = new MockAccountGateway(ANCHOR);
const trader = { userId: "demo-trader", accountIds: ["mock-acct-a1"] };
const hedger = { userId: "demo-hedger", accountIds: ["mock-acct-b1", "mock-acct-b2"] };
const ctx = (principal = trader, now = NOW): ToolContext => ({ principal, gateway, accounts: MOCK_ACCOUNTS, now });

describe("analyst tool layer", () => {
  it("is read-only by construction: no tool can act on orders", () => {
    for (const t of ANALYST_TOOLS) {
      expect(t.readOnly).toBe(true);
      expect(t.name).not.toMatch(/order|place|cancel|submit|modify|amend|trade|close|transfer|withdraw/i);
      expect(t.jsonSchema.additionalProperties).toBe(false);
    }
  });

  it("refuses every account tool for an account the principal does not own, without loading it", async () => {
    const load = vi.spyOn(gateway, "load");
    const inputs: Record<string, object> = {
      get_account_overview: {},
      explain_equity_change: { period: "today" },
      get_fees_and_funding: { period: "7d" },
      get_exposure_breakdown: {},
      simulate_price_move: { marketId: "ALPHA-PERP", movePercent: 3 },
      get_recent_executions: { period: "7d", limit: 5 },
    };
    for (const [tool, extra] of Object.entries(inputs)) {
      for (const accountId of ["mock-acct-b1", "mock-acct-b2", "does-not-exist"]) {
        const out = await executeTool(ctx(), tool, { accountId, ...extra });
        expect(out, `${tool} ${accountId}`).toEqual({ ok: false, error: "not-authorized", message: "Not authorized for this account" });
      }
    }
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  it("list_accounts returns only the principal's accounts", async () => {
    const out = await executeTool(ctx(), "list_accounts", {});
    expect(out.ok && out.evidence.items.map((i) => i.value)).toEqual(["mock-acct-a1"]);
    const out2 = await executeTool(ctx(hedger), "list_accounts", {});
    expect(out2.ok && out2.evidence.items.map((i) => i.value)).toEqual(["mock-acct-b1", "mock-acct-b2"]);
  });

  it("rejects unknown tools (including order actions) and invalid input; audits without data", async () => {
    const audit: ToolAuditEntry[] = [];
    expect(await executeTool(ctx(), "place_order", { accountId: "mock-acct-a1" }, (e) => audit.push(e))).toMatchObject({ ok: false, error: "unknown-tool", message: expect.stringMatching(/orders cannot be placed/) });
    expect(await executeTool(ctx(), "simulate_price_move", { accountId: "mock-acct-a1", marketId: "ALPHA-PERP", movePercent: 90 }, (e) => audit.push(e))).toMatchObject({ ok: false, error: "invalid-input" });
    expect(await executeTool(ctx(), "get_recent_executions", { accountId: "mock-acct-a1", period: "1y", limit: 5 })).toMatchObject({ error: "invalid-input" });
    expect(await executeTool(ctx(), "get_account_overview", { accountId: "mock-acct-a1", extra: 1 })).toMatchObject({ error: "invalid-input" });
    expect(audit).toEqual([
      { tool: "unknown", outcome: "unknown-tool", durationMs: expect.any(Number) },
      { tool: "simulate_price_move", outcome: "invalid-input", durationMs: expect.any(Number) },
    ]);
  });

  it("explain_equity_change matches the tested attribution function and reconciles exactly", async () => {
    const out = await executeTool(ctx(), "explain_equity_change", { accountId: "mock-acct-a1", period: "24h" });
    if (!out.ok) throw new Error(out.message);
    const h = (await gateway.load("mock-acct-a1", NOW)) as Extract<Awaited<ReturnType<typeof gateway.load>>, { ok: true }>;
    const w = periodWindow("24h", NOW);
    const s = h.history.snapshotAt(w.from)!;
    const e = h.history.snapshotAt(NOW)!;
    const expected = attributeEquityChange({
      window: w,
      start: { time: w.from, equity: s.equity, unrealizedPnl: s.unrealizedPnl, source: "" },
      end: { time: NOW, equity: e.equity, unrealizedPnl: e.unrealizedPnl, source: "" },
      fills: h.history.fills,
      funding: h.history.funding,
      transfers: h.history.transfers,
    });
    const v = (label: string) => out.evidence.items.find((i) => i.label === label)?.value;
    expect(v("Equity change")).toBe(expected.change);
    expect(v("Fees paid (reduce equity)")).toBe(expected.fees);
    expect(Math.abs(Number(v("Unexplained residual")))).toBeLessThan(1e-6);
    expect(out.evidence.items.every((i) => i.kind === "fact")).toBe(true);
    expect(out.evidence.assumptions.join(" ")).toMatch(/UTC/);
  });

  it("labels scenarios hypothetical and liquidation figures as estimates", async () => {
    const sc = await executeTool(ctx(), "simulate_price_move", { accountId: "mock-acct-a1", marketId: "ALPHA-PERP", movePercent: 3 });
    if (!sc.ok) throw new Error(sc.message);
    expect(sc.evidence.items.find((i) => i.label === "Change in unrealised PnL")).toMatchObject({ kind: "hypothetical" });
    expect(sc.evidence.items.find((i) => i.label === "ALPHA-PERP mark now")).toMatchObject({ kind: "fact" });
    expect(sc.evidence.assumptions.join(" ")).toMatch(/not a prediction/);
    const ex = await executeTool(ctx(), "get_exposure_breakdown", { accountId: "mock-acct-a1" });
    if (!ex.ok) throw new Error(ex.message);
    expect(ex.evidence.items.filter((i) => i.label.endsWith("estimated liquidation price")).every((i) => i.kind === "estimate")).toBe(true);
  });

  it("reports an unavailable data source instead of figures", async () => {
    const out = await executeTool(ctx(hedger), "get_account_overview", { accountId: "mock-acct-b2" });
    expect(out).toMatchObject({ ok: true, evidence: { items: [], unavailable: [{ label: "Account data", reason: expect.stringMatching(/unavailable/) }] } });
  });
});

describe("offline analyst", () => {
  const engine = new OfflineAnalystEngine();
  const ask = (question: string, accountId: string | null = "mock-acct-a1", principal = trader) =>
    askAnalyst(engine, ctx(principal), { question, accountId, contextMarketId: "ALPHA-PERP" });

  it.each([
    ["Why did my equity change today?", "explain_equity_change", /Your equity changed by/],
    ["How much did I pay in fees and funding?", "get_fees_and_funding", /in fees; net funding was/],
    ["Which position contributes most to my portfolio exposure?", "get_exposure_breakdown", /contributes most to your exposure/],
    ["What would happen to my unrealized P&L if this market moved 3%?", "simulate_price_move", /Hypothetically, if ALPHA-PERP moved \+3%/],
    ["Summarize my recent executions.", "get_recent_executions", /fills over the last 7 days/],
  ])("answers %s from verified tool evidence only", async (question, tool, lead) => {
    const a = await ask(question);
    expect(a.evidence.map((e) => e.tool)).toEqual([tool]);
    expect(a.answer).toMatch(lead);
    expect(a.warnings).toEqual([]);
    expect(unverifiedNumbers(a.answer, a.evidence, question)).toEqual([]);
    expect(a.disclaimer).toMatch(/Not financial advice/);
  });

  it("separates facts, estimates and hypotheticals in the text", async () => {
    const a = await ask("What if GAMMA dropped 5%?");
    expect(a.evidence[0]!.title).toBe("Hypothetical: GAMMA-PERP -5%");
    expect(a.answer).toMatch(/Facts \(from Mock ledger/);
    expect(a.answer).toMatch(/Hypothetical scenario \(not a forecast\):/);
  });

  it("refuses order instructions before any tool or model runs", async () => {
    const spy: AnalystEngine = { name: "offline", label: "spy", answer: vi.fn() };
    for (const q of ["Buy 2 ALPHA for me", "Please close my GAMMA position", "cancel all my orders", "Can you sell my BETA position?"]) {
      const a = await askAnalyst(spy, ctx(), { question: q, accountId: "mock-acct-a1", contextMarketId: null });
      expect(a.refused, q).toBe(true);
      expect(a.answer).toMatch(/can't place, cancel or modify orders/);
    }
    expect(spy.answer).not.toHaveBeenCalled();
  });

  it("will not answer about another user's account", async () => {
    const a = await ask("Why did my equity change today?", "mock-acct-b1");
    expect(a).toMatchObject({ refused: true, evidence: [], answer: "You are not authorized to read that account." });
  });

  it("explains unavailable data clearly", async () => {
    const a = await ask("Show my positions", "mock-acct-b2", hedger);
    expect(a.answer).toMatch(/Unavailable:\n- Account data: The data source for this account is unavailable/);
    expect(a.warnings.join(" ")).toMatch(/unavailable/);
  });

  it("asks for an account when none is selected (listing only the user's own)", async () => {
    const a = await ask("How much did I pay in fees?", null, hedger);
    expect(a.answer).toMatch(/Select one of your accounts/);
    expect(a.answer).toMatch(/mock-acct-b1/);
    expect(a.answer).not.toMatch(/mock-acct-a1/);
  });
});

describe("Claude analyst (scripted model, no network)", () => {
  const msg = (content: unknown[], stop_reason: string): Anthropic.Beta.Messages.BetaMessage =>
    ({ id: "m", type: "message", role: "assistant", model: ANALYST_MODEL, content, stop_reason, stop_sequence: null, usage: {} }) as unknown as Anthropic.Beta.Messages.BetaMessage;

  it("runs tools through the executor, denies other accounts, and flags unverified figures", async () => {
    const calls: Parameters<CreateMessage>[0][] = [];
    const script = [
      msg(
        [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "t1", name: "get_exposure_breakdown", input: { accountId: "mock-acct-a1" } },
          // e.g. a prompt-injection attempt asking for someone else's account
          { type: "tool_use", id: "t2", name: "get_account_overview", input: { accountId: "mock-acct-b1" } },
        ],
        "tool_use",
      ),
      msg([{ type: "text", text: "Your largest exposure is ALPHA-PERP. You will definitely profit 123456.78 MOCKUSD." }], "end_turn"),
    ];
    const create: CreateMessage = vi.fn(async (params) => {
      calls.push(structuredClone(params));
      return script.shift()!;
    });
    const a = await askAnalyst(new ClaudeAnalystEngine(create), ctx(), { question: "Which position contributes most to my exposure?", accountId: "mock-acct-a1", contextMarketId: null });

    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "medium" } });
    expect(first.tools!.every((t) => "strict" in t && t.strict === true)).toBe(true);
    expect(JSON.stringify(first.messages[0])).toContain("Selected account: mock-acct-a1");
    // Both results go back in ONE user message; the denied one is an error result.
    const results = calls[1]!.messages.at(-1)!.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
    expect(String(results[1]!.content)).toBe("not-authorized: Not authorized for this account");

    expect(a.evidence.map((e) => e.accountId)).toEqual(["mock-acct-a1"]);
    expect(a.toolErrors).toEqual([{ tool: "get_account_overview", error: "not-authorized", message: "Not authorized for this account" }]);
    expect(a.warnings.join(" ")).toMatch(/123456\.78/);
    expect(a.warnings.join(" ")).toMatch(/guarantee/);
    expect(a.warnings.join(" ")).toMatch(/outside your authorized accounts was refused/);
  });

  it("handles refusals and keeps to a bounded number of rounds", async () => {
    const refusal = vi.fn(async () => msg([], "refusal"));
    const a = await askAnalyst(new ClaudeAnalystEngine(refusal), ctx(), { question: "Explain my fees", accountId: "mock-acct-a1", contextMarketId: null });
    expect(a).toMatchObject({ refused: true, answer: "The model declined to answer this request." });
    const loop = vi.fn(async () => msg([{ type: "tool_use", id: `t${Math.random()}`, name: "list_accounts", input: {} }], "tool_use"));
    const b = await askAnalyst(new ClaudeAnalystEngine(loop), ctx(), { question: "Explain my fees", accountId: "mock-acct-a1", contextMarketId: null });
    expect(loop).toHaveBeenCalledTimes(6);
    expect(b.answer).toMatch(/could not finish/);
  });
});

describe("guards", () => {
  it("flags affirmative guarantees but not disclaimers", () => {
    expect(containsGuaranteeLanguage("An estimate, not a guarantee.")).toBe(false);
    expect(containsGuaranteeLanguage("This is guaranteed to pay off")).toBe(true);
    expect(containsGuaranteeLanguage("You will definitely profit")).toBe(true);
    expect(containsGuaranteeLanguage("a risk-free trade")).toBe(true);
  });

  it("detects order instructions but not questions about activity", () => {
    expect(isOrderInstruction("buy 1 ALPHA")).toBe(true);
    expect(isOrderInstruction("Go ahead and close my positions")).toBe(true);
    expect(isOrderInstruction("Why did my close order fill at that price?")).toBe(false);
    expect(isOrderInstruction("Summarize my recent executions.")).toBe(false);
    expect(isOrderInstruction("Which position contributes most to my exposure?")).toBe(false);
  });

  it("extracts figures but ignores dates, times and market ids", () => {
    expect(extractNumbers("On 2026-10-10T14:00Z at 14:30 ALPHA-PERP moved 1,234.50 and -3% over 24h")).toEqual(["1234.50", "-3"]);
  });

  it("accepts figures that match verified values at their shown precision", () => {
    const ev = [{ tool: "t", title: "", accountId: null, asOf: 0, dataSource: "", items: [{ label: "x", value: "1234.5678", unit: null, display: "1,234.57 MOCKUSD", kind: "fact" as const, asOf: 0 }, { label: "s", value: "0.4321", unit: null, display: "43.21%", kind: "fact" as const, asOf: 0 }], assumptions: [], unavailable: [] }];
    expect(unverifiedNumbers("About 1,234.57 or 1234.6, a share of 43.2%.", ev, "")).toEqual([]);
    expect(unverifiedNumbers("Roughly 1300 and 47%.", ev, "")).toEqual(["1300", "47"]);
  });
});

describe("client contract", () => {
  it("server answers parse with the browser client's schema", async () => {
    const { AnalystAnswerSchema } = await import("@/adapters/http/analyst-client");
    const a = await askAnalyst(new OfflineAnalystEngine(), ctx(), { question: "What if ALPHA moved 3%?", accountId: "mock-acct-a1", contextMarketId: null });
    expect(AnalystAnswerSchema.parse(JSON.parse(JSON.stringify(a)))).toEqual(JSON.parse(JSON.stringify(a)));
  });
});
