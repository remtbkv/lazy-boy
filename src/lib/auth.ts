// Auth.js v5 config — the single place Spotify tokens are minted and refreshed.
// Fixes the prototype's scattered `_ensure_token()` pattern.

import NextAuth, { customFetch } from "next-auth";
import Spotify from "next-auth/providers/spotify";
import { cookies } from "next/headers";
import { cache } from "react";
import { mintUid, ownerUid, type IdentityVerdict, type Uid } from "@/lib/identity";
import { markGrantDead } from "@/lib/app-db";
import { readIdentity, resolveSignIn, signedInUser, signInRedirect } from "@/lib/identity-read";
import { isOwnerSignIn } from "@/lib/owner";
import { REQUEST_COOKIE, verifyRequestCookie } from "@/lib/request-cookie";
import { spotifyScopes } from "@/lib/scopes";
import { gateJwt, sessionFields, signInClaims } from "@/lib/session-gate";
import type { OwnedToken } from "@/lib/spotify";
import { SPOTIFY_NOT_REGISTERED, SPOTIFY_UNAVAILABLE, spotifyUserinfo } from "@/lib/spotify/userinfo";
import { createTokenCore, isFresh, RefreshError, type UserTokens } from "@/lib/token-core";
import { withAdminTokenMove } from "@/lib/token-move";
import { appTokenStore } from "@/lib/token-store-app";

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

// Scopes ported from PlaylistManager.py (read/modify library, playlists, playback); the two
// profile scopes go when scopes.ts's DROP_PROFILE_SCOPES says so (PLAN.md §12.1).
const SCOPES = spotifyScopes();

// Custom fields we stash on the JWT (kept local so the callbacks don't depend on
// module-augmentation resolution).
type SpotifyToken = {
  uid?: string;
  ep?: number;
  auth_time?: number;
  error?: "RefreshAccessTokenError";
};

// The token core, per user (src/lib/token-core.ts: the refresh, the in-flight map and the lock,
// all keyed by uid), over Phase 2's encrypted `user_tokens` (token-store-app.ts). The admin's
// first read in a process copies his plaintext `meta` row in once ever, or, with
// LB_TOKEN_ROLLBACK=1, writes it back (token-move.ts, PLAN.md §11.4).
const core = createTokenCore(withAdminTokenMove(appTokenStore(), ownerUid), { onDeadGrant: (uid) => markGrantDead(uid, Date.now()) });

// ── Request-scoped reads ───────────────────────────────────────────────────────────────
// One tokens read per request instead of one per callback. /home calls auth() twice (the
// (app) layout and home/page), and each call read the tokens row in BOTH the jwt and the
// session callback — 4 serial primary round trips (~20-30ms median each, tails to 700ms)
// before any content. React cache() scopes this box to the request, so they share one read.
// The box holds the PROMISE, and every write/refresh republishes it, so a later read in the
// same request sees the fresh tokens instead of the pre-refresh snapshot. It is keyed by uid,
// so two users can never share a box even where cache() is a pass-through.
// Outside a request (the cron path) cache() has no dispatcher and is a pass-through: each
// call gets a fresh box, i.e. a plain direct read. Anything that polls or double-checks the
// DB across instances (the token core's refresh paths, getValidAccessToken) deliberately
// reads DIRECTLY — those need real-time state, not this request's snapshot.
const tokenBox = cache((_uid: Uid) => ({ p: null as Promise<UserTokens | null> | null }));
function readTokensShared(uid: Uid): Promise<UserTokens | null> {
  const box = tokenBox(uid);
  box.p ??= core.getStored(uid);
  return box.p;
}
/** Publish what the DB now holds (null after a clear) so later reads in this request don't
 *  serve a stale — or dead — token. */
function publishTokens(uid: Uid, t: UserTokens | null): void {
  tokenBox(uid).p = Promise.resolve(t);
}

// The identity read (docs/multi-user/PLAN.md §5.1), once per request per cookie: the jwt
// callback and the session callback ask the same box. It reads the app database's `users` row
// under SIGNUPS (identity-read.ts); a read that throws, or token keys that fail their
// sentinel, is the "unavailable" outcome.
const identityFor = cache(
  (uid: unknown, ep: unknown, authTime: unknown): Promise<IdentityVerdict> =>
    readIdentity({ uid, ep, auth_time: authTime }),
);

/** The Spotify access token for THIS request — server-only, and deliberately NOT a field on
 *  the session.
 *
 *  It used to be `session.accessToken`, which Auth.js serializes straight to the browser at
 *  `GET /api/auth/session`: any authenticated request there — so any script running on the
 *  origin — got back a live token carrying all 13 scopes, including the modify ones. Nothing
 *  client-side ever read it (this app mounts no SessionProvider), so it now travels through
 *  the request-scoped token box instead of through the session object.
 *
 *  CALL IT AFTER auth() IN THE SAME REQUEST. The jwt callback is what refreshes an expired
 *  token and publishes the result into the box; on its own this returns whatever is stored,
 *  fresh or not. That ordering is the reason this is a bare accessor and not another refresh
 *  path — refresh stays centralized in the jwt callback and getValidAccessToken (rule 3).
 *
 *  Free: it reads the box the jwt callback already populated — the same read the session
 *  callback used to make to fill the field in. */
export async function spotifyAccessTokenFor(uid: Uid): Promise<OwnedToken | undefined> {
  const t = await readTokensShared(uid).catch(() => null);
  return t ? { uid: t.uid, accessToken: t.accessToken } : undefined;
}

// Server-side, session-less access token for background jobs (e.g. the cron sync) that run
// without a request. Reuses the same stored tokens and shared refresh lock as the request
// path, so background and request refreshes coordinate (no PKCE rotation races). Returns
// null when the user has no row or the refresh is dead.
export async function getValidAccessTokenFor(uid: Uid): Promise<OwnedToken | null> {
  const t = await core.getValidAccessToken(uid);
  return t ? { uid: t.uid, accessToken: t.accessToken } : null;
}

/** The cron tick's token read (PLAN.md §5.4, §7.2): src/lib/sync/tick.ts's token getter. Unlike
 *  getValidAccessTokenFor it throws every failure and never clears a dead grant (token-core.ts). */
export function tokenForTick(uid: Uid): Promise<UserTokens | null> {
  return core.tokenForTick(uid);
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
  // A failed sign-in lands on /login with ?error=<code>, which the page explains, never on
  // Auth.js's generic error page.
  pages: { error: "/login" },
  providers: [
    Spotify({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      // Include the full url: passing only `params` would drop the provider's
      // default authorization endpoint and break URL construction. The explicit
      // redirect_uri forces the loopback IP in the authorize step.
      authorization: {
        url: "https://accounts.spotify.com/authorize",
        // show_dialog forces Spotify's consent screen on every login. Without it, Spotify
        // silently reuses a user's PRIOR consent — so any scope added after they first
        // authorized (or granted by an earlier app sharing this client id) is never issued,
        // and the token keeps the old, smaller scope set. That's what made playback control
        // (`user-modify-playback-state`) 403 "Forbidden" while reads kept working. Forcing
        // the dialog makes a fresh login grant the current full SCOPES.
        params: { scope: SCOPES, redirect_uri: CALLBACK_URL, show_dialog: "true" },
      },
      // Read /v1/me ourselves: an account outside the dev-mode allowlist gets a plain-text 403
      // that Auth.js's JSON parse turned into a "server configuration" error. See userinfo.ts.
      userinfo: { url: "https://api.spotify.com/v1/me", request: spotifyUserinfo },
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
    // Runs before jwt, so a refused account never reaches the token write below. The owner
    // guard (lib/owner.ts) stays until Phase 4a; then the app database decides by Spotify's
    // account_id (identity-read.ts): a refusal is AccessDenied or a named case on /login.
    async signIn({ profile }) {
      if (profile?.id === SPOTIFY_NOT_REGISTERED) return "/login?error=SpotifyNotRegistered";
      if (profile?.id === SPOTIFY_UNAVAILABLE) return "/login?error=SpotifyUnavailable";
      if (!(await isOwnerSignIn(profile?.id ?? undefined))) return false;
      // Phase 4a: the request this sign-in may claim, from the signed cookie /join left.
      const rid = verifyRequestCookie((await cookies()).get(REQUEST_COOKIE)?.value, Date.now());
      const o = await resolveSignIn(profile ?? {}, Date.now(), rid);
      return o.kind === "allowed" ? true : signInRedirect(o);
    },
    async jwt({ token, account, profile }) {
      const t = token as SpotifyToken;
      // Initial sign-in: name the user on the cookie (uid, session epoch, auth_time, from the
      // `users` row signIn just admitted, never from the incoming cookie), then write the encrypted
      // token row. Tokens never ride in the cookie: one there is bound to no user row and
      // invisible to the cron, so a sign-in that cannot write its row fails visibly and is
      // retried (PLAN.md §5.1, 01e A18).
      if (account) {
        const claims = signInClaims(await signedInUser(profile ?? {}), Date.now());
        if (!claims) return null;
        t.uid = claims.uid;
        t.ep = claims.ep;
        t.auth_time = claims.auth_time;
        const uid = mintUid(claims.uid);
        const tokens: UserTokens = {
          uid,
          accessToken: account.access_token!,
          refreshToken: account.refresh_token!,
          expiresAt: account.expires_at!,
        };
        await core.setTokens(uid, tokens);
        // The session callback reads next, in this same request — hand it what we wrote
        // instead of making it re-read the row we just stamped.
        publishTokens(uid, tokens);
        delete t.error;
        return t;
      }

      // Every later request: who is this? Refused (no uid — every cookie minted before Phase 1
      // — an unknown uid, a stale epoch, a sign-in over 30 days old) signs the request out.
      // Unavailable keeps the cookie exactly as it is and sets no uid, so nothing below runs
      // and requireUser() answers a retryable error.
      const verdict = await identityFor(t.uid, t.ep, t.auth_time);
      if (!gateJwt(t, verdict)) return null;
      if (verdict.kind !== "allowed") return t;
      const uid = verdict.uid;

      let stored: UserTokens | null;
      try {
        stored = await readTokensShared(uid);
      } catch {
        // Transient DB read error — a Turso hiccup must NOT crash the request into a
        // Configuration error / forced logout. Keep the session exactly as-is and let a
        // later request resolve the token.
        return t;
      }
      if (!stored) {
        t.error = "RefreshAccessTokenError";
        return t;
      }
      // Still valid (>60s headroom)?
      if (isFresh(stored)) {
        delete t.error;
        return t;
      }
      // Expired: refresh through the shared lock, always using the latest token.
      try {
        // refreshShared resolves to the tokens now in the DB (ours, or a winner's) — publish
        // them so the session callback hands out the fresh access token rather than the
        // expired one this request started with.
        publishTokens(uid, await core.refreshForRequest(uid, stored.refreshToken));
        delete t.error;
      } catch (e) {
        if (e instanceof RefreshError && e.terminal) {
          // Refresh token is genuinely dead → real re-login required, unless another
          // process already rotated to a fresh one (then this failure is a stale race).
          // Phase 4a: the user stops with the row kept (needs_reconnect, PLAN.md §5.4 step 1),
          // so the tick's confirmation can ask Spotify again. Guarded so a DB error while
          // checking doesn't itself crash the callback.
          try {
            await core.deadGrant(uid, stored.refreshToken);
            // DIRECT read: it has to see the post-check state, which the request box can't
            // (it still holds the token we just failed with). Publishing the result is what
            // keeps the session callback from handing out that dead token.
            const after = await core.getStored(uid);
            publishTokens(uid, after);
            if (after && (isFresh(after) || after.refreshToken !== stored.refreshToken)) delete t.error;
            else t.error = "RefreshAccessTokenError";
          } catch {
            /* DB unreachable — keep the session and retry next request */
          }
        }
        // Transient failure: keep the session; the next request retries.
      }
      return t;
    },
    async session({ session, token }) {
      const t = token as SpotifyToken;
      // Whatever this callback puts on `session` is what Auth.js hands the browser at
      // GET /api/auth/session. So: the refresh state and who the request runs as (the uid,
      // not a credential), and nothing else. The Spotify access token used to be set here —
      // server code now takes it from spotifyAccessTokenFor() instead, which reads the same
      // request-scoped box this callback used to read.
      Object.assign(session, sessionFields(await identityFor(t.uid, t.ep, t.auth_time), t.auth_time));
      session.error = t.error;
      return session;
    },
  },
});
