import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Freshness } from "@/core/market-data";

export function Panel({
  title,
  actions,
  freshness,
  className,
  children,
  testId,
  staleLabel = "Stale",
}: {
  title: ReactNode;
  actions?: ReactNode;
  freshness?: Freshness;
  staleLabel?: string;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      data-freshness={freshness}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-md border bg-surface", className)}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
        <div className="flex items-center gap-2">
          {freshness === "stale" && (
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning" role="status">
              {staleLabel}
            </span>
          )}
          {actions}
        </div>
      </header>
      <div className={cn("relative min-h-0 flex-1", freshness === "stale" && "opacity-60")}>{children}</div>
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
