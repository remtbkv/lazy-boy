// Feature orchestration: composes Resources (I/O) + domain (pure logic) into the
// operations the UI calls. Specs in docs/FEATURES.md.

import { Resources } from "./resources";
import {
  dedupeByKey,
  findDuplicates,
  intersect,
  mergeUnique,
  removeByIds,
  subtract,
} from "./domain";
import type { Playlist, Track } from "./types";

export type Progress = (collected: number, total: number) => void;

export type CompareEntry = {
  playlist: Playlist;
  unsaved: Track[];
  saved: Track[];
};

export class Service {
  readonly resources: Resources;
  constructor(accessToken: string) {
    this.resources = new Resources(accessToken);
  }

  me() {
    return this.resources.me();
  }
  myPlaylists(onlyMine = false) {
    return this.resources.myPlaylists(onlyMine);
  }
  playlist(id: string) {
    return this.resources.playlist(id);
  }
  playlistTracks(id: string) {
    return this.resources.playlistTracks(id);
  }

  /** Union of the user's entire library (liked + every owned playlist), deduped.
   *  `exceptPlaylistId` lets "clean" exclude the target itself. */
  async libraryTracks(exceptPlaylistId?: string, onProgress?: Progress): Promise<Track[]> {
    const me = await this.resources.me();
    const playlists = (await this.resources.myPlaylists()).filter(
      (p) => p.ownerId === me.id && p.id !== exceptPlaylistId,
    );
    // Rough total for the progress bar: liked + sum of playlist counts.
    const grandTotal = 1 + playlists.reduce((n, p) => n + p.trackCount, 0);
    let collected = 0;
    const bump = (n: number) => {
      collected += n;
      onProgress?.(collected, grandTotal);
    };

    const liked = await this.resources.savedTracks();
    bump(liked.length);
    const all: Track[] = [...liked];
    for (const p of playlists) {
      const tracks = await this.resources.playlistTracks(p.id);
      all.push(...tracks);
      bump(tracks.length);
    }
    return dedupeByKey(all);
  }

  /** Merge sources (in order) into a new playlist without duplicates. */
  async mergePlaylists(sourceIds: string[]): Promise<{ id: string; name: string; count: number }> {
    const names: string[] = [];
    const lists: Track[][] = [];
    for (const id of sourceIds) {
      const pl = await this.resources.playlist(id);
      names.push(pl.name);
      lists.push(await this.resources.playlistTracks(id));
    }
    const merged = mergeUnique(lists);
    const name = names.join(" + ");
    const newId = await this.resources.createPlaylist(name);
    await this.resources.addItems(newId, merged.map((t) => t.uri));
    return { id: newId, name, count: merged.length };
  }

  /** Clean: new playlist with tracks already saved elsewhere removed. Long-running. */
  async cleanPlaylist(
    targetId: string,
    opts: { backup?: boolean; onProgress?: Progress } = {},
  ): Promise<{ id: string; name: string; kept: number; removed: number; backupId?: string }> {
    const target = await this.resources.playlist(targetId);
    const targetTracks = await this.resources.playlistTracks(targetId);
    const library = await this.libraryTracks(targetId, opts.onProgress);

    const kept = subtract(targetTracks, library);
    const removed = intersect(targetTracks, library);

    const cleanedId = await this.resources.createPlaylist(`Cleaned: ${target.name}`);
    await this.resources.addItems(cleanedId, kept.map((t) => t.uri));

    let backupId: string | undefined;
    if (opts.backup && removed.length > 0) {
      backupId = await this.resources.createPlaylist(`Dupes removed from: ${target.name}`);
      await this.resources.addItems(backupId, removed.map((t) => t.uri));
    }
    return { id: cleanedId, name: `Cleaned: ${target.name}`, kept: kept.length, removed: removed.length, backupId };
  }

  /** Duplicates within a single playlist. */
  async findDuplicates(playlistId: string): Promise<Track[]> {
    const tracks = await this.resources.playlistTracks(playlistId);
    return findDuplicates(tracks);
  }

  /** New playlist = original minus the given track ids. */
  async removeTracks(playlistId: string, ids: string[]): Promise<{ id: string; name: string; removed: number }> {
    const pl = await this.resources.playlist(playlistId);
    const tracks = await this.resources.playlistTracks(playlistId);
    const kept = removeByIds(tracks, new Set(ids));
    const removed = tracks.length - kept.length;
    const newId = await this.resources.createPlaylist(`${removed} removed: ${pl.name}`);
    await this.resources.addItems(newId, kept.map((t) => t.uri));
    return { id: newId, name: `${removed} removed: ${pl.name}`, removed };
  }

  /** Mirror liked songs into a maintained playlist (exact replace). */
  async syncLikedToPlaylist(): Promise<{ id: string; count: number; name: string }> {
    const name = "Liked songs as playlist";
    const existing = (await this.resources.myPlaylists(true)).find((p) => p.name === name);
    const id = existing?.id ?? (await this.resources.createPlaylist(name));
    const liked = dedupeByKey(await this.resources.savedTracks());
    await this.resources.replaceItems(id, liked.map((t) => t.uri));
    return { id, count: liked.length, name };
  }

  /** Save the current playback queue to a playlist (Premium + active device). */
  async saveQueue(): Promise<{ id: string; name: string; count: number }> {
    const queue = await this.resources.queue();
    if (queue.length === 0) {
      throw new Error("Nothing is playing — start playback to capture a queue.");
    }
    const name = "Saved queue";
    const id = await this.resources.createPlaylist(name);
    await this.resources.addItems(id, queue.map((t) => t.uri));
    return { id, name, count: queue.length };
  }

  /** Song diff vs another user's public playlists. */
  async compareUser(userId: string): Promise<{ user: { id: string; displayName: string; image: string | null }; entries: CompareEntry[] }> {
    const cleanId = parseUserId(userId);
    const [user, theirPlaylists, myLibrary] = await Promise.all([
      this.resources.user(cleanId),
      this.resources.userPlaylists(cleanId),
      this.libraryTracks(),
    ]);
    const entries: CompareEntry[] = [];
    for (const pl of theirPlaylists) {
      const tracks = await this.resources.playlistTracks(pl.id);
      entries.push({
        playlist: pl,
        unsaved: subtract(tracks, myLibrary),
        saved: intersect(tracks, myLibrary),
      });
    }
    return { user, entries };
  }

  /** Create a playlist from an explicit set of URIs (used to save a compare diff). */
  async createFromUris(name: string, uris: string[]): Promise<{ id: string; count: number }> {
    const id = await this.resources.createPlaylist(name);
    await this.resources.addItems(id, uris);
    return { id, count: uris.length };
  }
}

/** Accept a raw id, a `spotify:user:ID` uri, or an open.spotify.com profile URL. */
export function parseUserId(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("open.spotify.com")) {
    return trimmed.split("?")[0].split("/").filter(Boolean).pop() ?? trimmed;
  }
  if (trimmed.startsWith("spotify:user:")) return trimmed.split(":").pop()!;
  return trimmed;
}
