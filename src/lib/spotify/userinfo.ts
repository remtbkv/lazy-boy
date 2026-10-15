// Sign-in's profile read (the Spotify provider's userinfo step in src/lib/auth.ts).
//
// Spotify keeps this app in development mode, so only accounts on its User Management
// allowlist may use it. For anyone else, GET /v1/me answers 403 with a plain-text body
// ("The user is not registered for this application..."). Auth.js parsed the userinfo
// response as JSON, so that body threw a SyntaxError inside the OAuth callback and the
// person landed on Auth.js's generic "problem with the server configuration" page (seen in
// production on 2026-10-14). Reading /v1/me here turns that answer into a profile the
// signIn callback recognises and sends to a clear message on /login.
//
// A raw fetch, not client.ts: client.ts retries 403 as a rate limit, and this 403 is final.
// It runs once per sign-in, inside Auth.js's own OAuth step, never from app code.

export const SPOTIFY_NOT_REGISTERED = "spotify-not-registered";

type SpotifyProfile = {
  id: string;
  display_name: string | null;
  email: string | null;
  images: { url: string }[];
  [key: string]: unknown;
};

export async function spotifyUserinfo({
  tokens,
}: {
  tokens: { access_token?: string };
}): Promise<SpotifyProfile> {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const body = await res.text();
  if (!res.ok) {
    console.warn(`[auth] spotify /v1/me answered ${res.status}: ${body.slice(0, 200)}`);
    return { id: SPOTIFY_NOT_REGISTERED, display_name: null, email: null, images: [] };
  }
  return JSON.parse(body) as SpotifyProfile;
}
