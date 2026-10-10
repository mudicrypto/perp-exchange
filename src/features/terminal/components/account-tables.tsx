"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/trading/panel";
import { OrderStatusLabel, SideLabel, SignedAmount, SignedPercent } from "@/components/trading/values";
import type { Fill, Market, MarketId, Order, Position } from "@/core/domain";
import type { Result } from "@/core/domain";
import type { AccountState } from "@/core/ports";
import { ORDER_TYPE_LABEL } from "./order-labels";
import { displayPriceDecimals, formatAmount, formatDateTime, formatPrice, formatSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { newClientOrderId } from "../client-order-id";
import { useTerminal } from "../terminal-context";

const NO_ACCOUNT =
  "No account is connected. Watch-only account monitoring arrives in the next milestone. Nova will never ask for your seed phrase or private key.";

type MarketLookup = (id: MarketId) => Market | undefined;

function useMarketLookup(): MarketLookup {
  const { markets } = useTerminal();
  const byId = useMemo(() => new Map(markets.map((m) => [m.market.id, m.market])), [markets]);
  return (id) => byId.get(id);
}

function px(market: Market | undefined, value: number | null) {
  return formatPrice(value, displayPriceDecimals(value, market?.priceDecimals ?? 4));
}

function sz(market: Market | undefined, value: number) {
  return formatSize(value, market?.sizeDecimals ?? 4);
}

function H({ children, right }: { children: ReactNode; right?: boolean }) {
  return <TableHead className={cn("h-7 text-2xs font-normal text-muted-foreground uppercase", right && "text-right")}>{children}</TableHead>;
}

function C({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return <TableCell className={cn("tabular py-1.5 text-xs", right && "text-right", className)}>{children}</TableCell>;
}

export function AccountTables({ compact = false }: { compact?: boolean }) {
  const { account, accountState } = useTerminal();
  const noAccount = account.connection.status === "disconnected";
  const counts = accountState
    ? {
        positions: accountState.snapshot.positions.length,
        orders: accountState.openOrders.length,
      }
    : null;

  const body = (content: (state: AccountState) => ReactNode, title: string) => {
    if (noAccount) return <EmptyState title={title}>{NO_ACCOUNT}</EmptyState>;
    if (!accountState)
      return (
        <div className="space-y-2 p-3" aria-busy="true">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      );
    return content(accountState);
  };

  return (
    <Tabs defaultValue="positions" className="flex h-full min-h-0 flex-col gap-0" data-testid="account-tables">
      <div className="flex items-center border-b px-2 py-1">
        <TabsList className="h-8">
          <TabsTrigger value="positions" className="text-xs" data-testid="tab-positions">
            Positions{counts ? ` (${counts.positions})` : ""}
          </TabsTrigger>
          <TabsTrigger value="orders" className="text-xs" data-testid="tab-orders">
            Open orders{counts ? ` (${counts.orders})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history" className="text-xs" data-testid="tab-history">Order history</TabsTrigger>
          <TabsTrigger value="fills" className="text-xs" data-testid="tab-fills">Fills</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="positions" className="min-h-0 flex-1 overflow-auto">
        {body((s) => <PositionsTable positions={s.snapshot.positions} compact={compact} />, "No positions to show")}
      </TabsContent>
      <TabsContent value="orders" className="min-h-0 flex-1 overflow-auto">
        {body((s) => <OpenOrdersTable orders={s.openOrders} />, "No open orders")}
      </TabsContent>
      <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
        {body(
          (s) => (s.orderHistory ? <OrderHistoryTable orders={s.orderHistory} /> : <NotProvided what="Order history" />),
          "No order history",
        )}
      </TabsContent>
      <TabsContent value="fills" className="min-h-0 flex-1 overflow-auto">
        {body((s) => (s.fills ? <FillsTable fills={s.fills} /> : <NotProvided what="Fills" />), "No fills")}
      </TabsContent>
    </Tabs>
  );
}

/** Shown when the source does not provide a dataset (null), as opposed to an empty one. */
function NotProvided({ what }: { what: string }) {
  return <EmptyState title={`${what} not available`}>This account source does not provide {what.toLowerCase()} yet.</EmptyState>;
}

function ActionResult({ result }: { result: Result<unknown> | null }) {
  if (!result || result.ok) return null;
  return (
    <p role="alert" className="px-3 py-1 text-xs text-sell" data-testid="action-error">
      {result.error.message}
    </p>
  );
}

export function PositionsTable({ positions, compact = false }: { positions: readonly Position[]; compact?: boolean }) {
  const { execution, capabilities } = useTerminal();
  const lookup = useMarketLookup();
  const [result, setResult] = useState<Result<unknown> | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const canClose = capabilities.capabilities["action.submit"].status === "supported" && capabilities.capabilities["order.market"].status === "supported";
  if (positions.length === 0) return <EmptyState title="No open positions">Positions you open appear here.</EmptyState>;

  const close = async (p: Position) => {
    const market = lookup(p.marketId);
    if (!market) return;
    setPending(p.marketId);
    setResult(
      await execution.submitOrder(
        {
          clientOrderId: newClientOrderId("nova-close"),
          marketId: p.marketId,
          side: p.size > 0 ? "sell" : "buy",
          type: "market",
          size: Math.abs(p.size),
          maxSlippage: 0.05,
          reduceOnly: true,
          leverage: p.leverage,
          marginMode: p.marginMode,
        },
        execution.describeInstrument(market),
      ),
    );
    setPending(null);
  };

  return (
    <>
      <ActionResult result={result} />
      <Table data-testid="positions-table">
        <TableHeader>
          <TableRow>
            <H>Market</H>
            <H right>Size</H>
            <H right>Entry</H>
            <H right>Mark</H>
            <H right>Liq. price</H>
            <H right>Margin</H>
            <H right>uPnL (ROE)</H>
            {!compact && canClose && <H right>Action</H>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {positions.map((p) => {
            const m = lookup(p.marketId);
            const roe = p.marginUsed > 0 ? p.unrealizedPnl / p.marginUsed : null;
            return (
              <TableRow key={p.marketId} data-testid={`position-${p.marketId}`}>
                <C>
                  <span className="font-medium">{p.marketId}</span>{" "}
                  <span className="text-2xs text-muted-foreground">{p.leverage}x</span>
                </C>
                <C right>
                  <SideLabel side={p.size > 0 ? "buy" : "sell"} position /> {sz(m, Math.abs(p.size))}
                </C>
                <C right>{px(m, p.entryPrice)}</C>
                <C right>{px(m, p.markPrice)}</C>
                <C right className="text-warning">{px(m, p.liquidationPrice)}</C>
                <C right>{formatAmount(p.marginUsed)}</C>
                <C right>
                  <SignedAmount value={p.unrealizedPnl} /> <SignedPercent className="text-2xs" value={roe} />
                </C>
                {!compact && canClose && (
                  <C right>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-2xs"
                      disabled={pending === p.marketId}
                      onClick={() => close(p)}
                      aria-label={`Market close ${p.marketId} position`}
                      data-testid={`close-${p.marketId}`}
                    >
                      Close
                    </Button>
                  </C>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function OpenOrdersTable({ orders }: { orders: readonly Order[] }) {
  const { execution, capabilities } = useTerminal();
  const lookup = useMarketLookup();
  const [result, setResult] = useState<Result<unknown> | null>(null);
  const canCancel = capabilities.capabilities["action.cancel"].status === "supported";
  const canCancelAll = capabilities.capabilities["action.cancel-all"].status === "supported";
  if (orders.length === 0) return <EmptyState title="No open orders">Resting limit orders appear here.</EmptyState>;
  return (
    <>
      <div className="flex items-center justify-between px-3 py-1">
        <ActionResult result={result} />
        {canCancelAll && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 text-2xs text-sell"
            onClick={async () => setResult(await execution.cancelAllOrders())}
            data-testid="cancel-all"
          >
            Cancel all
          </Button>
        )}
      </div>
      <Table data-testid="open-orders-table">
        <TableHeader>
          <TableRow>
            <H>Time</H>
            <H>Market</H>
            <H>Side</H>
            <H>Type</H>
            <H right>Price</H>
            <H right>Trigger</H>
            <H right>Size</H>
            <H right>Filled</H>
            <H>Status</H>
            {canCancel && <H right>Action</H>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((o) => {
            const m = lookup(o.marketId);
            return (
              <TableRow key={o.id} data-testid="open-order-row">
                <C className="text-muted-foreground">{formatDateTime(o.createdAt)}</C>
                <C className="font-medium">{o.marketId}</C>
                <C><SideLabel side={o.side} /></C>
                <C>
                  {ORDER_TYPE_LABEL[o.type]}
                  {o.timeInForce && ` · ${o.timeInForce.toUpperCase()}`}
                  {o.reduceOnly && <span className="ml-1 text-2xs text-muted-foreground">RO</span>}
                </C>
                <C right>{o.price === null ? "Market" : px(m, o.price)}</C>
                <C right>{o.triggerPrice === null ? "—" : px(m, o.triggerPrice)}</C>
                <C right>{sz(m, o.size)}</C>
                <C right>{sz(m, o.filledSize)}</C>
                <C>
                  <OrderStatusLabel status={o.status} />
                </C>
                {canCancel && (
                  <C right>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-2xs"
                      onClick={async () => setResult(await execution.cancelOrder({ orderId: o.id }))}
                      aria-label={`Cancel order ${o.id}`}
                      data-testid={`cancel-${o.id}`}
                    >
                      Cancel
                    </Button>
                  </C>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function OrderHistoryTable({ orders }: { orders: readonly Order[] }) {
  const lookup = useMarketLookup();
  if (orders.length === 0) return <EmptyState title="No order history">Filled, cancelled and rejected orders appear here.</EmptyState>;
  return (
    <Table data-testid="order-history-table">
      <TableHeader>
        <TableRow>
          <H>Time</H>
          <H>Market</H>
          <H>Side</H>
          <H>Type</H>
          <H right>Price</H>
          <H right>Size</H>
          <H right>Filled @ avg</H>
          <H>Status</H>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((o) => {
          const m = lookup(o.marketId);
          return (
            <TableRow key={o.id} data-testid="history-row">
              <C className="text-muted-foreground">{formatDateTime(o.updatedAt)}</C>
              <C className="font-medium">{o.marketId}</C>
              <C><SideLabel side={o.side} /></C>
              <C>{ORDER_TYPE_LABEL[o.type]}</C>
              <C right>{o.price === null ? "Market" : px(m, o.price)}</C>
              <C right>{sz(m, o.size)}</C>
              <C right>
                {o.filledSize > 0 ? `${sz(m, o.filledSize)} @ ${px(m, o.averageFillPrice)}` : "—"}
              </C>
              <C>
                <OrderStatusLabel status={o.status} />
                {o.statusReason && (
                  <span className="block max-w-72 truncate text-2xs text-muted-foreground" title={o.statusReason}>
                    {o.statusReason}
                  </span>
                )}
              </C>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function FillsTable({ fills }: { fills: readonly Fill[] }) {
  const lookup = useMarketLookup();
  if (fills.length === 0) return <EmptyState title="No fills">Executions appear here.</EmptyState>;
  return (
    <Table data-testid="fills-table">
      <TableHeader>
        <TableRow>
          <H>Time</H>
          <H>Market</H>
          <H>Side</H>
          <H right>Price</H>
          <H right>Size</H>
          <H right>Fee</H>
          <H>Liquidity</H>
          <H right>Realized PnL</H>
        </TableRow>
      </TableHeader>
      <TableBody>
        {fills.map((f) => {
          const m = lookup(f.marketId);
          return (
            <TableRow key={f.id} data-testid="fill-row">
              <C className="text-muted-foreground">{formatDateTime(f.time)}</C>
              <C className="font-medium">{f.marketId}</C>
              <C><SideLabel side={f.side} /></C>
              <C right>{px(m, f.price)}</C>
              <C right>{sz(m, f.size)}</C>
              <C right>{formatAmount(f.fee, { decimals: 4 })}</C>
              <C className={cn("capitalize", f.liquidity === "liquidation" && "text-sell")}>{f.liquidity}</C>
              <C right>{f.realizedPnl === 0 ? "—" : <SignedAmount value={f.realizedPnl} />}</C>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
