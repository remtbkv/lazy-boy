"use server";

import { revalidatePath } from "next/cache";
import { auth, signIn, signOut } from "@/lib/auth";
import { getSpotify } from "@/lib/session";
import { spotifyClient, SpotifyError } from "@/lib/spotify";
import { runTask } from "@/lib/tasks/registry";
import { clearSpotifyTokens } from "@/lib/db";

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
