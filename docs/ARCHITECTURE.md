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

A second data layer, independent of Spotify: **libSQL** (`@libsql/client`) against a
**self-hosted `sqld`** on the Zenbook, reached from Vercel over a Tailscale Funnel.
`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` point at it (the names are historical — they
carried Turso Cloud until 2026-08-08); with both unset it falls back to a local SQLite
file (`data/listens.db`, gitignored). Tables: `tracks`, `plays` (deduped on
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
  pinger** hitting `/api/cron/sync` with the stored token every 2 min: the Zenbook's user
  timer `lazyboy-cron-sync.timer` (`~/lazyboy-cron/ping.sh`). A daily **Vercel Cron**
  (`vercel.json`, 07:00 UTC) is the backstop. All sync hits share `/api/cron/sync`
  (`CRON_SECRET`-guarded); the daily chores have their own route and cron entry,
  `/api/cron/daily` at 09:00 UTC (Routes, below). One retired caller still 401s there until Rem removes it: the
  Zenbook's root-level `lazyboy-sync.timer` (stale since 07-01) — burn lazyboy-review 2026-10-03, Z1/Z2.
- **Two pingers, one tick per 90 s** (docs/multi-user/PLAN.md §7.9). The Zenbook's timer sends
  `Bearer $CRON_SECRET`; a cron-job.org job, every 2 minutes, sends `Bearer $CRON_SECRET_EXT`, so
  capture survives a Zenbook outage. `cronCaller()` (`src/lib/cron-auth.ts`) names the caller from
  the secret. Before any work the tick takes a stamp, a compare-and-set on the `meta` row
  `lock:tick` (`acquireLock("tick", 90_000)`): a call that finds a tick in the last 90 s answers 200
  and does nothing. With the pingers on alternate minutes every second call ticks, so Spotify sees
  the 2-minute cadence either pinger alone keeps, and a leaked secret in a loop gets one tick per
  90 s. The owner alarm (503 "no token", read before the stamp) and the outcome go to `CRON_SECRET`
  callers only; cron-job.org always gets a bare `{"ok":true}`, since it keeps reply bodies and
  durations and disables a job after a run of failures. It gets that reply at once and its tick
  runs in `after()`, so neither the reply's timing nor a 30 s timeout tells whether a harvest ran. `CRON_SECRET_EXT` opens `/api/cron/sync` and nothing else;
  `CRON_SECRET` opens every cron route.
  (A GitHub Actions cron drove this initially but was removed: GitHub schedules best-effort
  and stretched to multi-hour gaps, losing plays against the 50-play window.)
- Reads: Home's first paint is `getHomePayload()` — one indexed `meta` row holding the day
  strip, the all-time totals and the opening day's tracks, built on the write path. The day
  cards and the search box then run in the browser against the history payload;
  `getDailyStats` / `getPlaysByDay` / `searchHistory` remain as the server-side path for a
  cold store, an extended strip, and the fallback while the payload loads.
- **Derived stats, search & resume:** "listened" time is computed per play (the gap since the
  previous play, because `played_at` is when a play ENDED; capped at the song length; under
  5 s counts as zero; a play after an idle stretch is assumed to have run in full) — Spotify
  reports *when* a play ended, never *how long* it ran (`src/lib/skip-rule.ts`). Whole-table
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
- **Two clients: core and telemetry** (`docs/STORE_MIGRATION.md`). `getClient()` holds the
  app's data — `tracks`, `plays`, `contexts`, `meta`, `playlists`, `playlist_tracks`,
  `saved_tracks` — on `TURSO_DATABASE_URL`. `getTelemetryClient()` holds the three log tables —
  `api_log`, `client_metrics`, `usage_ledger` — on `TELEMETRY_DATABASE_URL`, with its own init
  (a separate telemetry client never creates core tables, nor the core client telemetry ones)
  and a store fetch of one 4 s attempt. No user path awaits it: its writes are fired with
  `void` or run in `after()` (`/api/metrics`), and `/usage` settles its log sections one by one
  so a dead telemetry store empties those sections, not the page. Unset (or equal to the core
  URL), telemetry rides the core client: tests, dev and the pre-migration single store.
- **No replica.** `getClient()` serves every read, every write and all of `meta`. The libSQL
  **embedded replica** that used to serve row-scanning reads was switched
  off in production on 2026-08-03 (each cold serverless instance bootstrapped the whole ~17 MB
  copy, burning 77% of Turso's 3 GB/mo syncs quota in three days) and deleted from `db.ts` on
  2026-08-11. What replaced it is not a second client but less reading: Home renders from a
  payload materialized into `meta` on the write path (`rebuildHomePayload`), the day list and
  search filter a payload the browser holds (`/api/search/{library,history}`), and what remains
  are indexed, bounded hits. Scanning reads that survive — the two payload rebuilds, the
  all-time list — run once per content version behind `unstable_cache`, keyed on
  `meta.write_seq`.
- **The store lives on the Zenbook, and stays there.** Turso's free org hard-blocked reads on
  2026-08-08 at 102.8% of the month's rows_read; production could render nothing, and the
  emergency bridge became the architecture when Rem chose to keep it. `sqld` holds the data at
  `~/lazyboy-sqld/data`, listens on 127.0.0.1 only, authenticates an Ed25519-signed JWT, and is
  published through a permanent Tailscale Funnel hostname (`docs/quota-forensic/BRIDGE.md`).
  Nothing is metered, and every scanning read got 5–8× faster than it was on Turso. The price,
  accepted deliberately: an apartment machine is now a production dependency — if the Zenbook
  drops off the tailnet, production has no database (the backstop recorder means nothing is
  lost, but the site is down for the duration). **Turso is a restore target, not a
  dependency**; the revert procedure is written down in BRIDGE.md before it is needed.
- **The history's loss floor is the Zenbook backstop recorder, not Turso.** Spotify hands
  back only the last ~50 plays, so any window where nothing can write (Turso quota-blocked —
  all four metered dimensions hard-block every query — or plain unreachable) is a permanent
  hole. `~/lazyboy-recorder/` on the Zenbook (`lazyboy-recorder.timer`, every 15 min)
  captures recently-played into its own SQLite file with its own Spotify token chain and
  never touches Turso; `scripts/backfill-from-backstop.mjs` replays what the primary missed
  (verified: byte-identical rows to sync-written ones, idempotent). Adopted the dev token
  chain 2026-08-06 — next local-dev session will hit one forced re-login and mint its own.
- **The quota guard `/api/cron/usage-check` is DORMANT**, and kept for the fallback. It reads
  the org's real usage from Turso's platform API and returns 500 when any metered dimension
  runs ahead of 1.5× the even month pace (or 90% absolute) — a check about a database
  production no longer reads or writes. It stays wired because it is the guard that would have
  to exist on day one of a fallback to Turso, and because its reconciliation half is what
  writes the platform total and the residual into the ledger `/usage` renders. Its logic lives
  in `src/lib/usage-check.ts`; `/api/cron/daily` runs it every day and only records the result
  (the cron-job.org job that called the route has held a stale secret since 2026-08-10). Needs `TURSO_PLATFORM_TOKEN` + `TURSO_ORG`; unconfigured is
  deliberately a 500 — a guard that silently skips is the failure mode it exists to kill.
- **The read-cost ledger outlives the quota it was built for.** `usage_ledger` + `read-costs.ts`
  still charge every named read path its modeled cost on every call, and `/usage` still renders
  it. The quota that made it urgent is gone; what it measures — which path a cost regression
  came from — is not. See `docs/READ_QUOTA.md`.
- **Token refresh coordination:** the `meta` table doubles as a cross-instance mutex
  (`acquireLock`/`releaseLock`, a TTL compare-and-set) so concurrent serverless instances
  don't race Spotify's rotating refresh token into `invalid_grant`. See `src/lib/auth.ts`.
- **Not yet user-scoped** — single-user only. Before multi-user, key rows by user. See
  `docs/SECURITY.md`.

## Routes (`src/app/api/**`)

- `auth/[...nextauth]` — Auth.js handler.
- `tasks/[id]` — clean-playlist progress polling.
- `playlists/sync` (POST) — one full library scan → DB; client fires it when the store is stale.
- `now-playing` — live "what's playing"; returns `{ playing: null }` when idle (never stale).
- `sync` (POST) — on-load history sync; server debounces, skipping if synced <~60 s ago.
- `cron/sync` (GET) — scheduled history sync. On-time triggers are the Zenbook's
  `lazyboy-cron-sync.timer` (2 min) and the cron-job.org job (2 min, `CRON_SECRET_EXT`), at most
  one tick per 90 s between them; a daily Vercel Cron (07:00 UTC) is the backstop.
  Session-less (uses the stored token).
- `cron/daily` (GET) — the daily chores, Vercel Cron at 09:00 UTC (after the Zenbook's ~07:00
  UTC reboot, since the prunes and ledger rows go to the telemetry store on it): all-time heal,
  Home payload rebuild, `api_log` + `client_metrics` prunes, the `played_at` convention check,
  the usage check. Each isolated; answers 200 with every chore's outcome; notifies nobody.
- `cron/usage-check` (GET) — the dormant Turso quota guard + the ledger reconciliation (see
  the listen-history section; logic in `src/lib/usage-check.ts`); 500 on breach or
  misconfiguration so a calling job's failure e-mail is the alarm.
- `cron/store-bench` (GET) — store round trips from inside a function: `?store=core` (`SELECT 1`
  ×30, a one-key `meta` read ×10, the history payload ×2) or `?store=telemetry` (`SELECT 1` ×10);
  per probe n/p50/p95/max/failures, plus region, store host and cold start. Reads only.

All check `auth()` and 401 on no session, except the `cron/*` routes: those take
`Authorization: Bearer $CRON_SECRET` (`src/lib/cron-auth.ts`, constant-time, fail-closed: an
unset secret rejects all callers) and no session; `cron/sync` alone also takes
`Bearer $CRON_SECRET_EXT`.

## Player simulation

- **Now-playing bar** (`components/now-playing.tsx`, mounted in the `(app)` layout): the
  shared `NowPlayingProvider` (`now-playing-context.tsx`) polls `/api/now-playing` from one
  leader tab (a visible one whenever one exists), on the schedule in `lib/now-playing-poll.ts`:
  every 6s while playing and visible, ~300 ms after the track's predicted end with a short
  burst if Spotify has not moved yet, every 15s paused or idle, boundaries only while hidden,
  and Retry-After on a 429 (docs/NOW_PLAYING_LATENCY.md). The bar interpolates the progress
  locally each second between polls. Renders only when there's genuine active playback. No active device → nothing shown.
- **Track right-click menu** (`components/track-context-menu.tsx`): Add to queue / Save to
  Liked / Open in Spotify, via `addToQueueAction` / `saveToLikedAction`.

## Shared client helpers (keep these DRY)

- `lib/format.ts` — duration / listen-time / relative-time / day-label formatting.
- `lib/filter.ts` — `fuzzyFilter` (substring + prefix-priority name search).
- `components/album-thumb.tsx` — album art + music-note fallback.
- `components/sort-menu.tsx` — the "Sort by ▾" dropdown.
- `app/(app)/search-island.tsx` — `SearchIsland`, the bottom-centered search pill.

---

**Related:** [GOTCHAS](GOTCHAS.md) (traps behind these choices) · [CONVENTIONS](CONVENTIONS.md)
(code/theme rules) · [FEATURES](FEATURES.md) (what the operations do) ·
[SECURITY](SECURITY.md) (token handling, pre-prod checklist) · [ROADMAP](ROADMAP.md).
