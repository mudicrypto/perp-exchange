import type { MarketId } from "../domain";
import { dec, ONE, OUTPUT_DECIMALS, roundDp, toPlain, ZERO, type Decimal, type DecimalInput } from "./decimal";
import type { PortfolioRiskReport } from "./portfolio";
import { amount, fraction } from "./units";
import { available, isAvailable, unavailable, type AvailableValue, type RiskInput, type RiskValue } from "./value";

export const DEFAULT_SCENARIO_MOVES: readonly string[] = ["-0.2", "-0.1", "-0.05", "0.05", "0.1", "0.2"];

export interface ScenarioPosition {
  marketId: MarketId;
  priceAfter: string;
  pnlChange: string;
  /** true/false when a liquidation estimate exists; null when it is unavailable (unknown, not "safe"). */
  reachesLiquidationEstimate: boolean | null;
}

export interface PriceMoveScenario {
  /** Uniform move applied to every mark, as a fraction (−0.1 = −10 %). */
  move: string;
  pnlChange: RiskValue;
  equityAfter: RiskValue;
  positions: ScenarioPosition[];
}

export const SCENARIO_ASSUMPTIONS = [
  "Hypothetical: every mark moves by the same fraction at once; real markets move unevenly and can gap.",
  "Linear PnL at the moved mark. Ignores fees, funding, slippage and liquidation penalties.",
  "Positions past their liquidation estimate are shown at the moved price; in reality the venue would have liquidated them, possibly at a worse price.",
];

const amt = (d: Decimal) => toPlain(roundDp(d, OUTPUT_DECIMALS.amount));

/**
 * Applies hypothetical uniform price moves to the report's positions.
 * Pure: no market data is fetched. Moves must be greater than −100 %.
 */
export function priceMoveScenarios(report: PortfolioRiskReport, moves: readonly DecimalInput[] = DEFAULT_SCENARIO_MOVES): PriceMoveScenario[] {
  const now = report.asOf;
  const unit = amount(report.currency ?? "quote");
  return moves.map((m) => {
    const move = dec(m);
    if (move.lte(ONE.neg())) throw new RangeError(`A price move must be greater than −100% (got ${toPlain(move)})`);
    const moveInput: RiskInput = { name: "Price move", value: toPlain(move), unit: fraction, source: "scenario", observedAt: null };
    const blocked = report.positions.find((p) => !isAvailable(p.markPrice));
    if (blocked && blocked.markPrice.status === "unavailable") {
      const u = unavailable(unit, `${blocked.marketId}: ${blocked.markPrice.reason}`, blocked.markPrice.missing, now);
      return { move: toPlain(move), pnlChange: u, equityAfter: u, positions: [] };
    }
    let change = ZERO;
    const inputs: RiskInput[] = [moveInput];
    const positions: ScenarioPosition[] = report.positions.map((p) => {
      const mark = dec((p.markPrice as AvailableValue).value);
      const size = dec((p.size as AvailableValue).value);
      const after = mark.mul(ONE.add(move));
      const pnl = size.mul(after.sub(mark));
      change = change.add(pnl);
      inputs.push(...(p.markPrice as AvailableValue).inputs, ...(p.size as AvailableValue).inputs);
      const liq = p.liquidationPrice;
      const reaches = isAvailable(liq) ? (size.gt(ZERO) ? after.lte(dec(liq.value)) : after.gte(dec(liq.value))) : null;
      return { marketId: p.marketId, priceAfter: toPlain(after), pnlChange: amt(pnl), reachesLiquidationEstimate: reaches };
    });
    const pnlChange = available({ value: amt(change), unit, kind: "estimate", method: "Σ size × mark × move", inputs, assumptions: SCENARIO_ASSUMPTIONS, asOf: now });
    const equity = report.margin.equity;
    const equityAfter = isAvailable(equity)
      ? available({ value: amt(dec(equity.value).add(change)), unit, kind: "estimate", method: "equity + scenario PnL change", inputs: [...equity.inputs, ...inputs], assumptions: SCENARIO_ASSUMPTIONS, asOf: now })
      : unavailable(unit, equity.reason, equity.missing, now);
    return { move: toPlain(move), pnlChange, equityAfter, positions };
  });
}
