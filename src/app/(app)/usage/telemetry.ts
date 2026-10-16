import {
  getClientLoadSpeed,
  getRecentlyPlayedQuotaWindows,
  getSpotifyCallBreakdown,
  readLedger,
  type ClientLoadSpeed,
  type LedgerRow,
  type QuotaWindow,
  type SpotifyCallSource,
} from "@/lib/db";

// The /usage reads that go to the telemetry store (docs/STORE_MIGRATION.md §6.6). Settled one
// by one: a frozen Zenbook costs this page its log sections after the telemetry fetch's 4 s,
// and the core half still renders. A section that failed comes back empty and flagged in
// `down`, so the page can say "unavailable" instead of "nothing recorded".
export type UsageTelemetry = {
  ledger: LedgerRow[];
  client: ClientLoadSpeed;
  spotifyCalls: SpotifyCallSource[];
  quotaWindows: QuotaWindow[];
  down: { ledger: boolean; client: boolean; spotifyCalls: boolean; quotaWindows: boolean };
};

export async function loadUsageTelemetry(days: number): Promise<UsageTelemetry> {
  const [ledger, client, spotifyCalls, quotaWindows] = await Promise.allSettled([
    readLedger(days),
    getClientLoadSpeed(),
    getSpotifyCallBreakdown(24),
    getRecentlyPlayedQuotaWindows(),
  ]);
  return {
    ledger: ledger.status === "fulfilled" ? ledger.value : [],
    client: client.status === "fulfilled" ? client.value : { pages: [], opens: [], errors: [] },
    spotifyCalls: spotifyCalls.status === "fulfilled" ? spotifyCalls.value : [],
    quotaWindows: quotaWindows.status === "fulfilled" ? quotaWindows.value : [],
    down: {
      ledger: ledger.status === "rejected",
      client: client.status === "rejected",
      spotifyCalls: spotifyCalls.status === "rejected",
      quotaWindows: quotaWindows.status === "rejected",
    },
  };
}
