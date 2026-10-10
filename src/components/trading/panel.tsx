import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { freshnessOf, type StreamStatus } from "@/core/market-data";

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

const STATUS_STYLE: Record<Exclude<StreamStatus, "live">, string> = {
  waiting: "bg-muted text-muted-foreground",
  stale: "bg-warning/15 text-warning",
  disconnected: "bg-sell/15 text-sell",
  error: "bg-sell/15 text-sell",
};

/**
 * Shows a stream's status in the panel header. Live data shows its age only
 * once it is a few seconds old; anything else is called out explicitly.
 */
export function StreamBadge({ status, lastUpdateAt, now }: { status: StreamStatus; lastUpdateAt?: number | null; now?: number }) {
  const since = lastUpdateAt != null && now != null ? now - lastUpdateAt : null;
  if (status === "live") {
    if (since === null || since < 3_000) return null;
    return (
      <span className="tabular text-2xs text-muted-foreground" data-testid="stream-age">
        {age(since)} ago
      </span>
    );
  }
  const label = {
    waiting: "Waiting for data",
    stale: since !== null ? `Stale · ${age(since)}` : "Stale",
    disconnected: since !== null ? `Disconnected · last ${age(since)} ago` : "Disconnected",
    error: "Error",
  }[status];
  return (
    <span role="status" data-testid="stream-badge" className={cn("rounded px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap", STATUS_STYLE[status])}>
      {label}
    </span>
  );
}

export function Panel({
  title,
  actions,
  stream,
  className,
  children,
  testId,
}: {
  title: ReactNode;
  actions?: ReactNode;
  /** Status of the data stream rendered in this panel, if any. */
  stream?: { status: StreamStatus; lastUpdateAt?: number | null; now?: number };
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const dim = stream && (stream.status === "stale" || stream.status === "disconnected");
  return (
    <section
      data-testid={testId}
      data-freshness={stream ? freshnessOf(stream.status) : undefined}
      data-stream-status={stream?.status}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border bg-surface", className)}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 className="truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        <div className="flex items-center gap-2">
          {stream && <StreamBadge {...stream} />}
          {actions}
        </div>
      </header>
      <div className={cn("relative min-h-0 flex-1", dim && "opacity-60")}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-sm text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}
