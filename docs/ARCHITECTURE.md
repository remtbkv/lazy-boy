# ARCHITECTURE.md

## Layers (strict, top calls down only)

```
┌─────────────────────────────────────────────────────────────┐
│ UI            src/app/**, src/components/**                   │
│               Server Components fetch via the service layer;  │
│               Client Components call server actions/routes.   │
├─────────────────────────────────────────────────────────────┤
│ Server actions / route handlers                               │
│               src/app/(app)/**/actions.ts, src/app/api/**     │
│               Auth-gated entry points. Own the access token.  │
├─────────────────────────────────────────────────────────────┤
│ Service layer  src/lib/spotify/                               │
│   client.ts    fetch wrapper: auth header, pagination,        │
│                429/Retry-After backoff, batching              │
│   resources.ts typed calls (playlists, tracks, player, users) │
│   domain.ts    PURE logic (dedupe/merge/subtract/intersect)   │
│   types.ts     Track + Spotify response types                 │
├─────────────────────────────────────────────────────────────┤
│ Auth          src/lib/auth.ts  (Auth.js + token refresh)      │
│ Tasks         src/lib/tasks/   (background job registry)      │
└─────────────────────────────────────────────────────────────┘
```

Rule: a layer may only import from layers below it. UI never imports `client.ts` directly for
Spotify HTTP — it goes through `resources.ts`. `domain.ts` imports nothing app-specific.

## Auth & tokens

- Auth.js v5 (`next-auth@beta`) with the built-in Spotify provider.
- Scopes (ported from the prototype) requested at sign-in — see `src/lib/auth.ts`.
- The Spotify **access token + refresh token + expiry** are stored in the encrypted JWT.
- The `jwt` callback refreshes the access token when it's within ~1 min of expiry, using
  `POST https://accounts.spotify.com/api/token` (grant_type=refresh_token). On failure it
  marks the session with `error: "RefreshAccessTokenError"` so the UI can prompt re-login.
- `session` callback exposes `session.accessToken` (server-side use only) and `session.error`.
- This is the single place tokens are minted/refreshed — fixes the prototype's scattered
  `_ensure_token()` calls.

## Route protection

No middleware/proxy. The `(app)` segment's `layout.tsx` is a Server Component that calls
`auth()`; if there's no session (or `session.error`), it `redirect()`s to `/login`. Every
authed page is a child of that layout, so the gate is enforced once.

## Getting an authed Spotify client

```ts
// in a Server Component / action / route handler
const session = await auth()
const sp = spotifyClient(session.accessToken)   // src/lib/spotify
const playlists = await sp.playlists.mine()
```

`spotifyClient(token)` returns the resource modules bound to that token. Nothing below the
action layer reads the session directly.

## Background tasks (clean playlist)

- `src/lib/tasks/registry.ts` exposes `createTask`, `getTask`, `updateTask` over an in-memory
  `Map<string, Task>`. A `Task` carries `status` (`queued|running|done|error`),
  `processed`, `total`, `result`, `error`.
- The clean action starts the work (not awaited), returns a `taskId`. The client polls
  `GET /api/tasks/[id]` until `done|error`.
- **Extension seam:** swap the Map for Redis/DB to make tasks survive refresh / multi-instance
  (ROADMAP Phase 3). The registry interface stays the same.
- Caveat (documented, acceptable for now): in-memory tasks are per-server-instance and reset
  on redeploy — fine for local/single-instance use.

## Data fetching & caching

- Cache Components are **not** enabled. All data is user-specific and fetched per request in
  Server Components. After a mutation, server actions call `revalidatePath(...)`.
- We rely on Server Components for reads so the access token never reaches the browser.

## Why these choices

- **Auth.js over hand-rolled OAuth:** secure cookie/CSRF/refresh handling out of the box; the
  prototype's bugs were largely token/session plumbing.
- **Pure domain layer:** the dedupe/clean/compare logic is the actual product value; isolating
  it makes it correct and testable independent of Spotify.
- **Service layer chokepoint:** one place to handle Spotify's rate limits and pagination,
  which were the prototype's top operational pain.

## Local listen-history store (`src/lib/db.ts`)

A second data layer, independent of Spotify: a local **SQLite** file
(`better-sqlite3`, `data/listens.db`, gitignored; native module declared in
`serverExternalPackages`). Tables: `tracks`, `plays` (deduped on `played_at`),
`contexts` (resolved playlist/album names), `meta`. Server-only (`import "server-only"`).

- **Sync** (`history/actions.ts`) pulls `/me/player/recently-played`, records new plays, and
  resolves any new playback contexts to names. Manual button for now → background poll later.
- Reads: `searchHistory`, `getDailyStats`, `getLastSync`. The `/history` page renders day
  cards + a searchable, scrollable log.
- **Not yet user-scoped** — single-user only. Before multi-user/production, key rows by user
  (or move to Postgres/Supabase). See `docs/SECURITY.md`.

## Routes (`src/app/api/**`)

- `auth/[...nextauth]` — Auth.js handler.
- `tasks/[id]` — clean-playlist progress polling.
- `playlists?offset=` — one page of playlists for the client's background load.
- `history/search?q=` — local history search (no Spotify call → instant).
- `now-playing` — live "what's playing"; returns `{ playing: null }` when idle (never stale).

All check `auth()` and 401 on no session.

## Player simulation

- **Now-playing bar** (`components/now-playing.tsx`, mounted in the `(app)` layout): polls
  `/api/now-playing` every ~12s while visible; renders only when there's genuine active
  playback. No active device → nothing shown.
- **Track right-click menu** (`components/track-context-menu.tsx`): Add to queue / Save to
  Liked / Open in Spotify, via `addToQueueAction` / `saveToLikedAction`.

## Shared client helpers (keep these DRY)

- `lib/format.ts` — duration / listen-time / relative-time / day-label formatting.
- `lib/filter.ts` — `fuzzyFilter` (substring + prefix-priority name search).
- `components/album-thumb.tsx` — album art + music-note fallback.
- `components/sort-menu.tsx` — the "Sort by ▾" dropdown.
- `components/floating-bar.tsx` — the bottom-centered search/see-more pill.
