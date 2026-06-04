"use server";

import { getSpotify } from "@/lib/session";
import { getAllTimeStats, getDailyStats, getLastSync } from "@/lib/db";
import { tzOffsetMinutes } from "@/lib/tz";
import { syncRecentPlays } from "@/lib/sync/history";

// Used by the history page's auto-refresh (every minute while the tab is open, no
// button): pulls the latest plays for the signed-in user into the store and returns
// refreshed day stats so the view updates in place. The same core also runs on app
// load + every 2 min via /api/sync, and on a schedule via /api/cron/sync.
export async function syncHistoryAction() {
  try {
    const sp = await getSpotify();
    const { added } = await syncRecentPlays(sp);
    const tz = await tzOffsetMinutes();
    const [daily, lastSync, allTime] = await Promise.all([
      getDailyStats(tz),
      getLastSync(),
      getAllTimeStats(),
    ]);
    return { ok: true as const, added, daily, lastSync, allTime };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Sync failed" };
  }
}
