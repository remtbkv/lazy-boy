"use server";

import { revalidatePath } from "next/cache";
import { auth, signIn, signOut } from "@/lib/auth";
import { getSpotify } from "@/lib/session";
import { spotifyClient } from "@/lib/spotify";
import { runTask } from "@/lib/tasks/registry";

export type ActionResult<T = void> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

// ---- auth ----
export async function login() {
  await signIn("spotify", { redirectTo: "/me" });
}
export async function logout() {
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
      const sp = spotifyClient(token);
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

export async function removeTracksAction(
  playlistId: string,
  ids: string[],
): Promise<ActionResult<{ name: string; removed: number }>> {
  try {
    if (ids.length === 0) throw new Error("No tracks selected.");
    const sp = await getSpotify();
    const r = await sp.removeTracks(playlistId, ids);
    revalidatePath(`/playlists/${playlistId}`);
    return { ok: true, name: r.name, removed: r.removed };
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
