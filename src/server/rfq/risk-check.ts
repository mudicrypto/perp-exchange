import "server-only";
import { getServerEnv } from "@/config/server-env";
import { dec, OUTPUT_DECIMALS, roundDp, toPlain } from "@/core/risk";
import type { RfqCreate } from "@/core/rfq";
import { getCatalogGateway } from "../catalog-gateway";

export interface RfqRiskRefusal {
  limit: "maxOrderNotional" | "maxPositionNotional";
  message: string;
}

/**
 * Server-side pre-trade check for RFQ requests, using limits configured on
 * the server (the browser cannot change them). The notional uses the higher
 * of the requester's reference price and the server's own mark, so a client
 * cannot understate it. Position and portfolio limits need the account, which
 * for the simulator lives in the browser; they are enforced there by
 * RiskGuardedExecutionAdapter before a quote is accepted.
 */
export async function checkRfqLimits(input: RfqCreate): Promise<RfqRiskRefusal | null> {
  const limits = getServerEnv().NOVA_RISK_LIMITS;
  let reference = dec(input.referencePrice);
  try {
    const markets = await getCatalogGateway().listMarkets();
    const mark = markets.find((m) => m.market.id === input.marketId)?.stats?.markPrice;
    if (mark !== undefined && dec(mark).gt(reference)) reference = dec(mark);
  } catch {
    // Without a server mark, the client's reference price is used.
  }
  const notional = dec(input.size).mul(reference);
  const show = (d: ReturnType<typeof dec>) => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));
  for (const name of ["maxOrderNotional", "maxPositionNotional"] as const) {
    const limit = limits[name];
    // An RFQ trade can at most open a position of its own size, so both limits bound the request notional.
    if (limit?.action === "block" && notional.gt(dec(limit.value))) {
      return { limit: name, message: `Request notional ${show(notional)} exceeds the ${name === "maxOrderNotional" ? "order" : "position"} notional limit of ${limit.value}` };
    }
  }
  return null;
}
