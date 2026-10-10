"use client";

import { ShieldCheck, Wallet } from "lucide-react";
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
import { useTerminal } from "../../terminal-context";

/**
 * Wallet placeholder. Wallet connection is a later milestone; this dialog
 * states what exists today instead of imitating a connect flow.
 */
export function WalletButton() {
  const { account } = useTerminal();
  const paper = account.connection.status === "paper";
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant={paper ? "outline" : "default"} data-testid="wallet-button">
          <Wallet aria-hidden />
          <span className="hidden sm:inline">{paper ? "Demo account" : "Connect wallet"}</span>
          <span className="sr-only sm:hidden">{paper ? "Demo account" : "Connect wallet"}</span>
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="wallet-dialog">
        <DialogHeader>
          <DialogTitle>Wallet connection is not available yet</DialogTitle>
          <DialogDescription>
            {paper
              ? "You are using a simulated paper account funded with fictitious SIMUSD. Orders are matched locally against simulated order books and never reach a real venue."
              : "Nova is read-only in this milestone. Watch-only account monitoring and wallet connection are planned next."}
          </DialogDescription>
        </DialogHeader>
        <p className="flex items-start gap-2 rounded-md border border-buy/30 bg-buy/5 p-3 text-xs">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-buy" aria-hidden />
          Nova will never ask for your seed phrase or private key. When wallets are supported, signing will
          happen inside your own wallet.
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
