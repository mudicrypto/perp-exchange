"use client";

import type { ReactNode } from "react";
import { AppHeader } from "./components/shell/app-header";
import { SimulationBanner } from "./components/status-indicators";
import { useTerminal } from "./terminal-context";

export function AppShell({ children }: { children: ReactNode }) {
  const { marketData } = useTerminal();
  return (
    <div className="flex h-dvh min-h-[600px] flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppHeader />
      {marketData.descriptor.kind === "simulation" && <SimulationBanner />}
      {children}
    </div>
  );
}
