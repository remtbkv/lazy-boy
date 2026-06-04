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
  const images = raw.album?.images ?? [];
  return {
    id: raw.id,
    artist,
    title: raw.name,
    uri: raw.uri,
    album: raw.album?.name,
    albumImage: images.at(-1)?.url ?? images[0]?.url ?? null, // smallest for thumbs
    durationMs: raw.duration_ms,
  };
}

// Spotify HTML-escapes playlist descriptions (&amp;, &#x27;, …); decode the common
// entities so they read as plain text.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function normPlaylist(raw: RawPlaylist): Playlist {
  return {
    id: raw.id,
    name: raw.name,
    // Spotify sometimes stores the literal strings "null"/"undefined" as the
    // description; treat those (and an actual null) as no description.
    description: decodeEntities(
      raw.description && raw.description !== "null" && raw.description !== "undefined"
        ? raw.description
        : "",
    ),
    ownerId: raw.owner.id,
    ownerName: raw.owner.display_name ?? raw.owner.id,
    trackCount: raw.tracks?.total ?? raw.items?.total ?? 0,
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

// The full playlist list paginates the whole library yet changes rarely, and
// both the Me stats and the Playlists grid re-fetch it on every navigation.
// Cache it briefly per access token (single-user app) so revisiting a page is
// instant instead of re-scanning. Native Spotify order is preserved;
// createPlaylist busts the entry.
const PLAYLISTS_TTL_MS = 60_000;
const playlistsCache = new Map<string, { at: number; items: Playlist[] }>();

export class Resources {
  readonly http: HttpClient;
  constructor(
    private accessToken: string,
    patient = false,
  ) {
    this.http = new HttpClient(accessToken, patient);
  }

  /** Whole library in native order, cached for a short TTL. */
  private async allPlaylists(): Promise<Playlist[]> {
    const fresh = this.peekPlaylists();
    if (fresh) return fresh;
    const items = (
      await this.http.getAll<RawPlaylist>("/me/playlists?limit=50")
    ).map(normPlaylist);
    playlistsCache.set(this.accessToken, { at: Date.now(), items });
    return items;
  }

  /** Cached library if still fresh, else null — never triggers a fetch. */
  private peekPlaylists(): Playlist[] | null {
    const hit = playlistsCache.get(this.accessToken);
    return hit && Date.now() - hit.at < PLAYLISTS_TTL_MS ? hit.items : null;
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
  /** Whole library in native Spotify order (for the grid + persistent store). */
  async myPlaylistsAll(): Promise<Playlist[]> {
    return this.allPlaylists();
  }

  async myPlaylists(onlyMine = false): Promise<Playlist[]> {
    const items = await this.allPlaylists();
    const me = onlyMine ? (await this.me()).id : null;
    return [...items]
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
    // Spotify migrated playlist tracks to the `/items` endpoint; the old
    // `/tracks` endpoint now returns 403.
    const items = await this.http.getAll<RawPlaylistTrackItem>(
      `/playlists/${id}/items?limit=100`,
      onProgress,
    );
    const out: Track[] = [];
    for (const i of items) {
      const t = normTrack(i.item ?? i.track ?? null);
      if (t) out.push({ ...t, addedAt: i.added_at });
    }
    return out;
  }

  async createPlaylist(name: string, isPublic = false): Promise<string> {
    // Spotify removed `POST /users/{id}/playlists` in the Feb 2026 API changes;
    // the current create endpoint is `POST /me/playlists` (this was the source of
    // the 403 on Save queue / Clean / Merge). Body fields are unchanged.
    const pl = await this.http.post<{ id: string }>(`/me/playlists`, {
      name,
      public: isPublic,
    });
    // A new playlist makes the cached library stale; drop it so the next read
    // (Me stats, grid) reflects the addition.
    playlistsCache.delete(this.accessToken);
    return pl.id;
  }

  /** Add track URIs in batches of 100. */
  async addItems(playlistId: string, uris: string[]): Promise<void> {
    // Writes go to the `/items` collection (Spotify migrated off `/tracks`).
    for (const batch of chunk(uris, CHUNK)) {
      await this.http.post(`/playlists/${playlistId}/items`, { uris: batch });
    }
  }

  /** Replace a playlist's contents with the given URIs (clears, then adds). */
  async replaceItems(playlistId: string, uris: string[]): Promise<void> {
    // PUT with empty list clears; then add in batches (PUT only accepts up to 100).
    await this.http.put(`/playlists/${playlistId}/items`, { uris: [] });
    await this.addItems(playlistId, uris);
  }

  /** Remove all occurrences of the given track URIs from a playlist. */
  async removeItems(playlistId: string, uris: string[]): Promise<void> {
    // Feb 2026: DELETE moved to `/items` and the body field is `items` (was `tracks`).
    for (const batch of chunk(uris, CHUNK)) {
      await this.http.delete(`/playlists/${playlistId}/items`, {
        items: batch.map((uri) => ({ uri })),
      });
    }
    playlistsCache.delete(this.accessToken);
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
  /** The track playing RIGHT NOW, or null if nothing is actively playing / there
   *  is no active device. The endpoint returns 204 (→ undefined) when idle, so we
   *  never surface stale "last played" data here. */
  async currentlyPlaying(): Promise<{
    track: Track;
    isPlaying: boolean;
    progressMs: number;
    durationMs: number;
    context: { type: string; uri: string } | null;
  } | null> {
    type PlayerState = {
      is_playing?: boolean;
      item?: RawTrack | null;
      currently_playing_type?: string;
      progress_ms?: number;
      context?: { type?: string; uri?: string } | null;
    };
    let data = await this.http.get<PlayerState | undefined>("/me/player/currently-playing");
    // `/me/player/currently-playing` returns 204 (→ undefined) not only when idle
    // but intermittently *during* active playback (right after a track change, or
    // when the desktop client is slow to report) — that's the "not recognizing my
    // player" bug. Fall back to the full player-state endpoint, which still reports
    // the active device's current track when currently-playing comes back empty.
    // `/me/player` also returns 204 when there's genuinely no active device, so this
    // stays live and never shows stale/last-played data.
    if (!data?.item) {
      data = await this.http.get<PlayerState | undefined>("/me/player");
    }
    // normTrack rejects episodes/local files; require a real track item. We no
    // longer gate on currently_playing_type === "track" because /me/player reports
    // it as "unknown" while paused, which would hide a legitimately-loaded track.
    if (!data?.item) return null;
    const track = normTrack(data.item);
    if (!track) return null;
    // normTrack picks the smallest image (for tiny thumbs); the now-playing card
    // is much larger, so use the highest-res album image available here.
    const hiRes = data.item.album?.images?.[0]?.url;
    return {
      track: hiRes ? { ...track, albumImage: hiRes } : track,
      isPlaying: Boolean(data.is_playing),
      progressMs: data.progress_ms ?? 0,
      durationMs: track.durationMs ?? 0,
      context: data.context?.uri
        ? { type: data.context.type ?? "", uri: data.context.uri }
        : null,
    };
  }

  /** Add a track to the active device's playback queue. 404 if no active device. */
  async addToQueue(uri: string): Promise<void> {
    await this.http.post(`/me/player/queue?uri=${encodeURIComponent(uri)}`);
  }

  /** Start playback of a context (playlist/album) on the active device, optionally
   *  jumping to a specific track URI within it. 404 if no active device. */
  async playContext(contextUri: string, offsetUri?: string): Promise<void> {
    await this.http.put("/me/player/play", {
      context_uri: contextUri,
      ...(offsetUri ? { offset: { uri: offsetUri } } : {}),
    });
  }

  /** Transport controls for the active device. Each 404s with no active device. */
  async nextTrack(): Promise<void> {
    await this.http.post("/me/player/next");
  }
  async previousTrack(): Promise<void> {
    await this.http.post("/me/player/previous");
  }
  async resumePlayback(): Promise<void> {
    await this.http.put("/me/player/play");
  }
  async pausePlayback(): Promise<void> {
    await this.http.put("/me/player/pause");
  }
  async seek(positionMs: number): Promise<void> {
    await this.http.put(`/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}`);
  }

  /** Full player state incl. device volume; null when there's no active device.
   *  (`/me/player/currently-playing` omits the device, which save-queue needs to
   *  restore the volume after muting.) */
  async playbackState(): Promise<{
    isPlaying: boolean;
    progressMs: number;
    trackId: string | null;
    trackUri: string | null;
    volumePercent: number | null;
  } | null> {
    const data = await this.http.get<
      | {
          is_playing?: boolean;
          progress_ms?: number;
          item?: { id?: string; uri?: string; type?: string } | null;
          device?: { volume_percent?: number | null } | null;
        }
      | undefined
    >("/me/player");
    if (!data || !data.item?.uri) return null;
    return {
      isPlaying: Boolean(data.is_playing),
      progressMs: data.progress_ms ?? 0,
      trackId: data.item.id ?? null,
      trackUri: data.item.uri ?? null,
      volumePercent: data.device?.volume_percent ?? null,
    };
  }

  /** Set active-device volume (0–100). 403s on devices that can't be controlled
   *  (e.g. phones) — callers treat that as "couldn't mute" and carry on. */
  async setVolume(percent: number): Promise<void> {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    await this.http.put(`/me/player/volume?volume_percent=${v}`);
  }

  /** Save a track to the user's Liked Songs. The Feb 2026 API changes removed
   *  `PUT /me/tracks` for Development-Mode apps in favour of the generic library
   *  endpoint, which takes Spotify URIs rather than bare IDs. */
  async saveTrack(id: string): Promise<void> {
    await this.http.put(`/me/library`, { uris: [`spotify:track:${id}`] });
  }

  /** The user's last-played tracks with timestamps and the context (playlist/
   *  album/artist) they were played from. Feeds the local listen-history store. */
  async recentlyPlayed(
    limit = 50,
  ): Promise<
    { track: Track; playedAt: string; contextType: string | null; contextUri: string | null }[]
  > {
    const data = await this.http.get<{
      items: {
        track: RawTrack;
        played_at: string;
        context: { type: string; uri: string } | null;
      }[];
    }>(`/me/player/recently-played?limit=${limit}`);
    const out: {
      track: Track;
      playedAt: string;
      contextType: string | null;
      contextUri: string | null;
    }[] = [];
    for (const it of data.items) {
      const t = normTrack(it.track);
      if (!t) continue;
      out.push({
        track: t,
        playedAt: it.played_at,
        contextType: it.context?.type ?? null,
        contextUri: it.context?.uri ?? null,
      });
    }
    return out;
  }

  /** Resolve a playback context URI (spotify:playlist/album/artist:ID) to its
   *  name, so listen history can show "from <playlist>" instead of "playlist".
   *  Returns null if unresolvable (e.g. dev-mode 403 on a non-owned playlist). */
  async contextName(uri: string): Promise<{ name: string; type: string } | null> {
    const m = uri.match(/^spotify:(playlist|album|artist):([A-Za-z0-9]+)/);
    if (!m) return null;
    const [, type, id] = m;
    const endpoint =
      type === "playlist"
        ? `/playlists/${id}?fields=name`
        : type === "album"
          ? `/albums/${id}`
          : `/artists/${id}`;
    try {
      const d = await this.http.get<{ name: string }>(endpoint);
      return { name: d.name, type };
    } catch {
      return null;
    }
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
