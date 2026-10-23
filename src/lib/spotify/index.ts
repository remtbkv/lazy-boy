// Public entry to the Spotify service layer.
//   const sp = spotifyClient(uid, await spotifyAccessTokenFor(uid))   // server-only; lib/auth.ts
//   const playlists = await sp.myPlaylists()
import type { Uid } from "@/lib/identity";
import { Service } from "./service";
import type { TokenSource } from "./client";

// `patient` opts the client into riding out rate limits — only for background bulk
// work (e.g. cleaning a playlist). Interactive callers omit it so they fail fast
// and let the UI degrade rather than hang.
// `token` is the request's access token for interactive use, or a getter returning a
// currently-valid one for background work that can outlive a single token (see
// actions.ts → refreshingToken).
// `owner` is the user the client acts for: each token must name them (TokenOwnerError
// otherwise) and each api_log row is tagged with them.
export function spotifyClient(owner: Uid, token: TokenSource, patient = false, source = "untagged"): Service {
  return new Service(token, patient, source, owner);
}

export { DeadlineError, SpotifyError, TokenOwnerError, spotifyCooldownMs } from "./client";
export type { OwnedToken, TokenSource } from "./client";
export type { Track, Playlist, SpotifyUser } from "./types";
export type { CompareEntry } from "./service";
