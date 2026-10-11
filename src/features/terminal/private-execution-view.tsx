"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { CircleAlert, LockKeyhole, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/trading/panel";
import type { Market, MarketId, Side } from "@/core/domain";
import { PRIVATE_EXECUTION_MODES, type PrivateExecutionMode } from "@/core/privacy";
import { counterpartyView, type RfqRequesterView } from "@/core/rfq";
import { checkPrivateMode } from "@/core/trading";
import { formatPrice, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { newClientOrderId } from "./client-order-id";
import { useNow } from "./hooks/use-market-data";
import { LEVEL_LABEL, MODE_LABEL, MODE_SUMMARY } from "./private-execution/mode-labels";
import { PrivacyMatrix } from "./private-execution/privacy-matrix";
import { PrivateHistory } from "./private-execution/private-history";
import { failedChecks } from "./risk/checks";
import { RiskValueText } from "./risk/risk-value";
import { useTerminal } from "./terminal-context";

type Status = { kind: "idle" } | { kind: "busy"; message: string } | { kind: "success"; message: string } | { kind: "error"; message: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Request failed");

/**
 * Private Execution workspace. Every mode's availability and disclosure is
 * derived from the active venue's declared capabilities and privacy profile;
 * submissions go through PrivateExecutionService (hidden / iceberg) or the
 * RFQ service, both of which re-check support before anything is sent.
 */
export function PrivateExecutionView() {
  const terminal = useTerminal();
  const { capabilities: venue, privateExecution, privateVenue, markets, selected, mids, accountState, execution } = terminal;
  const ids = useId();

  const checks = useMemo(
    () => Object.fromEntries(PRIVATE_EXECUTION_MODES.map((m) => [m, checkPrivateMode(venue, m)])) as Record<PrivateExecutionMode, ReturnType<typeof checkPrivateMode>>,
    [venue],
  );
  const [mode, setModeState] = useState<PrivateExecutionMode>(() => PRIVATE_EXECUTION_MODES.find((m) => checks[m].ok) ?? "hidden");
  const disclosure = useMemo(() => privateExecution.disclosure(mode), [privateExecution, mode]);
  const check = checks[mode];

  const [marketChoice, setMarketChoice] = useState<MarketId | null>(null);
  const marketId = marketChoice ?? selected?.market.id ?? markets[0]?.market.id ?? null;
  const market: Market | null = markets.find((m) => m.market.id === marketId)?.market ?? null;
  const position = accountState?.snapshot.positions.find((p) => p.marketId === marketId) ?? null;

  const [side, setSide] = useState<Side>("buy");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [displaySize, setDisplaySize] = useState("");
  const [leverageInput, setLeverage] = useState("5");
  const [postOnly, setPostOnly] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const [counterparties, setCounterparties] = useState<{ id: string; name: string }[] | null>(null);
  const [counterpartyError, setCounterpartyError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [revealSide, setRevealSide] = useState(false);
  const [rfq, setRfq] = useState<RfqRequesterView | null>(null);

  const leverage = position ? position.leverage : Number(leverageInput);
  const mid = marketId ? (mids?.mids.get(marketId) ?? null) : null;
  const rfqReady = mode === "rfq" && check.ok && privateVenue !== null;

  const setMode = (next: PrivateExecutionMode) => {
    setModeState(next);
    setConfirmed(false);
    setStatus({ kind: "idle" });
  };

  // Counterparties are fetched only when the RFQ mode is actually usable.
  useEffect(() => {
    if (!rfqReady || counterparties !== null) return;
    let cancelled = false;
    privateVenue.rfq
      .listCounterparties()
      .then((list) => {
        if (!cancelled) setCounterparties(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) setCounterpartyError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [rfqReady, counterparties, privateVenue]);

  // Poll an open request for quotes until it closes.
  const openRfqId = rfq?.status === "open" ? rfq.id : null;
  useEffect(() => {
    if (!openRfqId || !privateVenue) return;
    const timer = setInterval(() => {
      privateVenue.rfq.get(openRfqId).then(setRfq, (error: unknown) => setStatus({ kind: "error", message: errorMessage(error) }));
    }, 1_000);
    return () => clearInterval(timer);
  }, [openRfqId, privateVenue]);

  const bookOrderInput = (clientOrderId: string) =>
    market && (mode === "hidden" || mode === "iceberg")
      ? {
          clientOrderId,
          marketId: market.id,
          side,
          type: mode,
          price: Number(price),
          size: Number(size),
          timeInForce: postOnly ? "post-only" : "gtc",
          reduceOnly: false,
          leverage,
          marginMode: "isolated",
          ...(mode === "iceberg" ? { displaySize: Number(displaySize) } : {}),
        }
      : null;

  // The same pre-trade assessment the execution guard will enforce on submission.
  const riskPreview = (() => {
    const draft = bookOrderInput("preview");
    if (!draft || !market || size === "" || price === "") return null;
    const validated = execution.validateOrder(draft, execution.describeInstrument(market));
    return validated.ok ? execution.assess(validated.value, market) : null;
  })();
  const riskBlocked = riskPreview?.decision === "block";

  const submitBookOrder = async () => {
    if (!market || (mode !== "hidden" && mode !== "iceberg")) return;
    const input = {
      clientOrderId: newClientOrderId("priv"),
      marketId: market.id,
      side,
      type: mode,
      price: Number(price),
      size: Number(size),
      timeInForce: postOnly ? "post-only" : "gtc",
      reduceOnly: false,
      leverage,
      marginMode: "isolated",
      ...(mode === "iceberg" ? { displaySize: Number(displaySize) } : {}),
    };
    setStatus({ kind: "busy", message: "Submitting to the simulated venue…" });
    const result = await privateExecution.submit(
      mode,
      input,
      execution.describeInstrument(market),
      confirmed ? { mode, venueId: venue.venueId, level: disclosure.level } : null,
    );
    if (result.ok) {
      setStatus({ kind: "success", message: `${MODE_LABEL[mode]} ${result.value.id}: ${result.value.status.replaceAll("-", " ")}.` });
    } else {
      const issues = result.error.code === "validation" ? result.error.issues.map((i) => i.message).join("; ") : result.error.message;
      setStatus({ kind: "error", message: issues });
    }
  };

  const sendRfq = async () => {
    if (!privateVenue || !market) return;
    if (mid === null) return setStatus({ kind: "error", message: "No public price is available for this market yet." });
    if (!(Number(size) > 0)) return setStatus({ kind: "error", message: "Enter a size." });
    if (chosen.length === 0) return setStatus({ kind: "error", message: "Select at least one counterparty." });
    setStatus({ kind: "busy", message: "Sending request…" });
    try {
      const created = await privateVenue.rfq.create({
        marketId: market.id,
        size: Number(size),
        side: revealSide ? side : null,
        referencePrice: mid,
        counterpartyIds: chosen,
      });
      setRfq(created);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const acceptQuote = async (quoteId: string, quotePrice: number) => {
    if (!privateVenue || !rfq || !market) return;
    const trade = { clientOrderId: newClientOrderId("rfq"), marketId: rfq.marketId, side, size: rfq.size, price: quotePrice, leverage };
    // Check the paper account can take the trade *before* committing to it.
    const blocker = privateVenue.checkRfqTrade(trade);
    if (blocker) return setStatus({ kind: "error", message: blocker.message });
    setStatus({ kind: "busy", message: "Accepting quote…" });
    try {
      const accepted = await privateVenue.rfq.accept(rfq.id, { quoteId, side });
      setRfq(accepted);
      const execution = accepted.execution;
      if (!execution) throw new Error("The RFQ service did not confirm an execution.");
      const booked = privateVenue.recordRfqTrade({ ...trade, price: execution.price, size: execution.size, side: execution.side });
      setStatus(
        booked.ok
          ? { kind: "success", message: `RFQ trade with ${execution.counterpartyName}: ${execution.side} ${execution.size} @ ${execution.price}.` }
          : { kind: "error", message: `The desk confirmed the trade but the paper account could not book it: ${booked.error.message}` },
      );
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed) return setStatus({ kind: "error", message: "Confirm the privacy disclosure first." });
    if (mode === "rfq") void sendRfq();
    else void submitBookOrder();
  };

  const limit = Number(price);
  const busy = status.kind === "busy";
  const formDisabled = !check.ok || !market || (mode === "rfq" && rfq?.status === "open");

  return (
    <main id="main" className="flex-1 overflow-y-auto" data-testid="private-execution-page">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <header className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-xs font-medium text-private uppercase">
            <LockKeyhole className="size-3.5" aria-hidden /> Private Execution
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Control who sees your order</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Privacy is provided by the venue that holds your order and by how Nova routes requests, never by this
            interface. Each mode below shows exactly who can see what on {venue.venueName}.
          </p>
          {venue.origin === "simulated" && (
            <p className="w-fit rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs text-warning" data-testid="private-simulated-banner">
              Simulated venue: orders, quotes, counterparties and fills are fictitious (SIMUSD). Nothing is sent to a real venue.
            </p>
          )}
        </header>

        <Panel title="Execution mode">
          <div role="radiogroup" aria-label="Execution mode" className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRIVATE_EXECUTION_MODES.map((m) => {
              const available = checks[m].ok;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  data-testid={`mode-${m}`}
                  data-available={available}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    mode === m ? "border-private bg-private/10" : "hover:bg-accent",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm font-semibold">
                    {MODE_LABEL[m]}
                    <span className={cn("rounded px-1.5 py-0.5 text-2xs font-medium", available ? "bg-buy/15 text-buy" : "bg-muted text-muted-foreground")}>
                      {available ? "Available" : m === "encrypted" ? "Planned" : "Unavailable"}
                    </span>
                  </span>
                  <span className="text-2xs text-muted-foreground">{MODE_SUMMARY[m]}</span>
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <Panel title={`${MODE_LABEL[mode]} · ${venue.venueName}`}>
            <div className="space-y-3 p-3">
              <div
                className="rounded-md border p-2.5 text-xs"
                data-testid="venue-capability"
                data-status={check.ok ? "supported" : "unsupported"}
                data-level={disclosure.level}
              >
                <p className="flex items-center gap-1.5 font-semibold">
                  {check.ok ? <ShieldCheck className="size-3.5 text-buy" aria-hidden /> : <CircleAlert className="size-3.5 text-warning" aria-hidden />}
                  {check.ok ? `${venue.venueName} supports this mode` : `Unavailable on ${venue.venueName}`}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {check.ok ? (disclosure.capability.status === "supported" ? (disclosure.capability.note ?? disclosure.headline) : "") : check.error.message}
                </p>
              </div>

              {!check.ok ? (
                <p className="text-sm text-muted-foreground" data-testid="mode-unavailable">
                  Nova will not send this request: {venue.venueName} cannot honour it, and Nova never substitutes a public order for a private one.
                </p>
              ) : !market ? (
                <p className="text-sm text-muted-foreground">Loading markets…</p>
              ) : (
                <form onSubmit={submit} className="space-y-3" data-testid="private-order-form" aria-describedby={`${ids}-status`}>
                  <div className="space-y-1">
                    <Label htmlFor={`${ids}-market`}>Market</Label>
                    <select
                      id={`${ids}-market`}
                      className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                      value={market.id}
                      onChange={(e) => setMarketChoice(e.target.value)}
                      disabled={formDisabled}
                    >
                      {markets.map((m) => (
                        <option key={m.market.id} value={m.market.id}>
                          {m.market.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Side">
                    {(["buy", "sell"] as const).map((s) => (
                      <Button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={side === s}
                        variant="outline"
                        disabled={formDisabled}
                        onClick={() => setSide(s)}
                        data-testid={`private-side-${s}`}
                        className={cn(side === s && (s === "buy" ? "border-buy bg-buy/15 text-buy" : "border-sell bg-sell/15 text-sell"))}
                      >
                        {s === "buy" ? "Buy" : "Sell"}
                      </Button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`${ids}-size`}>Size ({market.base})</Label>
                      <Input id={`${ids}-size`} inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} disabled={formDisabled} data-testid="private-size" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${ids}-price`}>Limit price</Label>
                      <Input id={`${ids}-price`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={formDisabled} data-testid="private-price" />
                    </div>
                  </div>
                  {mode === "rfq" && (
                    <p className="text-2xs text-muted-foreground">
                      Your limit price stays in this browser; it is used only to decide which quotes you may accept. Nova&apos;s server
                      receives the public mid you see, which the simulated auto-quoting desks price around:{" "}
                      <span className="tabular text-foreground" data-testid="rfq-reference">
                        {mid === null ? "—" : formatPrice(mid, market.priceDecimals)}
                      </span>
                    </p>
                  )}
                  {mode === "iceberg" && (
                    <div className="space-y-1">
                      <Label htmlFor={`${ids}-display`}>Displayed quantity ({market.base})</Label>
                      <Input
                        id={`${ids}-display`}
                        inputMode="decimal"
                        value={displaySize}
                        onChange={(e) => setDisplaySize(e.target.value)}
                        disabled={formDisabled}
                        data-testid="private-display-size"
                      />
                      <p className="text-2xs text-muted-foreground">Shown publicly at your price and refilled after each slice fills.</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor={`${ids}-lev`}>Leverage (isolated)</Label>
                      <Input
                        id={`${ids}-lev`}
                        inputMode="numeric"
                        value={position ? String(position.leverage) : leverageInput}
                        onChange={(e) => setLeverage(e.target.value)}
                        disabled={formDisabled || position !== null}
                        aria-describedby={position ? `${ids}-lev-hint` : undefined}
                      />
                      {position && (
                        <p id={`${ids}-lev-hint`} className="text-2xs text-muted-foreground">
                          Locked to the open position.
                        </p>
                      )}
                    </div>
                    {mode !== "rfq" && (
                      <label className="flex items-end gap-2 pb-2 text-xs">
                        <Checkbox checked={postOnly} onCheckedChange={(v) => setPostOnly(v === true)} disabled={formDisabled} /> Post-only
                      </label>
                    )}
                  </div>

                  {mode === "rfq" && (
                    <fieldset className="space-y-1.5" disabled={formDisabled}>
                      <legend className="text-sm font-medium">Counterparties</legend>
                      {counterpartyError && <p className="text-xs text-sell">{counterpartyError}</p>}
                      {counterparties === null && !counterpartyError && <p className="text-xs text-muted-foreground">Loading counterparties…</p>}
                      {counterparties?.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={chosen.includes(c.id)}
                            onCheckedChange={(v) => setChosen((prev) => (v === true ? [...prev, c.id] : prev.filter((id) => id !== c.id)))}
                            data-testid={`counterparty-${c.id}`}
                          />
                          {c.name}
                        </label>
                      ))}
                      <label className="flex items-center gap-2 pt-1 text-xs">
                        <Checkbox checked={revealSide} onCheckedChange={(v) => setRevealSide(v === true)} data-testid="reveal-side" />
                        Reveal my side to the selected counterparties
                      </label>
                    </fieldset>
                  )}

                  {riskPreview && (
                    <div className="rounded-md border p-2.5 text-xs" data-testid="private-risk" data-decision={riskPreview.decision}>
                      <p className="mb-1 font-semibold">Pre-trade risk</p>
                      <dl className="grid grid-cols-2 gap-y-0.5">
                        <dt className="text-muted-foreground">Order notional</dt>
                        <dd className="text-right">
                          <RiskValueText value={riskPreview.notional} />
                        </dd>
                        <dt className="text-muted-foreground">Initial margin</dt>
                        <dd className="text-right">
                          <RiskValueText value={riskPreview.initialMargin} />
                        </dd>
                        <dt className="text-muted-foreground">Est. liquidation</dt>
                        <dd className="text-right">
                          <RiskValueText value={riskPreview.liquidationPrice} priceDecimals={market.priceDecimals} />
                        </dd>
                      </dl>
                      {failedChecks(riskPreview).map((c) => (
                        <p key={c.limit} className={cn("mt-1", c.action === "block" ? "text-sell" : "text-warning")}>
                          {c.action === "block" ? "Blocked: " : "Warning: "}
                          {c.message}
                        </p>
                      ))}
                    </div>
                  )}

                  <label className="flex items-start gap-2 rounded-md border border-private/40 bg-private/5 p-2.5 text-xs" data-testid="privacy-confirm-label">
                    <Checkbox
                      checked={confirmed}
                      onCheckedChange={(v) => setConfirmed(v === true)}
                      disabled={formDisabled}
                      data-testid="privacy-confirm"
                      className="mt-0.5"
                    />
                    <span>
                      I have read who can see my {MODE_LABEL[mode]} on {venue.venueName} ({LEVEL_LABEL[disclosure.level].toLowerCase()}).
                    </span>
                  </label>

                  <Button type="submit" className="w-full bg-private font-semibold text-black hover:bg-private/90" disabled={formDisabled || busy || !confirmed || riskBlocked} data-testid="private-submit">
                    {mode === "rfq" ? "Request quotes" : `Place ${MODE_LABEL[mode].toLowerCase()}`}
                  </Button>
                </form>
              )}

              <div id={`${ids}-status`} role="status" aria-live="polite" data-testid="execution-status" data-kind={status.kind}>
                {status.kind !== "idle" && (
                  <p className={cn("rounded-md p-2 text-xs", status.kind === "error" ? "bg-sell/10 text-sell" : status.kind === "success" ? "bg-buy/10 text-buy" : "text-muted-foreground")}>
                    {status.message}
                  </p>
                )}
              </div>

              {mode === "rfq" && rfq && market && <RfqQuotes rfq={rfq} market={market} side={side} limit={limit} busy={busy} onAccept={acceptQuote} onCancel={() => privateVenue?.rfq.cancel(rfq.id).then(setRfq, (e: unknown) => setStatus({ kind: "error", message: errorMessage(e) }))} />}
            </div>
          </Panel>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="Privacy disclosure">
              <div className="space-y-3 p-3" data-testid="privacy-disclosure" data-level={disclosure.level}>
                <p className="text-sm font-semibold" data-testid="disclosure-headline">
                  {disclosure.headline}
                </p>
                {disclosure.profile ? (
                  <PrivacyMatrix disclosure={disclosure} />
                ) : (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {disclosure.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
                {mode === "rfq" && disclosure.profile && market && <CounterpartyPreview marketId={market.id} size={Number(size)} side={revealSide ? side : null} />}
                {mode === "iceberg" && disclosure.profile && (
                  <p className="text-xs text-warning">An iceberg is an execution algorithm, not anonymity: the displayed slice and every fill are public.</p>
                )}
              </div>
            </Panel>

            <Panel title="Private orders and fills">
              <PrivateHistory markets={markets} />
            </Panel>
          </div>
        </div>

        <div>
          <Button asChild variant="outline">
            <Link href="/">Back to trading</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}

/** Exactly what each selected counterparty receives, from the same redaction the server applies. */
function CounterpartyPreview({ marketId, size, side }: { marketId: MarketId; size: number; side: Side | null }) {
  const view = counterpartyView(
    { id: "one-time-request-id", marketId, size: size > 0 ? size : 1, side, status: "open", createdAt: 0, expiresAt: 0, quotes: [], execution: null },
    "preview",
  );
  return (
    <div className="rounded-md border p-2.5 text-xs" data-testid="counterparty-preview">
      <p className="font-medium">What each selected counterparty receives</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <dt>Request id</dt>
        <dd>a one-time random id</dd>
        <dt>Market</dt>
        <dd>{view.marketId}</dd>
        <dt>Size</dt>
        <dd>{size > 0 ? view.size : "your size"}</dd>
        <dt>Your side</dt>
        <dd data-testid="preview-side">{view.requesterSide ?? "not revealed (two-way quote)"}</dd>
        <dt>Your limit price</dt>
        <dd>never sent</dd>
        <dt>Your identity</dt>
        <dd>never sent</dd>
        <dt>Other quotes</dt>
        <dd>never shown</dd>
      </dl>
    </div>
  );
}

function RfqQuotes({
  rfq,
  market,
  side,
  limit,
  busy,
  onAccept,
  onCancel,
}: {
  rfq: RfqRequesterView;
  market: Market;
  side: Side;
  limit: number;
  busy: boolean;
  onAccept: (quoteId: string, price: number) => void;
  onCancel: () => void;
}) {
  const now = useNow(1_000);
  return (
    <div className="space-y-2 rounded-md border p-2.5" data-testid="rfq-panel" data-status={rfq.status} data-rfq-id={rfq.id}>
      <p className="flex items-center justify-between text-xs font-medium">
        <span>
          Request <span className="capitalize">{rfq.status}</span>
        </span>
        {rfq.status === "open" && <span className="tabular text-muted-foreground">expires {formatRelativeTime(rfq.expiresAt, now)}</span>}
      </p>
      {rfq.quotes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Waiting for quotes…</p>
      ) : (
        <ul className="space-y-1.5">
          {rfq.quotes.map((q) => {
            const quotePrice = side === "buy" ? q.ask : q.bid;
            const withinLimit = quotePrice !== null && limit > 0 && (side === "buy" ? quotePrice <= limit : quotePrice >= limit);
            return (
              <li key={q.id} className="flex items-center justify-between gap-2 text-xs" data-testid="rfq-quote">
                <span>
                  <span className="font-medium">{q.counterpartyName}</span>
                  <span className="ml-2 tabular text-muted-foreground">
                    {formatPrice(q.bid, market.priceDecimals)} / {formatPrice(q.ask, market.priceDecimals)}
                  </span>
                </span>
                {rfq.status === "open" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !withinLimit}
                    onClick={() => quotePrice !== null && onAccept(q.id, quotePrice)}
                    data-testid="rfq-accept"
                    title={withinLimit ? undefined : "Outside your limit price"}
                  >
                    {side === "buy" ? "Buy" : "Sell"} @ {formatPrice(quotePrice, market.priceDecimals)}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rfq.status === "open" && (
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="rfq-cancel">
          Cancel request
        </Button>
      )}
      {rfq.execution && (
        <p className="text-xs text-buy" data-testid="rfq-execution">
          Traded with {rfq.execution.counterpartyName}: {rfq.execution.side} {rfq.execution.size} @ {formatPrice(rfq.execution.price, market.priceDecimals)}
        </p>
      )}
    </div>
  );
}
