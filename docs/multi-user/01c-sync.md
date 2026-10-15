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
0.95M, the library rescans' unscoped orphan passes 0.39M, the unique-song counts 0.16M, the harvest
probes ~0.06M. About 0.25M were other planning lanes' audit counts. Of the rows written, `api_log`
was 8,472 (63%), `usage_ledger` 618; the core tables took ~3,000.

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
| S11 | `recordPlays` dedupe and UNIQUE `(track_id, played_at)`, `db.ts:174, 484-516` | key without a user | two users in a Spotify Jam can end the same track in the same millisecond; the second user's play is silently ignored (01a D4, D17) | `(user_id, track_id, played_at)` |
| S12 | negative context cache, `src/lib/sync/history.ts:67-85`, `db.ts:586-638` | a 403 is cached for everyone | B's 403 on A's private playlist hides its name from A's own syncs, because `unseenContexts` then treats it as seen, until the 30-day recheck (01a D8, D25) | positive names shared, negative rows per user |
| S13 | maybeSyncLibrary inside the tick, `route.ts:171` | the one library rides the harvest tick | a new user's first full scan (hundreds of playlist pages at 150 ms pacing) sits inside a tick other users are waiting on | rescans outside the harvest deadline, one user per tick, resumable (they already commit per playlist) |
| S14 | the daily block, `route.ts:71-91` (dead today, QUEUE.md C2) | global heal, payload rebuild, convention check | heals one user's totals, rebuilds one payload; `checkPlayedAtConvention` (`db.ts:1044-1065`) chains several users' plays and can report a false inversion | per-user loop in STORE_MIGRATION's `/api/cron/daily` (§6) |
| S15 | capture health, `db.ts:1738-1741`, `src/lib/capture-health.ts:17-26` | one `last_sync`, one token presence; the banner tells the reader to "check the Zenbook pinger" | every user sees the owner's capture state | per-user state from the due queue (§5.2); the pinger hint for the owner only |
| S16 | the recorder, `~/lazyboy-recorder/recorder.py` | one token chain (shared with `spotify_tokens_dev`, review L1), no user column | covers the owner only; covering others means their refresh tokens in a plain file on the Zenbook and 96 calls a day each (01a D35, §5.7) | owner-only, or retired in favour of a dual-write (§5.7) |
| S17 | the scripts, `scripts/` | write `plays` and re-open verdicts with no user; `backfill-from-backstop.mjs:73-76` reads every play to build its existing set | a replay inserts the owner's plays with no owner and re-opens other users' verdicts (01a D33, D34) | a required `--user`, every statement scoped |
| S18 | the owner guard, `src/lib/owner.ts:11-14`, `src/lib/auth.ts:344-347` | refuses every account but `SPOTIFY_OWNER_ID` | the one thing keeping S1-S17 harmless today | removed last, after everything above ships |

## 4. Spotify's limits, which bound N

## 5. Running it for N users

### 5.1 The budget, per user and in total
### 5.2 Scheduling: a per-user due queue
### 5.3 Freshness from the player, completeness from batched harvests
### 5.4 Failure isolation
### 5.5 The open-app paths
### 5.6 The library rescan
### 5.7 The recorder and the loss floor
### 5.8 Vercel: invocations and wall time
### 5.9 Store reads and writes per user

## 6. STORE_MIGRATION: what multi-user needs, and what should change before it runs

## 7. Decisions that are Rem's

## 8. Unknowns

## Appendix A: exactly what I ran
