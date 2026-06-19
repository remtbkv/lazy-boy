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
- The Spotify **access/refresh tokens live in the DB** (`spotify_tokens` via `src/lib/db.ts`),
  which is the single source of truth. The JWT cookie is kept lean (tokens deleted from it
  after sign-in); a cookie copy is only retained as a fallback if the DB write fails, and an
  older cookie-stored session is migrated into the DB on its next request.
- The `jwt` callback refreshes the access token when it's within ~1 min of expiry, using
  `POST https://accounts.spotify.com/api/token` (grant_type=refresh_token). On failure it
  marks the session with `error: "RefreshAccessTokenError"` so the UI can prompt re-login.
- **Refresh is coordinated**, not duplicated: an in-process lock (`refreshShared`) collapses
  concurrent refreshes within one instance, and a cross-instance DB mutex
  (`acquireLock`/`releaseLock` on the `meta` table) stops separate serverless instances from
  racing Spotify's *rotating* refresh token into `invalid_grant`. Losers poll the DB and
  accept any **fresh** token (Spotify doesn't always rotate the refresh token, so "did it
  change" is the wrong signal). The lock is owner-tokened: `acquireLock` returns a token
  that `releaseLock` requires, so a holder that overran its TTL can't free a lock someone
  else has since taken.
- `session` callback exposes `session.accessToken` (server-side use only) and `session.error`.
- `getValidAccessToken()` is the session-less accessor for background jobs (cron, tasks) — it
  reuses the same DB tokens and shared lock, so request and background refreshes coordinate.
- This is the single place tokens are minted/refreshed — fixes the prototype's scattered
  `_ensure_token()` calls.

## Route protection

No middleware/proxy. The `(app)` segment's `layout.tsx` is a Server Component that calls
`auth()`; if there's no session (or `session.error`), it `redirect()`s to `/login`. Every
authed page is a child of that layout, so the gate is enforced once.

## Getting an authed Spotify client

```ts
// in a Server Component / action / route handler
const sp = await getSpotify()                 // src/lib/session — authed, redirects on a dead session
const playlists = await sp.myPlaylists()

// or bind a client to an explicit token (e.g. a background task's refreshing getter):
const sp = spotifyClient(token)               // src/lib/spotify
```

`spotifyClient(token)` returns a `Service` bound to that token. Nothing below the action
layer reads the session directly.

`token` is a `TokenSource` — either the request's access-token string (fresh for the
request's lifetime) **or** a `() => Promise<string>` getter. Interactive callers pass the
string; **background tasks pass a getter** (`refreshingToken()` in `actions.ts`) so a run
that outlives the ~1 h token refreshes mid-flight instead of dying on a 401. See
*Background tasks*.

## Background tasks (clean playlist)

- `src/lib/tasks/registry.ts` exposes `createTask`, `getTask`, `updateTask` over an in-memory
  `Map<string, Task>`. A `Task` carries `status` (`queued|running|done|error`),
  `processed`, `total`, `result`, `error`.
- The clean action starts the work (not awaited), returns a `taskId`. The client polls
  `GET /api/tasks/[id]` until `done|error`.
- Long tasks (`reconcileClean`, `syncLibrary`) get a **refreshing token getter**, not a fixed
  string, so the access token is renewed across a multi-minute run.
- `createTask` runs a TTL sweep that evicts `done|error` tasks older than 10 min, so a
  long-lived process doesn't accumulate finished tasks.
- **Extension seam:** swap the Map for Redis/DB to make tasks survive refresh / multi-instance
  (ROADMAP Phase 3). The registry interface stays the same.
- **Serverless caveat:** the store is a per-instance `globalThis` Map. On a multi-instance host
  (e.g. Vercel), the instance that polls `/api/tasks/[id]` may not be the one that ran the
  task, so progress can 404 — fine for local/single-instance use; the Redis/DB swap is what
  makes it production-safe. The same per-instance limit applies to the Spotify client's
  rate-limit cooldown and the playlist cache (both module-scoped). See `docs/GOTCHAS.md`.

## Data fetching & caching

- Cache Components are **not** enabled. All data is user-specific and fetched per request in
  Server Components. After a mutation, server actions call `revalidatePath(...)`.
- We rely on Server Components for reads so the access token never reaches the browser.

## Why these choices

- **Auth.js over hand-rolled OAuth:** secure cookie/CSRF/refresh handling built in; the
  prototype's bugs were largely token/session plumbing.
- **Pure domain layer:** the dedupe/clean/compare logic is the actual product value; isolating
  it makes it correct and testable independent of Spotify.
- **Service layer chokepoint:** one place to handle Spotify's rate limits and pagination,
  which were the prototype's top operational pain.

## Listen-history store (`src/lib/db.ts`)

A second data layer, independent of Spotify: **libSQL/Turso** (`@libsql/client`),
which persists on Vercel's serverless runtime. `TURSO_DATABASE_URL` +
`TURSO_AUTH_TOKEN` point at the remote DB; with both unset it falls back to a local
SQLite file (`data/listens.db`, gitignored). Tables: `tracks`, `plays` (deduped on
`played_at`), `contexts` (resolved playlist/album names), `meta`. Server-only
(`import "server-only"`). **Every function is async** (the DB is over the network).

- **Sync core** (`sync/history.ts`, `syncRecentPlays`) pulls `/me/player/recently-played`,
  records new plays (deduped on `played_at`), resolves new playback contexts to names.
  **Why polling, not a webhook:** Spotify's recently-played endpoint returns only the
  **last 50 plays** and can't page back further, so completeness depends on polling often
  enough that <50 plays accumulate between runs (50 ≈ 3h of nonstop listening). There is
  **no manual sync button** — it's all automatic. Triggered (no `setInterval` — serverless
  can't run one): in-app while the site is open (`SyncOnLoad` syncs on load, every 2 min,
  and on tab-focus → `POST /api/sync`, debounced server-side to ~60 s, so an open tab is
  effectively live; the home history view also refreshes each minute via
  `syncHistoryAction`); and — the coverage path for when the app is closed — an **external
  every-5-min pinger** hitting `/api/cron/sync` with the stored token (a systemd timer on an
  always-on machine, or a service like cron-job.org). A **GitHub Actions** workflow
  (`.github/workflows/sync.yml`, scheduled best-effort) and a daily **Vercel Cron**
  (`vercel.json`) are backstops. All scheduled hits share `/api/cron/sync`
  (`CRON_SECRET`-guarded).
- Reads: `searchHistory`, `getDailyStats`, `getLastSync`. The home page renders the listen
  history — day cards + a searchable, scrollable log — streamed below the quick actions.
- **Derived stats, search & resume:** "listened" time is computed per play (the gap to the
  next play, capped at the song length; under 5 s counts as zero; an isolated play is assumed
  to have finished) — Spotify reports *when* a track played, never *how long*. Whole-table
  totals (`alltime_stats`) are cached in `meta` and recomputed on write; per-day totals compute
  live. The **Find** quick action searches playlist songs/artists via an FTS5 trigram index
  (`tracks_fts`, rebuilt on library sync). **Resume** (`resumePlaylistAction`) picks up where
  you left off, matching plays to playlist positions by id then by `(name, artist)`. New
  `db.ts` queries follow the conventions in that file's header (drive joins from the indexed
  hot table; cache aggregates on write; do gap math in JS, not SQL window functions). Details
  in `docs/GOTCHAS.md`.
- **Token refresh coordination:** the `meta` table doubles as a cross-instance mutex
  (`acquireLock`/`releaseLock`, a TTL compare-and-set) so concurrent serverless instances
  don't race Spotify's rotating refresh token into `invalid_grant`. See `src/lib/auth.ts`.
- **Not yet user-scoped** — single-user only. Before multi-user, key rows by user. See
  `docs/SECURITY.md`.

## Routes (`src/app/api/**`)

- `auth/[...nextauth]` — Auth.js handler.
- `tasks/[id]` — clean-playlist progress polling.
- `playlists/sync` (POST) — one full library scan → DB; client fires it when the store is stale.
- `history/search?q=` — local history search (no Spotify call → instant).
- `now-playing` — live "what's playing"; returns `{ playing: null }` when idle (never stale).
- `sync` (POST) — on-load history sync; server debounces, skipping if synced <~60 s ago.
- `cron/sync` (GET) — scheduled history sync. On-time trigger is an external every-5-min
  pinger; GitHub Actions + a daily Vercel Cron are backstops. `CRON_SECRET`-guarded
  (fail-closed: an unset secret rejects all callers), session-less (uses the stored token).

All check `auth()` and 401 on no session, except `cron/sync` (cron secret, no session).

## Player simulation

- **Now-playing bar** (`components/now-playing.tsx`, mounted in the `(app)` layout): the
  shared `NowPlayingProvider` (`now-playing-context.tsx`) polls `/api/now-playing` every 6s
  **while the tab is visible**; the bar interpolates the progress locally each second between
  polls. Renders only when there's genuine active playback. No active device → nothing shown.
- **Track right-click menu** (`components/track-context-menu.tsx`): Add to queue / Save to
  Liked / Open in Spotify, via `addToQueueAction` / `saveToLikedAction`.

## Shared client helpers (keep these DRY)

- `lib/format.ts` — duration / listen-time / relative-time / day-label formatting.
- `lib/filter.ts` — `fuzzyFilter` (substring + prefix-priority name search).
- `components/album-thumb.tsx` — album art + music-note fallback.
- `components/sort-menu.tsx` — the "Sort by ▾" dropdown.
- `components/floating-bar.tsx` — the bottom-centered search/see-more pill.
- `components/animated-number.tsx` — `AnimatedNumber`: tweens a count from its old value to a
  new one (ease-out, reduced-motion aware, no first-paint count-up). Use for any number that
  updates live.

---

**Related:** [GOTCHAS](GOTCHAS.md) (traps behind these choices) · [CONVENTIONS](CONVENTIONS.md)
(code/theme rules) · [FEATURES](FEATURES.md) (what the operations do) ·
[SECURITY](SECURITY.md) (token handling, pre-prod checklist) · [ROADMAP](ROADMAP.md).
