"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SummaryRow } from "@/components/trading/values";
import type { ConnectionState } from "@/core/ports";
import { formatRelativeTime } from "@/lib/format";
import { useDiagnostics, useNow } from "../../hooks/use-market-data";
import { useTerminal } from "../../terminal-context";
import { ConnectionIndicator } from "../status-indicators";

function stateDetail(state: ConnectionState, now: number): string {
  switch (state.status) {
    case "open":
      return `Connected ${formatRelativeTime(state.since, now)}`;
    case "connecting":
      return `Connecting (attempt ${state.attempt})`;
    case "reconnecting":
      return `${state.reason}. Retry ${state.nextRetryAt > now ? `in ${Math.ceil((state.nextRetryAt - now) / 1000)}s` : "now"} (attempt ${state.attempt})`;
    case "closed":
      return `Closed: ${state.reason}`;
    case "idle":
      return "Not connected yet";
  }
}

/** Connection indicator that opens live diagnostics for the market data source. */
export function ConnectionStatus() {
  const { marketData, connection, mids } = useTerminal();
  const [open, setOpen] = useState(false);
  const diagnostics = useDiagnostics(marketData, open);
  const now = useNow(1_000);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md px-1.5 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label="Connection details"
          data-testid="connection-button"
        >
          <ConnectionIndicator state={connection} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid="connection-details">
        <p className="mb-1 text-xs font-semibold">{marketData.descriptor.label}</p>
        <p className="mb-2 text-2xs text-muted-foreground">
          {marketData.descriptor.kind === "live"
            ? "Live public market data. Nothing here is simulated."
            : "Simulated data generated in this browser. Not real prices."}
        </p>
        <dl>
          <SummaryRow label="Status" testId="diag-status">{stateDetail(connection, now)}</SummaryRow>
          <SummaryRow label="Last message">
            {diagnostics?.lastMessageAt ? formatRelativeTime(diagnostics.lastMessageAt, now) : "—"}
          </SummaryRow>
          <SummaryRow label="Market list mids">
            {mids ? `last update ${formatRelativeTime(mids.observedAt, now)}` : "not received (snapshot prices)"}
          </SummaryRow>
          <SummaryRow label="Active subscriptions" testId="diag-subscriptions">{diagnostics?.activeSubscriptions ?? "—"}</SummaryRow>
          <SummaryRow label="Reconnects">{diagnostics?.reconnects ?? "—"}</SummaryRow>
          <SummaryRow label="Dropped malformed messages" testId="diag-invalid">{diagnostics?.invalidMessages ?? "—"}</SummaryRow>
        </dl>
        {diagnostics?.lastInvalidReason && (
          <p className="mt-2 text-2xs break-words text-muted-foreground">Last dropped: {diagnostics.lastInvalidReason}</p>
        )}
        {diagnostics?.lastVenueError && (
          <p className="mt-1 text-2xs break-words text-sell">Venue error: {diagnostics.lastVenueError}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
