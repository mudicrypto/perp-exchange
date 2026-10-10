import { AlertTriangle, Radio, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ConnectionState, DataSourceDescriptor } from "@/core/ports";
import { cn } from "@/lib/utils";

export function SimulationBanner() {
  return (
    <div
      role="alert"
      data-testid="simulation-banner"
      className="flex items-center justify-center gap-2 bg-warning px-3 py-1 text-xs font-semibold text-black"
    >
      <AlertTriangle className="size-3.5" aria-hidden />
      SIMULATED MARKET DATA — prices, order books and trades are generated locally and are not real.
    </div>
  );
}

export function DataSourceBadge({ descriptor }: { descriptor: DataSourceDescriptor }) {
  const simulated = descriptor.kind === "simulation";
  return (
    <Badge
      variant="outline"
      data-testid="data-source-badge"
      className={cn("font-mono text-[10px]", simulated ? "border-warning text-warning" : "text-muted-foreground")}
      title={descriptor.label}
    >
      {simulated ? "SIMULATION" : descriptor.label}
    </Badge>
  );
}

function describe(state: ConnectionState): { label: string; tone: "ok" | "warn" | "bad" } {
  switch (state.status) {
    case "open":
      return { label: "Live", tone: "ok" };
    case "connecting":
      return { label: state.attempt > 1 ? `Connecting (attempt ${state.attempt})` : "Connecting", tone: "warn" };
    case "reconnecting":
      return { label: `Reconnecting (attempt ${state.attempt})`, tone: "warn" };
    case "closed":
      return { label: "Disconnected", tone: "bad" };
    case "idle":
      return { label: "Not connected", tone: "warn" };
  }
}

export function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const { label, tone } = describe(state);
  const Icon = tone === "bad" ? WifiOff : Radio;
  return (
    <span
      data-testid="connection-indicator"
      data-status={state.status}
      role="status"
      aria-live="polite"
      title={state.status === "reconnecting" ? state.reason : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        tone === "ok" && "text-buy",
        tone === "warn" && "text-warning",
        tone === "bad" && "text-sell",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
