"use server";

import { unstable_rethrow } from "next/navigation";
import { requireActionUser } from "@/lib/require-user";
import { forUser, ledgerAdd, type DayStats, type StoredPlaylist, type TrackStats, type UserStore } from "@/lib/db";
import { HISTORY_REFRESH_EXTRA_ROWS } from "@/lib/read-costs";
import { tzOffsetMinutes } from "@/lib/tz";

// Listen-history data actions for Home — DB reads only; from Phase 3 that includes
// refreshHistoryAction (below), which used to harvest. Every one of them returns personal data, so each
// gates first: the layout already redirects anyone without a session, but an action is a
// public endpoint and has to check for itself. The gate is requireActionUser's (PLAN §5.1,
// §5.4): a session whose grant is gone is refused here as on the pages, and the store it
// hands back is the gated user's.
async function gated(): Promise<UserStore | null> {
  const user = await requireActionUser();
  return "uid" in user ? forUser(user.uid) : null;
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
  const store = await gated();
  if (!store) return { playlists: [], backupPref: false, syncedAt: null };
  const [playlists, meId, backupPref, syncedAt] = await Promise.all([
    store.getStoredPlaylists(),
    store.getMeId(),
    store.getCleanBackupPref(),
    store.getPlaylistsSyncedAt(),
  ]);
  return {
    playlists: playlists.map((p) => ({ ...p, mine: !!meId && p.ownerId === meId })),
    backupPref,
    syncedAt,
  };
}

/** Tracks for one local day — the client caches per day, so each day costs one call. */
export async function dayTracksAction(day: string): Promise<TrackStats[]> {
  const store = await gated();
  if (!store) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const tz = await tzOffsetMinutes(store);
  return store.getPlaysByDay(day, tz);
}

/** Older day stats — the strip starts with the recent window and extends on demand. */
export async function dailyStatsAction(days: number): Promise<DayStats[]> {
  const store = await gated();
  if (!store) return [];
  const tz = await tzOffsetMinutes(store);
  return store.getDailyStats(tz, Math.min(days, 100000));
}

/** Most-played all-time — fetched on demand when the All time view is opened. */
export async function allTimePlaysAction(): Promise<TrackStats[]> {
  const store = await gated();
  if (!store) return [];
  return store.getAllTimePlays(300);
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
  /** The plays the store holds that the client's index is missing (newest first), so the
   *  client can patch its in-memory search index instantly — the server payload only rebuilds
   *  every 10 min (db.ts, the slow marker). An indexed read bounded by the delta. */
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

/** Re-read what's on screen from the user's store.
 *
 *  It calls nobody (multi-user PLAN §7.6, decision 15): it used to harvest recently-played on
 *  every call, with no debounce, from every open tab, and was one more concurrent writer of
 *  the derived state. The cron's tick stores each play within about two minutes of its end;
 *  until it does, the browser's provisional row (optimistic-play.ts, handoff.ts) stands in.
 *  `added` is always 0 now; the delta in `newPlays` carries whatever the tick stored.
 *
 *  `want` is the view the client is currently showing, so a single round-trip refreshes the
 *  strip, the all-time totals AND the visible rows:
 *    "latest"  — following the newest day (resolved server-side, so a midnight rollover
 *                moves you onto the new day instead of stranding you on yesterday)
 *    "all"     — the all-time list
 *    null      — a pinned past day (frozen history — the rows cannot change, so don't refetch
 *                them) or an active search
 *  `days` keeps the strip at whatever width it's been expanded to. */
export async function refreshHistoryAction(
  want: "latest" | "all" | null,
  days: number,
  // The newest play minute the client's in-memory search index already holds. The delta
  // returned in `newPlays` is computed against THIS: a play the cron tick stored seconds
  // earlier is missing from the client's index until then.
  sinceMinute: number | null = null,
): Promise<HistoryRefresh> {
  // A refused caller gets the empty answer rather than a redirect mid-render.
  const store = await gated();
  if (!store) return NO_REFRESH;
  try {
    // This fires every 120 s from an open tab, twice per track change and on visibility, so
    // it is the term an open tab contributes. Only this action's own bounded head/delta check
    // is charged here — the strip, the day and the all-time list below are ledgered under
    // their own readers, and counting them twice would hide a real residual.
    void ledgerAdd("history_refresh", HISTORY_REFRESH_EXTRA_ROWS).catch(() => {});
    const tz = await tzOffsetMinutes(store);
    const [daily, allTime, newPlays] = await Promise.all([
      store.getDailyStats(tz, Math.max(14, Math.min(days, 100000))),
      store.getAllTimeStats(),
      // The plays the client's index is missing, for its instant search patch.
      // searchHistory with an empty query is "newest N plays, one row each" via
      // idx_plays_played_at, so the steady-state cost is a 1-row head check and a delta
      // fetch only runs when there is one — bounded by the delta, never a scan.
      (async (): Promise<TrackStats[] | null> => {
        if (sinceMinute == null) return null;
        const head = await store.searchHistory("", 1);
        const newest = head[0] ? Math.floor(Date.parse(head[0].lastPlayed) / 60000) : null;
        // `>=` on the boundary minute, not `>`: a second play landing in the SAME minute
        // the client already holds was strictly-greater-filtered out of every delta and
        // stayed missing until the next cold payload (audit 2026-08-19, T2.5). The client
        // patch dedupes on (identity, minute), so re-delivering the boundary is free.
        if (newest == null || newest < sinceMinute) return null;
        const rows = await store.searchHistory("", 50);
        const fresh = rows.filter(
          (r) => Math.floor(Date.parse(r.lastPlayed) / 60000) >= sinceMinute,
        );
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
        ? await store.getAllTimePlays(300)
        : day
          ? await store.getPlaysByDay(day, tz)
          : null;
    return { ok: true, added: 0, daily, allTime, day, tracks, newPlays };
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
  const store = await gated();
  if (!store) return [];
  const q = query.trim();
  if (!q) return [];
  return store.searchHistory(q, 500);
}
