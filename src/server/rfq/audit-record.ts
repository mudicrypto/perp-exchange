import { createHash } from "node:crypto";

export type RfqAuditEvent =
  | "session.created"
  | "rfq.created"
  | "rfq.quoted"
  | "rfq.accepted"
  | "rfq.cancelled"
  | "rfq.denied";

/**
 * Allow-list of loggable fields. Sizes, prices, sides, markets, session ids
 * and tokens are never logged; the RFQ id is replaced by a short one-way hash
 * so log lines can be correlated without being usable to read the request.
 */
const ALLOWED = new Set(["rfqId", "status", "counterpartyCount", "quoteCount", "reason", "route"]);

export function auditRecord(event: RfqAuditEvent, fields: Record<string, unknown>): Record<string, string | number> {
  const record: Record<string, string | number> = { audit: "rfq", event };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key)) continue;
    if (key === "rfqId" && typeof value === "string") {
      record.rfqRef = createHash("sha256").update(value).digest("hex").slice(0, 10);
    } else if (typeof value === "string" || typeof value === "number") {
      record[key] = value;
    }
  }
  return record;
}
