import type { DecimalString } from "./decimal";
import type { Unit } from "./units";

/**
 * How a figure was obtained.
 * - calculated:     derived exactly from the listed inputs by the stated method
 * - estimate:       derived under stated assumptions that may not hold (e.g. a constant funding rate)
 * - venue-reported: taken from the venue as reported; Nova did not compute it
 */
export type RiskValueKind = "calculated" | "estimate" | "venue-reported";

/** One input to a calculation, shown to the user with its source and age. */
export interface RiskInput {
  name: string;
  value: DecimalString | string;
  unit: Unit | null;
  source: string;
  /** When the input was observed (ms since epoch); null for configuration and constants. */
  observedAt: number | null;
}

export interface AvailableValue {
  status: "available";
  value: DecimalString;
  unit: Unit;
  kind: RiskValueKind;
  /** Formula or rule, in words. */
  method: string;
  inputs: RiskInput[];
  assumptions: string[];
  /** The calculation time (`now` passed to the engine). */
  asOf: number;
}

export interface UnavailableValue {
  status: "unavailable";
  unit: Unit;
  reason: string;
  /** Names of the inputs that were missing or stale. */
  missing: string[];
  asOf: number;
}

/** Every risk figure is either available with its provenance, or unavailable with a reason. Never a guess. */
export type RiskValue = AvailableValue | UnavailableValue;

export function available(fields: Omit<AvailableValue, "status">): AvailableValue {
  return { status: "available", ...fields };
}

export function unavailable(unit: Unit, reason: string, missing: string[], asOf: number): UnavailableValue {
  return { status: "unavailable", unit, reason, missing, asOf };
}

export const isAvailable = (v: RiskValue): v is AvailableValue => v.status === "available";
