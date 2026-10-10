import { Suspense } from "react";
import { connection } from "next/server";
import { getPublicRuntimeConfig } from "@/config/server-env";
import { TradingTerminal } from "@/features/terminal/trading-terminal";

async function Terminal() {
  // Configuration is read per request so deployments can change it without rebuilding.
  await connection();
  const runtime = getPublicRuntimeConfig();
  return <TradingTerminal runtime={runtime} />;
}

export default function Page() {
  return (
    <Suspense
      fallback={<div className="p-6 text-sm text-muted-foreground">Loading terminal…</div>}
    >
      <Terminal />
    </Suspense>
  );
}
