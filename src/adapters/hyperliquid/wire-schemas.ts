/**
 * Zod schemas for Hyperliquid's public API wire format.
 *
 * Provenance (see docs/integrations/HYPERLIQUID.md):
 *  - Official SDKs by hyperliquid-dex: python-sdk `utils/types.py`,
 *    rust-sdk `ws/sub_structs.rs` + `ws/message_types.rs`.
 *  - Cross-checked with `@nktkas/hyperliquid` schemas, which reference the
 *    official docs pages (info endpoint, websocket subscriptions).
 * The official docs site could not be reached from the build environment,
 * so these schemas must be re-verified with `npm run test:live`.
 *
 * Only fields Nova uses are required. Unknown extra fields are stripped, so
 * additive API changes do not break parsing; missing or malformed required
 * fields fail validation and the payload is dropped.
 *
 * These types must not be imported outside `src/adapters/hyperliquid`.
 */
import { z } from "zod";

/** Hyperliquid encodes decimals as strings. */
export const HlDecimal = z.string().regex(/^-?\d+(\.\d+)?$/, "Expected decimal string");
export const HlPositiveDecimal = z.string().regex(/^\d+(\.\d+)?$/, "Expected unsigned decimal string");

export const HlCandleIntervalSchema = z.enum([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M",
]);

export const HlUniverseAssetSchema = z.object({
  name: z.string().min(1),
  szDecimals: z.number().int().min(0),
  maxLeverage: z.number().positive(),
  onlyIsolated: z.boolean().optional(),
  isDelisted: z.boolean().optional(),
  marginTableId: z.number().int().optional(),
});
export type HlUniverseAsset = z.infer<typeof HlUniverseAssetSchema>;

export const HlMetaSchema = z.object({
  universe: z.array(HlUniverseAssetSchema),
});

export const HlPerpAssetCtxSchema = z.object({
  funding: HlDecimal,
  openInterest: HlPositiveDecimal,
  prevDayPx: HlPositiveDecimal,
  dayNtlVlm: HlPositiveDecimal,
  premium: HlDecimal.nullable().optional(),
  oraclePx: HlPositiveDecimal,
  markPx: HlPositiveDecimal,
  midPx: HlPositiveDecimal.nullable().optional(),
  impactPxs: z.array(HlPositiveDecimal).nullable().optional(),
  dayBaseVlm: HlPositiveDecimal.optional(),
});
export type HlPerpAssetCtx = z.infer<typeof HlPerpAssetCtxSchema>;

export const HlMetaAndAssetCtxsSchema = z.tuple([HlMetaSchema, z.array(HlPerpAssetCtxSchema)]);
export type HlMetaAndAssetCtxs = z.infer<typeof HlMetaAndAssetCtxsSchema>;

export const HlCandleSchema = z.object({
  t: z.number().int().nonnegative(),
  T: z.number().int().nonnegative(),
  s: z.string(),
  i: z.string(),
  o: HlPositiveDecimal,
  c: HlPositiveDecimal,
  h: HlPositiveDecimal,
  l: HlPositiveDecimal,
  v: HlPositiveDecimal,
  n: z.number().int().nonnegative(),
});
export type HlCandle = z.infer<typeof HlCandleSchema>;
export const HlCandleSnapshotSchema = z.array(HlCandleSchema);

export const HlL2LevelSchema = z.object({
  px: HlPositiveDecimal,
  sz: HlPositiveDecimal,
  n: z.number().int().nonnegative(),
});

export const HlL2BookSchema = z.object({
  coin: z.string(),
  time: z.number().int().nonnegative(),
  levels: z.tuple([z.array(HlL2LevelSchema), z.array(HlL2LevelSchema)]),
});
export type HlL2Book = z.infer<typeof HlL2BookSchema>;

export const HlTradeSchema = z.object({
  coin: z.string(),
  side: z.enum(["A", "B"]),
  px: HlPositiveDecimal,
  sz: HlPositiveDecimal,
  time: z.number().int().nonnegative(),
  hash: z.string(),
  tid: z.number().int().nonnegative(),
});
export type HlTrade = z.infer<typeof HlTradeSchema>;
export const HlTradesSchema = z.array(HlTradeSchema);

export const HlActiveAssetCtxSchema = z.object({
  coin: z.string(),
  ctx: HlPerpAssetCtxSchema,
});
export type HlActiveAssetCtx = z.infer<typeof HlActiveAssetCtxSchema>;

/**
 * `allMids` data: `{ mids: { [coin]: px } }` (rust-sdk `AllMidsData`).
 * Values are validated per entry in the mapper, so one malformed price does
 * not discard every other market's price.
 */
export const HlAllMidsSchema = z.object({
  mids: z.record(z.string(), z.string()),
});
export type HlAllMids = z.infer<typeof HlAllMidsSchema>;

/** Every websocket message is `{ channel, data }`. */
export const HlWsEnvelopeSchema = z.object({
  channel: z.string(),
  data: z.unknown().optional(),
});
