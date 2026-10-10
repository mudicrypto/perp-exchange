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
  const magnitude = Math.floor(Math.log10(Math.abs(price)));
  return Math.max(0, Math.min(maxDecimals, significant - magnitude - 1));
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

/** Quote-currency amount without a currency symbol (the currency is labelled separately). */
export function formatAmount(
  value: number | null | undefined,
  options: { decimals?: number; signed?: boolean; compact?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const { decimals = 2, signed = false, compact = false } = options;
  // Avoid "-0.00".
  const normalized = Math.abs(value) < 0.5 * 10 ** -decimals ? 0 : value;
  const text = normalized.toLocaleString("en-US", {
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : decimals,
    maximumFractionDigits: decimals,
  });
  return signed && normalized > 0 ? `+${text}` : text;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return `${date} ${formatTime(ms)}`;
}

export function formatRelativeTime(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
