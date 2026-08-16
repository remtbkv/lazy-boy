// Public entry to the Spotify service layer.
//   const sp = spotifyClient(await spotifyAccessToken())   // server-only; see lib/auth.ts
//   const playlists = await sp.myPlaylists()
import { Service } from "./service";
import type { TokenSource } from "./client";

// `patient` opts the client into riding out rate limits — only for background bulk
// work (e.g. cleaning a playlist). Interactive callers omit it so they fail fast
// and let the UI degrade rather than hang.
// `token` is the request's access token for interactive use, or a getter returning a
// currently-valid one for background work that can outlive a single token (see
// actions.ts → refreshingToken).
export function spotifyClient(token: TokenSource, patient = false, source = "untagged"): Service {
  return new Service(token, patient, source);
}

export { SpotifyError } from "./client";
export type { TokenSource } from "./client";
export type { Track, Playlist, SpotifyUser } from "./types";
export type { CompareEntry } from "./service";
