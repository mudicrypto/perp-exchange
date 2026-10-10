import "server-only";
import { auditRecord, type RfqAuditEvent } from "./audit-record";

/** Writes an RFQ audit line containing only allow-listed, non-sensitive fields. */
export function auditRfq(event: RfqAuditEvent, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify(auditRecord(event, fields)));
}
