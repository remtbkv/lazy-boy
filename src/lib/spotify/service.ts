// Feature orchestration: composes Resources (I/O) + domain (pure logic) into the
// operations the UI calls. Specs in docs/FEATURES.md.

import { Resources } from "./resources";
import type { TokenSource } from "./client";
import {
  dedupeByKey,
  findDuplicates,
  intersect,
  mergeUnique,
  subtract,
} from "./domain";
import type { Playlist, Track } from "./types";
import { exactTime } from "@/lib/format";

export type Progress = (collected: number, total: number) => void;

export type CompareEntry = {
  playlist: Playlist;
  unsaved: Track[];
  saved: Track[];
};

export class Service {
  readonly resources: Resources;
  // `patient` rides out rate limits for background bulk work (e.g. cleaning a
  // playlist); forwarded to Resources/HttpClient. Interactive callers omit it so
  // they fail fast and let the UI degrade rather than hang.
  constructor(token: TokenSource, patient = false) {
    this.resources = new Resources(token, patient);
  }

  me() {
    return this.resources.me();
  }
  myPlaylists(onlyMine = false) {
    return this.resources.myPlaylists(onlyMine);
  }
  myPlaylistsAll() {
    return this.resources.myPlaylistsAll();
  }
  playlist(id: string) {
    return this.resources.playlist(id);
  }
  playlistTracks(id: string) {
    return this.resources.playlistTracks(id);
  }
  recentlyPlayed(limit = 50) {
    return this.resources.recentlyPlayed(limit);
  }
  contextName(uri: string) {
    return this.resources.contextName(uri);
  }
  currentlyPlaying() {
    return this.resources.currentlyPlaying();
  }
  addToQueue(uri: string) {
    return this.resources.addToQueue(uri);
  }
  playContext(contextUri: string, offsetUri?: string) {
    return this.resources.playContext(contextUri, offsetUri);
  }
  playTracks(uris: string[]) {
    return this.resources.playTracks(uris);
  }
  nextTrack() {
    return this.resources.nextTrack();
  }
  previousTrack() {
    return this.resources.previousTrack();
  }
  resumePlayback() {
    return this.resources.resumePlayback();
  }
  pausePlayback() {
    return this.resources.pausePlayback();
  }
  saveTrack(id: string) {
    return this.resources.saveTrack(id);
  }

  removeFromPlaylist(playlistId: string, uri: string) {
    return this.resources.removeItems(playlistId, [uri]);
  }

  // Lower-level passthroughs used by the sync + clean orchestration modules
  // (src/lib/sync, src/lib/clean), which compose Spotify writes with the DB store.
  createPlaylist(name: string, isPublic = false) {
    return this.resources.createPlaylist(name, isPublic);
  }
  addItems(playlistId: string, uris: string[]) {
    return this.resources.addItems(playlistId, uris);
  }
  addItemsAt(playlistId: string, uris: string[], position: number) {
    return this.resources.addItemsAt(playlistId, uris, position);
  }
  removeItems(playlistId: string, uris: string[]) {
    return this.resources.removeItems(playlistId, uris);
  }
  replaceItems(playlistId: string, uris: string[]) {
    return this.resources.replaceItems(playlistId, uris);
  }
  savedTracks() {
    return this.resources.savedTracks();
  }
  savedTracksHead() {
    return this.resources.savedTracksHead();
  }
  deletePlaylist(playlistId: string) {
    return this.resources.unfollowPlaylist(playlistId);
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

  /** Duplicates within a single playlist. */
  async findDuplicates(playlistId: string): Promise<Track[]> {
    const tracks = await this.resources.playlistTracks(playlistId);
    return findDuplicates(tracks);
  }

  /** Save the current playback queue to a playlist (Premium + active device).
   *
   *  Spotify's GET /me/player/queue is forbidden for many apps (403), so we use the
   *  original skip-through trick: queue a rare sentinel track followed by the current
   *  track, mute, then skip forward collecting each song until we reach the sentinel,
   *  and finally skip past it back onto the re-queued current track and restore the
   *  position + volume. Paced with small sleeps so fast skipping isn't rate-limited. */
  async saveQueue(): Promise<{ id: string; name: string; count: number }> {
    const SENTINEL_ID = "6sVK7RXMHRGxAefiqEGEbP"; // "bittersweet" by $up1 — unlikely to be queued
    const SENTINEL_URI = `spotify:track:${SENTINEL_ID}`;
    const MAX = 100; // Spotify queues cap around 100
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const start = await this.resources.playbackState();
    if (!start || !start.trackUri) {
      throw new Error("No active device — open Spotify and play a song first.");
    }
    const position = start.progressMs;
    const currentUri = start.trackUri;
    if (!start.isPlaying) await this.resources.resumePlayback();

    // Mute while skipping so it isn't a blast of song intros. Best-effort: some
    // devices (phones) can't be volume-controlled (403) — just carry on unmuted.
    let restoreVolume: number | null = null;
    if (start.volumePercent != null && start.volumePercent > 0) {
      try {
        await this.resources.setVolume(0);
        restoreVolume = start.volumePercent;
      } catch {
        /* device volume not controllable */
      }
    }

    const collected: { id: string; uri: string }[] = [];
    try {
      // Sentinel marks the end of the real queue; re-queue the current track after
      // it so playback lands back where it started.
      await this.resources.addToQueue(SENTINEL_URI);
      await this.resources.addToQueue(currentUri);
      await this.resources.nextTrack();
      await sleep(300);

      const playingTrack = async () =>
        (await this.resources.currentlyPlaying())?.track ?? null;
      let curr = await playingTrack();
      let n = 0;
      while (curr && curr.id !== SENTINEL_ID && n <= MAX + 5) {
        if (n === MAX - 7) await sleep(10000); // let the API's queue view catch up
        collected.push({ id: curr.id, uri: curr.uri });
        n++;
        await this.resources.nextTrack();
        await sleep(300);
        // Wait for the track to actually change; nudge again if it stalls.
        const prevId = curr.id;
        let next: Track | null = curr;
        let nudgedAt = Date.now();
        while (next && next.id === prevId) {
          await sleep(150);
          next = await playingTrack();
          if (Date.now() - nudgedAt > 1500) {
            nudgedAt = Date.now();
            await this.resources.nextTrack();
            next = await playingTrack();
          }
        }
        curr = next;
      }
      // Skip past the sentinel back onto the re-queued current track, then restore.
      await this.resources.nextTrack();
      await sleep(300);
      await this.resources.seek(position);
    } catch (e) {
      // Spotify can refuse a player command (403 "Player command failed") on the
      // back of rapid skipping. If we already collected the queue, that's the part
      // that matters — don't lose it; fall through and still save what we have.
      if (collected.length === 0) throw e;
    } finally {
      if (restoreVolume != null) {
        try {
          await this.resources.setVolume(restoreVolume);
        } catch {
          /* ignore */
        }
      }
    }

    if (collected.length === 0) {
      throw new Error("Nothing to save from queue.");
    }
    // Let any player-command throttling settle before the playlist write, so the
    // save itself isn't refused on the back of all the rapid skipping.
    await sleep(800);
    // Stamp each save with the local date/time so every queue snapshot is a
    // distinct playlist (e.g. "Saved queue — Jun 2, 2026, 3:25 PM").
    const name = `Saved queue — ${exactTime(new Date().toISOString())}`;
    const id = await this.resources.createPlaylist(name);
    await this.resources.addItems(id, collected.map((t) => t.uri));
    return { id, name, count: collected.length };
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
