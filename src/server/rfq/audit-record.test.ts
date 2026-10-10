import { describe, expect, it } from "vitest";
import { auditRecord } from "./audit-record";

describe("RFQ audit records", () => {
  it("keeps only allow-listed fields and hashes the RFQ id", () => {
    const record = auditRecord("rfq.accepted", {
      rfqId: "rfq-secret-id",
      status: "accepted",
      quoteCount: 2,
      size: 12.5,
      price: 1001.25,
      side: "buy",
      marketId: "ALPHA-PERP",
      sessionId: "session-token",
      token: "counterparty-token",
    });
    expect(record).toEqual({ audit: "rfq", event: "rfq.accepted", rfqRef: expect.stringMatching(/^[0-9a-f]{10}$/), status: "accepted", quoteCount: 2 });
    const line = JSON.stringify(record);
    for (const secret of ["rfq-secret-id", "12.5", "1001.25", "buy", "ALPHA", "session-token", "counterparty-token"]) {
      expect(line).not.toContain(secret);
    }
  });
});
