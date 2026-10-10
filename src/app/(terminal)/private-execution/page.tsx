import type { Metadata } from "next";
import { PrivateExecutionView } from "@/features/terminal/private-execution-view";

export const metadata: Metadata = { title: "Private Execution · Nova Exchange" };

export default function PrivateExecutionPage() {
  return <PrivateExecutionView />;
}
