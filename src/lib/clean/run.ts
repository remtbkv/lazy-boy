import "server-only";
import { spotifyClient } from "@/lib/spotify";
import { intersect, subtract } from "@/lib/spotify/domain";
import type { Track } from "@/lib/spotify/types";
import {
  getLibrarySyncedAt,
  getLibraryTracks,
  getPlaylistTracks,
  storePlaylistTracks,
} from "@/lib/db";
import { syncLibrary } from "@/lib/sync/library";
import { cleanedName, backupName as makeBackupName } from "@/lib/clean/names";

type Spotify = ReturnType<typeof spotifyClient>;

// Everything Phase 2 needs to reconcile the playlists Phase 1 created.
export type CleanContext = {
  targetId: string;
  name: string; // "Cleaned: X"
  cleanedId: string;
  backupId: string | null;
  backup: boolean;
  backupName: string; // "Dupes removed from: X"
  kept: Track[]; // exactly what Phase 1 wrote to the cleaned playlist (target order)
};

export type CleanResult = {
  id?: string;
  name: string;
  kept: number;
  removed: number;
  backupId?: string;
  // True when nothing was a duplicate — no "Cleaned: …" playlist was created.
  unique?: boolean;
};

export type ReconcileResult = {
  changed: boolean;
  name: string;
  added: number;
  removed: number;
};

// Phase 1: clean from the (possibly stale) DB index and return immediately. Creates
// "Cleaned: X" (tracks not saved elsewhere) and, if backing up, "Dupes removed from:
// X". The library read is pure DB — fast — so this is near-instant on a warm index.
export async function cleanPhase1(
  sp: Spotify,
  targetId: string,
  backup: boolean,
): Promise<{ result: CleanResult; ctx: CleanContext | null }> {
  // Cold start only: with no index yet we'd clean against an empty library and remove
  // nothing, so build it once here. Normally the hourly cron keeps it warm.
  if (!(await getLibrarySyncedAt())) await syncLibrary(sp);

  const target = await sp.playlist(targetId);
  let targetTracks = await getPlaylistTracks(targetId);
  if (targetTracks.length === 0) {
    targetTracks = await sp.playlistTracks(targetId);
    if (targetTracks.length) await storePlaylistTracks(targetId, targetTracks, target.snapshot);
  }

  // Other cleaned playlists count as library (so a song kept in an earlier clean is purged
  // here); only this target's own "Cleaned: <name>" output is excluded — see getLibraryTracks.
  const library = await getLibraryTracks(targetId, target.name);
  const kept = subtract(targetTracks, library);
  const removed = intersect(targetTracks, library);

  const name = cleanedName(target.name);
  const backupName = makeBackupName(target.name);

  // Nothing's a duplicate → don't create a redundant full-copy "Cleaned: X"; the caller
  // just tells the user the playlist is unique. (No reconcile either.)
  if (removed.length === 0) {
    return {
      result: { name, kept: kept.length, removed: 0, unique: true },
      ctx: null,
    };
  }

  const cleanedId = await sp.createPlaylist(name);
  await sp.addItems(cleanedId, kept.map((t) => t.uri));

  let backupId: string | null = null;
  if (backup && removed.length > 0) {
    backupId = await sp.createPlaylist(backupName);
    await sp.addItems(backupId, removed.map((t) => t.uri));
  }

  return {
    result: { id: cleanedId, name, kept: kept.length, removed: removed.length, backupId: backupId ?? undefined },
    ctx: { targetId, name, cleanedId, backupId, backup, backupName, kept },
  };
}

// Phase 2: refresh the index + the target from Spotify, recompute the correct result,
// and reconcile the cleaned playlist to match (exact-mirror). Fixes both directions of
// staleness — wrongly-removed songs go back at their right position; wrongly-kept songs
// come out (and the backup is mirrored to the true removed set).
export async function reconcileClean(sp: Spotify, ctx: CleanContext): Promise<ReconcileResult> {
  await syncLibrary(sp);
  const target = await sp.playlist(ctx.targetId);
  const targetFresh = await sp.playlistTracks(ctx.targetId);
  if (targetFresh.length) await storePlaylistTracks(ctx.targetId, targetFresh, target.snapshot);

  const libraryFresh = await getLibraryTracks(ctx.targetId, target.name);
  const keptFresh = subtract(targetFresh, libraryFresh);
  const removedFresh = intersect(targetFresh, libraryFresh);

  // Diff the correct result against what Phase 1 actually wrote.
  const toAdd = subtract(keptFresh, ctx.kept); // wrongly removed → put back
  const toRemove = subtract(ctx.kept, keptFresh); // wrongly kept → take out

  if (toRemove.length) await sp.removeItems(ctx.cleanedId, toRemove.map((t) => t.uri));

  // Re-insert each at its index in the correct (target) order. Ascending, so each
  // insert lands before the not-yet-inserted ones shift it.
  const idxByUri = new Map(keptFresh.map((t, i) => [t.uri, i] as const));
  const adds = [...toAdd].sort((a, b) => (idxByUri.get(a.uri) ?? 0) - (idxByUri.get(b.uri) ?? 0));
  for (const t of adds) {
    await sp.addItemsAt(ctx.cleanedId, [t.uri], idxByUri.get(t.uri) ?? 0);
  }

  // Exact-mirror the backup to the true removed set (so nothing sits in both the
  // cleaned playlist and the backup).
  if (ctx.backup) {
    if (ctx.backupId) {
      await sp.replaceItems(ctx.backupId, removedFresh.map((t) => t.uri));
    } else if (removedFresh.length) {
      // Phase 1 found no dupes (no backup made), but the refresh did — create it now.
      const id = await sp.createPlaylist(ctx.backupName);
      await sp.addItems(id, removedFresh.map((t) => t.uri));
    }
  }

  return {
    changed: toAdd.length > 0 || toRemove.length > 0,
    name: ctx.name,
    added: toAdd.length,
    removed: toRemove.length,
  };
}
