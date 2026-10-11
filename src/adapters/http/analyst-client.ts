import { z } from "zod";
import { ApiError, ApiErrorBodySchema } from "./nova-api-client";

const EvidenceItemSchema = z.object({
  label: z.string(),
  value: z.string().nullable(),
  unit: z.string().nullable(),
  display: z.string(),
  kind: z.enum(["fact", "estimate", "hypothetical"]),
  asOf: z.number().nullable(),
  note: z.string().optional(),
});

export const ToolEvidenceSchema = z.object({
  tool: z.string(),
  title: z.string(),
  accountId: z.string().nullable(),
  asOf: z.number(),
  dataSource: z.string(),
  items: z.array(EvidenceItemSchema),
  assumptions: z.array(z.string()),
  unavailable: z.array(z.object({ label: z.string(), reason: z.string() })),
});
export type ToolEvidenceView = z.infer<typeof ToolEvidenceSchema>;

export const AnalystAnswerSchema = z.object({
  answer: z.string(),
  engine: z.enum(["claude", "offline"]),
  engineLabel: z.string(),
  evidence: z.array(ToolEvidenceSchema),
  toolErrors: z.array(z.object({ tool: z.string(), error: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
  refused: z.boolean(),
  disclaimer: z.string(),
  asOf: z.number(),
});
export type AnalystAnswerView = z.infer<typeof AnalystAnswerSchema>;

const AccountSchema = z.object({ id: z.string(), label: z.string(), currency: z.string(), origin: z.enum(["mock", "venue"]) });
export const AnalystSessionSchema = z.object({ user: z.object({ id: z.string(), name: z.string() }), accounts: z.array(AccountSchema) });
export type AnalystSessionView = z.infer<typeof AnalystSessionSchema>;
const UsersSchema = z.array(z.object({ id: z.string(), name: z.string() }));

/** Browser client for the analyst API. Responses are validated; the session cookie is HttpOnly. */
export class AnalystClient {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  /** null when not signed in. Throws ApiError(404) when the analyst is not available in this environment. */
  async session(): Promise<AnalystSessionView | null> {
    const res = await this.fetchImpl("/api/analyst/session", { credentials: "same-origin" });
    if (res.status === 401) return null;
    return this.parse(res, AnalystSessionSchema);
  }

  async users(): Promise<{ id: string; name: string }[]> {
    return this.parse(await this.fetchImpl("/api/analyst/users"), UsersSchema);
  }

  async signIn(userId: string): Promise<AnalystSessionView> {
    return this.parse(await this.post("/api/analyst/session", { userId }), AnalystSessionSchema);
  }

  async signOut(): Promise<void> {
    await this.fetchImpl("/api/analyst/session", { method: "DELETE", credentials: "same-origin" });
  }

  async ask(question: string, accountId: string | null, marketId: string | null): Promise<AnalystAnswerView> {
    return this.parse(await this.post("/api/analyst/ask", { question, accountId, marketId }), AnalystAnswerSchema);
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async parse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = ApiErrorBodySchema.safeParse(json);
      throw new ApiError(err.success ? err.data.error.code : "http", err.success ? err.data.error.message : `Request failed (${res.status})`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError("invalid-response", "The analyst returned data that failed validation.", res.status);
    return parsed.data;
  }
}
