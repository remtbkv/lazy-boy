// Public entry to the Spotify service layer.
//   const sp = spotifyClient(session.accessToken)
//   const playlists = await sp.myPlaylists()
import { Service } from "./service";

export function spotifyClient(accessToken: string): Service {
  return new Service(accessToken);
}

export { SpotifyError } from "./client";
export type { Track, Playlist, SpotifyUser } from "./types";
export type { CompareEntry } from "./service";
