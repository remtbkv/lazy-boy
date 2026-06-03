"use server";

import { getSpotify } from "@/lib/session";
import { getAllTimeStats, getDailyStats, getLastSync } from "@/lib/db";
import { syncRecentPlays } from "@/lib/sync/history";

// Manual "Sync recent plays": pulls the latest plays for the signed-in user into
// the local store and returns refreshed day stats. The same core also runs on a
// background schedule (see src/lib/sync/scheduler.ts).
export async function syncHistoryAction() {
  try {
    const sp = await getSpotify();
    const { added } = await syncRecentPlays(sp);
    return {
      ok: true as const,
      added,
      daily: getDailyStats(),
      lastSync: getLastSync(),
      allTime: getAllTimeStats(),
    };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "Sync failed" };
  }
}
