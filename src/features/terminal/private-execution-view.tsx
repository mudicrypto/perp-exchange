"use client";

import Link from "next/link";
import { Check, LockKeyhole, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel } from "@/components/trading/panel";
import type { PrivateExecutionMode } from "@/core/ports";
import { describeExecutionVisibility } from "@/core/private-execution";
import { useTerminal } from "./terminal-context";

interface PlannedMode {
  mode: PrivateExecutionMode;
  name: string;
  hides: string;
  stillVisible: string;
}

const PLANNED: readonly PlannedMode[] = [
  { mode: "hidden-limit", name: "Hidden limit orders", hides: "Resting price and size are not shown in the book", stillVisible: "Fills on the trade tape" },
  { mode: "iceberg", name: "Iceberg orders", hides: "All but a small displayed slice of size", stillVisible: "The displayed slice and fills" },
  { mode: "batch-auction", name: "Frequent batch auctions", hides: "Order details until the batch clears; removes speed advantage", stillVisible: "Clearing price and volume per batch" },
  { mode: "sealed-rfq", name: "Sealed-bid RFQ", hides: "Request from the public book; quotes are private between parties", stillVisible: "Resulting trade (venue-dependent)" },
];

function Yes({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {ok ? <Check className="size-3.5 text-buy" aria-hidden /> : <X className="size-3.5 text-sell" aria-hidden />}
      {label}
    </span>
  );
}

/**
 * Dedicated Private Execution entry point. It describes what is true today
 * (derived from the active venue's declared capabilities) and what is
 * planned — no control here can mark an order as private.
 */
export function PrivateExecutionView() {
  const { capabilities } = useTerminal();
  const disclosure = describeExecutionVisibility(capabilities, null);
  const available = capabilities.supportedPrivateModes.length > 0;

  return (
    <main id="main" className="flex-1 overflow-y-auto" data-testid="private-execution-page">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 md:p-6">
        <header className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-xs font-medium text-private uppercase">
            <LockKeyhole className="size-3.5" aria-hidden /> Private Execution
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Trade without broadcasting your intent</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Private execution is about what other participants can see before and after you trade. It can only be
            provided by the venue that holds your order — never by the interface. Nova shows exactly what your
            current venue publishes.
          </p>
          <p
            className="w-fit rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs text-warning"
            data-testid="private-status"
          >
            Status: {available ? "available" : `not available on ${capabilities.venueName}`} — orders placed in Nova today are public.
          </p>
        </header>

        <Panel title={`Current venue · ${capabilities.venueName}`}>
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Resting orders</dt>
                <dd>
                  <Yes ok={capabilities.restingOrderVisibility === "hidden"} label={capabilities.restingOrderVisibility === "hidden" ? "Hidden" : "Public order book"} />
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Fills</dt>
                <dd>
                  <Yes
                    ok={capabilities.fillVisibility === "private"}
                    label={{ "public-ledger": "Public ledger", "public-tape": "Public trade tape", private: "Private" }[capabilities.fillVisibility]}
                  />
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Account attribution</dt>
                <dd>
                  <Yes ok={!capabilities.publicAccountAttribution} label={capabilities.publicAccountAttribution ? "Public by address" : "Not public"} />
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Private order types</dt>
                <dd>{available ? capabilities.supportedPrivateModes.join(", ") : "None"}</dd>
              </div>
            </dl>
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">{disclosure.headline}</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                {disclosure.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          </div>
        </Panel>

        <Panel title="Planned modes (Nova venue)">
          <Table data-testid="planned-modes">
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Mode</TableHead>
                <TableHead className="text-xs">Hides</TableHead>
                <TableHead className="text-xs">Still visible</TableHead>
                <TableHead className="text-xs">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PLANNED.map((m) => (
                <TableRow key={m.mode}>
                  <TableCell className="text-sm font-medium">{m.name}</TableCell>
                  <TableCell className="text-xs whitespace-normal text-muted-foreground">{m.hides}</TableCell>
                  <TableCell className="text-xs whitespace-normal text-muted-foreground">{m.stillVisible}</TableCell>
                  <TableCell>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                      {capabilities.supportedPrivateModes.includes(m.mode) ? "Available" : "Planned"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>

        <Panel title="Our commitments">
          <ul className="grid gap-3 p-4 text-sm md:grid-cols-3">
            <li>
              <p className="font-medium">No false labels</p>
              <p className="text-xs text-muted-foreground">An order is shown as private only if the venue receiving it supports that mode.</p>
            </li>
            <li>
              <p className="font-medium">Disclosure at the ticket</p>
              <p className="text-xs text-muted-foreground">Every order ticket states what will be public before you submit.</p>
            </li>
            <li>
              <p className="font-medium">Reviewed before launch</p>
              <p className="text-xs text-muted-foreground">Privacy guarantees will be independently reviewed before any private mode is offered.</p>
            </li>
          </ul>
        </Panel>

        <div>
          <Button asChild variant="outline">
            <Link href="/">Back to trading</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
