// Auth.js v5 config — the single place Spotify tokens are minted and refreshed.
// Fixes the prototype's scattered `_ensure_token()` pattern.

import NextAuth, { customFetch } from "next-auth";
import Spotify from "next-auth/providers/spotify";

// Spotify banned `localhost` redirect URIs (Nov 2025): only the loopback IP literal
// `http://127.0.0.1:PORT` is allowed over HTTP. But Next.js normalizes 127.0.0.1 ->
// localhost in request URLs, so Auth.js would otherwise send a `localhost` redirect_uri
// that Spotify rejects. We pin the callback to the loopback IP in both OAuth steps:
//   1. the authorize request (authorization.params.redirect_uri), and
//   2. the token exchange (provider customFetch, below).
// The matching `localhost -> 127.0.0.1` rewrite for the post-login redirect lives in
// src/app/api/auth/[...nextauth]/route.ts. Access the app at http://127.0.0.1:3000.
const ORIGIN = (process.env.AUTH_URL ?? "http://127.0.0.1:3000")
  .replace(/\/$/, "")
  .replace("localhost", "127.0.0.1");
const CALLBACK_URL = `${ORIGIN}/api/auth/callback/spotify`;

// Scopes ported from PlaylistManager.py (read/modify library, playlists, playback).
const SCOPES = [
  "user-read-private",
  "user-read-email",
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
].join(" ");

const TOKEN_URL = "https://accounts.spotify.com/api/token";

// Custom fields we stash on the JWT (kept local so the callbacks don't depend on
// module-augmentation resolution).
type SpotifyToken = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: "RefreshAccessTokenError";
};

async function refreshAccessToken(refreshToken: string) {
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw data;
  return {
    accessToken: data.access_token as string,
    // Spotify may or may not return a new refresh token.
    refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
  };
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Spotify({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      // Include the full url: passing only `params` would drop the provider's
      // default authorization endpoint and break URL construction. The explicit
      // redirect_uri forces the loopback IP in the authorize step.
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        params: { scope: SCOPES, redirect_uri: CALLBACK_URL },
      },
      // Force the same loopback redirect_uri in the token exchange (Auth.js would
      // otherwise send the normalized `localhost` one, which Spotify rejects).
      [customFetch]: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("https://accounts.spotify.com/api/token") && init?.body) {
          const body = init.body;
          if (body instanceof URLSearchParams && body.has("redirect_uri")) {
            body.set("redirect_uri", CALLBACK_URL);
          }
        }
        return fetch(input, init);
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      const t = token as SpotifyToken;
      // Initial sign-in: persist tokens from the provider.
      if (account) {
        t.accessToken = account.access_token;
        t.refreshToken = account.refresh_token;
        t.expiresAt = account.expires_at;
        return t;
      }
      // Still valid (>60s headroom)?
      if (t.expiresAt && Date.now() / 1000 < t.expiresAt - 60) {
        return t;
      }
      // Expired: refresh.
      if (!t.refreshToken) {
        t.error = "RefreshAccessTokenError";
        return t;
      }
      try {
        const refreshed = await refreshAccessToken(t.refreshToken);
        t.accessToken = refreshed.accessToken;
        t.refreshToken = refreshed.refreshToken;
        t.expiresAt = refreshed.expiresAt;
        delete t.error;
      } catch {
        t.error = "RefreshAccessTokenError";
      }
      return t;
    },
    async session({ session, token }) {
      const t = token as SpotifyToken;
      session.accessToken = t.accessToken;
      session.error = t.error;
      return session;
    },
  },
});
