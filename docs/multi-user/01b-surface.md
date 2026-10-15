# 01b — The request surface: entry points, gates, caches, and where users would mix

Lane 0221_lb_mu_ov_surface, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. Line numbers are against commit `1c7aabb` (no file under `src/` changed between it
and `90e912f`, checked with `git diff --stat 1c7aabb HEAD -- src`). Every claim cites `file:line`
or a doc section; every number says how it was measured. Section 9 lists every command I ran.

Status: outline. Sections fill in order and are committed as each lands.

## 0. Summary

## 1. How a request learns who the user is today

It doesn't. A request learns *that* someone is signed in, then acts on the one account whose tokens
sit in the store. Three facts make that so.

### 1.1 The session cookie carries no Spotify id

The session is an Auth.js v5 JWT in a cookie, 30-day `maxAge` (`src/lib/auth.ts:300-303`), with no
database adapter. Without an adapter, Auth.js mints the user's id as a fresh random UUID at every
sign-in rather than taking the provider's id: `@auth/core` 0.41.2 (the version in
`package-lock.json:53-54`), `lib/actions/callback/oauth/callback.js:224` sets
`id: crypto.randomUUID()`, and `lib/actions/callback/index.js:72-77` copies it into the token as
`sub`. The Spotify id exists in that same step as `account.providerAccountId`
(`callback.js:233`), but the app's `jwt` callback never stores it: on sign-in it writes the tokens to
the store and deletes them from the cookie (`auth.ts:352-377`), and nothing else is added. The
`session` callback exposes `error` only (`auth.ts:444-452`; the type at
`src/types/next-auth.d.ts:10-13`). So the cookie holds `name`, `email`, `picture`, a random `sub`,
and sometimes `error`. Nothing on the server or in the browser can say which Spotify account a
session belongs to.

### 1.2 Every Spotify call uses the one global token row

All four token paths read the same row, `meta.spotify_tokens` (`spotify_tokens_dev` outside
production; the key is chosen at `src/lib/db.ts:2511-2512`, read at `db.ts:2518-2526`):

| path | where | used by |
|---|---|---|
| `getSpotify()` → `spotifyAccessToken()` → `readTokensShared()` → `getSpotifyTokens()` | `src/lib/session.ts:13-18`, `auth.ts:270-272`, `auth.ts:74-78` | every page, action and route that calls Spotify for the signed-in user |
| `getValidAccessToken()` | `auth.ts:278-289` | `/api/cron/sync`, `startLibrarySync`, and through `refreshingToken()` (`src/app/(app)/actions.ts:46-57`) the clean and delete actions |
| the `jwt` callback's refresh | `auth.ts:379-441` | every `auth()` call |
| sign-in's write | `auth.ts:352-362` → `setSpotifyTokens` (`db.ts:2514-2516`) | every completed sign-in |

The last row is the incident that prompted this program: a second account's sign-in overwrote the
owner's row, and from then on every request, including the owner's, ran as the second account
(commit `044c9b6`'s message).

### 1.3 Every store read is unscoped

No table has a user column (`db.ts:158-243`, the schema), and no exported read in `db.ts` takes a
user argument. The single-user assumptions sit in three places a request touches: global `meta` keys
(`me_id`, `home_payload`, `user_tz_offset`, `last_sync`, the version markers, the token row), global
tables (`plays`, `tracks`, `playlists`, `playlist_tracks`, `saved_tracks`, `contexts`), and a fixed
home zone, `America/New_York`, for payloads built on the write path (`db.ts:1265-1270`). The full
census of tables and keys is 01a's; this file follows them only where a request or a cache meets
them.

### 1.4 What that means right now: any valid session is the owner

The `jwt` callback trusts any cookie that decrypts with `AUTH_SECRET`. For a returning session it
reads the global row and, if the token is fresh, clears `error` and returns (`auth.ts:379-414`); it
never compares the session's person with the token's owner. The owner-only guard runs only in the
`signIn` callback (`auth.ts:344-347`), which a returning session never passes through. So the
browser that completed the second account's sign-in before the guard deployed (8:41 PM) holds a
cookie that today resolves to the owner's token: that browser sees the owner's history and library,
and its clicks drive the owner's Spotify (playback, playlist creation, removal). It shows the second
account's own name and avatar in the header (`src/app/(app)/layout.tsx:51-52` reads them from the
cookie), over the owner's data.

`vercel env ls` (read-only, section 9) lists `AUTH_SECRET` as created 133 days ago in Production and
Preview. The listing shows creation age only, so a rotation since then is unlikely but not proven
from it. Rotating `AUTH_SECRET` is the immediate fix; section 6, item E1, has the options.

## 2. Entry-point inventory

### 2.1 Pages
### 2.2 Server actions
### 2.3 API routes
### 2.4 Gate consistency

## 3. Caches and shared state, and whether each key separates users

### 3.1 Next's Data Cache (`unstable_cache`)
### 3.2 Version markers and ETags
### 3.3 Request-scoped boxes
### 3.4 Module and `globalThis` state (the task registry included)
### 3.5 Locks in `meta`
### 3.6 Browser-side state
### 3.7 Vercel-side surfaces: preview deployments, CDN

## 4. Entry points that would leak or mix data across users, as written

## 5. What the surface needs for multi-user

## 6. Exposures that exist today, single-user

## 7. What multi-user needs from STORE_MIGRATION.md

## 8. Unknowns and what I did not verify

## 9. What I ran
