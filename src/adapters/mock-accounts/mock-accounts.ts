import type { AccountHistoryGateway, AccountLoad, AccountRecord } from "@/core/analytics";
import { buildMockHistory, type MockAccountScript } from "./mock-ledger";

/**
 * Fictitious accounts for the AI analyst demo and tests. They are not
 * connected to any venue, the paper simulator or real money.
 */
export const MOCK_ACCOUNT_SCRIPTS: readonly MockAccountScript[] = [
  {
    account: { id: "mock-acct-a1", label: "Mock account A1 (fictitious)", currency: "MOCKUSD", origin: "mock" },
    leverage: 5,
    events: [
      { kind: "transfer", hoursAgo: 96, amount: 20_000 },
      { kind: "fill", hoursAgo: 80, marketId: "ALPHA-PERP", side: "buy", size: 3, liquidity: "taker" },
      { kind: "fill", hoursAgo: 52, marketId: "BETA-PERP", side: "buy", size: 120, liquidity: "maker" },
      { kind: "fill", hoursAgo: 30, marketId: "ALPHA-PERP", side: "sell", size: 1, liquidity: "taker" },
      { kind: "fill", hoursAgo: 20, marketId: "GAMMA-PERP", side: "sell", size: 8_000, liquidity: "taker" },
      { kind: "fill", hoursAgo: 9.5, marketId: "ALPHA-PERP", side: "buy", size: 1.5, liquidity: "maker" },
      { kind: "fill", hoursAgo: 6.25, marketId: "BETA-PERP", side: "sell", size: 40, liquidity: "taker" },
      { kind: "transfer", hoursAgo: 4, amount: 2_500 },
      { kind: "fill", hoursAgo: 2.5, marketId: "GAMMA-PERP", side: "buy", size: 3_000, liquidity: "taker" },
      { kind: "fill", hoursAgo: 0.75, marketId: "ALPHA-PERP", side: "sell", size: 0.5, liquidity: "taker" },
    ],
  },
  {
    account: { id: "mock-acct-b1", label: "Mock account B1 (fictitious)", currency: "MOCKUSD", origin: "mock" },
    leverage: 3,
    events: [
      { kind: "transfer", hoursAgo: 120, amount: 50_000 },
      { kind: "fill", hoursAgo: 100, marketId: "BETA-PERP", side: "sell", size: 500, liquidity: "taker" },
      { kind: "fill", hoursAgo: 40, marketId: "ALPHA-PERP", side: "buy", size: 10, liquidity: "maker" },
      { kind: "transfer", hoursAgo: 12, amount: -5_000 },
      { kind: "fill", hoursAgo: 3, marketId: "BETA-PERP", side: "buy", size: 200, liquidity: "taker" },
    ],
  },
];

/** An account whose data source is down — used to show how unavailable data is reported. */
export const MOCK_OFFLINE_ACCOUNT: AccountRecord = { id: "mock-acct-b2", label: "Mock account B2 (data source offline)", currency: "MOCKUSD", origin: "mock" };

export interface MockUser {
  id: string;
  name: string;
  accountIds: readonly string[];
}

/** Mock identities for the demo sign-in. No passwords, wallets or personal data. */
export const MOCK_USERS: readonly MockUser[] = [
  { id: "demo-trader", name: "Demo trader (mock)", accountIds: ["mock-acct-a1"] },
  { id: "demo-hedger", name: "Demo hedger (mock)", accountIds: ["mock-acct-b1", "mock-acct-b2"] },
];

export const MOCK_ACCOUNTS: readonly AccountRecord[] = [...MOCK_ACCOUNT_SCRIPTS.map((s) => s.account), MOCK_OFFLINE_ACCOUNT];

/** Mock history gateway. `anchor` fixes event times for the process lifetime (deterministic in tests). */
export class MockAccountGateway implements AccountHistoryGateway {
  private readonly cache = new Map<string, ReturnType<typeof buildMockHistory>>();

  constructor(private readonly anchor: number) {}

  async load(accountId: string, now: number): Promise<AccountLoad> {
    if (accountId === MOCK_OFFLINE_ACCOUNT.id) {
      return { ok: false, reason: "The data source for this account is unavailable (simulated outage). No figures can be given for it." };
    }
    const script = MOCK_ACCOUNT_SCRIPTS.find((s) => s.account.id === accountId);
    if (!script) return { ok: false, reason: "Unknown account" };
    let history = this.cache.get(accountId);
    if (!history) {
      history = buildMockHistory(script, this.anchor);
      this.cache.set(accountId, history);
    }
    if (now > this.anchor + 7 * 24 * 3_600_000) return { ok: false, reason: "Mock account records end 7 days after the server started" };
    // Never expose records later than the caller's "now".
    return { ok: true, history: { ...history, funding: history.funding.filter((p) => p.time <= now), fills: history.fills.filter((f) => f.time <= now), transfers: history.transfers.filter((t) => t.time <= now) } };
  }
}
