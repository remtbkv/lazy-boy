// Auth.js v5 config — the single place Spotify tokens are minted and refreshed.
// Fixes the prototype's scattered `_ensure_token()` pattern.

import NextAuth from "next-auth";
import Spotify from "next-auth/providers/spotify";

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
      authorization: { params: { scope: SCOPES } },
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
