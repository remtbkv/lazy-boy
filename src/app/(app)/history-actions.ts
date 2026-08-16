"use server";

import { unstable_rethrow } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSpotify } from "@/lib/session";
import { syncRecentPlays } from "@/lib/sync/history";
import {
  getAllTimePlays,
  getAllTimeStats,
  getCleanBackupPref,
  getDailyStats,
  getMeId,
  getPlaylistsSyncedAt,
  getPlaysByDay,
  getStoredPlaylists,
  ledgerSyncCall,
  searchHistory,
  type DayStats,
  type StoredPlaylist,
  type TrackStats,
} from "@/lib/db";
import { HISTORY_REFRESH_EXTRA_ROWS } from "@/lib/read-costs";
import { tzOffsetMinutes } from "@/lib/tz";

// Listen-history data actions for Home — DB reads only, except refreshHistoryAction (below),
// which is the one that talks to Spotify. Every one of them returns personal data, so each
// gates on a session: the layout already redirects anyone without one, but an action is a
// public endpoint and has to check for itself.
async function allowed(): Promise<boolean> {
  return !!(await auth());
}

export type DockData = {
  /** `mine` lets Subtract offer in-place removal only on playlists you own. */
  playlists: (StoredPlaylist & { mine: boolean })[];
  backupPref: boolean;
  syncedAt: string | null;
};

/** Everything the action dock's panels need. Deliberately NOT part of the page's server
 *  render: it's ~180 playlist rows that nothing on first paint needs (only a panel, once you
 *  open one), so blocking the first byte on it was pure waste. Fetched in the background
 *  right after mount instead. */
export async function dockDataAction(): Promise<DockData> {
  if (!(await allowed())) return { playlists: [], backupPref: false, syncedAt: null };
  const [playlists, meId, backupPref, syncedAt] = await Promise.all([
    getStoredPlaylists(),
    getMeId(),
    getCleanBackupPref(),
    getPlaylistsSyncedAt(),
  ]);
  return {
    playlists: playlists.map((p) => ({ ...p, mine: !!meId && p.ownerId === meId })),
    backupPref,
    syncedAt,
  };
}

/** Tracks for one local day — the client caches per day, so each day costs one call. */
export async function dayTracksAction(day: string): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const tz = await tzOffsetMinutes();
  return getPlaysByDay(day, tz);
}

/** Older day stats — the strip starts with the recent window and extends on demand. */
export async function dailyStatsAction(days: number): Promise<DayStats[]> {
  if (!(await allowed())) return [];
  const tz = await tzOffsetMinutes();
  return getDailyStats(tz, Math.min(days, 100000));
}

/** Most-played all-time — fetched on demand when the All time view is opened. */
export async function allTimePlaysAction(): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  return getAllTimePlays(300);
}

export type HistoryRefresh = {
  ok: boolean;
  added: number;
  daily: DayStats[];
  allTime: { plays: number; durationMs: number; since: string | null };
  /** The day the returned tracks belong to — resolved server-side, so a "latest" request
   *  lands on the correct day even when the local date has just rolled over. */
  day: string | null;
  tracks: TrackStats[] | null;
  /** The plays this sync just landed (newest first), so the client can patch its
   *  in-memory search index instantly — the server payload only rebuilds every 10 min
   *  (db.ts, the slow marker). An indexed read of `added` rows, bounded by the delta. */
  newPlays: TrackStats[] | null;
};

const NO_REFRESH: HistoryRefresh = {
  ok: false,
  added: 0,
  daily: [],
  allTime: { plays: 0, durationMs: 0, since: null },
  day: null,
  tracks: null,
  newPlays: null,
};

/** Pull new plays from Spotify into the local store, then re-read what's on screen.
 *
 *  This is the ONE action here that talks to Spotify — every other read is DB-only. Without
 *  it the page renders whatever was last written to the store and never notices a song
 *  finishing, which is exactly the bug it fixes.
 *
 *  `want` is the view the client is currently showing, so a single round-trip refreshes the
 *  strip, the all-time totals AND the visible rows:
 *    "latest"  — following the newest day (resolved AFTER the sync, so a midnight rollover
 *                moves you onto the new day instead of stranding you on yesterday)
 *    "all"     — the all-time list
 *    null      — a pinned past day (frozen history — the rows cannot change, so don't refetch
 *                them) or an active search
 *  `days` keeps the strip at whatever width it's been expanded to. */
export async function refreshHistoryAction(
  want: "latest" | "all" | null,
  days: number,
  // The newest play minute the client's in-memory search index already holds. The delta
  // returned in `newPlays` is computed against THIS, not against what this call inserted:
  // a play the cron tick synced seconds earlier is just as missing from the client's index
  // as one we insert here, and `added` alone would skip it.
  sinceMinute: number | null = null,
): Promise<HistoryRefresh> {
  // getSpotify() throws a login REDIRECT when there's no session. Returning empty instead
  // keeps a signed-out caller from being bounced mid-render — no session, nothing to sync.
  if (!(await allowed())) return NO_REFRESH;
  try {
    const sp = await getSpotify("home-sync");
    const { added } = await syncRecentPlays(sp);
    // This fires every 120 s from an open tab, twice per track change and on visibility, so
    // it is the term an open tab contributes. Only the sync plus this action's own bounded
    // head/delta check are charged here — the strip, the day and the all-time list below are
    // ledgered under their own readers, and counting them twice would hide a real residual.
    void ledgerSyncCall("history_refresh", added, HISTORY_REFRESH_EXTRA_ROWS);
    const tz = await tzOffsetMinutes();
    const [daily, allTime, newPlays] = await Promise.all([
      getDailyStats(tz, Math.max(14, Math.min(days, 100000))),
      getAllTimeStats(),
      // The plays the client's index is missing, for its instant search patch.
      // searchHistory with an empty query is "newest N plays, one row each" via
      // idx_plays_played_at, so the steady-state cost is a 1-row head check and a delta
      // fetch only runs when there is one — bounded by the delta, never a scan.
      (async (): Promise<TrackStats[] | null> => {
        if (sinceMinute == null) return added > 0 ? searchHistory("", Math.min(added, 50)) : null;
        const head = await searchHistory("", 1);
        const newest = head[0] ? Math.floor(Date.parse(head[0].lastPlayed) / 60000) : null;
        if (newest == null || newest <= sinceMinute) return null;
        const rows = await searchHistory("", 50);
        const fresh = rows.filter((r) => Math.floor(Date.parse(r.lastPlayed) / 60000) > sinceMinute);
        return fresh.length > 0 ? fresh : null;
      })(),
    ]);
    const day =
      want === "latest"
        ? (daily[0]?.day ?? null)
        : want === "all"
          ? "all"
          : null;
    const tracks =
      day === "all"
        ? await getAllTimePlays(300)
        : day
          ? await getPlaysByDay(day, tz)
          : null;
    return { ok: true, added, daily, allTime, day, tracks, newPlays };
  } catch (e) {
    // A missing/expired session throws a redirect — let it through rather than reporting it
    // as a failed sync.
    unstable_rethrow(e);
    return NO_REFRESH;
  }
}

/** Full-history search (name or artist, SQL LIKE) — every play as its own row,
 *  newest first; the client groups per song/artist.
 *
 *  This is now the FALLBACK path: matching normally happens in the browser against
 *  /api/search/{library,history}. It still runs while those are in flight (or if both failed
 *  to load), so the box is never dead — narrower, though, since it only knows the history. */
export async function searchPlaysAction(query: string): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  const q = query.trim();
  if (!q) return [];
  return searchHistory(q, 500);
}
