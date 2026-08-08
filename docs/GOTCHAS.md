# GOTCHAS.md — hard-won lessons for this repo

Read this before debugging. Each item below cost real time to discover; trust it
instead of re-investigating. (Pairs with `CLAUDE.md`, `AGENTS.md`, and the other
`docs/`.)

## Runtime / dev environment

- **Access the app at `http://127.0.0.1:3000`, never `localhost`.** The Spotify
  redirect URI is the loopback IP, and the session cookie is bound to it. Cookies
  do **not** cross `localhost` ↔ `127.0.0.1`, so opening `localhost` looks logged
  out and breaks the OAuth PKCE cookie.
- **`next.config.ts` must keep `allowedDevOrigins: ["127.0.0.1", "localhost"]`.**
  Without it, Next 16 blocks `/_next` dev resources as cross-origin, the client
  runtime never hydrates, and **every interactive element silently does nothing**
  (dead buttons, dead inputs). If you ever see "buttons do nothing," check this
  and hydration FIRST — it's almost never the component.
- **Project location: `~/projects/lazyboy`.** It used to live in a
  OneDrive cloud-synced folder, where file watching was unreliable and the dev
  server served stale compiled code; it was moved to `~/projects` on 2026-06-01 to
  fix that, so HMR is now reliable. If a change still "isn't taking effect" (e.g.
  HMR websocket noise in a sandbox), the hard reset is:
  `pkill -f "next dev"; rm -rf .next/dev; PORT=3000 npm run dev`.
- **Never run `npm run build` while `next dev` is running** — both write `.next`,
  so the dev server starts returning 500s / `ERR_INCOMPLETE_CHUNKED_ENCODING` and
  client navigation (`router.push`) silently fails. Symptom: arrow-key/link nav
  "doesn't work" even though the code is fine. Fix: stop dev, build (or not), then
  restart dev clean. To just typecheck without disturbing dev, prefer `npx tsc --noEmit`.
- **Session is a 30-day persistent JWT** (`src/lib/auth.ts`); the cookie just marks
  who's logged in. **Spotify tokens live in the DB** (`meta.spotify_tokens`), which
  is the source of truth, NOT the cookie. This exists because Spotify's PKCE refresh
  token **rotates on every use**: with tokens in the cookie, a page refresh fires
  several concurrent requests that each refresh with the same (soon-invalidated)
  token, and the losers get `invalid_grant` → forced re-login. Now an in-process
  lock (`refreshShared`) coordinates one refresh, writes the new tokens to the DB,
  and everyone reads the latest from there. Within one request that read is deduped
  through a `cache()` promise box (`readTokensShared` in `auth.ts`) — layout + page
  `auth()` calls and both callbacks share a single primary read (measured 4 → 1 per
  `/home` render), and every refresh/write republishes the box so the same request
  never serves a pre-refresh token. The refresh-coordination paths (`coordinatedRefresh`,
  `waitForFreshToken`, cron's `getValidAccessToken`) stay on direct reads — they need
  real-time DB state. Refresh retries transient failures
  (429/5xx/network) and only forces re-login on a genuinely dead refresh token
  (`invalid_grant`). Older cookie-stored tokens are migrated into the DB on first
  request. If you ever wipe `data/listens.db` you'll need to reconnect once.

## Base UI primitives — NOT Radix

The `src/components/ui/*` components are generated against **`@base-ui/react`**
(v1.x), not Radix. Base UI differs in ways that broke things here:

- **Controlled `Checkbox` / `Input` `onChange` does not propagate** in this
  React 19 setup — the controlled value snaps back / never updates. Both were
  rewritten to **native** `<input>` elements (`ui/checkbox.tsx`, `ui/input.tsx`).
  Do **not** reintroduce Base UI controlled form inputs.
- **A native `<input>` nested in a `<label>` double-fires `onChange`** here (one
  click → two toggles → net zero). For clickable rows, put a single `onClick` on
  a `<div role="checkbox">` and keep the checkbox **visual-only** (see
  `home/dock.tsx`, `track-list.tsx`, `ui/checkbox.tsx`).
- **`DropdownMenuLabel` must sit inside a `Menu.Group`** or Base UI throws
  `MenuGroupContext is missing` (crashed the profile menu → "page couldn't
  load"). It's a plain `<div>` now.
- **Base UI `Menu` has no `openOnHover` prop.** Hover-to-open is done with
  controlled `open` state + a close-delay bridge in `chrome.tsx`.
- Triggers use the **`render`** prop, not Radix's `asChild`.

## Spotify Web API — changed since model training data

- **Playlist tracks moved from `/playlists/{id}/tracks` to
  `/playlists/{id}/items`.** The old `/tracks` endpoint now returns **403** for
  GET (and writes). Use `/items` everywhere (GET list, POST add, PUT replace).
- **Response key renames** (see `resources.ts`):
  - Playlist object: the track-paging object is under **`items`**, not `tracks`.
    Read the count as `raw.tracks?.total ?? raw.items?.total`.
  - Playlist item rows: the track is under **`item`**, not `track`. Read
    `i.item ?? i.track`.
- The HTTP client (`client.ts`) retries **403** (transient rate-limit) with
  backoff, like 429.
- **Development-mode restriction:** the Spotify app is in dev mode, so reading
  **any other user's** profile/playlists returns **403** (confirmed even for the
  official `spotify` account). This blocks **Compare-a-friend, the playlist
  subtracter, and all friend features** until the user adds those people to the
  app's allowlist in the Spotify dashboard → User Management. **Not fixable in
  code.** Don't keep retrying or assume the user ID is wrong — it's a dashboard
  setting the user controls.
- **The same song carries different track ids in different places (relinking /
  duplicate releases).** A track stored in a playlist and the *same* track as it
  comes back from `/me/player/recently-played` can have **different ids** (market
  relinking, re-uploads, alternate releases). So anything correlating plays to a
  playlist must match on **`(artist, title)`**, not the id — this is the same
  identity the dedupe/clean features use (FEATURES § Track identity). Resume does
  exactly this: it matches a play to a playlist position by id first, then falls
  back to `(name, artist)`, so relinked plays still count.

## Architecture added recently

- **Persistent playlist library (DB-backed):** the full library is stored in
  libSQL (`playlists` table in `src/lib/db.ts`, native order). `/home` and
  `/playlists` read it **on render — no Spotify call**, so pages are
  instant and never block/rate-limit on a library scan. `playlists-sync.tsx`
  (client) fires `POST /api/playlists/sync` when the store is empty or >15 min
  stale; the sync does the one full scan off the render path, then `router.refresh()`
  shows fresh data. `me_id` + `playlists_synced_at` live in the `meta` table. (The
  old per-page `/api/playlists?offset=` waterfall and its `myPlaylistsPage` chain
  were deleted.) `playlists-grid.tsx` has fuzzy search; thumbnails are lazy.
  **Creating a playlist must also write the store** — the
  grid renders only from the DB, so merge / save-queue / clean / save-diff call
  `recordNewPlaylist()` (→ `db.upsertStoredPlaylist`, position −1 = sorts first) right
  after the Spotify create; without that the new playlist is invisible until the next
  full sync (up to 15 min).
- **Playlist detail pages serve cached tracks, revalidated by `snapshot_id`.** Paginating a
  playlist's tracks from Spotify on every visit was the main slowness. Tracks are cached per
  playlist in `playlist_tracks` (+ `tracks`), read on render via `getPlaylistTracks`. The
  page already fetches the playlist object for its header, which includes Spotify's
  `snapshot_id` (changes only when the playlist's contents change). We store it
  (`plsnap:<id>` in meta) and re-fetch tracks **only when it differs** — so an unchanged
  playlist is never re-paginated, and a changed one is always caught. `PlaylistTracksSync`
  is rendered only on a snapshot mismatch; it POSTs the new snapshot to
  `/api/playlists/[id]/tracks`, which re-fetches + stores, then `router.refresh()`. Cold
  cache streams a live fetch that fills it. `removeFromPlaylistAction` updates the cache so
  removes don't reappear. Do NOT bulk-refresh every playlist on a schedule (rate-limit
  trap) — revalidate per-playlist on visit via snapshot.
- **Listen-history backend (`src/lib/db.ts`):** **libSQL/Turso** (`@libsql/client`),
  so it persists on Vercel's serverless runtime. `TURSO_DATABASE_URL` +
  `TURSO_AUTH_TOKEN` select the remote DB; with both unset (dev) it falls back to a
  local file at `data/listens.db` (gitignored). **All `db.ts` functions are async**
  (network DB) — `await` them. Synced from `/me/player/recently-played` in
  `sync/history.ts`. Tables: `tracks`, `plays` (deduped on `played_at`), `contexts`
  (resolved playlist/album names for the "From" column). The listen history lives on the
  home page (`/home`, streamed below the quick actions) — per-day cards + a searchable log.
- **Dev and benchmarks bill the PRODUCTION Turso quota — point heavy local work at the
  local file DB.** `.env.local` carries `TURSO_DATABASE_URL`, so `next dev`, every open
  localhost tab, `npm run build` prerenders, and every `bench-reads.mjs` run read the real
  primary, and Turso bills rows SCANNED against the free plan's 500M/month. Two dev-heavy
  days (2026-08-01 and 08-04/05) each burned on the order of 100M rows this way and drove
  a 75%-quota warning email. Rule: benchmark/verification/agent runs default to the local
  file (`data/listens.db` — run with `TURSO_DATABASE_URL` unset) unless the point is to
  measure the primary itself; a deliberate primary-measuring run should state its expected
  row cost before it loops. Don't leave localhost tabs open on a dev server pointed at the
  primary — the 2-min sync poll re-renders (and pre-caching, re-scanned) all day.
- **`recently-played` only returns the last 50 plays — this drives the whole sync
  design.** Spotify caps that endpoint at 50 and won't page back further, so any play
  that scrolls off before you poll is **gone forever**. Completeness therefore depends
  on polling often enough that <50 plays pile up between runs (50 ≈ 3h of nonstop
  listening). A heavy user can do hundreds of plays/day, so a once-a-day poll loses
  most of them — don't "optimize" the sync down to infrequent.
- **History sync runs without `setInterval`** (serverless has no long-running process),
  and there is **no manual sync button** — it's fully automatic. One shared core
  (`syncRecentPlays`), triggered by: **in-app polling** while the site is open
  (`SyncOnLoad` → `POST /api/sync` on load, every 2 min, and on tab-focus; server skips
  if synced <60 s ago — so an open tab is effectively live, and the home history view also
  refreshes each minute); and the **app-closed coverage** path — an **external pinger**
  hitting `/api/cron/sync` with the stored token every ~2 min (a service like cron-job.org,
  or a systemd timer on an always-on machine), with a daily **Vercel Cron** (`vercel.json`)
  as the backstop. Every scheduled hit carries `Authorization: Bearer $CRON_SECRET`
  (fail-closed: an unset secret rejects all callers). A GitHub Actions cron drove this at
  first but was removed — GitHub schedules best-effort and real spacing stretched to hours,
  which loses plays against the 50-play window; a dedicated pinger holds a tight cadence.
- **Day buckets use the user's timezone, sent from the browser — never `'localtime'`.**
  Turso runs in UTC, so `date(played_at, 'localtime')` would bucket by UTC and plays after
  UTC-midnight show up on "tomorrow." Spotify's API has no user timezone, so `TimezoneCookie`
  writes the browser's UTC offset to a `tzoffset` cookie; `tzOffsetMinutes()` reads it.
  `getDailyStats` shifts each play by that offset in JS to bucket by local day; `getPlaysByDay`
  applies it in SQL via `date(played_at, '±N minutes')` (`localDay()` in `db.ts`). Caveat: one
  current offset is applied to all rows, so plays within ~1h of a
  *past* DST change can land a day off — fine for personal history. Cron-context callers
  (no request) get offset 0, but they don't compute day buckets, so it doesn't matter.
- **Listened time ≠ play count — it's measured per play, capped at the song.** Each play
  counts the gap until your *next* play, capped at the track length, so a song you skip part-way
  counts only the seconds it actually ran (`playsWithListened` / `getDailyStats` in `db.ts`).
  A play that ran under 5 s counts **zero** (a skip, not a listen; `LISTEN_MIN_MS`). An
  isolated play (next play more than a song-length later) is assumed to have finished — the best
  estimate available, since Spotify reports *when* a track played, never *how long*. Plays are
  always the real count; this only shapes the "listened" totals. Whole-table totals
  (`alltime_stats`) are cached in `meta` and recomputed on write; per-day totals compute live.
- **Row-scanning reads go through a local replica, not the remote DB — and Turso's slowness
  is not latency.** Medians over n=8, because single-shot timings against this primary are
  worthless (`SELECT 1` alone ranged 37–440 ms in one run): round trip ~47 ms, but
  `SELECT COUNT(*) FROM tracks` (15k rows, nothing returned) is ~312 ms against ~0.02 ms for
  the same data in local SQLite. The cost is per row scanned, and no index tuning hides it
  once a query touches thousands of rows. `getReader()` in `db.ts` therefore serves scanning
  reads from a **libSQL embedded replica** (a local SQLite copy synced from the primary) —
  same SQL, identical rows: history search 344 ms → 5.7 ms, the all-time list 705 ms →
  8.9 ms, one day's plays 41 ms → 0.9 ms, the day-strip mount scan 105 ms → 13 ms.
  **Treat any primary-side number here as an order of magnitude, not a constant** — the
  same query measured 2.9 s earlier in the day and 344 ms later, unchanged. That is also a
  correction of the record: the messages of commits `76e2c61` and `37af0ea` cite single-shot
  figures (e.g. search 2933 ms, all-time list 2952 ms) that read 3–7× larger than the medians
  here; the medians are the measurement, the commit messages are what one draw from a
  high-variance backend looked like. Writes and everything touching `meta` stay on `getClient()` (the
  primary): a write through a replica forwards-then-pulls (~5× slower), and the token/lock
  rows must never be read from a copy another instance's refresh hasn't reached, which is the
  `invalid_grant` race `acquireLock` exists to prevent. Every write ends with `syncReader()`
  so the read after it is fresh. **Another process's write is never served stale**: there is no
  background poll (a 30 s `syncInterval` was 2,880 pulls/day per instance whether or not
  anything had been written, and still left a 30 s stale window). Instead every write that
  touches a replica-served table bumps `meta.write_seq` in its own batch, and `getReader()`
  gates on it once per request — replica when the primary's marker and the copy's match,
  primary for that request plus one background catch-up pull when they don't. Idle instances
  pull nothing; a cross-instance write is visible on the very next read.
  A cold instance is never blocked on the copy — `getReader()` returns the primary until the
  first sync lands — and if the replica can't be built at all, everything keeps working on
  the primary. Kill switch: `LAZYBOY_NO_REPLICA=1`.
- **The render-path reads are cached in Next's data cache, and `meta.write_seq` — not a
  timer — is what keeps them fresh.** With the replica off in production (the kill switch is
  set there, so the syncs quota stops burning) every day-strip / per-day / playlist-grid read
  is a scan against the remote primary, and Turso bills rows SCANNED: revisiting a day re-read
  the whole `plays` table to produce a byte-identical answer. Measured 2026-08-05 against the
  primary, medians (min–max), n=7, 6,995 plays: one day's plays 722 ms (170–1,023), the 14-day
  strip 896 ms (235–3,008), the whole-history strip 1,405 ms (1,047–4,474) — the last of which
  fired on *every* Home mount. (A second session half an hour later put the same day read at
  136 ms; absolute figures are session weather, the shape isn't. `bench-reads.mjs day` re-runs it.) So `getPlaysByDay` / `getDailyStats` / `getAllTimePlays` /
  `getStoredPlaylists` are wrapped in `unstable_cache` in two shapes:
  **LIVE** (today, yesterday, the strip, the all-time list, the playlist grid) takes
  `meta.write_seq` as an argument purely so it lands in the cache KEY — any write that changes
  what they read bumps the marker, so the next read has a different key and recomputes. That is
  the whole freshness guarantee for TODAY, and it is why the ~2-min sync still surfaces new
  plays immediately: `recordPlays` bumps the marker, and `syncReader()` drops the request's
  shared copy of it, so the re-read that follows a sync cannot be served the pre-sync entry.
  The `revalidate` on those entries is a garbage bound on superseded keys, **not** the
  freshness mechanism — never reach for a shorter TTL to "make it fresher", the key already
  did it. **FROZEN** (a day older than **today−2 in the user's zone**) drops the marker from
  the key, so every later visit — any tab, any instance — costs zero DB reads. The cutoff is
  today−2, not yesterday: plays only land at "now", but a resumed sync backfills up to
  Spotify's last-50-plays window, so yesterday must stay live. And frozen entries still expire
  daily rather than living forever, because two columns of a past day are *derived* and can be
  rewritten later — `source` resolves from `contexts` (a name that 403'd at play time can
  resolve a month on) and from `plays.ctx_orphan`, which flips when a playlist's membership
  changes. If the marker can't be read at all, the call runs UNCACHED — without it there is no
  proof an entry is current, and fresh-but-slow beats stale.
  Two traps when verifying this: `unstable_cache` is bypassed for any request carrying
  `cache-control: no-cache` in dev (`incremental-cache/index.js`), so a probe fetched with
  `cache: "no-store"` will show a DB read on every hit and look like the cache is dead — use a
  cache-busting query param instead; and never cache anything from `meta` (tokens, locks,
  `*_synced_at`) or the auth path — those are coordination reads and must stay live on the
  primary.
- **The Data Cache OUTLIVES THE DEPLOY, so a cache key must identify the payload SHAPE, not
  just the data.** This shipped broken on 2026-08-05 and is the one cross-deploy hazard every
  `unstable_cache` entry in `db.ts` shares. The search index was keyed on
  (key parts + `MAX(rowid)` version); adding album art changed what the cached function
  RETURNED but moved neither, so the new deploy hit the previous deploy's entry, got the old
  bare-array value, destructured it as `{ images, tracks }` into two undefineds and served a
  body with no tracks in it. Every browser then silently lost its index and fell back to a
  server search per keystroke. Reproduced locally, `next start`, no Vercel needed: build with a
  marker in the cached value → request it → change the marker → rebuild **without** clearing
  `.next/cache` → the route still serves the FIRST build's marker. Bump a shape token in the key
  parts and the same rebuild serves the new one. So: **changing the return shape of a cached
  read means moving its cache key in the same commit** (`LIBRARY_INDEX_SHAPE` /
  `HISTORY_INDEX_SHAPE` are the pattern —
  it keys the entry AND rides in the ETag, so the server cache and the browser cache invalidate
  together). `TrackStats` / `DayStats` / `StoredPlaylist` are the shapes the other cached reads
  serve; add or remove a field on one of them and its key must move too. Nothing detects a
  stale-shaped entry at runtime, and it does not expire for a day.
- **A client must never treat "HTTP 200" as "a payload I can read", and never let a failed
  request leave a spinner up.** Same incident, second half: the search box hung on "Searching…"
  indefinitely, which was NOT the stale shape (that degrades to the server fallback) but a
  rejected server action with no `.catch` — the state that renders the spinner was only ever
  cleared on success. Any promise a view's pending flag depends on needs a failure path that
  records the attempt under the same key a success would, or the UI waits forever. Verified by
  aborting the action in Playwright: before, "Searching…" at 9s and counting; after, a real
  message at 300ms.
- **A bundled replica snapshot cannot speed up cold starts — the primary rotates its libSQL
  replication generation periodically** (observed 2026-08-01: as often as every ~7–11 min —
  gen 4470→4473 over ~25 min — but a later 19-min window sat on one generation; cadence is
  variable and any rotation inside a deploy's lifetime kills a seed).
  A same-generation seed boots in ~0.9s vs ~2–6s full sync, but one generation behind costs
  ~6s and two behind ~14s — *worse than starting empty* — and a deploy-time seed is stale
  within minutes. Measured and rejected; details above `REPLICA_SIDECARS` in `db.ts`. What
  works instead: the replica boots lazily on the first scanning read (the eager instance-start
  warm in `src/instrumentation.ts` was removed 2026-08-03 — every cold instance, including the
  cron-only ones that never scan, pulled the full ~17MB and it burned 77% of the free plan's
  3GB/mo syncs quota in 3 days), and a damaged inherited replica file is wiped and re-synced once (sync() succeeds on
  a corrupt file; the failure only surfaces on the first query). Minimal correct sidecar set
  when copying a replica: `.db` + `-info` + `-wal` — omitting `-wal` silently loses every row
  still in the WAL.
- **Turso meters four dimensions and blocks on ANY of them — optimizing one silently loads
  another, twice now.** Rows read, rows written, syncs and storage each have their own cap,
  and exceeding any single one blocks every query until the calendar month resets. Incident
  one (Aug 3): the eager replica warm was burning the 3 GB syncs quota → replica turned off
  in prod → every scanning read became billed primary rows. Incident two (Aug 6): the
  rows-read counter hit 86% — dominated by `unresolvedContextUris`, a full plays scan +
  per-row contexts probe (~14K billed rows) that ran on EVERY sync call (~1,000+/day across
  the cron tick, the second ~5-min pinger, and the open tab's 2-min refresh), replica-less.
  It was invisible because it is milliseconds on a local file and its cost lives on a
  dashboard nobody re-visits. The rules this bought: (1) any change that moves traffic
  between the replica, the primary, and the cache states its expected cost on *every*
  metered dimension before it ships — the model and per-path costs live in
  `docs/READ_QUOTA.md`; (2) a per-call read may not scan a table that grows with history —
  bound it to the batch in hand (`unseenContexts()`: a new context can only arrive via the
  incoming plays, so check those ≤50 URIs; the full scan survives as a once-a-day pass for
  the 30-day negative-cache recheck); (3) the guard is `/api/cron/usage-check` + a daily
  cron-job.org job with failure e-mail — the real counter, checked mechanically, not a
  convention about benchmarks.
- **If a query is slow, count the rows it SCANS, not the rows it returns.** Both bad ones
  returned little. `searchHistory` is `LIKE '%q%'`, unindexable by construction, so it scans
  `tracks` — ~6 ms on the replica but 1,904 ms median (1,383–3,133, n=7, 2026-08-05) against the
  primary, which is what production runs. It is no longer on the keystroke path: **library
  search matches in the BROWSER** against `/api/search/{library,history}` (db.ts, "The
  client-side search payloads"), and `searchHistory` survives only as the fallback while those
  load.
  `sourceExpr` was worse and is fixed (next bullet). `getPlaysByDay` was the
  third: `date(played_at, '±N minutes') = :day` is the *authority* on which local day a play
  belongs to, but it's a function of the column, so no index can serve it and one day's ~90
  rows cost a full `plays` scan. It now carries a redundant `played_at >= :from AND < :to` in
  raw UTC alongside the `date()` equality — same window, expressed so `idx_plays_played_at` can
  seek it (`SCAN p` → `SEARCH p USING INDEX idx_plays_played_at`). Verified equal rather than
  assumed: identical rows for all 67 days in the store, and a deliberately 1h-off range made 29
  of them disagree, so the check can actually fail (`bench-reads.mjs day` runs both halves). Add the same pair to any new day-scoped
  query — the `date()` half alone is correct and slow, the range half alone is fast and wrong
  at the boundary.
- **A play's "From" is stored (`plays.ctx_orphan`), not derived per read.** The rule — blank
  the source when Spotify reports a playlist context but the song isn't in that cached
  playlist — used to be two correlated `playlist_tracks` subqueries per *output row*, which
  was ~90 % of `getAllTimePlays`. It was also the wrong shape: the answer only changes when a
  playlist is synced, but the expression re-derived it on every render. Now
  `recomputeOrphanFlags()` refreshes the flag exactly when membership can have moved —
  `{newOnly}` for plays just recorded, `{playlistId}` when one playlist's tracks change,
  unscoped for the backfill and for a library-list rewrite that actually dropped memberships
  (`needsFullOrphanPass`: the playlist id set moved, or the purge deleted rows — the unscoped
  pass bills ~2.5M rows, so a rename or a reorder must not trigger it) — and writes only rows whose
  verdict actually flips, so a steady-state sync writes zero rows. Measured on the live DB
  (medians, n=5): all-time list 63 ms → 8.9 ms and history search 36 ms → 5.7 ms on the
  replica, rows identical, 0 mismatches against the old expression across all 6,644 plays.
  On the **primary** the same change is only 903 ms → 705 ms and 546 ms → 344 ms, and one
  day's plays does not improve at all (41 ms either way) — the win is real on the replica and
  marginal-to-absent against remote Turso, whose variance swamps it.
  **If you add a way for playlist membership to change, call `recomputeOrphanFlags` from it**
  — that is the one thing that can now go stale. A `NULL` flag reads as non-orphan, which is
  the same answer the old expression gave for a playlist it couldn't verify, so a missed
  recompute degrades to "shows the playlist name" and self-heals on the next sync.
- **Resume picks up where you left off in a playlist** (`resumePlaylistAction`): it scopes
  plays in that playlist to the most recent session (>3 h gap splits sessions), takes the end
  of the longest in-order run within it (tolerating small skips), and resumes at the next
  track. It matches plays to playlist positions by id **then by `(name, artist)`** so relinked
  ids still count (see the relinking note under Spotify Web API). Reads are cached
  (`getPlaylistTracks`) + run in parallel with auth; the only network write is the Spotify
  play call.
- **`db.ts` query conventions (follow them for new queries — they're in the file header).**
  Every row-scanning read goes to `getReader()` (the replica): primary scans are seconds-scale
  with unbounded session-to-session variance (the same plays scan measured ~105ms one morning
  and 1.4-2.2s that afternoon), replica reads are single-digit ms. Keep `INNER JOIN` for
  `lower(artist)`/`lower(name)` identity lookups so the planner uses `idx_tracks_artist_name`
  (22-24ms vs 82-510ms on the primary) — but `LEFT` vs `INNER` on plays-driven joins is
  measured indistinguishable, so it's a style default now, not a perf rule, and `LEAD`/`LAG`
  are fine on the replica (~1.5× a plain fetch). Cache whole-table aggregates in `meta`
  (covered by `scripts/verify-derived.mjs`); writes + all `meta` keys use `getClient()` and
  serial primary reads stack ~20-30ms each, so dedupe or `Promise.all` them. Never turn a
  single-session primary timing into a rule.

## Measuring a search from the browser (`lb-perf`)

Server logs cannot answer "how long did my search take" — matching runs in the browser against
the client-side index and the rows are painted there, so the only honest clock is the one in
the page. Open `/home?perf=1` once (it sticks; `?perf=0` or clearing `localStorage.lb-perf`
turns it off) and every query logs one console line:

```
[lb-perf] “bitter” rows=6 paint=18ms art1=18ms artAll=18ms stats=276ms index=memory
```

All times are from the **last keystroke** (each keystroke supersedes the previous probe, so a
burst of typing reports the wait after you stopped). `paint` = rows on screen, `art1` / `artAll`
= first and last album image of the VISIBLE rows (off-screen rows are `loading="lazy"` and never
fetch at all), `stats` = play counts and times filled in, `index` = where the query was answered
(`memory` / `fetching` / `fallback`). A dash means it never arrived — `stats=—` is a failed
hydration, which is reported rather than waited out. Everything is behind one boolean read, so
with the flag off the readout costs nothing. Implementation: `src/lib/search-perf.ts`, which is
the ablation harness that measured the album-art variants, so its numbers are comparable with
the ones quoted in the commit history.

## Verifying UI with Playwright

- The dev server is usually already running in the background; HMR is reliable now
  that the project is outside OneDrive (see Runtime / dev environment above).
- Auth expires ~hourly → re-auth in the browser: `/login` → "Connect Spotify" →
  "Agree" (the Spotify account stays logged in, so it's two clicks).
- Save screenshots to `~/.claude/screenshots/` (user rule), never the project.

## Player simulation (now-playing + track menu)

- **Now-playing must never show stale data.** Use live player state, NOT `recently-played`
  (that's history). `currentlyPlaying()` reads `/me/player/currently-playing` (204 → `null`
  when idle), then **falls back to `/me/player`** when that returns 204 — the
  currently-playing endpoint intermittently 204s *during* active playback (right after a
  track change / slow desktop client), which read as "the site doesn't recognize my player."
  `/me/player` still reports the active device's track in that window and itself 204s when
  there's truly no active device, so the fallback stays live. The bar (`now-playing.tsx`,
  mounted in the `(app)` layout) renders only when a track comes back.
- **Add to queue** needs an active device; Spotify 404s otherwise → the action returns a
  friendly "no active device" message. Same dev-mode caveats don't apply (it's your own player).

## Reuse, don't recreate (post-refactor)

Shared helpers were extracted — use them instead of re-writing:
`lib/format.ts` (durations/times/day labels), `lib/filter.ts` (`fuzzyFilter`),
`components/album-thumb.tsx`, `components/sort-menu.tsx`, `components/floating-bar.tsx`.
The `(app)` pages stream their data (Suspense) so a slow/rate-limited Spotify call never
blocks the whole page — keep that pattern.

## Per-instance server state is invisible across serverless instances

Three things live in module/`globalThis` memory, so they're shared only *within one Node
process*, not across a multi-instance deploy (e.g. Vercel):

- **Task registry** (`lib/tasks/registry.ts`) — the instance that polls `/api/tasks/[id]`
  may not be the one that ran the task → progress can 404 in production. (It now sweeps
  finished tasks after 10 min so a long-lived process doesn't leak them, but the
  cross-instance gap needs the Redis/DB swap in ROADMAP Phase 3.)
- **Spotify rate-limit cooldown** (`lib/spotify/client.ts`, `cooldownUntil`) — a 429 only
  backs off requests on the same instance.
- **Playlist cache** (`lib/spotify/resources.ts`) — one process-wide entry (intentionally
  not keyed by access token, which only caused a guaranteed miss + leak on each hourly token
  rotation); each instance has its own.

All three are acceptable for local/single-instance use. What genuinely *coordinates* across
instances is anything that goes through the DB — notably the token-refresh lock (`meta`
table). When something must be correct multi-instance, put it in the DB, not module scope.

## Background tasks outlive the access token — pass a token getter

A clean reconcile or full library sync can run longer than Spotify's ~1 h access token. Don't
hand a background task a fixed token string — it'll 401 mid-run. Pass a `TokenSource` getter
(`refreshingToken()` in `actions.ts`; `startLibrarySync` and the cron route build the same
getter from `getValidAccessToken`) so the client refreshes through the shared lock as
needed. Interactive request-path callers still pass the plain string (fresh for the request).

## Server actions must rethrow Next's control-flow errors

`getSpotify()` handles a dead session by calling `redirect("/login")` — which works by
**throwing**. A server action that wraps it in `try/catch` and maps the error to a result
turns that redirect into a literal `"NEXT_REDIRECT"` error toast. Every catch that can see
`getSpotify()` (or anything else that may `redirect()`) starts with
`unstable_rethrow(e)` from `next/navigation` — see `fail()` in `(app)/actions.ts`. Keep
that line first in any new action's catch.

## POSTs are never blind-retried

`client.ts` retries network errors/timeouts — but only for non-POST methods. A timed-out
POST may still have been applied by Spotify, and the POSTs here aren't idempotent
(add-items again = duplicate tracks; create-playlist again = a second playlist;
next-track again = double skip). GET/PUT/DELETE re-send safely. Don't "fix" a flaky POST
by adding it back to the retry loop.

## Dead playback contexts are negative-cached

`contextName()` returns `null` only for 403/404 (dev-mode forbidden / deleted) and the
history sync records those as a `contexts` row with `name = NULL` — that row is what stops
the same dead URI being re-fetched on *every* sync (displays fall back to the context type
via `COALESCE`). Transient failures throw instead and stay unresolved for the next sync.
The cache is self-healing: negative rows carry a `checked_at` and are re-tried after ~30
days (`NEGATIVE_RECHECK_MS`), never-seen contexts always first — so if the app ever leaves
dev mode, names fill in on their own within a month. No manual cleanup.

## FloatingBar measures its previous sibling

The bottom search pill computes the page's bottom padding from
`wrap.previousElementSibling` — "the last real content element". Anything `position:fixed`
rendered between the content and `<FloatingBar>` poisons that measurement (its rect is
viewport-relative) and zeroes the clearance. Keep fixed-position extras (back-to-top etc.)
*after* the pill in JSX; DOM order doesn't matter visually for fixed elements.

## Deployment skew + stale tabs

A deploy does not reach an open tab until that tab reloads, so a tab left open keeps
executing the old bundle — and calling whatever the old code called — indefinitely. That is
what the Aug 7→8 burn was: one always-on tab on a pre-fix build, refreshing ~2×/min at a flat
~2.55M rows/h for 15+ hours (`docs/quota-forensic/OLD_BUILD_COST.md`). The guard closes the
window to minutes. `next.config.ts` mints a `NEXT_PUBLIC_BUILD_ID` (Vercel's commit sha; a
timestamp locally) and inlines it into both bundles; the tab compares it against the server's
and `src/lib/build-skew.ts` decides when to reload itself.

**It reads two sources, and the difference between them is the point.** `/api/now-playing`
returns the id on every reply, so that beacon is free — it rides the 6s poll the app already
makes. But **Vercel skew protection pins a client's requests to the deployment that served
it**, which is what kept the burner tab on pre-fix server actions for a day: a pinned tab's
poll answers with the pinned tab's *own* id, so its "match" means nothing and that beacon
alone would never fire. The escape is the cookie that does the pinning. Every ~5 min (a
counter on the existing poll — no second timer) the leader fetches `/api/build` with
`credentials: "omit"`; no cookie goes out, so the request lands on the *current* deployment
and its answer can be believed. Hence the asymmetry in the decision module: an authoritative
match clears the streak, a poll match clears only a streak no probe has contradicted, and a
probe saying "stale" while the poll says "current" is not a tie — that divergence *is* the
pinned-tab signature and counts as mismatch. `/api/build` is deliberately unauthenticated
(a request with no credentials is one no session can attach to) and must stay free of auth
and DB work; a tab hits it for as long as it stays open. Followers never fetch either
endpoint — they read both ids off the leader's broadcast.

The three brakes each cover a different failure, so don't tighten them casually: a mismatch
must hold **continuously for 3 min**, because a deploy mid-propagation serves old and new
replies alternately and a *fresh* tab seeing that flap must not reload; **one reload per
10 min** per browser (localStorage stamp), because a beacon that could never agree would
otherwise reload-loop; and a reload is **deferred while the tab is visible and was touched in
the last 60 s**, so nobody's page is yanked mid-use — the streak keeps running and it fires
at the next idle or hidden moment, and a hidden tab (the expensive kind) reloads immediately.
End to end a pinned stale tab reloads within ~3–8 min of a deploy (probe cadence + debounce).
Known answers, including the pinned case and its control: `node scripts/test-build-skew.mjs`.

## Production security

See `docs/SECURITY.md` before any public deploy. Biggest item: the listen-history DB is
**not user-scoped** (single-user). `/api/cron/sync` is **fail-closed** — it requires
`CRON_SECRET` to be set (and matched); an unset secret rejects every caller, so the schedulers
won't run until it's configured. Baseline security headers are in `next.config.ts`.

---

**Related:** [ARCHITECTURE](ARCHITECTURE.md) (the design these traps sit under) ·
[CONVENTIONS](CONVENTIONS.md) · [SECURITY](SECURITY.md) · the repo root `AGENTS.md`
(Next 16 API notes) and `CLAUDE.md` (project overview).
