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
  `refreshHistoryAction`); and — the coverage path for when the app is closed — an **external
  pinger** hitting `/api/cron/sync` with the stored token every ~2 min (a [cron-job.org](https://cron-job.org)
  job, or a systemd timer on an always-on machine). A daily **Vercel Cron** (`vercel.json`)
  is the backstop. All scheduled hits share `/api/cron/sync` (`CRON_SECRET`-guarded).
  (A GitHub Actions cron drove this initially but was removed: GitHub schedules best-effort
  and stretched to multi-hour gaps, losing plays against the 50-play window.)
- Reads: `searchHistory`, `getDailyStats`, `getLastSync`. The home page renders the listen
  history — day cards + a searchable, scrollable log — streamed below the quick actions.
- **Derived stats, search & resume:** "listened" time is computed per play (the gap to the
  next play, capped at the song length; under 5 s counts as zero; an isolated play is assumed
  to have finished) — Spotify reports *when* a track played, never *how long*. Whole-table
  totals (`alltime_stats`) are cached in `meta` and recomputed on write; per-day totals compute
  live. **Resume** (`resumePlaylistAction`) picks up where you left off, matching plays to
  playlist positions by id then by `(name, artist)`. New `db.ts` queries follow the
  conventions in that file's header (drive joins from the indexed hot table; cache aggregates
  on write; do gap math in JS, not SQL window functions). Details in `docs/GOTCHAS.md`.
- **Verifying the derived values.** `alltime_stats`, `unique_song_count` and `plays.ctx_orphan`
  are caches kept fresh by hand-maintained invalidation, so they can silently drift from the
  source rows. `node --env-file=.env.local scripts/verify-derived.mjs` recomputes all three from
  source against the primary and exits 1 with the named diff when a stored value disagrees
  (read-only; `--demo` injects and restores a deliberate corruption to show it actually fails).
- **Two clients, split by role.** Remote Turso costs ~1 s per few-thousand rows *scanned*
  (not a latency problem — the round trip is ~20 ms), so `getReader()` serves row-scanning
  reads from a libSQL **embedded replica**: a local SQLite copy of the same database, synced
  in the background. `getClient()` — the primary — keeps every write plus all of `meta`, so
  write latency and the cross-instance token/lock guarantees are unchanged. Writes call
  `syncReader()` so the next read sees them. The replica is never on the critical path: reads
  fall back to the primary until the first sync lands, and permanently if it fails. See
  `docs/GOTCHAS.md`.
- **In production the replica is OFF and Turso is the read architecture, deliberately.**
  `LAZYBOY_NO_REPLICA=1` has been set in Vercel since 2026-08-03: the primary rotates its
  replication generation on its own schedule, a behind-generation replica re-pulls the whole
  ~17 MB file, and on serverless that burned 77% of the free plan's 3 GB/mo syncs quota in
  three days. Replica-less, every scanning read is billed rows against the 500M/mo
  rows-read quota instead — which is fine **only because** every recurring read path is
  bounded (per-day costs, the model, and the pre-registered measurements:
  `docs/READ_QUOTA.md`). A warm store off Vercel (a permanently-synced copy on the always-on
  Zenbook serving reads) was considered and deferred: post-fix the modeled burn is ≤10% of
  quota/month, serving adds an apartment-machine dependency the app otherwise doesn't have,
  and the same generation-rotation behavior makes a long-lived libSQL replica's sync cost
  unsafe to even measure this month (each full re-pull is ~17 MB against ~0.6 GB of
  remaining syncs headroom). Reversal condition: if a post-fix measurement window shows the
  closed-app burn above ~3M rows/day, or history growth pushes the bounded paths past ~30%
  of quota, build the Zenbook read store (incremental `SELECT`-based pull, not the libSQL
  sync protocol) and serve precomputed artifacts outward.
- **The history's loss floor is the Zenbook backstop recorder, not Turso.** Spotify hands
  back only the last ~50 plays, so any window where nothing can write (Turso quota-blocked —
  all four metered dimensions hard-block every query — or plain unreachable) is a permanent
  hole. `~/lazyboy-recorder/` on the Zenbook (`lazyboy-recorder.timer`, every 15 min)
  captures recently-played into its own SQLite file with its own Spotify token chain and
  never touches Turso; `scripts/backfill-from-backstop.mjs` replays what the primary missed
  (verified: byte-identical rows to sync-written ones, idempotent). Adopted the dev token
  chain 2026-08-06 — next local-dev session will hit one forced re-login and mint its own.
- **The quota guard is `/api/cron/usage-check`**, hit daily by a cron-job.org job with
  failure e-mail on: it reads the org's real usage from Turso's platform API and returns 500
  when any metered dimension runs ahead of 1.5× the even month pace (or 90% absolute). Needs
  `TURSO_PLATFORM_TOKEN` + `TURSO_ORG` in the environment; unconfigured is deliberately a
  500 — a guard that silently skips is the failure mode it exists to kill.
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
- `cron/sync` (GET) — scheduled history sync. On-time trigger is an external pinger
  (cron-job.org, ~2 min); a daily Vercel Cron is the backstop. `CRON_SECRET`-guarded
  (fail-closed: an unset secret rejects all callers), session-less (uses the stored token).
- `cron/usage-check` (GET) — the Turso quota guard (see the listen-history section);
  `CRON_SECRET`-guarded, 500 on breach or misconfiguration so the calling cron job's
  failure e-mail is the alarm.

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
