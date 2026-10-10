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
import { describeExecution, PRIVATE_EXECUTION_MODES } from "@/core/privacy";
import { useTerminal } from "../terminal-context";
import { MODE_LABEL } from "../private-execution/mode-labels";

/**
 * Entry point from the order ticket. It reports what the *current* venue can
 * do for each private mode — derived from the venue's declared capabilities,
 * never from a UI toggle.
 */
export function PrivateExecutionDialog({ children }: { children: ReactNode }) {
  const { capabilities: venue } = useTerminal();
  const modes = PRIVATE_EXECUTION_MODES.map((mode) => describeExecution(venue.capabilities, venue.privacy, mode));
  const anyAvailable = modes.some((m) => m.executable);
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent data-testid="private-execution-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKeyhole className="size-4 text-private" aria-hidden /> Private Execution
          </DialogTitle>
          <DialogDescription>
            {anyAvailable ? (
              <>Private modes {venue.venueName} supports are listed below. Orders from this ticket are public limit or market orders.</>
            ) : (
              <>
                Not available on {venue.venueName}. Orders you place here are <strong className="text-foreground">public</strong>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5 text-xs" data-testid="private-mode-summary">
          {modes.map((m) => (
            <li key={m.mode} className="flex items-start justify-between gap-3" data-mode={m.mode} data-executable={m.executable}>
              <span className="font-medium">{MODE_LABEL[m.mode]}</span>
              <span className="text-right text-muted-foreground">{m.executable ? m.headline : m.details[0]}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <Button asChild className="bg-private text-black hover:bg-private/90">
            <Link href="/private-execution" data-testid="private-execution-learn-more">Open workspace</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
