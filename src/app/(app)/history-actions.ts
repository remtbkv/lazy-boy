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
  getPlaysForTracks,
  getStoredPlaylists,
  searchHistory,
  type DayStats,
  type StoredPlaylist,
  type TrackStats,
} from "@/lib/db";
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
};

const NO_REFRESH: HistoryRefresh = {
  ok: false,
  added: 0,
  daily: [],
  allTime: { plays: 0, durationMs: 0, since: null },
  day: null,
  tracks: null,
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
): Promise<HistoryRefresh> {
  // getSpotify() throws a login REDIRECT when there's no session. Returning empty instead
  // keeps a signed-out caller from being bounced mid-render — no session, nothing to sync.
  if (!(await allowed())) return NO_REFRESH;
  try {
    const sp = await getSpotify();
    const { added } = await syncRecentPlays(sp);
    const tz = await tzOffsetMinutes();
    const [daily, allTime] = await Promise.all([
      getDailyStats(tz, Math.max(14, Math.min(days, 100000))),
      getAllTimeStats(),
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
    return { ok: true, added, daily, allTime, day, tracks };
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
 *  /api/history/search-index. It still runs while that index is in flight (or if it failed to
 *  load), so the box is never dead. */
export async function searchPlaysAction(query: string): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  const q = query.trim();
  if (!q) return [];
  return searchHistory(q, 500);
}

/** How many matched tracks one hydration call may ask about. The client caps its own match
 *  list at the same number, so this only bounds a malformed request. */
const MAX_HYDRATE_IDS = 400;

/** Play rows for a set of track ids — the stats half of the client-side search: the browser
 *  matched these ids against the index and needs their play counts, times and art. Same row
 *  shape as searchPlaysAction, so both paths render through the same code. */
export async function playsForTracksAction(ids: string[]): Promise<TrackStats[]> {
  if (!(await allowed())) return [];
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0).slice(0, MAX_HYDRATE_IDS);
  return getPlaysForTracks(clean);
}
