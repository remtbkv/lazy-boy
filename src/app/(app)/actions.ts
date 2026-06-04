"use server";

import { revalidatePath } from "next/cache";
import { auth, signIn, signOut } from "@/lib/auth";
import { getSpotify } from "@/lib/session";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { runTask } from "@/lib/tasks/registry";
import {
  clearSpotifyTokens,
  getPlaylistTracks,
  playedTrackIdsInContext,
  removeCachedPlaylistTrack,
  storePlaylistTracks,
} from "@/lib/db";

export type ActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
export async function mergeAction(
  sourceIds: string[],
): Promise<ActionResult<{ name: string; count: number; id: string }>> {
  try {
    if (sourceIds.length < 2) throw new Error("Pick at least two playlists.");
    const sp = await getSpotify();
    const r = await sp.mergePlaylists(sourceIds);
    revalidatePath("/playlists");
    return { ok: true, ...r };
  } catch (e) {
    return fail(e);
  }
}

/** Kicks off the clean as a background task; returns a task id to poll. */
export async function startCleanAction(
  playlistId: string,
  backup: boolean,
): Promise<ActionResult<{ taskId: string }>> {
  try {
    const session = await auth();
    if (!session?.accessToken) throw new Error("Not authenticated");
    const token = session.accessToken;
    const task = runTask("clean-playlist", async (onProgress) => {
      // Patient client: the library scan is a long bulk job, so ride out rate
      // limits instead of failing. Interactive requests use a fail-fast client.
      const sp = spotifyClient(token, true);
      return sp.cleanPlaylist(playlistId, { backup, onProgress });
    });
    return { ok: true, taskId: task.id };
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
    revalidatePath("/playlists");
    return { ok: true, name: r.name, count: r.count };
  } catch (e) {
    return fail(e);
  }
}

export async function syncLikedAction(): Promise<
  ActionResult<{ name: string; count: number }>
> {
  try {
    const sp = await getSpotify();
    const r = await sp.syncLikedToPlaylist();
    revalidatePath("/playlists");
    return { ok: true, name: r.name, count: r.count };
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
    return fail(e);
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
    if (e instanceof SpotifyError && (e.status === 404 || e.status === 403)) {
      return { ok: false, error: "No active device — start playing on Spotify first." };
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

// "Pick up where you left off": start the chosen playlist on the active device at the
// song *after* where you left off. Assumes in-order (non-shuffled) listening. The
// leave-off point is the end of the longest in-order run of songs you've played
// (small skips allowed) — NOT just the farthest-down song, so rewinding doesn't drag it
// backward AND a one-off accidental play deep in the list doesn't jump you ahead past
// songs you never heard. No history for that playlist → start from the top. Needs an
// active device + Premium, like the other transport controls.
export async function resumePlaylistAction(
  playlistId: string,
): Promise<ActionResult<{ track: string; fromTop: boolean }>> {
  try {
    const uri = `spotify:playlist:${playlistId}`;
    // Read the cached track list (instant) and the played-track set in parallel with
    // auth, instead of re-paginating the whole playlist from Spotify before playing —
    // that live scan was the lag. Only cold (never-cached) playlists fall back to a live
    // fetch, and we cache that result for next time.
    const [sp, cached, playedIds] = await Promise.all([
      getSpotify(),
      getPlaylistTracks(playlistId),
      playedTrackIdsInContext(uri),
    ]);
    let tracks = cached;
    if (tracks.length === 0) {
      tracks = await sp.playlistTracks(playlistId);
      if (tracks.length > 0) void storePlaylistTracks(playlistId, tracks);
    }
    if (tracks.length === 0) throw new Error("This playlist has no playable tracks.");

    // Positions (in playlist order) of tracks you've played from this playlist.
    const playedPos: number[] = [];
    for (let i = 0; i < tracks.length; i++) if (playedIds.has(tracks[i].id)) playedPos.push(i);

    // Leave-off point = the end of the LONGEST in-order run, tolerating small skips (a
    // gap of up to GAP positions between consecutive plays still counts as the same run).
    // This is robust against accidents: a one-off play deep in the list is its own
    // length-1 run and won't win, so we never skip you past songs you haven't heard.
    const GAP = 10;
    let bestEnd = -1;
    let bestLen = 0;
    let runStart = 0;
    for (let k = 1; k <= playedPos.length; k++) {
      const broke = k === playedPos.length || playedPos[k] - playedPos[k - 1] > GAP;
      if (broke) {
        const len = k - runStart;
        if (len > bestLen) {
          bestLen = len;
          bestEnd = playedPos[k - 1];
        }
        runStart = k;
      }
    }
    const fromTop = bestEnd < 0;
    const startIdx = fromTop ? 0 : Math.min(bestEnd + 1, tracks.length - 1); // the next song
    const start = tracks[startIdx];
    await sp.playContext(uri, start.uri);
    return { ok: true, track: start.title, fromTop };
  } catch (e) {
    if (e instanceof SpotifyError && (e.status === 404 || e.status === 403)) {
      return { ok: false, error: "No active device — start playing on Spotify first." };
    }
    return fail(e);
  }
}
