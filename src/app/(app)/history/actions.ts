"use server";

import { getSpotify } from "@/lib/session";
import { getAllTimeStats, getDailyStats, getLastSync } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// Manual "Sync recent plays": pulls the latest plays for the signed-in user into
// the store and returns refreshed day stats. The same core also runs on app load
// (/api/sync) and via a daily Vercel Cron backstop (/api/cron/sync).
export async function syncHistoryAction() {
  try {
    const sp = await getSpotify();
    const { added } = await syncRecentPlays(sp);
    const [daily, lastSync, allTime] = await Promise.all([
      getDailyStats(),
      getLastSync(),
      getAllTimeStats(),
    ]);
    return { ok: true as const, added, daily, lastSync, allTime };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Sync failed" };
  }
}
