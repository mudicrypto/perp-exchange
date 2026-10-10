const EM_DASH = "—";

export function formatPrice(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Choose display decimals for a price: venue max, but trimmed for large prices. */
export function displayPriceDecimals(price: number | null | undefined, maxDecimals: number): number {
  if (!price || !Number.isFinite(price)) return Math.min(2, maxDecimals);
  const significant = 5;
  const integerDigits = Math.max(1, Math.floor(Math.log10(Math.abs(price))) + 1);
  return Math.max(0, Math.min(maxDecimals, significant - integerDigits));
}

export function formatSize(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatUsd(value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    notation: options.compact ? "compact" : "standard",
    maximumFractionDigits: options.compact ? 2 : 2,
  });
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function formatPercent(fraction: number | null | undefined, decimals = 2, signed = false): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return EM_DASH;
  const text = (fraction * 100).toFixed(decimals);
  return `${signed && fraction > 0 ? "+" : ""}${text}%`;
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}
