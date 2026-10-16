// The Spotify scopes Lazy Boy asks for (src/lib/auth.ts). PLAN.md §12.1 drops `user-read-email`
// and `user-read-private`: development mode returns no e-mail, nothing reads `product`, and no
// request uses `market=from_token`. It waits on evidence that /v1/me still returns `account_id`
// (the sign-in link, PLAN §5.1) with the smaller set: Phase 4a's turn sets DROP_PROFILE_SCOPES
// from Rem's probe (~/.claude/broke/scratch/lazyboy_mu/probe/me_keys_reduced.json), true only if
// it shows `has_account_id`. It takes effect at each user's next consent.
export const DROP_PROFILE_SCOPES = false;

const PROFILE_SCOPES = ["user-read-private", "user-read-email"];

const APP_SCOPES = [
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "user-read-recently-played",
  "user-read-playback-position",
];

export function spotifyScopes(dropProfile = DROP_PROFILE_SCOPES): string {
  return [...(dropProfile ? [] : PROFILE_SCOPES), ...APP_SCOPES].join(" ");
}
