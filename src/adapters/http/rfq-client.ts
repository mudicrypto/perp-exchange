import { z } from "zod";
import {
  RfqRequesterViewSchema,
  type RfqAccept,
  type RfqCreate,
  type RfqRequesterView,
} from "@/core/rfq";
import { ApiError, ApiErrorBodySchema } from "./nova-api-client";

const CounterpartyListSchema = z.array(z.object({ id: z.string(), name: z.string() }));

/**
 * Browser client for Nova's RFQ service. Every response is validated. The
 * session cookie is HttpOnly: this code never sees or stores it.
 */
export class RfqClient {
  private session: Promise<void> | null = null;

  constructor(
    private readonly baseUrl = "",
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  listCounterparties(): Promise<{ id: string; name: string }[]> {
    return this.call("GET", "/api/rfq/counterparties", undefined, CounterpartyListSchema);
  }

  create(input: RfqCreate): Promise<RfqRequesterView> {
    return this.call("POST", "/api/rfq", input, RfqRequesterViewSchema);
  }

  get(id: string): Promise<RfqRequesterView> {
    return this.call("GET", `/api/rfq/${encodeURIComponent(id)}`, undefined, RfqRequesterViewSchema);
  }

  accept(id: string, input: RfqAccept): Promise<RfqRequesterView> {
    return this.call("POST", `/api/rfq/${encodeURIComponent(id)}/accept`, input, RfqRequesterViewSchema);
  }

  cancel(id: string): Promise<RfqRequesterView> {
    return this.call("POST", `/api/rfq/${encodeURIComponent(id)}/cancel`, {}, RfqRequesterViewSchema);
  }

  private ensureSession(): Promise<void> {
    this.session ??= this.fetchImpl(`${this.baseUrl}/api/session`, { method: "POST", credentials: "same-origin" }).then(async (res) => {
      if (!res.ok) {
        this.session = null;
        throw await toError(res);
      }
    });
    return this.session;
  }

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, schema: z.ZodType<T>, retry = true): Promise<T> {
    await this.ensureSession();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      // Session expired (e.g. server restart): start a new one once.
      this.session = null;
      return this.call(method, path, body, schema, false);
    }
    if (!res.ok) throw await toError(res);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ApiError("invalid-response", "The RFQ service returned data that failed validation.", res.status);
    return parsed.data;
  }
}

async function toError(res: Response): Promise<ApiError> {
  const body = ApiErrorBodySchema.safeParse(await res.json().catch(() => null));
  return body.success ? new ApiError(body.data.error.code, body.data.error.message, res.status) : new ApiError("http", `Request failed (${res.status})`, res.status);
}
