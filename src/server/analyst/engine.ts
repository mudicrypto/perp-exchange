import type { ToolEvidence } from "./evidence";
import type { ToolAuditEntry } from "./executor";
import type { ToolContext } from "./tools";

export interface AnalystRequest {
  question: string;
  /** The account selected in the UI (already authorized by the route), if any. */
  accountId: string | null;
  /** Market currently in view, used to resolve "this market". */
  contextMarketId: string | null;
}

export interface EngineResult {
  text: string;
  evidence: ToolEvidence[];
  toolErrors: { tool: string; error: string; message: string }[];
  /** True when the engine declined to answer (e.g. model refusal). */
  declined?: boolean;
}

/** Produces an answer by calling read-only tools through `executeTool`. Never touches data directly. */
export interface AnalystEngine {
  readonly name: "claude" | "offline";
  readonly label: string;
  answer(ctx: ToolContext, request: AnalystRequest, audit: (entry: ToolAuditEntry) => void): Promise<EngineResult>;
}
