"use client";

import { FlaskConical, RotateCcw, ServerCrash, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DemoControls } from "../../create-sources";

const OUTAGE_MS = 8_000;

/** Lets testers exercise failure states of the simulated environment. */
export function DemoControlsMenu({ demo }: { demo: DemoControls }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="text-warning" data-testid="demo-controls">
          <FlaskConical aria-hidden />
          <span className="hidden sm:inline">Demo</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
          Simulation controls. They only affect this browser tab.
        </p>
        <div className="grid gap-1">
          <Button variant="ghost" className="justify-start" data-testid="demo-outage" onClick={() => demo.simulateOutage(OUTAGE_MS)}>
            <WifiOff aria-hidden /> Simulate {OUTAGE_MS / 1000}s connection loss
          </Button>
          <Button variant="ghost" className="justify-start" data-testid="demo-candle-error" onClick={() => demo.failNextCandleRequest()}>
            <ServerCrash aria-hidden /> Fail next chart data request
          </Button>
          <Button variant="ghost" className="justify-start" data-testid="demo-reset" onClick={() => demo.resetAccount()}>
            <RotateCcw aria-hidden /> Reset demo account
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
