import type { Metadata } from "next";
import { PortfolioView } from "@/features/terminal/portfolio-view";

export const metadata: Metadata = { title: "Portfolio · Nova Exchange" };

export default function PortfolioPage() {
  return <PortfolioView />;
}
