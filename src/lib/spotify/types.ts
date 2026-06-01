// Domain + Spotify API types. The app works with the normalized `Track`; raw
// Spotify JSON is only handled inside resources.ts.

/** Normalized track used everywhere in the app. */
export type Track = {
  id: string;
  artist: string; // primary artist name
  title: string;
  uri: string;
};

export type Playlist = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  trackCount: number;
  image: string | null;
  public: boolean;
  collaborative: boolean;
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
  artists: RawArtist[];
  album?: { images: RawImage[] };
};

export type RawPlaylistTrackItem = { track: RawTrack | null };
export type RawSavedTrackItem = { track: RawTrack | null };

export type RawPlaylist = {
  id: string;
  name: string;
  owner: { id: string; display_name?: string };
  tracks: { total: number };
  images: RawImage[];
  public: boolean;
  collaborative: boolean;
};
