// Typed Spotify endpoints + normalization to domain types. Built on HttpClient.
// Everything above this layer works with Track/Playlist, never raw Spotify JSON.

import { HttpClient, SpotifyError, type TokenSource } from "./client";
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
    snapshot: raw.snapshot_id,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The full playlist list paginates the whole library yet changes rarely, and
// both the Me stats and the Playlists grid re-fetch it on every navigation.
// Cache it briefly so revisiting a page is instant instead of re-scanning. One
// process-wide entry: this is a single-user app, so keying by access token only bought
// a guaranteed cache miss every hourly token rotation (and a leaked entry per rotation).
// Native Spotify order is preserved; create/remove/unfollow bust it.
const PLAYLISTS_TTL_MS = 60_000;
let playlistsCache: { at: number; items: Playlist[] } | null = null;

export class Resources {
  readonly http: HttpClient;
  constructor(token: TokenSource, patient = false) {
    this.http = new HttpClient(token, patient);
  }

  /** Whole library in native order, cached for a short TTL. */
  private async allPlaylists(): Promise<Playlist[]> {
    const fresh = this.peekPlaylists();
    if (fresh) return fresh;
    const items = (
      await this.http.getAll<RawPlaylist>("/me/playlists?limit=50")
    ).map(normPlaylist);
    playlistsCache = { at: Date.now(), items };
    return items;
  }

  /** Cached library if still fresh, else null — never triggers a fetch. */
  private peekPlaylists(): Playlist[] | null {
    return playlistsCache && Date.now() - playlistsCache.at < PLAYLISTS_TTL_MS
      ? playlistsCache.items
      : null;
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
      // Always blank — never let a placeholder ("no"/null/a coerced boolean) land in the
      // description, which is public-facing in the user's Spotify.
      description: "",
    });
    // A new playlist makes the cached library stale; drop it so the next read
    // (Me stats, grid) reflects the addition.
    playlistsCache = null;
    return pl.id;
  }

  /** Add track URIs in batches of 100. */
  async addItems(playlistId: string, uris: string[]): Promise<void> {
    // Writes go to the `/items` collection (Spotify migrated off `/tracks`).
    for (const batch of chunk(uris, CHUNK)) {
      await this.http.post(`/playlists/${playlistId}/items`, { uris: batch });
    }
    // The cached library list now carries a stale snapshot/trackCount for this playlist;
    // drop it so a sync inside the TTL doesn't skip the re-fetch (mirrors removeItems).
    playlistsCache = null;
  }

  /** Insert track URIs starting at `position` (playlist order), batched. Used by the
   *  clean reconcile to put a wrongly-removed track back where it belongs. */
  async addItemsAt(playlistId: string, uris: string[], position: number): Promise<void> {
    let pos = position;
    for (const batch of chunk(uris, CHUNK)) {
      await this.http.post(`/playlists/${playlistId}/items`, { uris: batch, position: pos });
      pos += batch.length;
    }
  }

  /** Delete (unfollow) one of the user's own playlists. Spotify has no hard "delete";
   *  removing your follow is how a playlist disappears from your library. */
  async unfollowPlaylist(playlistId: string): Promise<void> {
    await this.http.delete(`/playlists/${playlistId}/followers`);
    playlistsCache = null;
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
    playlistsCache = null;
  }

  // ---- library ----
  async savedTracks(
    onProgress?: (collected: number, total: number) => void,
  ): Promise<Track[]> {
    const items = await this.http.getAll<RawSavedTrackItem>(
      "/me/tracks?limit=50",
      onProgress,
    );
    const out: Track[] = [];
    for (const i of items) {
      const t = normTrack(i.track);
      if (t) out.push({ ...t, addedAt: i.added_at });
    }
    return out;
  }

  /** Cheap Liked-Songs change-probe: total count + the newest added_at, without
   *  paging the whole list. `/me/tracks` is ordered newest-first, so item 0's
   *  added_at is the latest add. Lets a sync skip the full re-fetch when nothing changed. */
  async savedTracksHead(): Promise<{ total: number; topAddedAt: string | null }> {
    const page = await this.http.get<{ total: number; items: RawSavedTrackItem[] }>(
      "/me/tracks?limit=1",
    );
    return { total: page.total ?? 0, topAddedAt: page.items[0]?.added_at ?? null };
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

  /** Play specific track URIs on the active device (no playlist context — e.g. playing
   *  a single song from history). 404 if no active device. */
  async playTracks(uris: string[]): Promise<void> {
    await this.http.put("/me/player/play", { uris });
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

  /** Save a track to the user's Liked Songs via the documented endpoint, `PUT
   *  /me/tracks?ids=…` (the read side uses GET /me/tracks too). Needs the
   *  `user-library-modify` scope; works for the app owner even in Development Mode. */
  async saveTrack(id: string): Promise<void> {
    await this.http.put(`/me/tracks?ids=${encodeURIComponent(id)}`);
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
    } catch (e) {
      // 403/404 are permanent for this context (dev-mode forbidden / deleted) — null
      // tells the caller to negative-cache it so it isn't re-fetched every sync.
      // Anything else (429, network) is transient: rethrow so it stays unresolved
      // and gets retried next sync instead of being cached as dead.
      if (e instanceof SpotifyError && (e.status === 403 || e.status === 404)) return null;
      throw e;
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
