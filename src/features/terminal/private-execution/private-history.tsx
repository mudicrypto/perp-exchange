"use client";

import { OrderStatusLabel, SideLabel } from "@/components/trading/values";
import type { MarketSummary, Order } from "@/core/domain";
import { formatDateTime, formatPrice, formatSize } from "@/lib/format";
import { useTerminal } from "../terminal-context";
import { ORDER_TYPE_LABEL } from "../components/order-labels";

const PRIVATE_TYPES = new Set<Order["type"]>(["hidden", "iceberg", "rfq"]);

/**
 * Private orders and their fills from the active account. Only the user's
 * own browser holds this list: the simulated paper account never leaves it.
 */
export function PrivateHistory({ markets }: { markets: readonly MarketSummary[] }) {
  const { accountState, privateVenue, execution } = useTerminal();
  if (!accountState) {
    return <p className="p-4 text-sm text-muted-foreground">No account connected. Private order history appears here for accounts Nova can read.</p>;
  }
  const byId = new Map<string, Order>();
  for (const o of [...(accountState.orderHistory ?? []), ...accountState.openOrders]) if (PRIVATE_TYPES.has(o.type)) byId.set(o.id, o);
  const orders = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const fills = (accountState.fills ?? []).filter((f) => f.orderId !== null && byId.has(f.orderId)).sort((a, b) => b.time - a.time);
  const decimalsOf = (marketId: string) => markets.find((m) => m.market.id === marketId)?.market;

  if (orders.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground" data-testid="private-history-empty">
        No private orders yet.
      </p>
    );
  }
  return (
    <div className="space-y-4 p-3" data-testid="private-history">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <caption className="mb-1 text-left text-xs font-medium">Orders</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">Time</th>
              <th className="font-medium">Market</th>
              <th className="font-medium">Mode</th>
              <th className="font-medium">Side</th>
              <th className="text-right font-medium">Size</th>
              <th className="text-right font-medium">Filled</th>
              <th className="text-right font-medium">Price</th>
              <th className="pl-3 font-medium">Shown publicly</th>
              <th className="font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const market = decimalsOf(o.marketId);
              const iceberg = o.type === "iceberg" ? privateVenue?.icebergState(o.id) : null;
              const open = o.status === "open" || o.status === "partially-filled";
              const shown =
                o.type === "hidden"
                  ? "Nothing (hidden)"
                  : o.type === "rfq"
                    ? "Not in book (RFQ)"
                    : iceberg
                      ? `${open ? formatSize(iceberg.displayed, market?.sizeDecimals ?? 4) : "—"} · ${iceberg.refills} refill${iceberg.refills === 1 ? "" : "s"}`
                      : "—";
              return (
                <tr key={o.id} className="border-b last:border-0" data-testid="private-order-row" data-type={o.type} data-status={o.status}>
                  <td className="py-1.5 tabular whitespace-nowrap">{formatDateTime(o.createdAt)}</td>
                  <td>{o.marketId}</td>
                  <td>{ORDER_TYPE_LABEL[o.type]}</td>
                  <td>
                    <SideLabel side={o.side} />
                  </td>
                  <td className="text-right tabular">{formatSize(o.size, market?.sizeDecimals ?? 4)}</td>
                  <td className="text-right tabular">{formatSize(o.filledSize, market?.sizeDecimals ?? 4)}</td>
                  <td className="text-right tabular">{formatPrice(o.averageFillPrice ?? o.price, market?.priceDecimals ?? 2)}</td>
                  <td className="pl-3" data-testid="private-order-shown">
                    {shown}
                  </td>
                  <td>
                    <OrderStatusLabel status={o.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-xs" data-testid="private-fills">
          <caption className="mb-1 text-left text-xs font-medium">Fills ({execution.origin === "simulated" ? "simulated" : "venue"})</caption>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 font-medium">Time</th>
              <th className="font-medium">Market</th>
              <th className="font-medium">Side</th>
              <th className="text-right font-medium">Price</th>
              <th className="text-right font-medium">Size</th>
              <th className="pl-3 font-medium">Liquidity</th>
            </tr>
          </thead>
          <tbody>
            {fills.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-2 text-muted-foreground">
                  No fills yet.
                </td>
              </tr>
            ) : (
              fills.map((f) => {
                const market = decimalsOf(f.marketId);
                return (
                  <tr key={f.id} className="border-b last:border-0" data-testid="private-fill-row" data-liquidity={f.liquidity}>
                    <td className="py-1.5 tabular whitespace-nowrap">{formatDateTime(f.time)}</td>
                    <td>{f.marketId}</td>
                    <td>
                      <SideLabel side={f.side} />
                    </td>
                    <td className="text-right tabular">{formatPrice(f.price, market?.priceDecimals ?? 2)}</td>
                    <td className="text-right tabular">{formatSize(f.size, market?.sizeDecimals ?? 4)}</td>
                    <td className="pl-3 capitalize">{f.liquidity}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
