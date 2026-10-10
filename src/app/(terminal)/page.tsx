import type { Metadata } from "next";
import { TradeWorkspace } from "@/features/terminal/trade-workspace";

export const metadata: Metadata = { title: "Trade · Nova Exchange" };

export default function TradePage() {
  return <TradeWorkspace />;
}
