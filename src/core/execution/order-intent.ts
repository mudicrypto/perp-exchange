import { OrderIntentSchema, type Market, type OrderIntent } from "../domain";

export type IntentIssue = { field: keyof OrderIntent | "form"; message: string };

export type IntentValidation =
  | { ok: true; intent: OrderIntent }
  | { ok: false; issues: IntentIssue[] };

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const text = value.toString();
  if (text.includes("e-")) {
    const [mantissa, exponent] = text.split("e-");
    const mantissaDecimals = mantissa?.split(".")[1]?.length ?? 0;
    return mantissaDecimals + Number(exponent);
  }
  return text.split(".")[1]?.length ?? 0;
}

/**
 * Validates an order intent against generic schema rules and the market's
 * declared precision and leverage limits. Venue-specific rules (e.g. a
 * significant-figure limit on price) belong to the venue's execution adapter.
 */
export function validateOrderIntent(input: unknown, market: Market): IntentValidation {
  const parsed = OrderIntentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: (issue.path[0] as keyof OrderIntent | undefined) ?? "form",
        message: issue.message,
      })),
    };
  }
  const intent = parsed.data;
  const issues: IntentIssue[] = [];
  if (intent.marketId !== market.id) {
    issues.push({ field: "marketId", message: "Order market does not match selected market" });
  }
  if (decimalsOf(intent.size) > market.sizeDecimals) {
    issues.push({ field: "size", message: `Size allows at most ${market.sizeDecimals} decimals` });
  }
  if (intent.limitPrice !== null && decimalsOf(intent.limitPrice) > market.priceDecimals) {
    issues.push({
      field: "limitPrice",
      message: `Price allows at most ${market.priceDecimals} decimals`,
    });
  }
  if (intent.leverage > market.maxLeverage) {
    issues.push({ field: "leverage", message: `Max leverage is ${market.maxLeverage}x` });
  }
  if (intent.marginMode === "cross" && market.isolatedOnly) {
    issues.push({ field: "marginMode", message: "This market supports isolated margin only" });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, intent };
}
