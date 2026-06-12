// Auth.js v5 config — the single place Spotify tokens are minted and refreshed.
// Fixes the prototype's scattered `_ensure_token()` pattern.

import NextAuth, { customFetch } from "next-auth";
import Spotify from "next-auth/providers/spotify";
import {
  getSpotifyTokens,
  setSpotifyTokens,
  clearSpotifyTokens,
  acquireLock,
  releaseLock,
  type SpotifyTokens,
} from "@/lib/db";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `terminal` distinguishes a genuinely dead refresh token (revoked / re-consent
// needed → force re-login) from a transient failure (token endpoint rate-limited,
// network blip → keep the session and retry later). Only terminal failures should
// log the user out; a transient one must not.
class RefreshError extends Error {
  terminal: boolean;
  constructor(terminal: boolean, message: string) {
    super(message);
    this.name = "RefreshError";
    this.terminal = terminal;
  }
}

async function refreshAccessToken(refreshToken: string) {
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  // Up to 3 tries with small, bounded backoff. Bounded so a slow token endpoint
  // can't hang the page render — we'd rather keep the session and retry next load.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        // Hard timeout: a slow/hanging token endpoint must NOT block the page
        // render (the layout awaits auth()). On timeout we fall back to the
        // existing session and retry on a later request.
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      // Network error or timeout: at most one retry, so render is never blocked
      // for more than ~10s before falling back to the current session.
      if (attempt >= 1) throw new RefreshError(false, `network: ${String(e)}`);
      await sleep(300 * (attempt + 1));
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      return {
        accessToken: data.access_token as string,
        // Spotify may or may not return a new refresh token.
        refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
      };
    }

    const data = await res.json().catch(() => ({}) as { error?: string });
    // A revoked/invalid refresh token is the one case that truly needs re-login.
    if (res.status === 400 && data?.error === "invalid_grant") {
      throw new RefreshError(true, "invalid_grant");
    }
    // Rate-limited or server error: retry, then give up transiently (no logout).
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(300 * (attempt + 1));
      continue;
    }
    throw new RefreshError(false, `token endpoint ${res.status}`);
  }
}

// Guard against a cross-process rotation race wiping good tokens. A terminal
// `invalid_grant` only means the refresh token *we* sent is dead — but if another
// process already refreshed successfully in the meantime, the stored refresh token
// has moved on and is still valid. Only clear when what's stored is still the exact
// token we just failed with; otherwise someone else won the race, so keep theirs.
async function clearTokensIfStale(attemptedRefreshToken: string): Promise<void> {
  const current = await getSpotifyTokens();
  if (!current || current.refreshToken === attemptedRefreshToken) {
    await clearSpotifyTokens();
  }
}

const isFresh = (t: SpotifyTokens) => Date.now() / 1000 < t.expiresAt - 60;

// In-process lock: concurrent requests in THIS instance that all see an expired
// token share ONE refresh instead of each firing their own (which, with Spotify's
// rotating PKCE refresh token, would invalidate each other and log the user out).
let inflightRefresh: Promise<SpotifyTokens> | null = null;
function refreshShared(refreshToken: string): Promise<SpotifyTokens> {
  if (!inflightRefresh) {
    inflightRefresh = coordinatedRefresh(refreshToken).finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

// Cross-INSTANCE coordination for serverless: the in-process lock above only covers
// one instance, but Vercel can run several. The DB is the shared source of truth, so:
//   1) double-check the DB — another request/instance may have already refreshed;
//   2) take a short-lived DB lock so only one refresh hits Spotify with a given
//      rotating token; losers poll the DB for the winner's freshly-written token.
// This is what stops concurrent cold starts from racing into invalid_grant.
async function coordinatedRefresh(triedToken: string): Promise<SpotifyTokens> {
  let current = await getSpotifyTokens();
  if (current && isFresh(current)) return current;

  for (let attempt = 0; attempt < 2; attempt++) {
    const lockOwner = await acquireLock("spotify_refresh", 15_000);
    if (lockOwner) {
      try {
        current = await getSpotifyTokens(); // the winner may have just written
        if (current && isFresh(current)) return current;
        const updated = await refreshAccessToken(current?.refreshToken ?? triedToken);
        await setSpotifyTokens(updated);
        return updated;
      } finally {
        await releaseLock("spotify_refresh", lockOwner);
      }
    }
    // Lost the lock — wait for whoever holds it to publish a fresh token.
    const published = await waitForFreshToken(10_000);
    if (published) return published;
    // Holder stalled/crashed; loop to retry (its lock TTL has likely expired).
  }
  // Last resort: refresh ourselves rather than fail the request.
  const updated = await refreshAccessToken(triedToken);
  await setSpotifyTokens(updated);
  return updated;
}

// Freshness alone proves the winner published: callers only wait here after seeing an
// expired stored token, so any fresh one is new. (Don't also require the refresh token
// to have changed — Spotify doesn't always rotate it, and that check made losers stare
// at a perfectly good token for the whole timeout, then refresh redundantly.)
async function waitForFreshToken(timeoutMs: number): Promise<SpotifyTokens | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    const t = await getSpotifyTokens();
    if (t && isFresh(t)) return t;
  }
  return null;
}

// Server-side, session-less access token for background jobs (e.g. the daily cron
// sync) that run without a request. Reuses the same stored tokens and shared
// refresh lock as the request path, so background and request refreshes coordinate
// (no PKCE rotation races). Returns null when nobody's signed in or refresh is dead.
export async function getValidAccessToken(): Promise<string | null> {
  const stored = await getSpotifyTokens();
  if (!stored) return null;
  if (Date.now() / 1000 < stored.expiresAt - 60) return stored.accessToken;
  try {
    const fresh = await refreshShared(stored.refreshToken);
    return fresh.accessToken;
  } catch (e) {
    if (e instanceof RefreshError && e.terminal) await clearTokensIfStale(stored.refreshToken);
    return null;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  // We serve on the loopback IP (127.0.0.1) and wrap the route handler, a non-standard
  // host setup. Trust it explicitly so Auth.js never refuses the host with a generic
  // "server configuration" error.
  trustHost: true,
  // Persistent JWT session: the session cookie carries a 30-day expiry so you
  // stay signed in across browser restarts. The Spotify access token inside it
  // is short-lived (~1h) but is silently refreshed in the jwt callback below, so
  // the long-lived session never forces a re-login as long as the refresh works.
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
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
      // Initial sign-in: stash tokens in the DB (the source of truth) and keep the
      // cookie lean. The DB lets concurrent refreshes coordinate (see refreshShared).
      if (account) {
        const tokens = {
          accessToken: account.access_token!,
          refreshToken: account.refresh_token!,
          expiresAt: account.expires_at!,
        };
        try {
          await setSpotifyTokens(tokens);
          // Stored in the DB (the source of truth) — keep the cookie lean.
          delete t.accessToken;
          delete t.refreshToken;
          delete t.expiresAt;
        } catch {
          // DB write failed (e.g. a transient Turso hiccup). Don't fail the whole
          // login with a server error — keep the tokens in the JWT cookie instead; the
          // migration path below moves them to the DB on a later request once it's back.
          t.accessToken = tokens.accessToken;
          t.refreshToken = tokens.refreshToken;
          t.expiresAt = tokens.expiresAt;
        }
        delete t.error;
        return t;
      }

      let stored = await getSpotifyTokens();
      // Migrate older sessions that kept tokens in the cookie into the DB once.
      if (!stored && t.refreshToken && t.accessToken && t.expiresAt) {
        stored = {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAt: t.expiresAt,
        };
        await setSpotifyTokens(stored);
        delete t.accessToken;
        delete t.refreshToken;
        delete t.expiresAt;
      }
      if (!stored) {
        t.error = "RefreshAccessTokenError";
        return t;
      }
      // Still valid (>60s headroom)?
      if (Date.now() / 1000 < stored.expiresAt - 60) {
        delete t.error;
        return t;
      }
      // Expired: refresh through the shared lock, always using the latest token.
      try {
        await refreshShared(stored.refreshToken);
        delete t.error;
      } catch (e) {
        if (e instanceof RefreshError && e.terminal) {
          // Refresh token is genuinely dead → real re-login required, unless another
          // process already rotated to a fresh one (then this failure is a stale race).
          await clearTokensIfStale(stored.refreshToken);
          if (await getSpotifyTokens()) delete t.error;
          else t.error = "RefreshAccessTokenError";
        }
        // Transient failure: keep the session; the next request retries.
      }
      return t;
    },
    async session({ session, token }) {
      const t = token as SpotifyToken;
      session.accessToken = (await getSpotifyTokens())?.accessToken;
      session.error = t.error;
      return session;
    },
  },
});
