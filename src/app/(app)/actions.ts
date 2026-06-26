"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { auth, signIn, signOut, getValidAccessToken } from "@/lib/auth";
import { getSpotify } from "@/lib/session";
import { spotifyClient, SpotifyError, type Track } from "@/lib/spotify";
import { intersect, keyOf, subtract } from "@/lib/spotify/domain";
import { runTask } from "@/lib/tasks/registry";
import { cleanPhase1, reconcileClean } from "@/lib/clean/run";
import { syncLibrary } from "@/lib/sync/library";
import { syncRecentPlays } from "@/lib/sync/history";
import { tzOffsetMinutes } from "@/lib/tz";
import {
  clearSpotifyTokens,
  deletePlaylistFromDb,
  getAllTimeStats,
  getCleanBackupPref,
  getDailyStats,
  getLastSync,
  hasPlaysBeforeDay,
  type DayStats,
  getMeId,
  getPlaylistTracks,
  getPlaylistTrackOrder,
  playedTracksInContext,
  removeCachedPlaylistTrack,
  setCleanBackupPref,
  storePlaylistTracks,
  upsertStoredPlaylist,
} from "@/lib/db";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// Used by the merged-in history view's auto-refresh (every minute while Home is open, no
// button): pulls the latest plays for the signed-in user into the store and returns
// refreshed day stats so the view updates in place. The same core also runs on app load +
// every 2 min via /api/sync, and on a schedule via /api/cron/sync. `days` matches however
// far the day strip is currently expanded, so a refresh doesn't collapse it back to 2 weeks.
export async function syncHistoryAction(days = 14) {
  try {
    const sp = await getSpotify();
    const { added } = await syncRecentPlays(sp);
    const tz = await tzOffsetMinutes();
    const [daily, lastSync, allTime] = await Promise.all([
      getDailyStats(tz, days),
      getLastSync(),
      getAllTimeStats(),
    ]);
    return { ok: true as const, added, daily, lastSync, allTime };
  } catch (e) {
    // Don't map getSpotify()'s login redirect into an error result (see fail() below).
    unstable_rethrow(e);
    return { ok: false as const, error: e instanceof Error ? e.message : "Sync failed" };
  }
}

// Expand the day-by-day strip on demand: 2 weeks → 4 weeks → all. Returns the day rows for
// the requested span plus whether even older days exist (so the strip knows to keep offering
// the next step). Each level bounds its own fetch, so this stays fast.
export async function loadDaysAction(
  days: number,
): Promise<ActionResult<{ daily: DayStats[]; hasMore: boolean }>> {
  try {
    await getSpotify(); // gate on a live session
    const tz = await tzOffsetMinutes();
    const daily = await getDailyStats(tz, days);
    const oldest = daily[daily.length - 1]?.day;
    const hasMore = !!oldest && daily.length >= days && (await hasPlaysBeforeDay(oldest, tz));
    return { ok: true, daily, hasMore };
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): { ok: false; error: string } {
  // getSpotify() redirects to /login on a dead session by THROWING Next's control-flow
  // error; mapping it to a result would show the user a literal "NEXT_REDIRECT" toast
  // instead of logging them out. Rethrow Next's internals, map only real errors.
  unstable_rethrow(e);
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

// A token getter for background tasks (clean reconcile, library sync) that can outlive
// the ~1h access token. It refreshes through the shared cross-instance lock and caches
// briefly, so a long run never dies on a mid-run 401 yet doesn't re-hit the DB per call.
// (getValidAccessToken only returns a token with ≥60s headroom, so a sub-60s cache is safe.)
function refreshingToken(): () => Promise<string> {
  let cached = "";
  let until = 0;
  return async () => {
    if (cached && Date.now() < until) return cached;
    const t = await getValidAccessToken();
    if (!t) throw new Error("Spotify session expired — log out and back in.");
    cached = t;
    until = Date.now() + 55_000;
    return t;
  };
}

// ---- auth ----
export async function login() {
  await signIn("spotify", { redirectTo: "/home" });
}
export async function logout() {
  await clearSpotifyTokens();
  await signOut({ redirectTo: "/login" });
}

// ---- playlist tools ----

// The grid renders from the DB store, so a playlist created on Spotify is invisible
// until the next full library sync (up to 15 min) unless we insert its row now. The
// next sync fills in the mosaic image and true position. Best-effort: the playlist
// exists on Spotify either way, so store upkeep must never fail the action.
async function recordNewPlaylist(id: string, name: string, trackCount: number): Promise<void> {
  try {
    const me = await getMeId();
    await upsertStoredPlaylist({ id, name, ownerId: me, image: null, trackCount });
  } catch {
    /* next sync picks it up */
  }
}

export async function mergeAction(
  sourceIds: string[],
): Promise<ActionResult<{ name: string; count: number; id: string }>> {
  try {
    if (sourceIds.length < 2) throw new Error("Pick at least two playlists.");
    const sp = await getSpotify();
    const r = await sp.mergePlaylists(sourceIds);
    await recordNewPlaylist(r.id, r.name, r.count);
    revalidatePath("/playlists");
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}

/** Clean a playlist. Phase 1 runs now against the persistent library index (fast) and
 *  its result comes straight back. Phase 2 — refresh the index from Spotify and reconcile
 *  the cleaned playlist — runs in the background; `taskId` lets the UI report any fixups.
 *  `backup` omitted → the user's saved global preference. */
export async function startCleanAction(
  playlistId: string,
  backup?: boolean,
): Promise<
  ActionResult<{ name: string; kept: number; removed: number; taskId?: string; unique?: boolean }>
> {
  try {
    const session = await auth();
    if (!session?.accessToken || session.error) throw new Error("Not authenticated");
    // Background bulk work can outlive the access token → refreshing getter, not a fixed
    // string (a 1h+ clean would otherwise 401 mid-run). Patient: ride out rate limits.
    const token = refreshingToken();
    const useBackup = backup ?? (await getCleanBackupPref());
    const { result, ctx } = await cleanPhase1(spotifyClient(token, true), playlistId, useBackup);
    // Nothing removed → no playlist created, nothing to reconcile.
    if (!ctx || result.unique) {
      return { ok: true, name: result.name, kept: result.kept, removed: 0, unique: true };
    }
    // The new playlists show in the grid right away (reconcile's syncLibrary would
    // also get there, but only after the whole background pass).
    if (result.id) await recordNewPlaylist(result.id, result.name, result.kept);
    if (ctx.backupId) await recordNewPlaylist(ctx.backupId, ctx.backupName, result.removed);
    const task = runTask("clean-reconcile", () =>
      reconcileClean(spotifyClient(token, true), ctx),
    );
    revalidatePath("/playlists");
    return { ok: true, name: result.name, kept: result.kept, removed: result.removed, taskId: task.id };
  } catch (e) {
    return fail(e);
  }
}

/** Persist the global "back up removed songs" preference for Clean. */
export async function setCleanBackupAction(on: boolean): Promise<ActionResult> {
  try {
    await setCleanBackupPref(on);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Resync the backend index (playlists + tracks + Liked) with Spotify as a background
 *  task; returns a task id whose progress (songs looked through / total) the client
 *  polls — so it keeps running and stays visible across a refresh. */
export async function startSyncAction(): Promise<ActionResult<{ taskId: string }>> {
  try {
    const session = await auth();
    if (!session?.accessToken || session.error) throw new Error("Not authenticated");
    const token = refreshingToken();
    const task = runTask("sync-backend", (onProgress) =>
      syncLibrary(spotifyClient(token, true), onProgress),
    );
    return { ok: true, taskId: task.id };
  } catch (e) {
    return fail(e);
  }
}

/** Start playing a playlist on the active device, like double-clicking it in Spotify.
 *  Shuffle is left at whatever the device is already set to. */
export async function playPlaylistAction(playlistId: string): Promise<ActionResult> {
  return playerControl((sp) => sp.playContext(`spotify:playlist:${playlistId}`));
}

/** Delete (unfollow) one of the user's playlists, then drop it from the local store.
 *  If Spotify says it's already gone (404 — the local index was stale), treat that as a
 *  clean, silent removal AND kick off a background resync, since other things may have
 *  changed too. The resync is non-blocking — it never holds up this action. */
export async function deletePlaylistAction(
  playlistId: string,
): Promise<ActionResult<{ alreadyGone?: boolean }>> {
  try {
    const session = await auth();
    if (!session?.accessToken || session.error) throw new Error("Not authenticated");
    // Getter, not a fixed string: the delete is quick, but the fire-and-forget resync
    // below can outlive the token.
    const token = refreshingToken();
    let alreadyGone = false;
    try {
      await spotifyClient(token).deletePlaylist(playlistId);
    } catch (e) {
      if (e instanceof SpotifyError && e.status === 404) alreadyGone = true;
      else throw e;
    }
    await deletePlaylistFromDb(playlistId);
    revalidatePath("/playlists");
    if (alreadyGone) {
      // Fire-and-forget background resync (the registry runs it; we don't await).
      runTask("sync-backend", (onProgress) =>
        syncLibrary(spotifyClient(token, true), onProgress),
      );
    }
    return { ok: true, alreadyGone };
  } catch (e) {
    return fail(e);
  }
}

export async function saveQueueAction(): Promise<
  ActionResult<{ name: string; count: number }>
> {
  try {
    const sp = await getSpotify();
    const r = await sp.saveQueue();
    await recordNewPlaylist(r.id, r.name, r.count);
    revalidatePath("/playlists");
    return { ok: true, name: r.name, count: r.count };
  } catch (e) {
    return fail(e);
  }
}

// ---- subtract (set difference) ----

export type SubtractTrack = {
  id: string;
  uri: string;
  title: string;
  artist: string;
  albumImage: string | null;
  durationMs: number | null; // not displayed — feeds the optimistic now-playing chip
  /** For overlap tracks: the first subtracted playlist that contains it. */
  in?: string;
};

// Tracks for a playlist — the cached index first (instant), live fetch + cache only
// when the playlist has never been synced. Same pattern as resumePlaylistAction.
async function playlistTracksCached(
  sp: Awaited<ReturnType<typeof getSpotify>>,
  id: string,
): Promise<Track[]> {
  const cached = await getPlaylistTracks(id);
  if (cached.length) return cached;
  const live = await sp.playlistTracks(id);
  if (live.length) void storePlaylistTracks(id, live).catch(() => {});
  return live;
}

/** Set difference for the Subtract panel: split the base playlist's tracks into those
 *  unique to it (kept) and those that also appear in any of the subtracted playlists
 *  (overlap, tagged with which playlist claims it). Reads the synced index, so it's
 *  instant — and as fresh as the last library sync, like Clean's phase 1. */
export async function subtractPreviewAction(
  baseId: string,
  others: { id: string; name: string }[],
): Promise<ActionResult<{ kept: SubtractTrack[]; overlap: SubtractTrack[] }>> {
  try {
    if (others.length === 0) throw new Error("Pick at least one playlist to subtract.");
    const sp = await getSpotify();
    const [baseTracks, ...otherLists] = await Promise.all([
      playlistTracksCached(sp, baseId),
      ...others.map((o) => playlistTracksCached(sp, o.id)),
    ]);
    // Which subtracted playlist "claims" each song — the first one containing it.
    const sourceByKey = new Map<string, string>();
    otherLists.forEach((list, i) => {
      for (const t of list) {
        const k = keyOf(t);
        if (!sourceByKey.has(k)) sourceByKey.set(k, others[i].name);
      }
    });
    const allOthers = otherLists.flat();
    const lite = (t: Track): SubtractTrack => ({
      id: t.id,
      uri: t.uri,
      title: t.title,
      artist: t.artist,
      albumImage: t.albumImage ?? null,
      durationMs: t.durationMs ?? null,
    });
    return {
      ok: true,
      kept: subtract(baseTracks, allOthers).map(lite),
      overlap: intersect(baseTracks, allOthers).map((t) => ({
        ...lite(t),
        in: sourceByKey.get(keyOf(t)),
      })),
    };
  } catch (e) {
    return fail(e);
  }
}

/** Remove a batch of tracks from a playlist in place (the Subtract panel's "remove
 *  overlap from base"). Refreshes the cached track list + snapshot afterwards so the
 *  index stays in step — the bulk version of removeFromPlaylistAction's upkeep. */
export async function removeTracksAction(
  playlistId: string,
  uris: string[],
): Promise<ActionResult<{ removed: number }>> {
  try {
    if (uris.length === 0) throw new Error("Nothing to remove.");
    const sp = await getSpotify();
    await sp.removeItems(playlistId, uris);
    const [pl, fresh] = await Promise.all([sp.playlist(playlistId), sp.playlistTracks(playlistId)]);
    await storePlaylistTracks(playlistId, fresh, pl.snapshot);
    revalidatePath(`/playlists/${playlistId}`);
    return { ok: true, removed: uris.length };
  } catch (e) {
    return fail(e);
  }
}

export async function saveCompareDiffAction(
  name: string,
  uris: string[],
): Promise<ActionResult<{ count: number }>> {
  try {
    if (uris.length === 0) throw new Error("Nothing to save.");
    const sp = await getSpotify();
    const r = await sp.createFromUris(name, uris);
    await recordNewPlaylist(r.id, name, r.count);
    revalidatePath("/playlists");
    return { ok: true, count: r.count };
  } catch (e) {
    return fail(e);
  }
}

// ---- player (web-player simulation) ----
export async function addToQueueAction(uri: string): Promise<ActionResult> {
  try {
    const sp = await getSpotify();
    await sp.addToQueue(uri);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof SpotifyError && (e.status === 404 || e.status === 403)) {
      return { ok: false, error: "No active device — start playing on Spotify first." };
    }
    return fail(e);
  }
}

export async function saveToLikedAction(trackId: string): Promise<ActionResult> {
  try {
    const sp = await getSpotify();
    await sp.saveTrack(trackId);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    // A 403 here means the session lacks the `user-library-modify` grant (e.g. it was
    // authorized before that scope was added) — surface a clean, actionable message
    // instead of Spotify's raw error JSON.
    if (e instanceof SpotifyError && e.status === 403) {
      return { ok: false, error: "Couldn't save — log out and back in to allow library changes." };
    }
    return { ok: false, error: "Couldn't save to Liked Songs." };
  }
}

export async function removeFromPlaylistAction(
  playlistId: string,
  uri: string,
): Promise<ActionResult> {
  try {
    const sp = await getSpotify();
    await sp.removeFromPlaylist(playlistId, uri);
    await removeCachedPlaylistTrack(playlistId, uri); // keep the cache in step
    revalidatePath(`/playlists/${playlistId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// Transport controls used by the now-playing card. All share the same "no active
// device" handling, since that's the one expected failure on a personal player.
async function playerControl(
  fn: (sp: Awaited<ReturnType<typeof getSpotify>>) => Promise<void>,
): Promise<ActionResult> {
  try {
    const sp = await getSpotify();
    await fn(sp);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof SpotifyError) {
      // 404 = no active device; 403 on a player command is usually "Premium required"
      // (or a transient restriction) — don't mislabel it as a device problem.
      if (e.status === 404) {
        return { ok: false, error: "No active device — start playing on Spotify first." };
      }
      if (e.status === 403) {
        return { ok: false, error: "Playback needs Spotify Premium and an active device." };
      }
    }
    return fail(e);
  }
}

export async function playerNextAction(): Promise<ActionResult> {
  return playerControl((sp) => sp.nextTrack());
}
export async function playerPreviousAction(): Promise<ActionResult> {
  return playerControl((sp) => sp.previousTrack());
}
export async function playerSetPlayingAction(play: boolean): Promise<ActionResult> {
  return playerControl((sp) => (play ? sp.resumePlayback() : sp.pausePlayback()));
}

// Double-click a track in a playlist → play it within that playlist's context (so the
// queue continues through the rest of the playlist, like Spotify).
export async function playPlaylistTrackAction(
  playlistId: string,
  trackUri: string,
): Promise<ActionResult> {
  return playerControl((sp) => sp.playContext(`spotify:playlist:${playlistId}`, trackUri));
}

// Double-click a track outside a playlist (e.g. in history) → just play that track.
export async function playTrackAction(trackUri: string): Promise<ActionResult> {
  return playerControl((sp) => sp.playTracks([trackUri]));
}

// "Pick up where you left off": start the chosen playlist on the active device at the
// song *after* where you left off. Assumes in-order (non-shuffled) listening.
//
// The leave-off point is scoped to your MOST RECENT listening session, then within that
// session it's the end of the longest in-order run of songs you played (small skips
// allowed). Two protections, two scales:
//   - Recency (session scope): if you got deep into the playlist days ago, then today
//     restarted and only played a few songs, today's short session wins — we don't shove
//     you back to the old deep spot. (This was the bug: the all-time longest run let an
//     older, deeper session push the resume point far past where you actually stopped.)
//   - In-session robustness (longest run): a one-off accidental tap deep in the list
//     during the session is its own length-1 run and won't win, so we never skip you past
//     songs you haven't heard.
// No history for that playlist → start from the top. Needs an active device + Premium.
export async function resumePlaylistAction(
  playlistId: string,
): Promise<ActionResult<{ track: string; fromTop: boolean }>> {
  try {
    const uri = `spotify:playlist:${playlistId}`;
    // Read the cached track list (instant) and the timestamped plays in parallel with
    // auth, instead of re-paginating the whole playlist from Spotify before playing —
    // that live scan was the lag. Only cold (never-cached) playlists fall back to a live
    // fetch, and we cache that result for next time.
    const [sp, cached, plays] = await Promise.all([
      getSpotify(),
      getPlaylistTrackOrder(playlistId),
      playedTracksInContext(uri),
    ]);
    let tracks = cached;
    if (tracks.length === 0) {
      tracks = await sp.playlistTracks(playlistId);
      if (tracks.length > 0) void storePlaylistTracks(playlistId, tracks).catch(() => {});
    }
    if (tracks.length === 0) throw new Error("This playlist has no playable tracks.");

    // Each track id → its position in the playlist (first occurrence wins for the rare
    // duplicate). Also index by name+artist as a fallback: Spotify gives the same song
    // different ids in a playlist vs. in recently-played (track relinking / duplicate
    // releases), so an id-only match silently drops those plays — which sent Resume back to
    // an earlier song than where you actually stopped. Plays are oldest→newest; map each to
    // {position, time}, dropping any whose song isn't in the playlist at all.
    const posOf = new Map<string, number>();
    const posByKey = new Map<string, number>();
    const songKey = (name: string | null | undefined, artist: string | null | undefined) =>
      `${(name ?? "").toLowerCase().trim()} ${(artist ?? "").toLowerCase().trim()}`;
    for (let i = 0; i < tracks.length; i++) {
      if (!posOf.has(tracks[i].id)) posOf.set(tracks[i].id, i);
      const key = songKey(tracks[i].title, tracks[i].artist);
      if (!posByKey.has(key)) posByKey.set(key, i);
    }
    const events: { pos: number; t: number }[] = [];
    for (const p of plays) {
      const pos = posOf.get(p.trackId) ?? posByKey.get(songKey(p.name, p.artist));
      const t = Date.parse(p.playedAt);
      if (pos !== undefined && !Number.isNaN(t)) events.push({ pos, t });
    }

    // Scope to the most recent session: split the time-ordered plays wherever the gap
    // between consecutive plays exceeds SESSION_GAP, and keep only the last group.
    const SESSION_GAP_MS = 3 * 60 * 60 * 1000;
    let sessionStart = 0;
    for (let i = 1; i < events.length; i++) {
      if (events[i].t - events[i - 1].t > SESSION_GAP_MS) sessionStart = i;
    }
    const positions = Array.from(new Set(events.slice(sessionStart).map((e) => e.pos))).sort(
      (a, b) => a - b,
    );

    // Within the session: end of the LONGEST in-order run, tolerating small skips (a gap of
    // up to GAP positions between consecutive plays still counts as the same run).
    const GAP = 10;
    let bestEnd = -1;
    let bestLen = 0;
    let runStart = 0;
    for (let k = 1; k <= positions.length; k++) {
      const broke = k === positions.length || positions[k] - positions[k - 1] > GAP;
      if (broke) {
        const len = k - runStart;
        if (len > bestLen) {
          bestLen = len;
          bestEnd = positions[k - 1];
        }
        runStart = k;
      }
    }
    // If your run already reached the last track, you've finished the playlist — start
    // over from the top rather than replaying the final song.
    const finished = bestEnd >= 0 && bestEnd + 1 >= tracks.length;
    const fromTop = bestEnd < 0 || finished;
    const startIdx = fromTop ? 0 : bestEnd + 1;
    const start = tracks[startIdx];
    await sp.playContext(uri, start.uri);
    return { ok: true, track: start.title, fromTop };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof SpotifyError) {
      if (e.status === 404) {
        return { ok: false, error: "No active device — start playing on Spotify first." };
      }
      if (e.status === 403) {
        return { ok: false, error: "Playback needs Spotify Premium and an active device." };
      }
    }
    return fail(e);
  }
}
