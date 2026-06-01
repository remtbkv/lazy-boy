// Typed Spotify endpoints + normalization to domain types. Built on HttpClient.
// Everything above this layer works with Track/Playlist, never raw Spotify JSON.

import { HttpClient } from "./client";
import type {
  Playlist,
  RawPlaylist,
  RawPlaylistTrackItem,
  RawSavedTrackItem,
  RawTrack,
  SpotifyUser,
  Track,
} from "./types";

const CHUNK = 100;

function normTrack(raw: RawTrack | null): Track | null {
  if (!raw || !raw.id || raw.is_local || raw.type === "episode") return null;
  const artist = raw.artists?.[0]?.name;
  if (!artist) return null;
  return { id: raw.id, artist, title: raw.name, uri: raw.uri };
}

function normPlaylist(raw: RawPlaylist): Playlist {
  return {
    id: raw.id,
    name: raw.name,
    ownerId: raw.owner.id,
    ownerName: raw.owner.display_name ?? raw.owner.id,
    trackCount: raw.tracks?.total ?? 0,
    image: raw.images?.[0]?.url ?? null,
    public: raw.public,
    collaborative: raw.collaborative,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class Resources {
  readonly http: HttpClient;
  constructor(accessToken: string) {
    this.http = new HttpClient(accessToken);
  }

  // ---- current user ----
  async me(): Promise<SpotifyUser> {
    const u = await this.http.get<{
      id: string;
      display_name?: string;
      images?: { url: string }[];
      product?: string;
    }>("/me");
    return {
      id: u.id,
      displayName: u.display_name ?? u.id,
      image: u.images?.[0]?.url ?? null,
      product: u.product,
    };
  }

  // ---- playlists ----
  async myPlaylists(onlyMine = false): Promise<Playlist[]> {
    const items = await this.http.getAll<RawPlaylist>("/me/playlists?limit=50");
    const me = onlyMine ? (await this.me()).id : null;
    return items
      .map(normPlaylist)
      .filter((p) => !onlyMine || p.ownerId === me)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  async playlist(id: string): Promise<Playlist> {
    const raw = await this.http.get<RawPlaylist>(`/playlists/${id}`);
    return normPlaylist(raw);
  }

  async playlistTracks(
    id: string,
    onProgress?: (collected: number, total: number) => void,
  ): Promise<Track[]> {
    const items = await this.http.getAll<RawPlaylistTrackItem>(
      `/playlists/${id}/tracks?limit=100`,
      onProgress,
    );
    return items.map((i) => normTrack(i.track)).filter((t): t is Track => t !== null);
  }

  async createPlaylist(name: string, isPublic = false): Promise<string> {
    const me = await this.me();
    const pl = await this.http.post<{ id: string }>(`/users/${me.id}/playlists`, {
      name,
      public: isPublic,
    });
    return pl.id;
  }

  /** Add track URIs in batches of 100. */
  async addItems(playlistId: string, uris: string[]): Promise<void> {
    for (const batch of chunk(uris, CHUNK)) {
      await this.http.post(`/playlists/${playlistId}/tracks`, { uris: batch });
    }
  }

  /** Replace a playlist's contents with the given URIs (clears, then adds). */
  async replaceItems(playlistId: string, uris: string[]): Promise<void> {
    // PUT with empty list clears; then add in batches (PUT only accepts up to 100).
    await this.http.put(`/playlists/${playlistId}/tracks`, { uris: [] });
    await this.addItems(playlistId, uris);
  }

  // ---- library ----
  async savedTracks(
    onProgress?: (collected: number, total: number) => void,
  ): Promise<Track[]> {
    const items = await this.http.getAll<RawSavedTrackItem>(
      "/me/tracks?limit=50",
      onProgress,
    );
    return items.map((i) => normTrack(i.track)).filter((t): t is Track => t !== null);
  }

  // ---- player ----
  /** Current track followed by the upcoming queue (Premium + active device). */
  async queue(): Promise<Track[]> {
    const data = await this.http.get<{
      currently_playing: RawTrack | null;
      queue: RawTrack[];
    }>("/me/player/queue");
    const all = [data.currently_playing, ...(data.queue ?? [])];
    return all.map(normTrack).filter((t): t is Track => t !== null);
  }

  // ---- other users (public) ----
  async user(id: string): Promise<SpotifyUser> {
    const u = await this.http.get<{
      id: string;
      display_name?: string;
      images?: { url: string }[];
    }>(`/users/${id}`);
    return {
      id: u.id,
      displayName: u.display_name ?? u.id,
      image: u.images?.[0]?.url ?? null,
    };
  }

  async userPlaylists(userId: string): Promise<Playlist[]> {
    const items = await this.http.getAll<RawPlaylist>(
      `/users/${userId}/playlists?limit=50`,
    );
    return items
      .map(normPlaylist)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
}
