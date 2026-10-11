"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, LockKeyhole } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminal } from "../../terminal-context";
import { DataSourceBadge } from "../status-indicators";
import { ConnectionStatus } from "./connection-status";
import { DemoControlsMenu } from "./demo-controls";
import { WalletButton } from "./wallet-button";

const NAV = [
  { href: "/", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/private-execution", label: "Private Execution", short: "Private", icon: LockKeyhole, iconClass: "text-private" },
  { href: "/analyst", label: "Analyst", icon: Bot, iconClass: "text-primary" },
] as const;

export function NovaLogo() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="Nova Exchange home">
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <defs>
          <linearGradient id="nova-g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" />
            <stop offset="1" stopColor="var(--private)" />
          </linearGradient>
        </defs>
        <path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" fill="url(#nova-g)" />
      </svg>
      <span className="text-sm font-semibold tracking-tight">Nova</span>
    </Link>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  const { marketData, demo } = useTerminal();
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-surface px-3 py-1.5 md:h-12 md:flex-nowrap md:py-0">
      <NovaLogo />
      <nav aria-label="Primary" className="order-last flex w-full min-w-0 items-center gap-1 overflow-x-auto md:order-none md:w-auto">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = "icon" in item ? item.icon : null;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {Icon && <Icon className={cn("size-3.5", "iconClass" in item && item.iconClass)} aria-hidden />}
              {"short" in item ? (
                <>
                  <span className="sm:hidden">{item.short}</span>
                  <span className="hidden sm:inline">{item.label}</span>
                </>
              ) : (
                item.label
              )}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <span className="hidden md:inline-flex">
          <DataSourceBadge descriptor={marketData.descriptor} />
        </span>
        <ConnectionStatus />
        {demo && <DemoControlsMenu demo={demo} />}
        <WalletButton />
      </div>
    </header>
  );
}
