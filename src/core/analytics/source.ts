import type { AccountSnapshot, Fill, Market, MarketId } from "../domain";
import type { FundingObservation, Observed, VenueMarginRules } from "../risk";
import type { FundingPayment, Transfer } from "./records";

export interface AccountRecord {
  id: string;
  label: string;
  currency: string;
  /** "mock": fictitious demo data. Real venues would be "venue". */
  origin: "mock" | "venue";
}

/** Everything the analyst may read about one account, as recorded by its data source. */
export interface AccountHistory {
  account: AccountRecord;
  rules: VenueMarginRules;
  markets: ReadonlyMap<MarketId, Market>;
  /** First time the account has records for; earlier periods are unavailable. */
  openedAt: number;
  /** Account state at `time` (null before `openedAt` or after the data's `asOf`). */
  snapshotAt(time: number): AccountSnapshot | null;
  /** Latest mark per market at `time`. */
  marks(time: number): ReadonlyMap<MarketId, Observed<number>>;
  fundingRates(time: number): ReadonlyMap<MarketId, Observed<FundingObservation>>;
  fills: readonly Fill[];
  funding: readonly FundingPayment[];
  transfers: readonly Transfer[];
  /** Source label shown with every figure. */
  source: string;
}

export type AccountLoad = { ok: true; history: AccountHistory } | { ok: false; reason: string };

/** Read-only access to account histories. Authorization happens before this is called. */
export interface AccountHistoryGateway {
  load(accountId: string, now: number): Promise<AccountLoad>;
}
