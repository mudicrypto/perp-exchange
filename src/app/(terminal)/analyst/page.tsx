import type { Metadata } from "next";
import { AnalystView } from "@/features/terminal/analyst-view";

export const metadata: Metadata = { title: "AI Analyst · Nova Exchange" };

export default function AnalystPage() {
  return <AnalystView />;
}
