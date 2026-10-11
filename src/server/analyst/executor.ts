import type { ToolEvidence } from "./evidence";
import { AuthorizationError } from "./principal";
import { ANALYST_TOOLS, type AnalystTool, type ToolContext } from "./tools";

export type ToolOutcome =
  | { ok: true; evidence: ToolEvidence }
  | { ok: false; error: "unknown-tool" | "invalid-input" | "not-authorized" | "failed"; message: string };

export interface ToolAuditEntry {
  tool: string;
  outcome: "ok" | Extract<ToolOutcome, { ok: false }>["error"];
  durationMs: number;
}

const byName = new Map<string, AnalystTool<unknown>>(ANALYST_TOOLS.map((t) => [t.name, t as unknown as AnalystTool<unknown>]));

/**
 * The only way the analyst touches account data. Every call: known tool →
 * input validated → account authorization inside the tool → read-only run.
 * Audit entries record the tool and outcome only (no account data).
 */
export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown, audit?: (entry: ToolAuditEntry) => void): Promise<ToolOutcome> {
  const started = Date.now();
  const finish = (outcome: ToolOutcome): ToolOutcome => {
    audit?.({ tool: byName.has(name) ? name : "unknown", outcome: outcome.ok ? "ok" : outcome.error, durationMs: Date.now() - started });
    return outcome;
  };
  const tool = byName.get(name);
  if (!tool) return finish({ ok: false, error: "unknown-tool", message: `There is no tool named ${name}. Only read-only account tools exist; orders cannot be placed, cancelled or modified.` });
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return finish({ ok: false, error: "invalid-input", message: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });
  try {
    return finish({ ok: true, evidence: await tool.run(ctx, parsed.data) });
  } catch (error) {
    if (error instanceof AuthorizationError) return finish({ ok: false, error: "not-authorized", message: error.message });
    if (error instanceof RangeError) return finish({ ok: false, error: "invalid-input", message: error.message });
    return finish({ ok: false, error: "failed", message: "The tool failed; no data was returned." });
  }
}
