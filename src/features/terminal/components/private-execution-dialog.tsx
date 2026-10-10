"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { describeExecutionVisibility } from "@/core/private-execution";
import { useTerminal } from "../terminal-context";

/**
 * Entry point from the order ticket. It reports what the *current* venue can
 * do — it never offers a "private" toggle the venue cannot honour.
 */
export function PrivateExecutionDialog({ children }: { children: ReactNode }) {
  const { capabilities: venue } = useTerminal();
  const capabilities = venue.visibility;
  const disclosure = describeExecutionVisibility(capabilities, "hidden-limit");
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent data-testid="private-execution-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKeyhole className="size-4 text-private" aria-hidden /> Private Execution
          </DialogTitle>
          <DialogDescription>
            Not available on {capabilities.venueName}. Orders you place here are{" "}
            <strong className="text-foreground">public</strong>.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {disclosure.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <p className="text-xs">
          Private modes (hidden limit orders, batch auctions, sealed-bid RFQ) need a venue that does not publish
          them. They are planned for Nova&apos;s own venue and will only be offered once that venue exists and its
          guarantees have been independently reviewed.
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <Button asChild className="bg-private text-black hover:bg-private/90">
            <Link href="/private-execution" data-testid="private-execution-learn-more">Learn more</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
