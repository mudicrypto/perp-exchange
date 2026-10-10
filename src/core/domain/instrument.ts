import { z } from "zod";
import { MarginModeSchema } from "./account";
import { MarketSchema, type Market } from "./market";

/**
 * A market as seen by an execution venue: the market-data description plus
 * the venue's trading rules. Produced by `ExecutionAdapter.describeInstrument`.
 */
export const InstrumentSchema = MarketSchema.extend({
  venueId: z.string().min(1),
  kind: z.literal("perpetual"),
  status: z.enum(["active", "reduce-only", "delisted"]),
  /** Maximum significant figures in a price (null = no such rule). */
  priceSignificantFigures: z.number().int().positive().nullable(),
  /** Whether integer prices are exempt from the significant-figure rule. */
  integerPricesExempt: z.boolean(),
  /** Minimum order value in quote units, if the venue enforces one Nova knows about. */
  minOrderValue: z.number().positive().nullable(),
  marginModes: z.array(MarginModeSchema).min(1),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

export interface InstrumentRules {
  venueId: string;
  status?: Instrument["status"];
  priceSignificantFigures: number | null;
  integerPricesExempt: boolean;
  minOrderValue: number | null;
}

export function instrumentFromMarket(market: Market, rules: InstrumentRules): Instrument {
  return InstrumentSchema.parse({
    ...market,
    venueId: rules.venueId,
    kind: "perpetual",
    status: rules.status ?? "active",
    priceSignificantFigures: rules.priceSignificantFigures,
    integerPricesExempt: rules.integerPricesExempt,
    minOrderValue: rules.minOrderValue,
    marginModes: market.isolatedOnly ? ["isolated"] : ["cross", "isolated"],
  });
}
