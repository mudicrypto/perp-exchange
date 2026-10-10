import { z } from "zod";
import { MarketIdSchema, SideSchema } from "../domain";

/**
 * Private request-for-quote. Confidentiality here is a property of who the
 * service lets read each record, so every view type below is the *complete*
 * set of fields that party receives. Nothing else leaves the RFQ service.
 */

/** How long counterparties may quote (ms). */
export const RFQ_QUOTE_WINDOW_MS = 30_000;
/** Completed requests are deleted this long after completion (ms). */
export const RFQ_RETENTION_MS = 5 * 60_000;
export const RFQ_MAX_COUNTERPARTIES = 5;

export const RfqStatusSchema = z.enum(["open", "accepted", "expired", "cancelled"]);
export type RfqStatus = z.infer<typeof RfqStatusSchema>;

export interface RfqCounterparty {
  id: string;
  name: string;
  /** Simulated desks quote automatically around the reference price. */
  autoQuoteSpreadBps: number | null;
}

/** Request body from the requester. The limit price is deliberately absent. */
export const RfqCreateSchema = z
  .object({
    marketId: MarketIdSchema,
    size: z.number().positive().finite(),
    /** Revealed side, or null to request a two-way quote. */
    side: SideSchema.nullable(),
    /** Public mid the requester observed; simulated desks quote around it. */
    referencePrice: z.number().positive().finite(),
    counterpartyIds: z.array(z.string().min(1).max(64)).min(1).max(RFQ_MAX_COUNTERPARTIES),
  })
  .strict()
  .refine((v) => new Set(v.counterpartyIds).size === v.counterpartyIds.length, { message: "Duplicate counterparty", path: ["counterpartyIds"] });
export type RfqCreate = z.infer<typeof RfqCreateSchema>;

export const RfqQuoteInputSchema = z
  .object({
    /** Price the counterparty buys at (requester sells), or null. */
    bid: z.number().positive().finite().nullable(),
    /** Price the counterparty sells at (requester buys), or null. */
    ask: z.number().positive().finite().nullable(),
  })
  .strict()
  .refine((q) => q.bid !== null || q.ask !== null, { message: "Quote at least one side" })
  .refine((q) => q.bid === null || q.ask === null || q.bid < q.ask, { message: "Bid must be below ask" });
export type RfqQuoteInput = z.infer<typeof RfqQuoteInputSchema>;

export const RfqAcceptSchema = z.object({ quoteId: z.string().min(1).max(64), side: SideSchema }).strict();
export type RfqAccept = z.infer<typeof RfqAcceptSchema>;

export const RfqQuoteSchema = z.object({
  id: z.string(),
  counterpartyId: z.string(),
  counterpartyName: z.string(),
  bid: z.number().positive().nullable(),
  ask: z.number().positive().nullable(),
  size: z.number().positive(),
  createdAt: z.number().int(),
});
export type RfqQuote = z.infer<typeof RfqQuoteSchema>;

export const RfqExecutionSchema = z.object({
  quoteId: z.string(),
  counterpartyId: z.string(),
  counterpartyName: z.string(),
  /** The requester's side. */
  side: SideSchema,
  price: z.number().positive(),
  size: z.number().positive(),
  time: z.number().int(),
});
export type RfqExecution = z.infer<typeof RfqExecutionSchema>;

/** Everything the requester can read about their own request. */
export const RfqRequesterViewSchema = z
  .object({
    id: z.string(),
    marketId: MarketIdSchema,
    size: z.number().positive(),
    side: SideSchema.nullable(),
    status: RfqStatusSchema,
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    counterparties: z.array(z.object({ id: z.string(), name: z.string() })),
    quotes: z.array(RfqQuoteSchema),
    execution: RfqExecutionSchema.nullable(),
  })
  .strict();
export type RfqRequesterView = z.infer<typeof RfqRequesterViewSchema>;

/**
 * Everything a selected counterparty can read. No requester identity, no
 * other counterparties, no competing quotes, no limit price; the execution
 * only if the counterparty's own quote was accepted.
 */
export const RfqCounterpartyViewSchema = z
  .object({
    requestId: z.string(),
    marketId: MarketIdSchema,
    size: z.number().positive(),
    /** The requester's side, only if they revealed it (or once they traded with you). */
    requesterSide: SideSchema.nullable(),
    status: z.enum(["open", "closed", "traded-with-you"]),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    yourQuote: z.object({ bid: z.number().positive().nullable(), ask: z.number().positive().nullable() }).nullable(),
    execution: z.object({ requesterSide: SideSchema, price: z.number().positive(), size: z.number().positive() }).nullable(),
  })
  .strict();
export type RfqCounterpartyView = z.infer<typeof RfqCounterpartyViewSchema>;

/** Field names each party receives (used to keep disclosures and code in sync). */
export const RFQ_COUNTERPARTY_FIELDS = Object.keys(RfqCounterpartyViewSchema.shape) as (keyof RfqCounterpartyView)[];
