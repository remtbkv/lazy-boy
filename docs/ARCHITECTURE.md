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
  effectively live; the `/history` page also refreshes its own view each minute via
  `syncHistoryAction`); and — the coverage path for when the app is closed — a **GitHub
  Actions cron** (`.github/workflows/sync.yml`) every 5 min (GitHub's hard floor for
  scheduled workflows, run best-effort) hitting `/api/cron/sync` with the stored token.
  A daily Vercel Cron (`vercel.json`) is a secondary backstop. All scheduled hits share
  `/api/cron/sync` (`CRON_SECRET`-guarded).
- Reads: `searchHistory`, `getDailyStats`, `getLastSync`. The `/history` page renders day
  cards + a searchable, scrollable log.
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
- `sync` (POST) — on-load history sync; server skips if synced <5 min ago.
- `cron/sync` (GET) — scheduled history sync (GitHub Actions every 5 min + Vercel daily);
  `CRON_SECRET`-guarded, session-less (uses the stored token).

All check `auth()` and 401 on no session, except `cron/sync` (cron secret, no session).

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
