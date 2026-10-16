// What economy and freeze change on the app-wide paths (docs/multi-user/CAPACITY.md §6's table,
// its app-wide column). Pure: the server routes read it with the stored mode, and the client
// never sees a mode, only the numbers a reply carries. budget.ts decides the mode.

export type Mode = "normal" | "economy" | "freeze";
export const MODES: readonly Mode[] = ["normal", "economy", "freeze"];

export function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

const MIN = 60_000;

/** The floor /api/now-playing's reply sets under the poller's own cadence (0 = its own). */
export const NOW_PLAYING_MIN_POLL_MS: Record<Mode, number> = { normal: 0, economy: 30_000, freeze: 60_000 };

/** How often an open tab syncs (SyncOnLoad) and Home re-reads its history (the open-tab
 *  refresh): /api/sync's reply carries it. */
export const SYNC_INTERVAL_MS: Record<Mode, number> = { normal: 2 * MIN, economy: 5 * MIN, freeze: 5 * MIN };

/** Whether /api/sync harvests at all. In freeze it answers with the interval only, so the tab
 *  learns when the freeze ends; the cron tick still captures. */
export const SYNC_ON_LOAD: Record<Mode, boolean> = { normal: true, economy: true, freeze: false };

/** The cron tick's library rescan: at most this often; null = none. */
export const LIBRARY_RESCAN_MS: Record<Mode, number | null> = { normal: 30 * MIN, economy: 120 * MIN, freeze: null };

/** The all-time recompute's gate on a landed play, until P2 replaces the recompute. */
export const ALLTIME_GATE_MS: Record<Mode, number> = { normal: 10 * MIN, economy: 30 * MIN, freeze: 30 * MIN };
