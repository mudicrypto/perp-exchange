"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PublicRuntimeConfig } from "@/config/runtime-config";
import type { MarketId, MarketSummary } from "@/core/domain";
import type { AccountState, ConnectionState } from "@/core/ports";
import { BrowserStorageStore } from "@/lib/storage";
import { createTerminalServices, type TerminalServices } from "./create-sources";
import { useConnectionState, useMarkets, type LoadStatus } from "./hooks/use-market-data";

export const STORE_KEYS = { market: "market", interval: "interval", ticketSize: "ticket" } as const;

export interface TerminalContextValue extends TerminalServices {
  runtime: PublicRuntimeConfig;
  store: BrowserStorageStore;
  connection: ConnectionState;
  markets: readonly MarketSummary[];
  marketsStatus: LoadStatus;
  marketsError: string | null;
  marketsUpdatedAt: number | null;
  retryMarkets: () => void;
  selected: MarketSummary | null;
  selectMarket: (id: MarketId) => void;
  /** null = no account (live venues in this milestone) or not loaded yet. */
  account: TerminalServices["account"];
  accountState: AccountState | null;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function useTerminal(): TerminalContextValue {
  const value = useContext(TerminalContext);
  if (!value) throw new Error("useTerminal must be used inside <TerminalProvider>");
  return value;
}

function useAccountState(services: TerminalServices): AccountState | null {
  const [state, setState] = useState<AccountState | null>(null);
  useEffect(() => services.account.subscribeAccount(setState), [services.account]);
  return state;
}

/**
 * Owns the market data source, account source and execution adapter for the
 * whole app shell, so state survives navigation between Trade, Portfolio and
 * Private Execution.
 */
export function TerminalProvider({ runtime, children }: { runtime: PublicRuntimeConfig; children: ReactNode }) {
  const [services] = useState(() => createTerminalServices(runtime));
  const [store] = useState(() => new BrowserStorageStore());
  const connection = useConnectionState(services.marketData);
  const { markets, status, error, updatedAt, retry } = useMarkets(services.marketData);
  const accountState = useAccountState(services);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : store.get(STORE_KEYS.market),
  );

  useEffect(
    () => () => {
      services.marketData.dispose();
      services.account.dispose();
    },
    [services],
  );

  const selected = useMemo(() => {
    if (markets.length === 0) return null;
    return (
      markets.find((m) => m.market.id === selectedId) ??
      [...markets].sort((a, b) => (b.stats?.dayNotionalVolume ?? 0) - (a.stats?.dayNotionalVolume ?? 0))[0] ??
      null
    );
  }, [markets, selectedId]);

  const value: TerminalContextValue = {
    ...services,
    runtime,
    store,
    connection,
    markets,
    marketsStatus: status,
    marketsError: error,
    marketsUpdatedAt: updatedAt,
    retryMarkets: retry,
    selected,
    selectMarket: (id) => {
      setSelectedId(id);
      store.set(STORE_KEYS.market, id);
    },
    accountState,
  };

  return (
    <TerminalContext.Provider value={value}>
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
    </TerminalContext.Provider>
  );
}
