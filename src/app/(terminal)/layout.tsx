import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { getPublicRuntimeConfig } from "@/config/server-env";
import { AppShell } from "@/features/terminal/app-shell";
import { TerminalProvider } from "@/features/terminal/terminal-context";

async function RuntimeBoundary({ children }: { children: ReactNode }) {
  // Configuration is read per request so deployments can change it without rebuilding.
  await connection();
  const runtime = getPublicRuntimeConfig();
  return (
    <TerminalProvider runtime={runtime}>
      <AppShell>{children}</AppShell>
    </TerminalProvider>
  );
}

export default function TerminalLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground" aria-busy="true">Loading Nova…</div>}>
      <RuntimeBoundary>{children}</RuntimeBoundary>
    </Suspense>
  );
}
