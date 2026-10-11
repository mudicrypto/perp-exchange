import {
  ORDER_TYPE_CAPABILITY,
  OrderRequestSchema,
  requestLimitPrice,
  type CapabilityMap,
  type FieldIssue,
  type Instrument,
  type OrderRequest,
  type Result,
  type TradingError,
} from "../domain";
import { checkRequestCapabilities, unsupportedError } from "./capability-registry";

export interface ValidationContext {
  /** Price used for value-based rules when the request has no limit price (e.g. mark). */
  referencePrice?: number | null;
}

export function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const text = value.toString();
  if (text.includes("e-")) {
    const [mantissa, exponent] = text.split("e-");
    return (mantissa?.split(".")[1]?.length ?? 0) + Number(exponent);
  }
  return text.split(".")[1]?.length ?? 0;
}

/** True if `value` can be written with at most `figures` significant figures. */
export function fitsSignificantFigures(value: number, figures: number): boolean {
  return Number(value.toPrecision(figures)) === value;
}

function priceIssues(field: string, price: number, instrument: Instrument): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (decimalsOf(price) > instrument.priceDecimals) {
    issues.push({ field, message: `Price allows at most ${instrument.priceDecimals} decimals` });
  }
  const sig = instrument.priceSignificantFigures;
  const exempt = instrument.integerPricesExempt && Number.isInteger(price);
  if (sig !== null && !exempt && !fitsSignificantFigures(price, sig)) {
    issues.push({ field, message: `Price allows at most ${sig} significant figures` });
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Venue-independent validation of an order request against an instrument's
 * trading rules and a venue's capability map. Order:
 *  1. unsupported order type / feature → explicit `unsupported` error (never emulated)
 *  2. schema + instrument rules → `validation` error listing every issue
 */
const FIELD_LABEL: Record<string, string> = {
  size: "Size",
  price: "Price",
  triggerPrice: "Trigger price",
  displaySize: "Display size",
  leverage: "Leverage",
  maxSlippage: "Slippage limit",
  side: "Side",
  type: "Order type",
  timeInForce: "Time in force",
  marginMode: "Margin mode",
  marketId: "Market",
  clientOrderId: "Client order id",
  reduceOnly: "Reduce-only",
};
const NUMERIC = new Set(["size", "price", "triggerPrice", "displaySize", "leverage", "maxSlippage"]);

/** Schema issues phrased for users, always naming the field (never raw schema text alone). */
function friendlyMessage(issue: { code: string; path: PropertyKey[]; message: string }, input: unknown): string {
  const field = String(issue.path[0] ?? "");
  const label = FIELD_LABEL[field] ?? (field || "Order");
  const value = isRecord(input) ? input[field] : undefined;
  if (field && value === undefined) return `${label} is required`;
  if (NUMERIC.has(field)) return issue.code === "too_big" ? `${label} is too large` : `${label} must be a positive number`;
  if (issue.path.length === 0) return issue.message;
  return `${label} is invalid`;
}

export function validateOrderRequest(
  input: unknown,
  instrument: Instrument,
  capabilities: CapabilityMap,
  context: ValidationContext = {},
): Result<OrderRequest, TradingError> {
  // Capability check on the declared type first, even if other fields are invalid.
  if (isRecord(input) && typeof input.type === "string" && input.type in ORDER_TYPE_CAPABILITY) {
    const capability = ORDER_TYPE_CAPABILITY[input.type as keyof typeof ORDER_TYPE_CAPABILITY];
    const error = unsupportedError(capability, capabilities[capability]);
    if (error) return { ok: false, error };
  }

  const parsed = OrderRequestSchema.safeParse(input);
  const issues: FieldIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? "form"), message: friendlyMessage(i, input) }));

  // Instrument rules run on whatever numeric fields are usable, so all problems show at once.
  const raw = isRecord(input) ? input : {};
  if (typeof raw.marketId === "string" && raw.marketId !== instrument.id) {
    issues.push({ field: "marketId", message: "Order market does not match the instrument" });
  }
  if (instrument.status === "delisted") issues.push({ field: "marketId", message: "Instrument is delisted" });
  if (instrument.status === "reduce-only" && raw.reduceOnly !== true) {
    issues.push({ field: "reduceOnly", message: "Instrument only accepts reduce-only orders" });
  }
  if (num(raw.size) && decimalsOf(raw.size) > instrument.sizeDecimals) {
    issues.push({ field: "size", message: `Size allows at most ${instrument.sizeDecimals} decimals` });
  }
  if (num(raw.displaySize) && decimalsOf(raw.displaySize) > instrument.sizeDecimals) {
    issues.push({ field: "displaySize", message: `Size allows at most ${instrument.sizeDecimals} decimals` });
  }
  if (num(raw.price)) issues.push(...priceIssues("price", raw.price, instrument));
  if (num(raw.triggerPrice)) issues.push(...priceIssues("triggerPrice", raw.triggerPrice, instrument));
  if (num(raw.leverage) && raw.leverage > instrument.maxLeverage) {
    issues.push({ field: "leverage", message: `Max leverage is ${instrument.maxLeverage}x` });
  }
  if ((raw.marginMode === "cross" || raw.marginMode === "isolated") && !instrument.marginModes.includes(raw.marginMode)) {
    issues.push({ field: "marginMode", message: `${raw.marginMode} margin is not available for this instrument` });
  }

  if (issues.length > 0 || !parsed.success) {
    return { ok: false, error: { code: "validation", issues, message: issues.map((i) => i.message).join("; ") } };
  }
  const request = parsed.data;

  if (instrument.minOrderValue !== null) {
    const price = requestLimitPrice(request) ?? ("triggerPrice" in request ? request.triggerPrice : null) ?? context.referencePrice ?? null;
    if (price !== null && request.size * price < instrument.minOrderValue) {
      const issue = { field: "size", message: `Minimum order value is ${instrument.minOrderValue} ${instrument.quote}` };
      return { ok: false, error: { code: "validation", issues: [issue], message: issue.message } };
    }
  }

  const unsupported = checkRequestCapabilities(request, capabilities);
  if (unsupported) return { ok: false, error: unsupported };
  return { ok: true, value: request };
}
