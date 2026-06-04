// Domain + Spotify API types. The app works with the normalized `Track`; raw
// Spotify JSON is only handled inside resources.ts.

/** Normalized track used everywhere in the app. The optional fields are only
 *  populated where the source response carries them (e.g. playlist detail). */
export type Track = {
  id: string;
  artist: string; // primary artist name
  title: string;
  uri: string;
  album?: string;
  albumImage?: string | null;
  durationMs?: number;
  addedAt?: string; // when added to the playlist (ISO), playlist detail only
};

export type Playlist = {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  trackCount: number;
  image: string | null;
  public: boolean;
  collaborative: boolean;
  // Changes only when the playlist's contents change — used to skip re-fetching a
  // playlist's tracks when nothing has changed.
  snapshot?: string;
};

export type SpotifyUser = {
  id: string;
  displayName: string;
  image: string | null;
  product?: string; // "premium" | "free" | ...
};

export type QueueItem = Track;

// ---- Raw Spotify API shapes (only what we read) ----

export type Paging<T> = {
  items: T[];
  next: string | null;
  total: number;
};

export type RawArtist = { name: string };
export type RawImage = { url: string };

export type RawTrack = {
  id: string | null;
  name: string;
  uri: string;
  is_local?: boolean;
  type?: string; // "track" | "episode"
  duration_ms?: number;
  artists: RawArtist[];
  album?: { name?: string; images?: RawImage[] };
};

// The `/playlists/{id}/items` endpoint nests the track under `item`; the older
// `/tracks` shape used `track`. Accept either.
export type RawPlaylistTrackItem = {
  item?: RawTrack | null;
  track?: RawTrack | null;
  added_at?: string;
};
export type RawSavedTrackItem = { track: RawTrack | null };

export type RawPlaylist = {
  id: string;
  name: string;
  description?: string | null;
  owner: { id: string; display_name?: string };
  // Spotify returns the track-paging object under `tracks` for some responses
  // and under `items` for others (both are `{ total, ... }`). Read either.
  tracks?: { total: number };
  items?: { total: number };
  images: RawImage[];
  public: boolean;
  collaborative: boolean;
  snapshot_id?: string;
};
