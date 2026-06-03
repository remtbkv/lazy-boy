// Public entry to the Spotify service layer.
//   const sp = spotifyClient(session.accessToken)
//   const playlists = await sp.myPlaylists()
import { Service } from "./service";

// `patient` opts the client into riding out rate limits — only for background bulk
// work (e.g. cleaning a playlist). Interactive callers omit it so they fail fast
// and let the UI degrade rather than hang.
export function spotifyClient(accessToken: string, patient = false): Service {
  return new Service(accessToken, patient);
}

export { SpotifyError } from "./client";
export type { Track, Playlist, SpotifyUser } from "./types";
export type { CompareEntry } from "./service";
