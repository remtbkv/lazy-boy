# 01c — Background work: history sync, library rescan, now-playing, the recorder, the scripts

Lane 0221_lb_mu_ov_sync, 2026-10-14. Planning only: nothing here changed code, data, the Zenbook
or Vercel. Line numbers are against commit `ac6f7fe`. Every number says how it was measured;
the exact commands are in Appendix A. "Rem's day" below means UTC 2026-10-14 unless stated.

Status: outline — sections fill in order; each is committed as it lands.

## 0. Summary

## 1. Inventory: every background job today

"Runs" are for Rem's day (UTC 2026-10-14) from the Zenbook's `~/lazyboy-cron/ping.log`, the store
meter's query log and `api_log` (Appendix A).

| job | trigger and cadence | code | runs on Rem's day |
|---|---|---|---|
| Closed-app history sync | Zenbook user timer `lazyboy-cron-sync.timer` (`OnUnitActiveSec=2min`, `OnBootSec=3min`, `Persistent=true`) runs `~/lazyboy-cron/ping.sh`: `curl -m 60` GET `/api/cron/sync` with `Bearer $CRON_SECRET`, reply appended to `ping.log`, non-200 fails the unit | `src/app/api/cron/sync/route.ts:60-185` | 716 ticks, 0 non-200. Over the log's 2,000 lines (Oct 12 06:20Z to Oct 15 01:13Z) 3 were `http=000` (curl failed) |
| Daily Vercel cron | `vercel.json` `0 7 * * *` on the same route | same | 1. Its daily block keys on an `x-vercel-cron` header Vercel does not send (`route.ts:67-91`, QUEUE.md C2), so it runs as one more ordinary tick |
| Retired callers | the cron-job.org job and the Zenbook's root `lazyboy-sync.timer`, both holding stale secrets | rejected at `route.ts:64-66` before any work | not counted |
| Open-app sync | `SyncOnLoad` POSTs `/api/sync` on load, every 2 min while visible, and on visibility change (`src/components/sync-on-load.tsx:12-27`); the route skips if `last_sync` is under 60 s old | `src/app/api/sync/route.ts:12-47` | 0 harvests that day (3 on Oct 15 so far) |
| Home's refresh | `refreshHistoryAction` every 120 s while Home is visible, on visibility, and forced on each track change; ambient triggers are throttled to 45 s client-side (`src/app/(app)/home/den-home.tsx:743-748, 989-993`). It calls `syncRecentPlays` with **no server debounce** (`src/app/(app)/history-actions.ts:133`) | `history-actions.ts:119-182` | 4 harvests (13 on Oct 12) |
| Library rescan, from the tick | `maybeSyncLibrary`: when `library_synced_at` is over 30 min old and no attempt in 10 min. Only on ticks that harvested, because the idle return comes first (`route.ts:144-146` before `:171`) | `route.ts:28-42` → `src/lib/sync/library.ts:29-104` | 32 |
| Library rescan, client fallback | `PlaylistsSync` kicks POST `/api/playlists/sync` when the store is empty or over 2 h stale; server-gated at 2 h, one task per instance | `src/components/playlists-sync.tsx:12`, `src/lib/playlists-sync.ts:24-71`, `src/app/api/playlists/sync/route.ts` | 0 |
| One playlist's resync | a detail page whose cached `snapshot_id` differs POSTs `/api/playlists/[id]/tracks` | `src/app/api/playlists/[id]/tracks/route.ts` | 0 |
| Now-playing | GET `/api/now-playing` every 6 s while visible, from one leader tab per browser (Web Lock `lb-nowplaying-leader` + BroadcastChannel), plus end-of-track polls | `src/components/now-playing-context.tsx:71-111, 358-360`; `src/app/api/now-playing/route.ts:18-69` | 7 Spotify calls (89 on Oct 13): Rem rarely keeps a tab visible |
| Backstop recorder | Zenbook `lazyboy-recorder.timer` (`OnCalendar=*:0/15`, `RandomizedDelaySec=30`, `Persistent=true`) runs `~/lazyboy-recorder/recorder.py`: its own token chain (`tokens.json`), one GET recently-played?limit=50, `INSERT OR IGNORE` into its own SQLite `backstop.db` (31,068,160 bytes) | on the Zenbook, not in the repo | 96 |
| Other Zenbook timers | `lazyboy-backup.timer` 04:40 (SQLite backup API, integrity check, gzip, rclone to OneDrive); `lazyboy-readmeter.timer` (15 min); the meter service on 8090 | `docs/quota-forensic/BRIDGE.md`, `ops/zenbook-meter/` | 1 backup, 96 samples |
| Quota guard | `/api/cron/usage-check`, dormant; its cron-job.org caller last ran 2026-08-10 | `src/app/api/cron/usage-check/route.ts` | 0 |
| Scripts | run by hand: `backfill-from-backstop.mjs`, `import-extended-history.mjs` (both close with `import-tail.mjs`), `verify-derived.mjs`, `bench-reads.mjs`; one-shots already run: `backfill-scan.mjs`, `migrate-skip-rule.mjs`; tests: `test-*.mjs`; `setup.mjs`, `gen-han-fold.py` | `scripts/` | — |

Everything that captures plays when the app is closed (the 2-minute pinger and the recorder) runs
on the Zenbook. The daily Vercel cron is the only off-Zenbook trigger.

## 2. Per run: Spotify calls, store reads and writes (measured)

### 2.1 The cron tick, by kind

The tick's path (`route.ts:95-172`): read the token (`getValidAccessToken`, refreshing through the
lock if under 60 s left); read the harvest gate; ask the player what is playing; harvest
recently-played only if something is playing, something played since the last harvest, or the last
harvest is over an hour old (`src/lib/harvest-gate.ts:20-24`); then maybe rescan the library.

| tick kind (Rem's day) | ticks | Spotify calls per tick (deduplicated, see 2.8) | store round trips p50 / p90 | wall time p50 / p90 / max |
|---|---|---|---|---|
| idle: nothing playing, gate closed | 436 | 2 for 413 ticks (currently-playing 204, then `/me/player` 204); 1 for 22 (a paused track: currently-playing 200) | 6 / 8 | 1.1 / 2.3 / 13.8 s |
| harvest, nothing new | 155 | 2 when playing (currently-playing 200, recently-played); 3 for the 16 session-tail or hourly-backstop harvests | 16 / 18 | 2.3 / 5.0 / 12.3 s |
| landed one or more plays | 125 (121 with one play, 4 with two) | 2-3, plus one per never-seen playback context (1 that day; capped at 20, `src/lib/sync/history.ts:60-63`) | 30 / 32 | 3.7 / 12.2 / 34.2 s |
| either of the two above, plus a library rescan | 32 | +~5 (2.3) | 146-161 | 6.9-11.9 s p50, max 29.1 s |

Wall time is the window from the tick's first store request to `ping.sh` getting its reply,
both clocked on the Zenbook; it leaves out a cold start's time before the first query.

Store rows per tick, from the meter's per-statement counts divided by the calls that make them:

- **Idle:** about 3 single-key `meta` reads (the token, the two gate stamps) and, on a cold
  instance, the schema init (28 cold starts that day, counted by `PRAGMA table_info(plays)`).
  Writes: the two `api_log` rows (4 rows written each, index entries included), which
  STORE_MIGRATION moves to the telemetry store, and `player_last_active` when something plays.
- **Harvest, nothing new:** ~215 rows read. `recordPlays` reads the batch's tracks by id (~140 rows a
  call: 40,441 over 289 calls) and every stored play at or after the batch's oldest (~50: 14,071 over
  284); `unseenContexts` ~16 (4,448 over 283); the rest are `meta` keys (cooldown,
  `contexts_full_check_at`, the Home payload's shape, the library stamps). Writes: `last_sync`,
  `rp_last_harvest`, one `usage_ledger` row, the `api_log` rows. The ledger's model calls this
  tick 159 rows (`src/lib/read-costs.ts`, `STEADY_SYNC_TICK_ROWS`, measured 2026-08-07).
- **Landed:** the harvest's reads plus the rebuild chain in 2.2.

### 2.2 What one landed play costs the store

`recordPlays` (`src/lib/db.ts:464-575`) inserts the play and bumps `write_seq` in one batch, then
gives new plays their orphan verdict (`recomputeOrphanFlags({newOnly})`, `:535`), re-opens the
successor of any out-of-order insert (`:547-558`), rules skips (`recomputeSkipFlags`, `:561`), and
recomputes the all-time totals if the last recompute is over 10 minutes old
(`maybeRecomputeAllTimeStats`, `:573`, `:577-583`). `syncRecentPlays` then rebuilds the Home payload
(`src/lib/sync/history.ts:105-109` → `db.ts:1315-1343`).

| step | runs on Rem's day | rows read per run | rows read that day | share of the day's 4,252,260 |
|---|---|---|---|---|
| all-time recompute: `orderedRealPlays`, a full ordered `plays` scan with a `tracks` probe per row (`db.ts:854-869`) | 44 | ~51,000 | 2,244,004 | 53% |
| Home payload: the 16-day strip read (`readDailyStats`, `db.ts:1092-1150`) | 127 | ~5,600 | 715,850 | 17% |
| Home payload: the opening day's plays (`readPlaysByDay`) | 127 | ~1,900 | 238,415 | 6% |
| orphan verdict for new plays | 125 | ~130 | 16,528 | 0.4% |
| skip verdicts | 125 | ~8 | 941 | — |

So a landed play costs ~7,700 rows read, and ~59,000 when the all-time gate is open; across the
day that is 3.2M rows for 129 plays, ~25,000 per play. Written per landed play on the core
tables: ~8 for the `plays` row and its index entries (1,032 for 129 inserts), the `skipped` and
`ctx_orphan` updates, 2-3 `write_seq` bumps, `last_sync`, the ~20 KB `home_payload` row, and 2
`meta` rows when the all-time gate is open: about 15-20 rows.

The all-time recompute is the largest single read the app makes, and it grows with history: its
cost per run is ~2.3 rows per stored play (~22,000 that day, 7,529 of them backfill rows it scans
and skips, 01a §2), and the 10-minute gate lets it run up to 144 times a day.

### 2.3 The library rescan

`syncLibrary` (`src/lib/sync/library.ts:29-104`): `/me` and every page of `/me/playlists`
(`?limit=50`, 3 pages for Rem's 114 playlists), a one-item Liked probe (`/me/tracks?limit=1`), then
the items of each **owned** playlist whose `snapshot_id` changed (`?limit=100` pages, paced 150 ms
apart) and the whole Liked list (`?limit=50` pages) when its count or newest `added_at` moved or
the last full fetch is over a day old.

- Spotify: 166 calls for the day's 32 rescans (deduplicated `api_log`, source
  `cron-library-scan`), ~5.2 per rescan; nothing changed on most.
- Store: ~130 round trips per rescan, most of them serial. The loop reads `plsnap:<id>` once per
  owned playlist (`library.ts:65-66` → `db.ts:2115-2117`), so ~110 one-key reads per rescan, about
  3,500 of the day's 7,469 `meta` reads. Then the list probe (`SELECT … FROM playlists`, 228 rows),
  the Liked signals, and one of three write tiers (`db.ts:1801-1899`): unchanged (two `meta`
  writes); artwork only (198 `UPDATE playlists SET image` that day, the rotating mosaic art); or the
  full rewrite (3 that day), which deletes and reinserts every playlist row, purges orphaned
  `playlist_tracks` and `plsnap:`/`pltracks_at:` keys, and, when the id set changed, runs the
  unscoped orphan pass (3 that day, 394,820 rows read as the meter counts the `UPDATE`).
- When anything changed: `recomputeUniqueSongCount` (4 that day, ~39,000 rows each) and the
  throttled all-time recompute.

### 2.4 The open-app paths: /api/sync and refreshHistoryAction

`POST /api/sync`: the session's token read, a `user_tz_offset` write on every call
(`src/app/api/sync/route.ts:24-27`), the `last_sync` read, and when due a full harvest (2.1). An
open tab therefore harvests only when the cron has not stamped `last_sync` in the last minute, which
is whenever the cron's gate is closed. Browsing the app with nothing playing costs a recently-played
call every 2 minutes.

`refreshHistoryAction`: always a harvest (no debounce), then the strip (`getDailyStats`, served
from Next's data cache unless `write_seq` moved), the all-time totals (one `meta` read), a one-row
head check and, when the browser's index is behind, up to 50 delta rows, and the visible day's plays
(cached). Up to 30 recently-played calls an hour per visible Home tab, plus one per track change.

### 2.5 Now-playing

Per poll: the session's token (one `meta` read), Spotify's currently-playing and, when that answers
204, `/me/player`; the context's name from `contexts` (one indexed read; a never-seen context costs
one Spotify call and a `contexts` write, after which hits are free and failures are cached as
negative rows, `src/app/api/now-playing/route.ts:34-56`); one `api_log` row per Spotify call. At 6 s
that is ~10 polls and 10-20 Spotify calls a minute for each user with a visible tab, the heaviest
Spotify traffic the app can generate per user.

### 2.6 The backstop recorder

Per run: one recently-played call (limit 50) and, when its access token has under 120 s left, a
refresh at `accounts.spotify.com` (about hourly); 50 `INSERT OR IGNORE` into its own `backstop.db`
(key `(track_id, played_at)`, the raw item JSON kept per play). It never reads or writes the app's
store. It runs every 15 minutes whether or not anything plays, so it adds 96 recently-played calls a
day on the same Client ID (01f compared `config.json` with `.env.local`: same Client ID).

### 2.7 One user's day, totalled

Spotify calls per day, deduplicated `api_log`, Oct 1-14 (Appendix A, probe 5): 1,529-1,685.

| source | calls/day | what |
|---|---|---|
| `cron-player-check` | 1,035-1,303 | the tick's player question, 2 calls on every idle tick |
| `cron-sync` | 139-319 | recently-played harvests (plus the rare context name) |
| `cron-library-scan` | 127-175 | rescans |
| `now-playing`, `home-sync`, `onload-sync` | 0-109 | the open app; near zero for Rem |
| the recorder (not in `api_log`) | +96 recently-played, ~+24 token refreshes | |

Recently-played calls for the app: ~235-415 a day (cron 139-319 plus the recorder's 96). No 429 on
any endpoint in the last 30 days (`api_log`, Appendix A, query 4).

Store on Rem's day (meter): 13,629 requests, 4,252,260 rows read, 13,480 rows written. The sync
paths account for ~3.9M of the reads: the all-time recompute 2.24M, the Home payload's two reads
0.95M, the library rescans' unscoped orphan passes 0.39M as the meter counts them (but see 2.8: on
Turso those three passes would have been ~15M), the unique-song counts 0.16M, the harvest probes
~0.06M. About 0.25M were other planning lanes' audit counts. Of the rows written, `api_log` was
8,472 (63%), `usage_ledger` 618; the core tables took ~3,000.

### 2.8 Measurement caveats

- **`api_log` double-logs.** On every day checked (Oct 6-14) 25-30% of its rows are exact
  duplicates: the same millisecond `ts`, path, status and source, at consecutive or interleaved ids
  (e.g. ids 162825-162828: the currently-playing row, the `/me/player` row, then a second copy of
  each). Two calls in one millisecond are impossible here, so these are re-sent INSERTs. They predate
  the meter (Oct 6: 2,218 rows, 1,589 distinct) and cluster on idle ticks, the ones that return
  fastest; harvest ticks' rows are not duplicated, so the recently-played counts (and 01f's August
  ban counts) stand. My hypothesis, not verified: `logSpotifyRequest` is fire-and-forget
  (`src/lib/spotify/client.ts:142-144`), the function is frozen after the response with the INSERT in
  flight, and on thaw the store fetch's 15 s attempt timer has expired, so its retry ladder re-sends
  (`src/lib/store-fetch.ts:52-85`). Every count in this document is deduplicated. 01f's player-call
  figure (~1,734 a day) is as logged; deduplicated it is ~1,035-1,303.
- The meter keeps only the first ~150 characters of each statement, so statements sharing a prefix
  are told apart by rows per call: ~51,000 is `orderedRealPlays` (no `WHERE` window), ~5,300-5,600
  is `readDailyStats`.
- **The meter undercounts the unscoped orphan `UPDATE`.** It logged 131,607 rows per run on Oct 14.
  The same `WHERE` as a `SELECT count(*)` read 5,102,733 through the meter on Oct 13
  (STORE_MIGRATION §3), and Turso billed 2,544,558 for one pass at ~7,300 plays on Aug 7
  (READ_QUOTA.md, sibling sweep), ~350 rows per play, which at today's size is ~5M. So sqld's
  per-statement count for an `UPDATE` appears to leave out its correlated subqueries, and Turso's
  bill does not. The other sync `UPDATE`s touch rows by id or through a partial index and are not
  affected. Where this document projects Turso cost it uses ~5M per unscoped pass.
- One full day, cross-checked against Oct 13 (84 plays landed, 28 all-time recomputes reading
  1,418,708 rows, 82 Home payload rebuilds). A heavier listening day scales the landed terms.
- Wall times are Zenbook-side windows. Vercel's own timings age out of its logs within the hour
  (STORE_MIGRATION §3) and were not read.

## 3. Single-user assumptions on the background paths

The data layer's census (01a §7, ids D1-D38) covers every unscoped table, statement and `meta` key
these jobs touch, and 01b §3.4 / 01e §5 cover the unkeyed process state. This table is what is
specific to running the background work, with the overlapping ids named. "Fan-out" means one
invocation processing several users at once, the shape §5 recommends; it turns several latent
collisions into hourly ones.

| id | where | today | with several users, unchanged | needs |
|---|---|---|---|---|
| S1 | `/api/cron/sync` control flow, `route.ts:95-172` | one token, one gate, one harvest, one library per invocation | the route can only ever serve the account whose token is in `meta.spotify_tokens` | a loop over due users with per-user state (§5.2) |
| S2 | the tick's statuses, `route.ts:103-111, 173-184` | 503 when the one token is gone; 500 on any non-429 error | one user's revoked token, de-allowlisting (a 403) or Spotify 5xx fails the tick for everyone and fails the pinger's unit | 200 with per-user outcomes; non-200 only when the tick itself could not run (§5.4) |
| S3 | `getValidAccessToken()`, `auth.ts:278-289`; `inflightRefresh`, `auth.ts:188-196` | no user argument; one in-flight refresh per instance | in a fan-out, two users whose tokens expire together share one refresh promise and one gets the other's tokens (01e A2, 01b §3.4). Hourly, near certain | per-user accessor and a map of in-flight refreshes keyed by user; per-user lock name (01a D20) |
| S4 | in-memory `cooldownUntil`, `src/lib/spotify/client.ts:48, 157, 178`; persisted `spotify_cooldown_until`, `db.ts:2376-2392` | one window for every endpoint; the 429 body is never read | a recently-played quota ban (a per-bucket event) also stops every user's player probe and library rescans; a rate-limit 429 correctly stops everyone | classify the 429 by `error.reason` (`QUOTA_EXCEEDED` vs a rate limit, §4) and key the cooldown by bucket; keep it app-wide (01a D22) |
| S5 | harvest gate `player_last_active` / `rp_last_harvest`, `db.ts:2364-2374`; `last_sync`, `db.ts:524-528` | one account's playback state | user B's playing tick opens the gate for everyone; `/api/sync`'s 60 s debounce reads another user's stamp | per-user stamps (01a D23) |
| S6 | `refreshHistoryAction` harvest, `history-actions.ts:133` | harvests on every call, no debounce, no gate | each user with a visible Home tab spends up to ~30 recently-played calls an hour from the shared pool (§4) | route it through the same per-user gate, or stop it calling Spotify (§5.5) |
| S7 | `playlistsCache`, `src/lib/spotify/resources.ts:74-81` | one 60 s entry per instance, unkeyed by design | a fan-out rescanning B within 60 s of A on the same instance stores A's playlists as B's library (01b §3.4) | key by user, or drop it from the background path |
| S8 | `currentSyncId` and the token getter, `src/lib/playlists-sync.ts:22, 50-54, 61-65` | one library task per instance, refreshing the one global token | B's kick returns A's task; B's scan would run on A's token (01e A17) | keyed by user, getter bound to the user |
| S9 | `storePlaylists` rewrite, `db.ts:1848-1883` | delete-all and purge on the one library | one user's list change deletes every other user's playlists and cached members (01a D12) | per-user rows; purge shared rows only when no user lists them |
| S10 | gap chains in `recomputeSkipFlags`, the successor reset, `orderedRealPlays`, `readDailyStats` | the predecessor is the previous play in the whole table | another user's play becomes the predecessor: wrong skip verdicts and listened time, no error anywhere (01a D18) | every chain within one user |
| S11 | `recordPlays` dedupe and UNIQUE `(track_id, played_at)`, `db.ts:174, 484-516` | key without a user | two users ending the same track in the same millisecond is rare, but a Spotify Jam plays one queue on both accounts; when it happens the second user's play is silently ignored (01a D4, D17) | `(user_id, track_id, played_at)` |
| S12 | negative context cache, `src/lib/sync/history.ts:67-85`, `db.ts:586-638` | a 403 is cached for everyone | B's 403 on A's private playlist hides its name from A's own syncs, because `unseenContexts` then treats it as seen, until the 30-day recheck (01a D8, D25) | positive names shared, negative rows per user |
| S13 | maybeSyncLibrary inside the tick, `route.ts:171` | the one library rides the harvest tick | a new user's first full scan (hundreds of playlist pages at 150 ms pacing) sits inside a tick other users are waiting on | rescans outside the harvest deadline, one user per tick, resumable (they already commit per playlist) |
| S14 | the daily block, `route.ts:71-91` (dead today, QUEUE.md C2) | global heal, payload rebuild, convention check | heals one user's totals, rebuilds one payload; `checkPlayedAtConvention` (`db.ts:1044-1065`) chains several users' plays and can report a false inversion | per-user loop in STORE_MIGRATION's `/api/cron/daily` (§6) |
| S15 | capture health, `db.ts:1738-1741`, `src/lib/capture-health.ts:17-26` | one `last_sync`, one token presence; the banner tells the reader to "check the Zenbook pinger" | every user sees the owner's capture state | per-user state from the due queue (§5.2); the pinger hint for the owner only |
| S16 | the recorder, `~/lazyboy-recorder/recorder.py` | one token chain (shared with `spotify_tokens_dev`, review L1), no user column | covers the owner only; covering others means their refresh tokens in a plain file on the Zenbook and 96 calls a day each (01a D35, §5.7) | owner-only, or retired in favour of a dual-write (§5.7) |
| S17 | the scripts, `scripts/` | write `plays` and re-open verdicts with no user; `backfill-from-backstop.mjs:73-76` reads every play to build its existing set | a replay inserts the owner's plays with no owner and re-opens other users' verdicts (01a D33, D34) | a required `--user`, every statement scoped |
| S18 | the owner guard, `src/lib/owner.ts:11-14`, `src/lib/auth.ts:344-347` | refuses every account but `SPOTIFY_OWNER_ID` | the one thing keeping S1-S17 harmless today | removed last, after everything above ships |

## 4. Spotify's limits, which bound N

01f §1 is the full policy read. These are the lines the sync design rests on, fetched with `curl`
on 2026-10-14 (Appendix A).

**Five users per app.** "Up to 5 authenticated Spotify users can use an app that is in development
mode" ([quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
The February 2026 migration guide's table: "Client IDs per developer 1 | Users per app 5", and
"Existing apps are grandfathered: If you already have multiple Client IDs or more than 5 users, you
will retain them. These limits only restrict what you can create or add going forward"
([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)).
Whether the owner counts toward the five is not stated (01f §1.2). Extended quota mode is out of
reach: "Spotify only accepts applications from organizations (not individuals)" and requires "at
least 250k MAUs" (quota modes). So N ≤ 5, Rem included. The 25 and 250 the planning program asks
about are not reachable on this app.

**A rate limit per app, over 30 seconds.** "Spotify's API rate limit is calculated based on the
number of calls that your app makes to Spotify in a rolling 30 second window … The limit varies
depending on whether your app is in development mode or extended quota mode"
([rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits)). No number
is published. 01f §1.4 cites an observed safe peak of 18 calls per 30 s (`db.ts:2655-2658`).

**A quota per developer account, in buckets.** "Spotify's Web API has a quota system that limits the
number of requests made through development mode apps that belong to a single developer account.
Note that this is different from rate limits. Endpoints are grouped into quota buckets and requests
to endpoints in the same bucket count toward a shared limit. The specific groupings and limits are
subject to change", answered with a 429 whose body carries `"reason": "QUOTA_EXCEEDED"` (quota
modes). Since July 23, 2026: "Previously, the API quota for Development Mode was counted per app.
Going forward, the quota is counted per developer account. If you have multiple apps in Development
Mode, the quota for all of those apps is shared under a single budget"
([Spotify blog](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)). The one
sentence pointing the other way is the July changelog's "When a user's quota has been exceeded, the
429 Too Many Requests response now contains the following body"
([July 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)).
More Client IDs therefore buy no budget.

**What this app has measured.**

- recently-played has a daily budget: six bans Aug 11-16, each lifting at 10:46-10:51 AM ET
  (`db.ts:2653-2670`), after 629-700 logged calls plus the recorder's ~96, so ~725-800 calls per
  quota day for the whole app (01f §1.4, from a store snapshot). The `api_log` duplication in 2.8 does
  not inflate those counts: harvest rows are not duplicated.
- Since the harvest gate (Aug 17): at most ~415 recently-played calls a day including the recorder
  (Oct 8: 319 cron + 96), and no 429 on any endpoint in the last 30 days.
- Which endpoints share that bucket (`api_log`, Aug 11-17, Appendix A probes 6-7): recently-played
  took 83 429s and `/me` 38, both with `Retry-After` up to ~12 h (43,241 s and 43,040 s), on the same
  days; the first `/me` ban (Aug 12 11:37:32Z) came two minutes before the first recently-played
  ban. No player, playlist or Liked endpoint returned a 429 that week. After 5 of the 83
  recently-played 429s a player call answered 200/204 within ten minutes; successful player polls
  were only logged from Aug 16, so the other windows say nothing either way. So `/me`, which every
  library rescan calls (`library.ts:40`), either shares the scarce bucket or has its own that the
  August failure storm exhausted the same way (a failing rescan was retried on every tick until the
  2026-08-19 audit, `route.ts:33-36`); this document treats it as shared. The player endpoints,
  which the cron asks first for that reason (`route.ts:121-127`), answered during at least some
  bans. Their own limit has never been reached; the cron alone spends ~1,035-1,303 a day.

**The question the design turns on:** is the ~725-800 a day the developer account's, shared by every
user of the app, or each user's? Every statement of the rule says the account's ("a single
developer account", "a single budget"), and one changelog sentence says "a user's quota". With one
user the two readings cannot be told apart, and nothing here has measured a second user. This
document plans for the shared reading, which is the one the documentation states, and §7 decision 3
is how to find out without risking Rem's own capture.

## 5. Running it for N users

N is at most 5 (§4). The worst case below is five users who listen like Rem: ~117 plays a day on
average over the last 30 days (01a §6), 129 on Rem's day, with something playing for ~9 hours.
Every figure in this section is an estimate built from §2's measurements; the arithmetic is shown.

### 5.1 The budget, per user and in total

**The scarce bucket (recently-played, and `/me`).** Budget ~725-800 calls a quota day (01f §1.4). A
budget whose "specific groupings and limits are subject to change" should not be planned at 100%;
this section plans to ~60%, ~450 a day.

| harvest policy (defined in 5.3) | recently-played calls a day, one Rem-like user | five such users | against ~450 |
|---|---|---|---|
| today: every 2-min tick while playing, the session tail, an hourly backstop | 139-319 (cron, measured) + 96 (recorder) | 1,200-2,100 with a recorder each; ~800-1,700 with only the owner's | over |
| (i) harvest when the player probe sees the track change | ~117-130 plays + ~5 tails + 24 backstops ≈ 150 | ~750 (+96 for the owner's recorder) | over, ~1.7× (1.9× with the recorder) |
| (iii) one harvest per 15 min of playback | 9 h × 4 + 5 + 24 ≈ 65 | ~325 | fits |
| (ii) provisional plays from the probe, one harvest per 30 min of playback | 9 h × 2 + 5 + 24 ≈ 47 | ~235 | fits, ~2× margin |

Two smaller terms in the same bucket: each library rescan calls `/me` (`library.ts:40`), 32 a day for
Rem, so ~160 a day at five users, for a value that never changes (the user's Spotify id); and the
hourly backstop, 24 a day per user, which could be every 2 hours (12) because 50 plays is ~2.5-3 hours
of nonstop listening. Dropping the rescan's `/me` and halving the backstop frees ~200 a day at five
users, about what the whole of policy (ii) spends.

Under the per-user reading every row fits, and the plan can keep today's policy.

**The player bucket.** Today ~1,035-1,303 calls a day per user, two on every idle tick (§2.1). Asking
`/me/player` alone (it reports the active device's track, and 204 when there is none; GOTCHAS
"Player simulation") halves the idle tick, ~720 a day. Probing every 5 minutes once a user has been
idle for 30 minutes brings it to ~9 h × 30 + 15 h × 12 ≈ 450 a day. Five users: ~2,250 a day against
an unmeasured limit, about twice what one user spends today.

**The library endpoints** (`/me/playlists`, `/me/tracks`, playlist items): ~130 a day per user
today, ~650 at five. No 429 on them, ever, in the retained `api_log`.

**The 30-second rate limit (per app).** The cron's player probe for five users in the same second is
5-10 calls; spread across the minute (5.2) it is ~2-3 per 30 s. Open tabs are the risk: one visible
tab polls now-playing every 6 s, 10-20 calls a minute. Five users with a visible tab each is 25-50
calls per 30 s, above the 18 per 30 s this app has seen pass without a 429 (01f §1.4). 5.5 caps it.

### 5.2 Scheduling: a per-user due queue

One state row per user (01a's `user_meta`, D9/D23, or a small table of its own):

| field | what |
|---|---|
| `state` | `active` (playing, or played in the last 30 min), `idle`, `backoff`, `needs_reauth` (refresh token dead), `removed` (Spotify answers 403 "not registered") |
| `next_probe_at`, `next_harvest_at`, `next_rescan_at` | when each piece is next due; jittered by a hash of the user id so users spread across the minute |
| `last_probe_track`, `last_probe_progress`, `last_active_at`, `last_harvest_at` | what the change gate (5.3) compares against; replaces today's two global gate stamps |
| `failures`, `last_error`, `last_ok_at` | the circuit breaker (5.4) and the per-user capture-health banner |
| `lease_owner`, `lease_until` | a claim, so an overrunning tick and the next one never process the same user twice |

The tick, once a minute from the pinger:

1. Claim the due users in one statement: an owner-tokened compare-and-set on the lease, the pattern
   `acquireLock` already uses (`db.ts:2541-2557`). This is also the tick's store health check: if it
   fails, the tick ends at once instead of letting N users each wait out the store fetch's three
   15-second attempts (`store-fetch.ts:28-29`).
2. Process the claimed users concurrently (at most 5, which is all of them), each under its own 25 s
   deadline, with `Promise.allSettled`: token, probe, harvest if the policy says so, record, then
   write the user's next due times and release the lease.
3. Run at most one user's due rescan, under its own deadline, outside the harvest deadlines (S13).
   Rescans already commit per playlist and resume where they stopped.
4. Answer 200 with a per-user outcome list. Answer non-200 only when step 1 failed, or when the
   owner's own capture has stopped (the owner's pinger failure is Rem's only alarm today, M1 of the
   Oct 3 review; other users' dead tokens show on their own banners instead).

Cadence by state: `active` probes every 2 min; `idle` every 2 min for the first 30 min, then every
5; `backoff` 2, 4, 8 … 60 min; `needs_reauth` and `removed` make no Spotify calls until the user signs
in again. Rescans every 30 min while active, every 2-3 hours idle.

One invocation for all users, not one per user: at N ≤ 5 it keeps invocations at 1,440 a day
whatever N is, and the pinger needs no list of users (it holds one secret and nothing else).

### 5.3 Freshness from the player, completeness from batched harvests

Completeness needs a harvest before 50 plays pile up; freshness, Rem's 2-minute choice (BRIDGE.md,
"The cron sync pinger"), needs one shortly after each track ends. Today both come from harvesting on
every playing tick, two harvests per landed play on Rem's day (264 playing harvests, 129 plays).
Three policies:

- **(i) Harvest on a track change.** Keep the last probe's track id and progress per user; harvest
  when the track changed, progress went backwards on the same track (a repeat), or playback stopped
  (the session tail). One harvest per play at most, and any changes a probe missed are inside the 50
  returned. Freshness unchanged. Small change in the cron route and the gate (`harvest-gate.ts`).
  Halves the bucket spend; not enough alone for five heavy users under the shared reading.
- **(iii) Batch the harvest.** One harvest per 15 min of playback. Plays reach the store up to 15 min
  late when the app is closed; an open app still shows them at once through its own provisional
  plays (`src/lib/optimistic-play.ts`, `handoff.ts`, the instant handoff in `den-home.tsx`). Trivial to
  build.
- **(ii) Provisional plays on the server.** When the probe sees track A give way to track B, record a
  provisional play of A ending at about B's start (now − B's progress); a harvest every 30 min of
  playback replaces provisionals with Spotify's rows and drops the ones it does not confirm (Spotify
  leaves very short plays out of recently-played). Closed-app freshness stays at ~2 min. The cost is
  real: a provisional flag the skip chain, the all-time totals and both payloads must respect, and a
  reconciliation the browser has but the server does not. A track shorter than the probe interval and
  played in full between two probes gets no provisional row; the next harvest still records it.

Recommendation: build (i) for everyone now; it costs nothing in freshness. If the quota proves
shared, add (iii) for every user, the owner included, unless Rem wants closed-app freshness kept at
2 minutes for everyone, which is what (ii) buys. The budget does not allow today's policy for the
owner and a slower one for friends: the owner alone is ~150 a day after (i), a third of the planning
budget. That is Rem's call (§7, decision 2).

### 5.4 Failure isolation

One user's failure must cost that user's slot and nothing else:

1. **Per-user deadline and `allSettled`** (5.2). A user whose Spotify calls hang uses its 25 s and
   is retried at its next due time; today's single path has no per-user bound (Spotify fetch timeouts
   are 10 s per attempt with up to three retries, `client.ts:8, 109, 121-124`).
2. **Per-user tokens, refresh and lock** (S3; 01e). A refresh token that answers `invalid_grant`
   deletes that user's token row (`clearTokensIfStale`, `auth.ts:170-181`, made per-user), sets
   `needs_reauth`, and stops all calls for that user. A user who revokes the app in their Spotify
   account settings arrives the same way.
3. **De-allowlisted users.** "API requests with an access token associated to that user and app will
   receive a 403 status code error" (quota modes). Today the client retries a 403 once
   (`client.ts:20, 197-201`), the harvest throws, and the route answers 500 for the whole tick
   (`route.ts:180-183`). Read the body ("not registered"), set `removed`, stop.
4. **Owner's Premium lapses.** "If the owner's Premium subscription lapses, the app will stop
   working" (migration guide). Every user then fails the same way at once; the tick must see "all
   users, same error" and back off as one, not mark five users `removed`.
5. **429s by kind** (S4). A rate-limit 429 is app-wide: one shared cooldown, as today. A
   `QUOTA_EXCEEDED` 429 is a bucket event: a cooldown for that bucket (until the observed reset at
   ~10:50 AM ET; the client's 30-minute persisted cap, `client.ts:27`, already limits re-probes to one
   per half hour), while probes and rescans in other buckets carry on.
6. **Spotify 5xx or timeouts for one user:** that user's `backoff`; the others are untouched.
7. **The store down:** step 1 of the tick fails fast for everyone, which is correct, because nothing
   can be recorded. Plays are not lost while it lasts for any user whose outage is shorter than 50
   plays (5.7).
8. **Idempotent writes only.** §2.8 shows re-sent INSERTs happen on this path. A claim is a
   compare-and-set with an owner token, a counter is written as a value rather than incremented, and
   every insert has a natural key (`plays` already does). Writes that must outlive the response go
   through `after()`, as `/api/playlists/sync` does (`src/app/api/playlists/sync/route.ts:14-16`),
   not a bare `void`.
9. **A new user's first rescan** (possibly hundreds of playlist pages) never runs inside the harvest
   deadline (S13, 5.6).
### 5.5 The open-app paths

- **`/api/sync`** runs the same per-user step as the cron (5.2), under the same lease and the same
  harvest policy, so an open tab gets an immediate catch-up on load and never spends more than the
  policy allows. Today it harvests whenever the cron's gate is closed (2.4).
- **`refreshHistoryAction`** stops calling Spotify and only re-reads the store. Today it harvests on
  every call (S6). The browser's own provisional plays already cover the moment a track ends.
- **`user_tz_offset`** becomes a per-user value written only when it changed; today every
  `/api/sync` call writes it, before the debounce (`src/app/api/sync/route.ts:24-27`).
- **Now-playing** needs a per-user cap of about 6 Spotify calls a minute to keep five users under
  ~15 per 30 s. The simplest way: poll every 15 s instead of 6 while a track is mid-play, and keep the
  existing end-of-track and visibility polls, which are what make a track change feel instant; the
  chip already interpolates progress between polls. A user with two devices visible doubles it; a
  short per-user server cache would fix that if it turns out to matter. Either way the cache or the
  poll keys by user (01b covers the browser-side `lb-nowplaying` copy).

### 5.6 The library rescan

- Per-user rows and stamps (01a D5-D7, D23) and a per-user rescan cadence: 30 min while active, every
  2-3 hours idle. Today it rides the hourly backstop harvest when idle (2.1).
- Drop `/me` from the rescan: the user's Spotify id is known from sign-in, and the display name can
  refresh daily. Saves one scarce-bucket call per rescan (5.1).
- Read every playlist's stored snapshot in one statement (a `snapshot_id` column on the user's
  playlist rows, which the list probe already reads at `db.ts:1776-1782`) instead of ~110 serial
  `getMeta` calls. That is ~110 round trips per rescan, about half the day's `meta` reads, and several
  seconds of every rescan at the Funnel's 40-210 ms median round trip (STORE_MIGRATION §1).
- No unkeyed `playlistsCache` on this path (S7).
- Owned playlists only, as today (`library.ts:54`): dev mode returns playlist items "only for
  playlists the user owns or collaborates on" (migration guide).
- A new user's first rescan is the expensive one: one call per 50 playlists, one per 100 tracks of
  every owned playlist, one per 50 liked songs. Rem's library (114 playlists, 7,400 cached
  memberships, 48 liked) is ~150 calls; at the 150 ms pacing that is one to two minutes, too long to
  share a tick with other users, so it runs one user per tick and resumes across ticks (the
  per-playlist commit and the snapshot gate already make a re-run skip finished playlists).

### 5.7 The recorder and the loss floor

During a capture outage of T hours a user loses every play beyond the newest 50 (GOTCHAS,
"`recently-played` only returns the last 50 plays"). Rem averages ~117 plays a day, ~14-16 an hour
while listening on Rem's day and ~20 at peak (`recorder.py`'s docstring), so an outage spanning more
than 2.5-3.5 hours of listening loses plays. Each user's floor is set by their own listening.

The recorder protects only the owner, costs 96 scarce-bucket calls a day (a quarter to two-fifths of
the app's spend in that bucket, 2.7), and runs on the same machine as the pinger, so the outages it
was built for took it down too (the Oct 3 review, D2: Aug 30-Sep 2 and Sep 3-9, plausibly several
hundred plays lost). After STORE_MIGRATION the store leaves the Zenbook but the pinger and the recorder stay
(its §5 diagram), so a Zenbook outage still stops closed-app capture for every user.

- (a) Keep the recorder owner-only and run it hourly: 24 calls a day instead of 96, and no play is
  lost while it runs, since 50 plays outlast an hour of any listening.
- (b) Add a second pinger off the Zenbook (the cron-job.org job and its `CRONJOB_*` env already
  exist, BRIDGE.md). Safe only once the lease in 5.2 exists: the route has no debounce today
  (`route.ts:60-185`), so two pingers would double every user's calls. Once the store is on Turso
  this covers a dead Zenbook for every user.
- (c) Retire the recorder's own calls and have the cron also write each harvest's raw response to a
  second store (the Zenbook's telemetry store after the move). Every user gets a second copy at no
  Spotify cost, but it is no longer independent of the app.

Recommendation: (a) now, (b) when the due queue lands, (c) only if Rem wants a raw copy of every
user's plays held on the Zenbook. Repairing a gap after the fact uses each user's own Extended
Streaming History export, which each user has to request; the importer needs `--user` (S17).

### 5.8 Vercel: invocations and wall time

- Invocations: one per pinger tick, 1,440 a day at one a minute, whatever N is, plus the open apps'
  requests.
- Wall time: the slowest user's step, since users run concurrently. Per user today, through the
  Funnel: idle 1.1 s p50, a landed play 12.2 s p90, a landed play plus a rescan 29 s at worst (2.1).
  STORE_MIGRATION's R1 target (p50 ≤ 15 ms per round trip, against the Funnel's 40-210 ms median)
  shrinks the store's share of a landed tick (~30 round trips) from roughly 1-6 s to well under
  1 s, and batching the rescan's snapshot reads (5.6) removes most of its ~130.
- No `maxDuration` is set anywhere under `src/app` (grep), so the platform default applies; which
  default this project runs with is 01f's (unverified here). A 25 s per-user deadline and one rescan
  per tick keep a tick under a minute whatever the default.

### 5.9 Store reads and writes per user

Against Turso's free plan after STORE_MIGRATION: 500M rows read and 10M written a month, and R4 asks
for ≤ 50% and ≤ 10% projected from a heavy day (STORE_MIGRATION §2).

**Per-user indexes are a precondition.** With a `user_id` column but no user-led index, each user's
all-time recompute scans every user's plays, so the total grows with N × all plays, roughly N².
01a D4's `(user_id, played_at)` makes each user's scan cost that user's plays only.

Rem's sync path in Turso terms, per day: the all-time recompute 1.4-2.2M (Oct 13-14), the Home
payload 0.6-1.0M, the harvest probes ~0.06M, the rescans' unique-song counts ~0.16M, and the unscoped
orphan pass at ~5M a run (2.8) about three times a week (STORE_MIGRATION §3), ~2.2M a day averaged.
That is ~4.5-5.6M a day, ~135-170M a month (27-34%), at today's history.

| five Rem-like users | reads a month | of 500M |
|---|---|---|
| per-user scoped, nothing else changed | ~675-850M | over the plan |
| + the orphan pass scoped to changed playlists (lanes 1910-1911), taken as ~10× cheaper | ~375-540M | over R4, at or over the plan |
| + an incremental all-time accumulator | ~155-215M | 31-43%, inside R4 |
| + the Home payload's strip updated in place on an append | under 100M | under 20% |

The all-time recompute also grows with history: ~2.3 rows per stored play per run, ~44 runs a day for
Rem, ~117 new plays a day, so its daily cost rises ~12,000 rows every day. A year from now it is
~6.6M a day for Rem alone. The accumulator (READ_QUOTA.md calls it "the queued lever") adds the new
plays' listened time to the stored totals and re-derives only around an out-of-order insert, making
the term proportional to new plays. No lane in STORE_MIGRATION builds it (§6).

Light listeners cost far less: the strip read is about 16 days of that user's plays, and their
recomputes are fewer.

Writes: ~3,000 core rows a day for Rem (2.7), ~15,000 for five, ~0.45M a month (4.5% of 10M).
`api_log` (~2,100 rows a day per user as logged, 4 rows written each) stays on the Zenbook under
STORE_MIGRATION and needs the daily prune (01a D32).

## 6. STORE_MIGRATION: what multi-user needs, and what should change before it runs

## 7. Decisions that are Rem's

## 8. Unknowns

## Appendix A: exactly what I ran
