# 01a — The data layer: store, schema, queries, volumes, and every single-user assumption

Lane 0221_lb_mu_ov_data of the multi-user planning program, Oct 14, 2026. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `ac6f7fe` (`src/`,
`scripts/`, `ops/` and `tests/` are identical to `1c7aabb`). Every number is labelled **[measured]**
(with how and when) or **[estimated]** (with the arithmetic); every statement I ran against any store
is listed in §11.

Source of every measured count and size: the Zenbook's nightly backups, pulled read-only from
`onedrive-backup:lazyboy-db` and opened locally in SQLite's `immutable=1` mode. **S-Oct14** is
`lazyboy-20261014-0840.db` (taken 4:40 AM today), **S-Sep14** and **S-Aug16** the same file from those
mornings. Nothing in this document read the production store or the Zenbook.

Status: complete.

## 0. Summary

- **The store has no notion of a user.** Ten tables, 24.56 MB (core 11.87 MB, telemetry 12.69 MB), one
  client, no foreign keys, no user column; all 243 `meta` rows are global, including the plaintext
  Spotify token rows (one for production, one for dev) (§2, §3). All 74 async exports of `db.ts` are user-less (§7, D2).
- **The owner's data** [measured on the Oct 14 nightly backup]: 22,040 plays (14,511 real, 7,529
  backfill), ~115 real plays a day (median 113, p90 150, busiest 204), 15,859 tracks, 110 owned playlists
  with 7,404 members. Core data grows ~35 KB a day; `api_log` grows ~2,000 rows a day and its 30-day
  prune has not run since Aug 10 (§6).
- **38 single-user assumptions, with file:line** (§7). The ones that would hurt people, not just leak:
  one user's library sync deletes every user's playlists and cached tracks (D12); skip verdicts and
  listened time chain each play to the previous play of ANY user and are then stored (D18); a play is
  dropped when another user played the same track at the same instant (D17); the seven data-cache keys
  and both search ETags carry no user (D26, D27); the playlist page reads any playlist id with no
  ownership check (D14).
- **Recommendation: a database per user** at this app's ceiling of five accounts (§8.1). It makes the
  unscoped statements correct without editing them, leaves the owner's data where it is, and lets a
  deletion reach backups. The row-level alternative is fully specified too (§8.2-8.6), with an INTEGER
  user key (measured 280 B per play against 432 B for a text Spotify id).
- **Scaling: storage is not the limit, reads are** (§9). Measured locally, user-led indexes keep a
  per-user history scan at 32-36 ms from 25 to 100 users, against 130-527 ms without them. On Turso's
  free plan, five owner-like users read ~570-615M rows a month with today's orphan pass (over the 500M
  limit) and ~245-290M with it scoped; per-user reads also grow with each user's history. The biggest
  daily read is a full `plays` scan gated to once per 10 min that STORE_MIGRATION attributes to the
  history payload; the code and the client metrics point to the all-time recompute instead, which runs
  whenever a user listens, app open or not (§11.2). An all-time accumulator and an incremental history
  payload are the data-model levers.
- **STORE_MIGRATION: run it as planned and keep the multi-user schema out of it** (§10). Four small
  additions: archive the meter's pre-cutover logs, make the ledger's route-handler writes reliable or
  label it a lower bound, write the backup as a loop over databases, and re-check R4 at N users.
- **Rem's calls** (§12): the data model, retention for invited users, backups versus the five-day
  deletion rule, and keeping the backstop recorder owner-only.

## 1. Where the data lives and how it is reached

One libSQL client per server process, `getClient()` (`src/lib/db.ts:135-146`), opened against
`TURSO_DATABASE_URL`, or the dev file `data/listens.db` when that is unset (`db.ts:127-129`). In
production the URL is the Zenbook's `sqld` behind the Tailscale Funnel, with the store meter on :8090 in
front of sqld on :8092 (STORE_MIGRATION §5, `ops/zenbook-meter/`). Every statement rides
`makeStoreFetch` (gzip pinned, 3 attempts × 15 s; `db.ts:151`, `src/lib/store-fetch.ts`). There is no
second client and no replica (`db.ts:52-57`, `db.ts:299-310`): every read, every write and every `meta`
key go through the one client.

`init()` runs once per cold process (`db.ts:153-297`): one `executeMultiple` of `CREATE TABLE/INDEX IF
NOT EXISTS`, then four `PRAGMA table_info` reads that add the columns later migrations introduced, then
three more `CREATE INDEX IF NOT EXISTS`. That is the app's only migration mechanism. It is safe for
adding a nullable column or an index; it is not safe for what multi-user needs (a user column inside the
`plays` UNIQUE constraint, new primary keys on four tables), which in SQLite are table rebuilds and cannot
run from whichever cold instance starts first (§8.6).

The same store serves production, every Preview deployment, and any dev server whose `.env.local` holds
the production URL (STORE_MIGRATION §3; GOTCHAS "Dev and benchmarks run against the LIVE production
store"). Dev has its own token row (`spotify_tokens_dev`, `db.ts:2511-2512`) and shares everything else.

Copies outside the store: the nightly snapshot to OneDrive at 4:40 AM (SQLite backup API, integrity
check, per-table count check; `docs/quota-forensic/BRIDGE.md` "The nightly snapshot"), and the Zenbook's
backstop recorder, which captures recently-played every 15 min into its own SQLite file with its own
token chain in `~/lazyboy-recorder/tokens.json` (BRIDGE.md "The Spotify token rows were left alone").
Both are single-user by construction. After STORE_MIGRATION, the seven core tables (`tracks`, `plays`,
`contexts`, `meta`, `playlists`, `playlist_tracks`, `saved_tracks`) live on Turso `lazyboy` and the three
telemetry tables (`api_log`, `client_metrics`, `usage_ledger`) stay on the Zenbook (STORE_MIGRATION §5).

## 2. Schema: every table, column and index

Columns as `init()` and its migrations create them. Production's live DDL (S-Oct14 `sqlite_master`)
matches the code exactly. There are no foreign keys, no `users` table, and no column that names an app
user: `playlists.owner_id` is the Spotify owner of a playlist, not the account that follows it.

Rows and bytes are [measured, S-Oct14]; bytes include each table's indexes (SQLite `dbstat`). The last
column is what the table becomes in a multi-user store; §8 argues each choice.

| table | defined at | rows | bytes (per row) | key | indexes | multi-user |
|---|---|---|---|---|---|---|
| `tracks` | `db.ts:159-167`, `245-249` | 15,859 | 4.20 MB (265 B) | PK `id` (Spotify track id) | `idx_tracks_artist_name (lower(artist), lower(name))` `:182` | shared catalog (public Spotify metadata) |
| `plays` | `db.ts:168-178`, `263-295` | 22,040: 14,511 real + 7,529 backfill | 6.07 MB (275 B) | `id` INTEGER PK AUTOINCREMENT; UNIQUE `(track_id, played_at)` | `idx_plays_track (track_id)` `:177`; `idx_plays_played_at (played_at)` `:178`; `idx_plays_context (context_uri)` `:286`; partial `idx_plays_skip_null (played_at) WHERE skipped IS NULL` `:281`; partial `idx_plays_orphan_null (id) WHERE ctx_orphan IS NULL` `:293` | per user |
| `contexts` | `db.ts:176`, `251-255` | 114 | 29 KB | PK `uri` | none | per user (§8.2: a name depends on whose token resolved it) |
| `meta` | `db.ts:183` | 243 | 66 KB | PK `key` | none | split: two key kinds stay global, the rest become per user or go (§3) |
| `playlists` | `db.ts:184-191` | 114 | 37 KB | PK `id` (Spotify playlist id) | none | per user (it is one user's library list, in that user's order) |
| `playlist_tracks` | `db.ts:192-204` | 7,400 | 1.45 MB (196 B) | PK `(playlist_id, position)` | `idx_pltracks_pl (playlist_id)` `:199`; `idx_pltracks_track (track_id)` `:204` | per user (§8.2 weighs sharing by playlist id) |
| `saved_tracks` | `db.ts:205-209` | 48 | 8 KB | PK `track_id` | none | per user |
| `api_log` | `db.ts:210-219`, `258-262` | 104,942 | 12.37 MB (118 B) | `id` AUTOINCREMENT | `idx_api_log_ts (ts)` `:218`; `idx_api_log_path_ts (path, ts)` `:219` | telemetry; add a nullable user column for per-user rate-limit attribution |
| `usage_ledger` | `db.ts:223-229` | 496 | 49 KB | PK `(day, reader)` | none | telemetry, global |
| `client_metrics` | `db.ts:233-242` | 1,716 | 262 KB | `id` AUTOINCREMENT | `idx_client_metrics_ts (ts)` `:242` | telemetry that holds personal data: `handoff` rows carry "artist — title" and the source playlist (`home/den-home.tsx:888-894`) |

Column notes that matter later:

- `plays.played_at` is ISO-8601 text with milliseconds and marks the END of a play (GOTCHAS "Listened
  time ≠ play count"). The 7,529 backfill rows all carry the sentinel `2026-05-30T00:00:00.000Z` and
  `context_type = 'backfill'` (`db.ts:753-760`). `ctx_orphan` and `skipped` are derived verdicts stored
  per row (`db.ts:263-280`); S-Oct14 holds 481 skipped, 1 pending and 1,162 orphan plays.
- `contexts.name IS NULL` is a negative cache: the URI 403'd or 404'd for the token that tried it
  (`db.ts:101-103`, GOTCHAS "Dead playback contexts are negative-cached").
- `playlists.position` is the order Spotify's `/me/playlists` returned for the signed-in user; `-1` marks
  a row the app inserted right after creating the playlist (`db.ts:2005-2028`).
- `tracks` rows are never deleted. 524 rows in S-Oct14 are referenced by no play, no playlist member and
  no Liked Song (left behind by removed playlists).
- `idx_pltracks_pl` duplicates the leading column of `playlist_tracks`' primary key, which already serves
  `WHERE playlist_id = ?`; it costs 287 KB and every member write. Unrelated to multi-user; noted, not
  proposed.

The file is 24.56 MB (5,996 pages of 4 KB, none free) [measured, S-Oct14]. The seven core tables are
11.87 MB (48%) and the three telemetry tables 12.69 MB (52%), of which `api_log` and its two indexes are
12.37 MB.

## 3. `meta`: every key

243 rows in S-Oct14: 23 single keys plus 110 `plsnap:<playlist id>` and 110 `pltracks_at:<playlist id>`.
No `lock:*` row was held at snapshot time. Every row is global today; the right-hand column says what it
becomes. Line numbers are `db.ts` unless a file is named.

| key | written by | read by | how often (today) | multi-user |
|---|---|---|---|---|
| `spotify_tokens` (prod), `spotify_tokens_dev` (dev) — JSON `{accessToken, refreshToken, expiresAt}`, plaintext, ~572 B | `setSpotifyTokens` 2514 ← `auth.ts:218, 236, 359, 397`; cleared by `clearSpotifyTokens` 2528 ← `auth.ts:179`, logout `actions.ts:67` | `getSpotifyTokens` 2518 ← `auth.ts:76` (every `auth()`), `auth.ts:171, 205, 215, 234, 248, 279, 432`; cron `route.ts:109`; `getCaptureHealth` 1739 | read on every authenticated request and every cron tick (720/day); rewritten at each refresh (access tokens last ~1 h) | per user, encrypted (lane 01e) |
| `lock:spotify_refresh` | `acquireLock` 2541 ← `auth.ts:212`; `releaseLock` 2559 ← `auth.ts:221` | the lock's own compare-and-set | once per token refresh | per user: one refresh lock per token chain |
| `lock:clean:<playlist id>` | `actions.ts:130`, released `actions.ts:156` | same | per Clean | per user and playlist |
| `me_id` | `storePlaylists` 1804 / 1819, every library sync (≤ 48/day) | `getMeId` 2034 ← `owner.ts:11` (sign-in), `playlists/page.tsx:25`, `playlists/[id]/page.tsx:42`, `actions.ts:79`, `history-actions.ts:48`, `getLibraryTracks` 2297 | per page that marks "owned" playlists | removed: the session's user id replaces it |
| `last_sync` | `recordPlays` 524-528, every harvest | `getLastSync` 1732 ← `api/sync/route.ts:28` (debounce); `getCaptureHealth` 1739 (Home, `/usage`) | every harvest (~250-330/day, §4) | per user |
| `write_seq` | `writeSeqStmt` 348 in the batches at 522, 598, 1841, 1887, 2021, 2094, 2177, 2195, 2255; `bumpWriteSeq` 357 at 749, 819; scripts `backfill-scan.mjs:108`, `import-tail.mjs:65`, `migrate-skip-rule.mjs:104` | `readWriteSeq` 388 via `liveKey` 965 and `slowSeq` 1552: every LIVE cached read | on every write that lands data (a landed tick bumps three or four times: the insert batch, the new plays' orphan verdicts, their skip verdicts, and new contexts if any) | per user (§5) |
| `library_seq` | `librarySeqStmt` 377 at 1887, 2022, 2094, 2178, 2196, 2255 | `getLibraryIndexVersion` 1528; `getUniqueSongCount` 1944; `recomputeUniqueSongCount` 1977 | when library membership changes | per user |
| `slow_seq_pub` | `slowSeqInner` 1587 (at most every 10 min) | `slowSeq` 1566, 1578 ← `getAllTimePlays` 992, `getHistoryIndexVersion` 1594 | ≤ 144/day | per user |
| `home_payload` (13-36 KB JSON) | `rebuildHomePayload` 1341 ← `sync/history.ts:106`, `home/page.tsx:63`, cron daily block `route.ts:83`; dropped by the import scripts | `getHomePayload` 1348 (every Home render); `hasHomePayload` 1362 (every harvest that landed nothing) | once per harvest that landed plays (~110-175/day) | per user, built in that user's zone |
| `alltime_stats` | `recomputeAllTimeStats` 1034 | `getAllTimeStats` 1019; ledger sizing `modeledPlaysCount` 2895 | ≤ every 10 min while plays land | per user |
| `alltime_at` | 1037 | `maybeRecomputeAllTimeStats` 580 | same | per user |
| `unique_song_count` (`{n, seq}`) | `recomputeUniqueSongCount` 1988 | `getUniqueSongCount` 1934 (`/playlists`) | when the library changed (~3-5/day) | per user |
| `contexts_full_check_at` | `setContextsFullCheckAt` 1750 | `getContextsFullCheckAt` 1746, every harvest | daily | per user (with per-user `contexts`) |
| `playlists_synced_at` | `storePlaylists` 1803 / 1812 | `getPlaylistsSyncedAt` 2030 ← `/playlists`, dock | every library sync | per user |
| `library_synced_at` | `setLibrarySyncedAt` 2331 | `getLibrarySyncedAt` 2327 ← cron `route.ts:31` (every tick), `playlists-sync.ts:45`, `clean/run.ts:59` | every completed library sync | per user |
| `library_scan_attempt_at` | 2352 ← cron `route.ts:39` | 2348 ← `route.ts:37` | every scan attempt (≤ 1 per 10 min) | per user |
| `saved_synced_at`, `liked_total`, `liked_top_added_at` | `storeSavedTracks` 2256-2258 | 2266-2272 ← `sync/library.ts:79-80` | when Liked Songs is re-read (≥ daily) | per user |
| `plsnap:<playlist id>` (110 rows) | `storePlaylistTracks` 2104; purged at 1875, 2194 | `getPlaylistSnapshot` 2115 ← `sync/library.ts:66`, `playlists/[id]/page.tsx:44`, `actions.ts:431` | per playlist whose snapshot moved | per user (follows `playlist_tracks`) |
| `pltracks_at:<playlist id>` (110 rows) | `storePlaylistTracks` 2098; purged at 1880, 2194 | **nothing reads it** (grep over `src/`, `scripts/`, `ops/`, `tests/`) | per playlist store | drop it; if kept, per user |
| `user_tz_offset` | `setUserTzOffset` 2341 ← `api/sync/route.ts:26` | `getUserTzOffset` 2336 ← `tz.ts:16` (no-cookie fallback), `rebuildHomePayload` 1320 | each on-load sync | per user |
| `player_last_active`, `rp_last_harvest` | `setHarvestGate` 2368 ← cron `route.ts:138, 159, 163` | `getHarvestGate` 2364 ← `route.ts:129`, every tick | every tick while playing, every harvest | per user |
| `spotify_cooldown_until` | `setSpotifyCooldownUntil` 2380 ← `spotify/client.ts:182` (a ban longer than `HARD_BAN_S`) | 2376 ← `home/page.tsx:81`, `playlists-sync.ts:35`, `sync/history.ts:34` | on a hard ban | global for app-level bans; see §7.4 |
| `played_at_convention` | `checkPlayedAtConvention` 1063, only from the cron's daily block | nothing in the app (a "capture-health surface" is planned, 1043) | never in practice: the daily block has not run since Aug 10 (STORE_MIGRATION §3); absent from S-Oct14 | global (a fact about Spotify's API), computed from any user with enough plays |
| `clean_backup_pref` | **no writer** (LOGIC_AUDIT_2026-08-19.md:230) | `getCleanBackupPref` 2397 ← `actions.ts:137`, `history-actions.ts:49` | never written; absent from S-Oct14 | per user if it ever gets a writer |
| `last_sync_added` | no code since `1d43bc7` (2026-06-03) | nothing | dead row, still in S-Oct14 | drop |

So two key kinds stay global (`spotify_cooldown_until`, `played_at_convention`), two are dead
(`last_sync_added`, and `pltracks_at:*` as written-never-read), `me_id` disappears, and every other kind
becomes per user.

## 4. Query sites: every statement, its caller, its trigger and how often it runs

### 4.1 Triggers and how often they fire (the owner, today)

| trigger | cadence | evidence |
|---|---|---|
| any authenticated request | per page render, action or API call; `auth()` reads the token row once per request (`auth.ts:73-78`) | code |
| cron tick (`/api/cron/sync`) | every 2 min = 720/day, whether or not anyone listens | Zenbook timer (STORE_MIGRATION §3) |
| harvest (the tick calls recently-played) | ~250-330/day: when playing, the first idle tick after playing, and hourly (`cron/sync/route.ts:121-146`) | [measured] api_log has 254/day recently-played calls Oct 7-13 (S-Oct14); the ledger's `sync_tick_*` rows say 330.6/day. Both are fire-and-forget writes (`db.ts:2623`, `db.ts:2818`) that can be lost when Vercel freezes the function (`spotify/client.ts:183-185` names the hazard); which one undercounts is not known |
| landed harvest (≥1 new play) | ~110-175/day | [measured] ledger `sync_tick_landed` 174.7/day Oct 7-13; 30-day mean 163.5, busiest day 290 (Aug 25) |
| library sync (`maybeSyncLibrary`) | at most every 30 min (`route.ts:28-42`); 48/day ceiling | api_log `cron-library-scan`: 160 Spotify calls/day [measured]; a steady run makes ~5 calls, so ~30+ runs/day [estimated] |
| open Home tab | `/api/now-playing` every 6 s (leader tab), `POST /api/sync` on load / every 2 min / on focus (server debounce 60 s), `refreshHistoryAction` every 120 s and twice per track change (READ_QUOTA "an open Home tab"), search payloads on idle after first paint | code; client timers |
| user actions | create / clean / delete / remove / resume / track menu | per click |
| daily block (`x-vercel-cron`) | **never**: Vercel does not send the header; dead since Aug 10 (STORE_MIGRATION §3, `route.ts:67-91`) | absent `played_at_convention`, unpruned `api_log` back to Aug 10 in S-Oct14 |

### 4.2 Every statement

Plans are `EXPLAIN QUERY PLAN` on S-Oct14 with the SQL copied from `db.ts` [measured]. "Scope" is what
the statement needs in a multi-user store; **leak** marks a statement that, run unchanged against a shared
table, returns or changes another user's rows. Line numbers are `db.ts`.

| function | statement and plan | called from | runs | scope |
|---|---|---|---|---|
| `getMeta` 2585, `setMeta` 2577, `metaStmt` 2568 | point read / upsert on `meta` PK | ~25 wrappers (§3) | the most frequent statement: per request (tokens), 3 per idle tick, ~10 per harvest, 4-5 per Home render | (user, key); **leak** for every per-user key |
| `acquireLock` 2541, `releaseLock` 2559 | conditional upsert / delete of `lock:<name>` | `auth.ts:212, 221`; `actions.ts:130, 156` | per token refresh, per Clean | lock name carries the user |
| `readCachedTracks` 426 | `tracks WHERE id IN (≤500)`; SEARCH PK | `recordPlays` 480, `storePlaylistTracks` 2069, `storeSavedTracks` 2231 | each harvest (≤50 ids), each playlist/Liked store | none: shared catalog |
| `recordPlays` 464: existing-plays read 484 | `plays WHERE played_at >= ?`; SEARCH `idx_plays_played_at` | `sync/history.ts:50` | each harvest (cron, `/api/sync`, `refreshHistoryAction`); ~50 rows | `user_id = ?` + index `(user_id, played_at)`. Unscoped it reads everyone's window, and the dedupe set (`playKey`) drops a play when another user played the same track at the same instant |
| `recordPlays` write batch 498-529 | track upserts (changed only), `INSERT OR IGNORE INTO plays`, `write_seq` bump, `last_sync` | same | each harvest; inserts only on landed ones | `plays.user_id`; UNIQUE `(user_id, track_id, played_at)`; per-user marker and stamp |
| `recordPlays` successor reset 549 | `UPDATE plays SET skipped = NULL WHERE played_at = :at … OR id = (next play after :at)`; MULTI-INDEX OR | same | per out-of-order insert (rare) | **leak**: "the next play" must be the same user's |
| `recomputeOrphanFlags` 724 `{newOnly}` | `UPDATE plays SET ctx_orphan = (predicate) WHERE ctx_orphan IS NULL`; SCAN via partial `idx_plays_orphan_null`, correlated probes on `playlist_tracks` by playlist id | `recordPlays` 535 | each landed harvest | predicate must match the play's user's `playlist_tracks` |
| `recomputeOrphanFlags` `{playlistId}` | same UPDATE `AND context_uri = :uri`; SEARCH `idx_plays_context` | `storePlaylistTracks` 2109, `deletePlaylistFromDb` 2202 | per playlist whose cached tracks changed | **leak**: rewrites every user's plays from that playlist against one user's copy; add `user_id = ?` |
| `recomputeOrphanFlags` `{}` (full) | same UPDATE over all plays; SCAN `plays` | `storePlaylists` 1897 when the playlist id set moved or the purge deleted rows | 0.2-0.4/day [measured, ledger `orphan_full_pass`]; 5,102,733 rows read at 21,950 plays (STORE_MIGRATION §3) | per user; it is the largest single read today and it scales with the whole table if left unscoped |
| `recomputeSkipFlags` 780 | window from the last real play before the oldest pending one; SEARCH `idx_plays_played_at` + `idx_plays_skip_null`; then a batch of per-row UPDATEs | `recordPlays` 561 | each landed harvest | **leak / wrong data**: the gap chain orders ALL plays by time, so with two users a play's predecessor would be the other user's play and its listened time and skip verdict would be wrong. Every subquery needs `user_id = ?`; partial index `(user_id, played_at) WHERE skipped IS NULL` |
| `orderedRealPlays` 854 | all real plays in time order; SCAN `plays` via `idx_plays_played_at` | `recomputeAllTimeStats` 1033 ← `maybeRecomputeAllTimeStats` 579 ← `recordPlays` 573, `sync/library.ts:100` | at most every 10 min while plays land (`db.ts:577-583`), so up to 6 per listening hour, app open or not; daily heal (dead) | per user; same gap-chain hazard. The closest match in the code for the meter's dominant scan (§11.2) |
| `unseenContexts` 619 | `contexts WHERE uri IN (≤50)`; SEARCH PK | `sync/history.ts:60` | each harvest | per user with per-user `contexts` |
| `unresolvedContextUris` 646 | DISTINCT over all plays with a context, LEFT JOIN `contexts`; SCAN `plays` | `sync/history.ts:60` | daily (`contexts_full_check_at`) [measured, ledger 1.0/day] | per user |
| `recordContexts` 586 | upsert batch + `write_seq` | `sync/history.ts:85`; `api/now-playing/route.ts:45, 52` | when a new context appears | per user (a 403 for one user is not a 403 for another) |
| `getContextName` 2486 | point read on `contexts` | `api/now-playing/route.ts:36` | every now-playing poll with a context: every 6 s per open tab | per user |
| `searchHistory` 884, empty query | newest plays; SCAN `plays` via `idx_plays_played_at`, LIMIT ≤50 | `history-actions.ts:148-156` | each `refreshHistoryAction` | `(user_id, played_at)` index or it walks other users' newest plays first |
| `searchHistory`, LIKE | same scan filtered by `name/artist LIKE '%q%'`, LIMIT 500 | `history-actions.ts:194` (fallback search while payloads load) | rare [measured, ledger 0.0-0.1/day] | per user; unindexable by construction, so its cost is the user's whole history if scoped and the whole table if not |
| `readAllTimePlays` 996 | SCAN `plays`, GROUP BY track, correlated "latest source" subquery on `idx_plays_track` | `getAllTimePlays` 988 ← `history-actions.ts:77, 171` | on slow-marker change, when the All-time view is open | per user; index `(user_id, track_id)` for the subquery |
| `checkPlayedAtConvention` 1044 | 7-day window; SEARCH `idx_plays_played_at` | cron daily block (dead) | never | one user's timeline |
| `readDailyStats` 1092 | 16-day window; SEARCH `idx_plays_played_at`; listened time from the previous play | `rebuildHomePayload` 1322; `getDailyStats` 1087 ← `home/page.tsx:58`, `history-actions.ts:71, 141` | ~110/day [measured, ledger `day_strip`] | per user; same gap-chain hazard |
| `hasPlaysBeforeDay` 1152 | EXISTS on `idx_plays_played_at` | tests only (`tests/adversarial/skip-and-hostile.test.ts:187`) | never in the app | per user |
| `readPlaysByDay` 1193 | day range on `idx_plays_played_at` + per-track source subquery | `rebuildHomePayload` 1331; `getPlaysByDay` 1186 ← `home/page.tsx:62`, `history-actions.ts:64, 173` | ~110/day [measured, ledger `day_plays`] | per user |
| `rebuildHomePayload` 1315, `getHomePayload` 1348, `hasHomePayload` 1362 | the three reads above plus `meta.home_payload` | `sync/history.ts:106`; `home/page.tsx:63, 80` | rebuild per landed harvest; read per Home render; existence check per steady harvest | per user, in that user's time zone |
| `readLibraryIndex` 1625 | SCAN `playlist_tracks` + `tracks` probes; SCAN `saved_tracks`; SCAN `playlists` | `getLibraryIndex` 1605 ← `api/search/library/route.ts:28, 49` | on `library_seq` change (cached) [measured, ledger 0.1-0.3/day, a lower bound] | per user; **leak** unscoped (every user's library in one payload) |
| `readHistoryIndex` 1686 | SCAN `plays` via `idx_plays_played_at`, join `tracks`, LEFT JOIN `contexts` | `getHistoryIndex` 1620 ← `api/search/history/route.ts:21, 35` | only when a browser asks for the payload and the slow marker moved: an open Home tab patches its copy in memory instead of re-fetching (`home/den-home.tsx:761-786`), so rebuilds follow Home page loads, not plays. Ledger: 0-2 a day Oct 7-13 [measured]. STORE_MIGRATION §3 attributes the meter's 23-a-day scan to this read; §11.2 explains why I doubt it | per user; **leak** unscoped |
| `storePlaylists` 1763 | probe: SCAN `playlists`; rewrite tier: `DELETE FROM playlists`, re-insert, `DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists)`, `DELETE FROM meta WHERE key LIKE 'plsnap:%' …` (SCAN `meta`) | `sync/library.ts:41` | each library sync; rewrite tier 2.9/day [measured, ledger] | **leak / data loss**: unscoped, one user's sync deletes every other user's playlists, their cached members and their snapshot keys. Every statement scoped |
| `readStoredPlaylists` 1916 | SCAN `playlists` ORDER BY position | `getStoredPlaylists` 1911 ← `playlists/page.tsx:24`, `history-actions.ts:47` | per `/playlists` render and dock load (cached on `write_seq`) | per user |
| `recomputeUniqueSongCount` 1969 | DISTINCT (artist, title) over members; SCAN `tracks` via `idx_tracks_artist_name`, probing `idx_pltracks_track` | `sync/library.ts:93`; `getUniqueSongCount` 1964 kick | when the library changed [measured, ledger 2.9-4.9/day] | per user; with a shared catalog the current plan walks every user's tracks, so drive it from the user's members |
| `getStoredPlaylist` 1994 | point read on `playlists` | `playlists/[id]/page.tsx:45` | per detail page | per user |
| `upsertStoredPlaylist` 2009 | upsert + both markers | `actions.ts:80` (merge, clean, save-queue, save-diff) | per created playlist | per user |
| `storePlaylistTracks` 2041 | cached positions (SEARCH PK by `playlist_id`), `readCachedTracks`, diffed upserts/deletes, markers, `pltracks_at`/`plsnap` stamps, then `{playlistId}` orphan pass | `sync/library.ts:69`; `playlists/[id]/page.tsx:194`; `api/playlists/[id]/tracks/route.ts:29`; `actions.ts:244, 445, 574`; `clean/run.ts:65, 120` | per owned playlist whose snapshot moved, plus page/action fills | per user |
| `getPlaylistSnapshot` 2115 | point read `plsnap:<id>` | `sync/library.ts:66`, `playlists/[id]/page.tsx:44`, `actions.ts:431` | once per OWNED playlist per library sync, serially: 110 reads per run [measured count of owned playlists, S-Oct14] | per user |
| `getPlaylistTracks` 2120, `getPlaylistTrackOrder` 2137 | SEARCH PK by `playlist_id`, join `tracks` | `playlists/[id]/page.tsx:43`; `actions.ts:241, 420, 568`; `clean/run.ts:62` | per detail page / action | per user; **leak** unscoped: the detail page reads any playlist id with no ownership check (`playlists/[id]/page.tsx:42-46`) |
| `removeCachedPlaylistTrack` 2151 | delete by uri (+ position), renumber positions | `actions.ts:456, 465` | per remove | per user |
| `deletePlaylistFromDb` 2188 | delete the playlist row, its members, its two meta keys | `actions.ts:193` | per delete | per user; **leak / data loss** unscoped |
| `storeSavedTracks` 2210 | SCAN `saved_tracks`, `readCachedTracks`, diffed writes, three stamps | `sync/library.ts:83` | when Liked Songs changed, at least daily | per user |
| `getLibraryTracks` 2286 | UNION of Liked and OWNED playlist members (`owner_id = me_id`); SCAN `playlist_tracks` | `clean/run.ts:70, 125` | per Clean (both phases) | per user; replaces `me_id` with the user |
| `playedTracksInContext` 2405 | SEARCH `idx_plays_context` | `actions.ts:569` (Resume) | per Resume | per user; **leak** unscoped (another user's plays from the same public playlist would move the resume point) |
| `findTrackWithPlaylists` 2432 | SEARCH `idx_tracks_artist_name`, then `playlist_tracks` by `idx_pltracks_track` joined to `playlists` | `actions.ts:372` (track menu) | per right-click | catalog half shared; playlist half per user, **leak** unscoped (lists other users' playlist names) |
| `logSpotifyRequest` 2603 | INSERT `api_log`; every 256th write per instance prunes rows older than 30 days | `spotify/client.ts:113, 142` | every Spotify call: 2,014/day [measured, S-Oct14 growth Sep 14 → Oct 14] | add a user column |
| `getSpotifyCallBreakdown` 2640, `getRecentlyPlayedQuotaWindows` 2682, `getApiLogSummary` 2757, `pruneApiLog` 2736 | `api_log` by `ts` / `(path, ts)` | `/usage` (`usage/page.tsx:252-253`); `client.ts:161` on a 429; cron daily block (dead) | per `/usage` open; per 429 | admin only |
| `ledgerAdd` 2818, `ledgerSet` 2840, `readLedger` 2858, `ledgerDayModeledTotal` 2872, `ledgerSyncCall` 2929 | upsert / range read on `usage_ledger` | the read paths above; `/usage`; `/api/cron/usage-check` (dead since Aug 10) | ~600-1,000 calls/day [measured, ledger `calls` sums] | global; per-user attribution optional |
| `recordClientMetrics` 3052, `getClientLoadSpeed` 3082 | batch INSERT; SCAN `client_metrics` (the `ts` filter is not used by the plan) | `api/metrics/route.ts:46`, `instrumentation.ts:17`; `/usage` | per beacon; ~3 rows/day on average lately [measured, S-Sep14 → S-Oct14] | add a user column (the rows carry song names) |
| `pruneClientMetrics` 2747 | DELETE by `ts` | cron daily block (dead) | never | global |

Round trips per user per day from background work alone [estimated from the code paths above and
§4.1's cadences]: an idle tick is ~3 statements, a steady harvest ~10, a landed harvest ~20 (the
rebuilds), and a library sync ~120, of which 110 are the serial `plsnap` reads. At 390 idle ticks, 155
steady and 175 landed harvests and ~30-48 library syncs, that is roughly 10,000-12,000 statements a
day (1,170 + 1,550 + 3,500 + 3,600 to 5,760), a third to nearly half of them the per-playlist snapshot
reads. None of it depends on the user opening the app.

## 5. Derived data and caches built on the store

**Stored derived values.** Two per row: `plays.ctx_orphan` (`db.ts:700-751`) and `plays.skipped`
(`db.ts:762-822`). Three whole-history aggregates in `meta`: `alltime_stats`, `unique_song_count`,
`home_payload`. Three version counters in `meta`: `write_seq` (bumped by any write a cached read serves,
`db.ts:312-360`), `library_seq` (library membership only, `db.ts:362-383`), and `slow_seq_pub`
(`write_seq` republished at most every 10 min, `db.ts:1536-1589`). `scripts/verify-derived.mjs`
recomputes the aggregates and the orphan flags from source and diffs them; it reads the whole store.

**Next data-cache entries.** Seven `unstable_cache` wrappers in `db.ts`. Vercel's Data Cache is shared by
every instance and outlives deploys (GOTCHAS "The Data Cache OUTLIVES THE DEPLOY"), so an entry written
for one request is served to any later request whose key matches.

| entry | key parts | arguments (the rest of the key) | TTL | at |
|---|---|---|---|---|
| all-time list | `all-time-plays` | limit, slow seq | 1 h | `db.ts:983-994` |
| day strip | `daily-stats` | offset, days, write seq | 1 h | `db.ts:1082-1090` |
| one day, frozen | `plays-by-day-frozen` | day, offset, write seq | 1 day | `db.ts:1176-1180` |
| one day, live | `plays-by-day-live` | day, offset, write seq | 1 h | `db.ts:1181-1191` |
| library payload | `library-index`, `v1` | library seq, shape | 1 day | `db.ts:1600-1613` |
| history payload | `history-index`, `v2` | slow seq, shape | 1 day | `db.ts:1615-1623` |
| playlist grid | `stored-playlists` | write seq | 1 h | `db.ts:1906-1914` |

None of the seven keys carries a user. Two ways that leaks once there is more than one user: with a
global counter, every user hits the same entries outright; with per-user counters, two users whose
counters happen to hold the same value (both start at 1) share an entry, so user B is served user A's
day, A's playlists, A's whole history payload. The user id has to be an explicit argument of every one
of these calls, independent of the counter. The test harness cannot catch a missing user key today:
`tests/stubs/next-cache.ts` makes `unstable_cache` a passthrough, so every "cached" read executes. An
isolation suite needs a stub that keys on the key parts plus the serialized arguments the way Next does,
so a forgotten user argument shows up as a cross-user hit (§8.7).

**Browser-facing versions.** The search routes build their ETags from these counters:
`"lib-v1-<library_seq>-<UTC day>"` and `"hist-v2-<slow seq>-<UTC day>"` (`api/search/library/route.ts:39`,
`api/search/history/route.ts:26`). No user component, so two accounts used in one browser can collide the
same way the cache keys do and get a 304 for the other account's body. A user component in the tag fixes
it; a keyed hash rather than the raw Spotify id, since ETags are visible to anything on the page. STORE
MIGRATION's phase E IndexedDB copy already keys on the signed-in user's id (STORE_MIGRATION §10).

**Request-scoped and module-scoped state in `db.ts`.** `seqBox` (`db.ts:402`) and `orderedRealPlays`
(`db.ts:854`) are React `cache()` boxes with no arguments, so they assume one user per request; that holds
for page renders, and the cron path has no React dispatcher (each call reads directly, `db.ts:396-401`).
Keying them by user makes them correct by construction rather than by call site. Two module-scope
values assume one user per instance: `uniqueRecomputeKickedAt` (`db.ts:1960`; one user's kick would
suppress every other user's recompute for 60 s) and `storeSizeMemo` (`db.ts:2887`; the ledger model's
plays count).

**Invalidation across users.** The marker rule (`db.ts:326-344`) says a write bumps when it changes a
table a cached read serves. Per-user markers keep that rule for per-user tables. The shared catalog is the
exception: `trackUpsertStmt` (`db.ts:444-461`) rewrites a `tracks` row whenever a sync sees different
fields, and that row feeds every user's cached reads, but only the syncing user's marker moves. Another
user then sees the old name or art until their own marker moves or the entry's TTL lapses (at most a day).
`library_seq` already accepts the same one-day bound for in-place re-tags (`db.ts:1520-1523`), so this
widens an accepted staleness rather than adding a new kind.

## 6. Volumes: row counts, sizes and growth per day (the owner's data)

Row counts [measured, three snapshots]; per-day rates are (S-Oct14 − S-Sep14) / 30 days.

| table | S-Aug16 | S-Sep14 | S-Oct14 | per day, last 30 days | bytes per row incl. indexes |
|---|---|---|---|---|---|
| `plays` | 15,618 | 18,537 | 22,040 | +116.8 | 275 |
| `tracks` | 15,068 | 15,591 | 15,859 | +8.9 (Aug 16 → Sep 14: +18.0) | 265 |
| `contexts` | 79 | 97 | 114 | +0.6 | 250 |
| `meta` | 233 | 243 | 243 | 0 (two rows per owned playlist plus 23) | 270 |
| `playlists` | 110 | 115 | 114 | ~0 | 320 |
| `playlist_tracks` | 7,089 | 7,386 | 7,400 | moves with playlist edits | 196 |
| `saved_tracks` | 33 | 45 | 48 | +0.1 | 170 |
| `api_log` | 13,528 | 44,524 | 104,942 | +2,014 | 118 |
| `usage_ledger` | 87 | 278 | 496 | +7.3 | 99 |
| `client_metrics` | 1,100 | 1,625 | 1,716 | +3.0 | 153 |
| file (used) | 10.96 MB | 16.29 MB | 24.56 MB | +276 KB | |

**Listening.** Real plays (backfill excluded) per UTC day over the 30 full days Sep 14 – Oct 13: mean
114.6, median 113, p90 150, min 59, max 172; over 61 days the busiest day was 204 [measured, S-Oct14]. By
month: June 3,594, July 2,969, August 3,746, September 2,788. The history holds 4,279 distinct track ids
from real plays, 11,390 distinct (artist, title) identities including backfill, and the library 6,418
identities across 110 owned playlists (7,404 members) and 48 Liked Songs [measured, S-Oct14].

**Bytes.** The owner's core data grows ~35 KB a day (116.8 plays × 275 B + 8.9 tracks × 265 B) [estimated
from the measured rows and per-row bytes], about 12.6 MB a year on top of today's 11.87 MB. Telemetry grows
about seven times faster: `api_log` adds ~2,000 rows (~238 KB) a day and is 86% of the file's 30-day growth. Its
30-day retention should cap it near 60,000 rows (~7 MB), but S-Oct14 holds rows back to Aug 10: the
prune runs only from the dead daily block or on every 256th write of one instance (`db.ts:2628`), which a
short-lived serverless instance rarely reaches.

**Writes.** The meter counted 11,136 rows written on Oct 13 (UTC), 8,072 of them `INSERT INTO api_log`
(STORE_MIGRATION §3), so the core tables take ~3,100 rows written a day for one active user.

**Reads.** The meter logged 1,430,580 rows read in the 21 hours from 9 PM Oct 12, and one full `plays`
scan (~50,500 rows per run, 23 runs) was 1.16M of a day's 1.94M (STORE_MIGRATION §3, which names it the
history payload; §11.2 argues it is more likely the all-time recompute). The unscoped orphan pass reads
5,102,733 rows at 21,950 plays and ran about three times a week (same section).

**Where the owner's numbers stop being typical.** 7,529 of the 22,040 plays are backfill (one row per
song of the pre-tracking library, `scripts/backfill-scan.mjs`), and they ride in the history payload, the
all-time list and every full `plays` scan. A new user starts with zero history and no backfill, so for
their first months every per-user full scan is a fraction of the owner's.

## 7. Census: every single-user assumption in the data layer

Sizes as in lane 2201's census (`01-current-system.md` §2): **S** = a key or a filter in one place;
**M** = a function's contract or a table's key changes, with callers to follow; **L** = a design change, a
schema migration over live data, or a loop that must fan out per user. Ids are for the designs and the
plan to cite. "Leak" means another user's data is returned or changed; "wrong" means the answer is
incorrect even for the user's own data.

### 7.1 Identity

| id | where | assumption | multi-user needs | size |
|---|---|---|---|---|
| D1 | `meta.me_id`: written `db.ts:1804, 1819`; read `db.ts:2034` ← `owner.ts:11`, `playlists/page.tsx:25-30`, `playlists/[id]/page.tsx:42`, `actions.ts:79`, `history-actions.ts:48-53`, `db.ts:2297` | the store has one Spotify account, recorded by the last library sync | the request's user id replaces it everywhere; `owner.ts` then needs `SPOTIFY_OWNER_ID` or an admin flag on a user row, not `me_id` | M |
| D2 | all 74 async exports of `db.ts` | no function takes a user | every per-user function takes the user; better, one scoped handle (`forUser(id)`) is the only way to reach per-user tables, so a call site cannot omit it (§8.5) | L |
| D3 | `auth.ts:291-454`; `home/page.tsx:87` | the session carries a display name and no user id the data layer uses | a server-trusted user id per request (the signed JWT's Spotify id, never client input); lane 01e | M |

### 7.2 Tables with no user column

| id | table | today | multi-user needs | size |
|---|---|---|---|---|
| D4 | `plays` (`db.ts:168-178`) | UNIQUE `(track_id, played_at)`; five indexes, none user-led | `user_id NOT NULL`; UNIQUE `(user_id, track_id, played_at)`; indexes `(user_id, played_at)`, `(user_id, track_id)`, `(user_id, context_uri)`, partials `(user_id, played_at) WHERE skipped IS NULL` and `(user_id, id) WHERE ctx_orphan IS NULL`. A table rebuild in SQLite | L |
| D5 | `playlists` (`db.ts:184-191`) | PK `id` | PK `(user_id, id)`; `position` is per user by nature | L |
| D6 | `playlist_tracks` (`db.ts:192-204`) | PK `(playlist_id, position)` | PK `(user_id, playlist_id, position)`, index `(user_id, track_id)` (§8.2 weighs a shared cache) | L |
| D7 | `saved_tracks` (`db.ts:205-209`) | PK `track_id` | PK `(user_id, track_id)` | M |
| D8 | `contexts` (`db.ts:176`) | PK `uri`; one negative cache for everyone | PK `(user_id, uri)` | M |
| D9 | `meta` (`db.ts:183`) | one key space | global `meta` for the two global kinds; `user_meta (user_id, key, value, PK (user_id, key))` for the rest (§8.3) | L |
| D10 | `tracks` (`db.ts:159-167`) | one catalog | stays shared (§8.2); the cost is the cross-user staleness in §5 "Invalidation across users", bounded at a day | — |
| D11 | `api_log`, `client_metrics` (`db.ts:210-242`) | no user | nullable `user_id` | S |

### 7.3 Statements with no user scope

| id | where | effect with two users, unchanged | needs | size |
|---|---|---|---|---|
| D12 | `storePlaylists` rewrite tier, `db.ts:1848-1883` | **leak, data loss**: `DELETE FROM playlists` and the two purges remove every other user's playlists, cached members and snapshot keys on each of one user's list changes | every statement `WHERE user_id = ?` | M |
| D13 | `deletePlaylistFromDb` `db.ts:2188-2205`; `removeCachedPlaylistTrack` `db.ts:2151-2184`; `upsertStoredPlaylist` `db.ts:2009-2028` | **leak, data loss**: act on a playlist id across users | scope by user | S each |
| D14 | `getPlaylistTracks` 2120, `getPlaylistTrackOrder` 2137, `getStoredPlaylist` 1994, `getPlaylistSnapshot` 2115; `playlists/[id]/page.tsx:42-46` reads by id with no ownership check | **leak**: any signed-in user reads any cached playlist by id, including another user's private one | scope by user | S each |
| D15 | `findTrackWithPlaylists` playlist half, `db.ts:2467-2473` | **leak**: names other users' playlists in the track menu | join the user's playlists | S |
| D16 | whole-table reads: `readLibraryIndex` 1625, `readHistoryIndex` 1686, `readAllTimePlays` 996, `readStoredPlaylists` 1916, `getLibraryTracks` 2286, `recomputeUniqueSongCount` 1969, `searchHistory` 884, `playedTracksInContext` 2405, `unresolvedContextUris` 646, `storeSavedTracks`' read 2214 | **leak**: everyone's rows in one user's payload, list or count | `WHERE user_id = ?` with a user-led index; `recomputeUniqueSongCount` rewritten to drive from the user's members, since its current plan walks the whole catalog | M |
| D17 | `recordPlays` dedupe read, `db.ts:484-496` | **wrong**: another user's play of the same track at the same instant marks this user's play as existing, and the insert is skipped | scope the read and the UNIQUE (D4) | S |
| D18 | gap chains: `recomputeSkipFlags` 780-822, the successor reset 549-557, `orderedRealPlays` 854-869, `readDailyStats` 1092-1148, `checkPlayedAtConvention` 1044-1065, and `scripts/import-tail.mjs` | **wrong**: each play's listened time and skip verdict come from the previous play in time across ALL plays, so interleaved users corrupt each other's verdicts and totals; the verdicts are then stored | every chain per user | M |
| D19 | orphan predicate `db.ts:700-709` and `recomputeOrphanFlags` 724-751 | **wrong**: a play is judged against any user's cached copy of the playlist; the `{playlistId}` scope rewrites every user's plays from it | predicate within the play's user; scopes carry the user | M |

### 7.4 Global keys and markers

| id | where | assumption | multi-user needs | size |
|---|---|---|---|---|
| D20 | token row `db.ts:2504-2531`; refresh lock `auth.ts:212`; logout's clear `actions.ts:67` | one token chain; signing out clears THE row | per-user token rows (encrypted, lane 01e), per-user lock names, logout clears only the caller's row | M |
| D21 | markers `write_seq`, `library_seq`, `slow_seq_pub` (`db.ts:345-416`, `1550-1596`) | one content version for the whole store | per user. With a global marker (even with the user in every cache key) any user's play moves every user's keys and payload versions, so while anyone listens nobody's day strip, playlist grid or payload is served from cache, and every Home load rebuilds its history payload | M |
| D22 | `spotify_cooldown_until` `db.ts:2376-2392`, honoured at `sync/history.ts:34`, `playlists-sync.ts:35`, `home/page.tsx:81` | one ban for everything | stays global: Spotify's rate limit is per app and its quotas are per developer account (01f §1.4), so a ban really is everyone's. The data model has nothing to change; sharing one budget fairly across users is lane 01c's | — |
| D23 | the per-user stamps and payloads of §3 (harvest gate, sync stamps, Liked signals, `home_payload`, `alltime_*`, `unique_song_count`, `plsnap:*`, `contexts_full_check_at`, `user_tz_offset`, `last_sync`) | one user's state | `user_meta` rows | M |
| D24 | `HOME_TZ = "America/New_York"` `db.ts:1270`; `user_tz_offset` written by every `POST /api/sync` (`api/sync/route.ts:24-27`) before its debounce | one time zone; the last browser to post wins | per-user offset and a per-user home zone; with two users in different zones each post would re-bucket the other's Home payload | S |
| D25 | negative context cache `db.ts:606-609`, `api/now-playing/route.ts:47-55` | a 403 is a 403 for everyone | per-user `contexts` (D8): one user's 403 (a private playlist, an account outside the allowlist) must not hide the name from the owner for 30 days | S with D8 |

### 7.5 Caches and process state

| id | where | multi-user needs | size |
|---|---|---|---|
| D26 | seven `unstable_cache` entries (§5 table) | the user id as an explicit argument of each | M |
| D27 | ETags `api/search/library/route.ts:39`, `api/search/history/route.ts:26` | a user component (keyed hash) | S |
| D28 | `seqBox` `db.ts:402`, `orderedRealPlays` `db.ts:854`, `uniqueRecomputeKickedAt` `db.ts:1960`, `storeSizeMemo` `db.ts:2887` | keyed by user | S each |
| D29 | `tests/stubs/next-cache.ts` passthrough | a keyed stub so isolation tests can see a cross-user cache hit | S |

### 7.6 Telemetry

| id | where | multi-user needs | size |
|---|---|---|---|
| D30 | `/usage` (`usage/page.tsx:245-255`) renders `api_log`, the ledger, `client_metrics` (song names in `handoff` rows, error text) and Turso's org usage | admin only; account deletion must reach `client_metrics` and any user-tagged `api_log` rows | S |
| D31 | `api_log` has `source` but no user | nullable user column, so a 429 or a quota ban is attributable to a user's sync | S |
| D32 | `api_log` retention not enforced (§6) | the daily route (STORE_MIGRATION phase A item 7) before N users multiply ~2,000 rows a day each | S |

### 7.7 Scripts, ops, migration

| id | where | assumption | multi-user needs | size |
|---|---|---|---|---|
| D33 | `scripts/backfill-from-backstop.mjs`, `import-extended-history.mjs`, `import-tail.mjs`, `backfill-scan.mjs`, `migrate-skip-rule.mjs` | they write `plays`, re-open verdicts, bump the global `write_seq` and drop the global `home_payload` | a required `--user`; every statement scoped; per-user chains (D18) | M |
| D34 | `scripts/verify-derived.mjs`, `scripts/bench-reads.mjs` | whole-table reads | per-user mode | S |
| D35 | backstop recorder (`~/lazyboy-recorder`, own token chain), `backup.py` | one account | the replay targets the owner's user id; whether the recorder covers other users is a product and security call (it would hold their refresh tokens on the Zenbook); lanes 01c and 01e | M |
| D36 | the meter's core fence (STORE_MIGRATION phase A item 8) | a fixed list of core tables | new tables (`user_meta`, a users table, token rows) classified as core | S |
| D37 | `init()` `db.ts:153-297` | schema changes are additive and idempotent, run by any cold instance | a versioned one-shot migration run with writers fenced (§8.6) | M |
| D38 | dev servers on `.env.local` write the production store (GOTCHAS) | the developer is the owner | a dev server signed in as anyone writes that user's production rows; STORE_MIGRATION step 15 re-points `.env.local` at production again | S |

## 8. What the data model needs for multi-user

Lane 01f found that one Spotify app in development mode serves at most five accounts, Rem's included,
and that extended quota mode is out of reach (01f-platform.md §1.2, §1.3, §1.6). This section is written
for five users and says where a larger number would change an answer.

### 8.1 Two ways to give every row a user

**Row-level.** One store. `plays`, `playlists`, `playlist_tracks`, `saved_tracks` and `contexts` gain a
user column that leads their keys and indexes; per-user `meta` keys move to a `user_meta` table; every
per-user statement in §4.2 gains `user_id = ?`. Enforcement lives in application code.

**Database per user.** One libSQL database per user holding today's seven core tables unchanged, plus
one small app database for the user list, the token rows and the two global `meta` kinds. The
connection is the scope: a statement can only see the database it was sent to.

| | row-level | database per user |
|---|---|---|
| census items it leaves to fix | all of §7 except D22, which needs nothing in either model | D1-D3, D20, D24, D26-D38. D4-D19, D21, D23 and D25 need no SQL change: whole-table statements are already per user, and the markers and stamps in each user's own `meta` are already per user |
| failure if one scope is missed | another user's rows returned, rewritten or deleted (D12-D19) | not possible inside the per-user database; the residual risk moves to choosing the client (one place) and to the cache keys (D26, D27), which both models must fix |
| the owner's data | rebuild four tables with a user column, re-key `meta`, move the token row (§8.6) | none: the owner's existing database becomes his user database; the token row moves to the app database |
| per-user query cost | flat in N only with user-led indexes (§9.2 measures it) | each database holds one user's rows; today's indexes and plans apply unchanged |
| backups, schema changes, clients | one of each | one per database: the nightly backup and every schema change loop over N+1 databases; the cron opens a client per user |
| account deletion | a DELETE per table, plus telemetry rows | drop the database, plus telemetry rows |
| deletion from backups | the nightly snapshot holds every user, so a deleted user stays in 60 days of offsite files unless they are rewritten | per-database backup files: deleting the user deletes their files |
| shared catalog | `tracks` once; the saving is the overlap between users' catalogs, at most the owner's 4.2 MB per user, negligible at five users | `tracks` per user |
| cross-user features (ROADMAP's friends) | SQL joins | two reads merged in code |
| store limits | none new | Turso's database count per plan must allow N+1 (lane 01f §4.2; not checked here). The Zenbook's sqld would need namespaces, but after STORE_MIGRATION it holds only telemetry |

**Recommendation: database per user, for this app at five users.** The reason is the failure each model
leaves open. Row-level puts more than fifty statements in `db.ts` (my count from §4.2, plus the five
import scripts) under one rule, "remember the user", and the census found the misses would not be
cosmetic: one user's library sync deleting everyone's playlists (D12), skip verdicts computed from
another person's previous play and then stored (D18), plays silently dropped on a timestamp collision
(D17). A per-user database makes those statements correct without touching them, it migrates Rem's data
by not moving it, and it lets a deletion reach the backups (§8.8). The costs are loops over at most six
databases. Two facts would change this: if Turso's plan caps databases below six (01f), or if Rem wants
cross-user features soon, where joins in one store are simpler. Rows-read quota is per organization on
Turso either way, so the choice does not change §9.3's budget.

The rest of §8 gives the row-level details as well, because the designs may weigh it differently.

### 8.2 Which tables are per user

- `tracks`: shareable in a row-level store. It holds public Spotify metadata keyed by Spotify track id and
  no personal data on its own. Its cost is the cross-user staleness in §5.
- `contexts`: per user. A name is what one user's token could resolve; a 403 for one account (a private
  playlist, an account outside the allowlist) must not become everyone's negative cache for 30 days
  (D25). It is 114 rows.
- `playlists`, `saved_tracks`: per user by meaning (one person's library list and Likes).
- `playlist_tracks`: per user. Sharing it by Spotify playlist id would save rows only when two users cache
  the same playlist, and it would make every read an access question (may this user see this playlist?)
  that the detail page does not ask today (D14). The library sync caches only owned playlists
  (`sync/library.ts:54, 65`): S-Oct14 holds no cached members of the 4 followed playlists.
- `plays`: per user.
- Telemetry: global tables with a nullable user column (D11, D30-D32).

### 8.3 `meta`

Row-level: a separate `user_meta (user_id, key, value, PRIMARY KEY (user_id, key))`, not prefixed keys in
`meta`. Deleting a user is one statement; the `LIKE 'plsnap:%' AND substr(key, 8)` purges
(`db.ts:1875-1882`) become plain per-user filters; and `FROM meta` in the code then means a global key.
Database per user: `meta` stays as it is inside each user database, and the app database keeps a global
`meta` for `spotify_cooldown_until` and `played_at_convention`.

Tokens belong in a table of their own in the app database in both models: sign-in has to find or
create the user before anything else exists, the cron fan-out needs every user's expiry at once, and
encryption at rest (lane 01e) wants one place to rotate keys.

### 8.4 The user key

A surrogate INTEGER user id, with the Spotify id as a unique column on the user row. Measured on 551,000
cloned plays (25 copies of S-Oct14's), user-led indexes as in D4: **280 bytes per play with an INTEGER
id, 432 with a 28-character text id** like the owner's Spotify id [measured locally, §11]. Today's
single-user table is 275 B/play, so the integer costs 2% and the text 57%, because the key repeats in
the row and in all six indexes. The surrogate also keeps Spotify ids out of cache keys and ETags. (In the
database-per-user model only the app database and telemetry carry a user key.)

### 8.5 Enforcement in one place

Either model needs one function that turns a request into a user-scoped data handle, and no other way to
reach per-user data. Concretely: `db.ts` stops exporting per-user functions at module level and exports
`forUser(uid)` (row-level: functions that close over `uid` and add it to every statement and cache key;
per-user databases: the same functions bound to that user's client). Callers get `uid` only from the
server-verified session or, in the cron, from the user list. Global functions (the cooldown, telemetry,
the user list) stay module-level. The census's D2 is this change; it touches every caller once.

### 8.6 Migrating the owner's data, and replacing `init()`

`init()` (`db.ts:153-297`) cannot carry this: it runs on any cold instance, concurrently, with writers
live. Both models need a schema version (a `meta.schema_version` key) and a one-shot migration script
run with writers stopped, the same discipline STORE_MIGRATION's cutover uses (pingers off, quiet,
snapshot, verify; STORE_MIGRATION §8 steps 2-7). `init()` then only checks the version and refuses to
serve a store that is behind.

Row-level, on a snapshot copy first: create the user row (uid 1 = the owner); rebuild `plays`,
`playlists`, `playlist_tracks`, `saved_tracks` and `contexts` with `user_id = 1` (SQLite: create new,
copy, drop, rename, re-index; 22,040 plays is instant); move per-user `meta` keys into `user_meta`; move
the token rows to the token table; drop `last_sync_added`, `pltracks_at:*` and `me_id`. Verify: per-table
counts equal, `scripts/verify-derived.mjs` green with a per-user mode (D34), the 7,529 backfill plays and
1,162 orphan flags and 481 skip verdicts unchanged.

Database per user: create the app database with the user row and the token rows; leave the owner's
database as it is apart from moving its token rows out; same verification on the token compare
(STORE_MIGRATION §8 step 10's rule: the later `expiresAt` wins).

### 8.7 Isolation tests the data layer needs

The vitest harness (`tests/setup.ts`, a throwaway SQLite file per test file) is the right home. Seed two
users with deliberately colliding data: the same track at the same `played_at`, the same playlist id in
both libraries, the same context URI with a name for one and a 403 for the other. Then run every
per-user function as user A and assert that user B's rows are byte-identical before and after, and
that nothing user A reads contains a B-only marker value. Replace the `unstable_cache` passthrough stub
(D29) with one that keys on the key parts plus the serialized arguments, so a call that forgets the user
returns the other user's entry in the test. D17's collision and D18's interleaved timelines are the two
cases most likely to slip past a review, so they deserve named tests.

### 8.8 Deletion, export, retention

What a user owns, per model: row-level, every row with their `user_id` in the five per-user tables,
`user_meta`, their token row, and their telemetry rows (`client_metrics` carries song names; D30);
database per user, their database plus the same app and telemetry rows. Lane 01f records Spotify's
five-day deletion requirement and its "do not store Spotify Content indefinitely" term (01f §1.5,
§1.6); the data model supports a retention window as one indexed range delete on `played_at` per user.
Stored verdicts stay valid, and the all-time totals recompute from what is left. (Applied to the owner,
such a window would delete the 7,529 backfill rows first: they carry the oldest timestamp.) Backups: the nightly snapshots keep 60 days offsite (BRIDGE.md), so in
a single shared store a deletion is complete only when the last snapshot holding the user ages out, or
every snapshot is rewritten. Per-database backup files avoid that: the deletion removes the user's files
too. How that squares with the five-day rule is Rem's call (§12).

## 9. How the data scales with N users

Five is the real ceiling for this app (01f §1.6). The 25 and 250 columns below answer the program's
brief and assume, as a worst case, that every user listens like the owner.

### 9.1 Storage

[estimated from §6's measured per-user figures]

| | per Rem-like user | N = 5 | N = 25 | N = 250 |
|---|---|---|---|---|
| core data today (owner: 11.87 MB incl. backfill) | 11.9 MB | 59 MB | 297 MB | 3.0 GB |
| core growth per year (~35 KB/day) | 12.6 MB | 63 MB | 315 MB | 3.2 GB |
| `api_log` at 30-day retention (~2,000 rows/day) | ~7 MB, flat | 36 MB | 180 MB | 1.8 GB |
| `api_log` with retention broken, as today, per year | ~87 MB | 435 MB | 2.2 GB | 22 GB |

A new user's first day is a library sync (their `tracks`, `playlists`, `playlist_tracks`, Liked Songs)
and no history. The owner's library is 6,590 distinct track ids (1.75 MB of `tracks` at 265 B) plus
1.45 MB of `playlist_tracks` [measured, S-Oct14], so a newcomer with a similar library starts near 3.3 MB
and grows from there. Storage is not what binds; the retention fix (D32) is the one storage item that
matters before more users arrive.

### 9.2 Per-user query cost as N grows

Measured locally (Mac, SQLite, no `ANALYZE`, as production), on N synthetic users each holding a copy of
the owner's 22,040 plays, timing the per-user version of each query for one user in the middle; median of
5 runs in ms [measured, §11]. "User-led" uses D4's indexes; "today's indexes" keeps the current ones and
only adds `user_id = ?` to the WHERE clause.

| query | user-led, N = 25 | user-led, N = 100 | today's indexes, N = 25 | today's indexes, N = 100 |
|---|---|---|---|---|
| history payload scan (`db.ts:1690`), 21,559 rows | 31.9 | 36.1 | 130.2 | 526.7 |
| all-time list (`db.ts:998`), top 300 | 21.1 | 23.7 | 221.8 | 1,116.0 |
| `orderedRealPlays` (`db.ts:856`), 14,511 rows | 16.5 | 17.8 | 98.6 | 435.8 |
| day strip, 16-day window (`db.ts:1101`) | 2.0 | 2.1 | 13.0 | 56.5 |
| `recordPlays` existing read (`db.ts:484`), 50 rows | 0.0 | 0.0 | 0.2 | 1.0 |

With a user-led index the plan is `SEARCH … USING INDEX (uid=?)` and the time does not move from 25 to
100 users. Without one the plan walks every user's plays (all of them for the full scans, everyone's
window for the windowed reads) and the time grows with N (×4 from 25 to 100). On a metered store the rows read grow the same way. A per-user database gets the left-hand
columns without new indexes. These are local-file times; the remote store adds its round trip and
transfer, which STORE_MIGRATION's R1 bounds.

### 9.3 Reads and writes per user per month against Turso's free plan

The free plan allows 500M rows read and 10M rows written a month, and exceeding either blocks every
query until the month resets (READ_QUOTA "What rows read means"). Rows read are counted per
organization, so both data models share one budget. Per Rem-like user, from the meter's measurements
in STORE_MIGRATION §3:

- a typical day reads ~1.6-1.9M rows (1,430,580 in the 21 hours from 9 PM Oct 12; 1.94M on the day the
  scan below ran 23 times), ~49-58M a month;
- the unscoped orphan pass reads ~5.1M rows per run, about three a week, ~65M a month (lanes 1910-1911
  scope it to changed playlists);
- one full `plays` scan of ~50,500 rows ran 23 times in a day; it is gated to once per 10 min, so a
  heavy listening day can reach 144 runs (~7.3M), which is why a heavy month reaches ~280M for one user.
  STORE_MIGRATION names it the history payload; if it is the all-time recompute, as §11.2 argues, it
  runs whenever the user listens, app open or not, so across N users it scales with listening hours
  rather than with app use, and phase E's browser cache does not reduce it;
- writes are ~3,100 core rows a day, ~93K a month (telemetry writes stay on the Zenbook).

[estimated] Five typical Rem-like users read ~570-615M a month with today's orphan pass
(5 × (49-58M + 65M)), over the plan; ~245-290M with the pass scoped, under it but above STORE_MIGRATION's
R4 bar of 50%. Five heavy months would be ~1.4B. Writes stay under 5% of the plan at five users.

The read cost per user also grows with that user's history, without bound: that scan reads ~2.3 rows per
stored play (50,500 / 22,040), and the history payload and the orphan pass are linear too. At the owner's
rate (~117 plays a day) the same scan a year from now reads ~150K rows. Two data-model levers address
this, and both are design choices for the next phase: make the all-time totals an accumulator updated
per landed play instead of a full scan (READ_QUOTA already calls it the "queued next lever"), and make the
history payload incremental (plays are append-mostly: a stored base plus the delta since its version,
rebuilt from scratch only when a derived column such as `ctx_orphan` or `skipped` moves in old rows).
Which one pays more depends on the attribution in §11.2.

### 9.4 Background statements

§4.2 estimates ~10,000-12,000 statements a day per user from the cron alone, whether or not the user
opens the app; five users is ~60,000 a day, under one a second on average. Within that, the library
sync's serial `plsnap:<id>` reads (110 per run for the owner, `sync/library.ts:65-66`) are the one
pattern that multiplies round trips by playlists × users; reading the user's snapshot keys in one
statement removes it. How the cron fans out across users is lane 01c's.

## 10. STORE_MIGRATION.md: what multi-user needs from it, and what should change before it runs

**Run it as planned, and keep the multi-user schema out of it.** The cutover moves today's single-user
schema to Turso and flips the env under code that expects that schema; its rollback is "flip the env
back" (STORE_MIGRATION §8). Folding the user columns or a second database into the same night would put
an untested schema change under a deployed app that does not know it, and would turn a reversible move
into a migration. The multi-user schema change is a later step with its own fence and snapshot (§8.6).

What the move already gives multi-user, from the data side:

- Core data on Turso in the functions' region (R1), where the per-statement round trip is short, which
  both §8 models need because every request reads at least a token row and a payload. Many small
  databases are a supported Turso pattern; how many a plan allows is 01f's §4.2.
- The telemetry split (phase A items 1-3) puts the three global tables behind their own client, which
  is where they belong in either model.
- The daily route (phase A item 7) restores `api_log` and `client_metrics` retention (D32) before more
  users multiply ~2,000 `api_log` rows a day each, and lands Turso's real usage in the ledger daily, the
  number §9.3's budget has to be watched against.
- Phase E keys the browser's IndexedDB copy by the signed-in user's id (STORE_MIGRATION §10), the right
  shape already. The ETags it revalidates against still need D27's user component.
- Lanes 1910-1911 scope the orphan pass. At five users that is the difference between ~570M and ~245M
  rows read a month (§9.3).

What I would change or add before Oct 15, 8 PM. All are small, none touches the cutover runbook, and
each is the director's and Rem's call:

1. **Archive the meter's pre-cutover logs, and read one fact out of them (lane 1903 or 1904).** After the
   cutover the meter sees telemetry only (STORE_MIGRATION §9) and Turso reports one counter per
   database. The meter's per-statement `querylog/<day>.jsonl` files are the only exact per-path read
   record of the owner's workload, and every multi-user budget will be built on them. Copy the last 14
   days off the Zenbook with the core snapshot. (Their retention there is not documented; I did not
   check it.) The fact: which SQL is the 23-a-day, ~50,500-row scan STORE_MIGRATION §3 calls the history
   payload (§11.2). If it is the all-time recompute, phase E does not reduce the dominant read and R4's
   heavy-day projection has a different lever.
2. **Know which instrument to trust (phase A).** The ledger and `api_log` disagree by ~30% on harvests
   (§4.1); both write fire-and-forget (`void …catch()`), which item 4 deliberately keeps. If the ledger
   is to attribute reads per path on Turso, where nothing else does, its writes should go through
   `after()` as item 4 does for `/api/metrics`; otherwise /usage should call it approximate.
3. **Write the backup as a loop over databases (lane 1904).** Phase D backs up "Turso's core" as one
   database. Under the per-user-database recommendation it becomes N+1; a list of database names costs
   nothing now and saves a rewrite.
4. **Note R4's scope.** R4 projects one user (STORE_MIGRATION §2). It holds for the cutover, and it
   fails for five Rem-like users without lanes 1910-1911 and a cheaper form of the dominant scan (an
   all-time accumulator or an incremental history payload, §9.3); the multi-user plan has to re-check it
   at N, not inherit it.

Later, before any multi-user code is deployed (not part of this cutover): Preview deployments and
`.env.local` point at the production store (STORE_MIGRATION §3 and step 15). Multi-user branch builds
must not, because their migration changes the schema; they need a separate Turso database copied from
production.

On the open question in STORE_MIGRATION §4 (move the three log tables to Turso too), the data layer adds
one fact: with more than one user, `client_metrics` holds other people's listening (`handoff` rows carry
"artist — title" and the source playlist, `home/den-home.tsx:888-894`), and `api_log` would gain a user
column. Wherever telemetry lives, it becomes personal data with a deletion duty. Dropping song names from
the `handoff` beacon removes most of that whichever way the question is answered.

## 11. Measurement log and unknowns

### 11.1 What I ran

Nothing ran against the production store, the Zenbook, Turso or Vercel. In order, on the Mac:

1. `rclone lsl onedrive-backup:lazyboy-db`: lists the nightly snapshots (Aug 16 to Oct 14).
2. `rclone copy` of `lazyboy-20261014-0840.db.gz`, `lazyboy-20260914-0840.db.gz` and
   `lazyboy-20260816-0840.db.gz`, each into its own empty directory, then `gunzip -k`.
3. Every query below with `sqlite3 "file:<snapshot>?immutable=1"`, read-only, no WAL or locks:
   - `sqlite_master` (types, names, DDL); `count(*)` per table; `PRAGMA page_size / page_count /
     freelist_count`; `SELECT name, count(*), sum(pgsize) FROM dbstat GROUP BY name`;
   - `meta` keys grouped by prefix with `count(*)` and `sum(length(value))` (values never printed);
   - `plays`: min/max `played_at`, counts by `context_type`, `skipped`, `ctx_orphan`; real plays per UTC
     day joined to a calendar of every day Aug 14 to Oct 13 (zero days kept); per month; distinct track
     ids and distinct `lower(artist), lower(name)` identities;
   - `tracks` referenced by no play, member or Like; distinct library track ids (members ∪ Likes); owned
     playlists (`owner_id` = `me_id`) and their `track_count` sum;
   - `api_log` per UTC day (Sep 30 to Oct 13) and per `source` (Oct 7 to Oct 13); `client_metrics` per
     day, and its page views and `history-ready` marks per hour for Oct 12-14; `usage_ledger` per reader
     for Oct 7-13, Sep 14 to Oct 13, and every row from Oct 11; `sqlite_sequence`;
   - `EXPLAIN QUERY PLAN` for 37 statements copied from `db.ts` (§4.2).
4. `sim.py`: a scratch SQLite file holding the S-Oct14 catalog plus N copies of its plays (uid 1..N) in
   two schemas, D4's user-led indexes and today's indexes with no UNIQUE (so no index leads with the
   user); `dbstat` bytes per play for 25 users with an INTEGER and a 28-character TEXT user id; then five
   timed runs of each §9.2 query for user ⌈N/2⌉ at N = 25 and N = 100. The 1.08 GB file was deleted
   after the run.

The scripts (`census.sh`, `sizes.sh`, `growth.sh`, `ledger.sh`, `eqp.sh`, `callers.sh`, `sim.py`) are in
`~/.claude/broke/scratch/lazyboy_mu/0221_data/bin/` for the review lanes to re-run. The downloaded
snapshots were deleted at the end: they hold the owner's listening history and both token rows.

### 11.2 Unknowns

- **Which full scan dominates reads.** STORE_MIGRATION §3 says the history payload's plays scan ran 23
  times in a day at ~50,500 rows, "rebuilt after every sync that lands a play". Three things point
  elsewhere. In the code the history payload rebuilds only when a browser requests it with a new
  version, and an open Home tab patches its copy instead of re-fetching (`home/den-home.tsx:761-786`);
  nothing on the sync path calls `getHistoryIndex`. `client_metrics` in S-Oct14 records no Home page
  view at all on Oct 13 (UTC), three on Oct 12, and the ledger's `history_payload` reader shows 0-2 runs
  a day that week. And the read that does run after landed syncs, gated to once per 10 min, is the
  all-time recompute (`orderedRealPlays`, `db.ts:854`): a full scan of 22,040 plays plus a `tracks`
  probe for each of the 14,511 real ones, which is ~51,000 rows if each probe counts twice, the way
  READ_QUOTA's calibration found joins counted ("about three per play"). The history payload would
  count higher, since it probes `tracks` for 21,559 plays and `contexts` for most of them. I did not
  read the meter's log, which names the SQL; §10 item 1 asks for it.
- **How often things really run.** The ledger and `api_log` disagree on harvests (330.6 vs 254 a day,
  Oct 7-13); both write fire-and-forget, and I do not know which loses writes. The meter is exact, but I
  did not read it (it is on the Zenbook); §4's cadences use the code's timers first and these figures as
  bounds.
- **Turso's database count** per plan decides whether a database per user is free (01f §4.2, pending
  when this was written).
- **Whether a shared catalog churns.** If two users' syncs see different fields for one track id
  (market, language), `trackUpsertStmt` would rewrite the row back and forth. Row-level only; I found no
  evidence either way, and the server sends no `Accept-Language`, which makes it less likely.
- **Remote timings.** §9.2's numbers are a local file. Turso-era per-query times are lane 1902/1903's
  bench (R1).
- **The snapshot is a day old**, taken 4:40 AM Oct 14, and its last four hours of `api_log` are partial;
  the per-day figures use the full days before it.
- **`plays`' AUTOINCREMENT counter** reads 1,395,419 for 22,040 rows (S-Oct14 `sqlite_sequence`). Not
  investigated; nothing uses `plays.id` as a cursor, so it does not affect the plan.
- **The meter's log retention** on the Zenbook (§10, item 1): not checked.
- Spotify's terms on storing Spotify content and derived listening metrics, and the per-developer
  quota pooling, are lane 01f's (§1.4, §1.5); D22 and §8.8 rest on them.

## 12. Decisions that are Rem's

1. **Data model: a database per user, or one shared store with a user column.** Technical, but it fixes
   the migration risk and the ops load for the life of the feature. Recommendation: a database per user
   at five users (§8.1): it removes the leak and wrong-data classes by construction, leaves your data
   where it is, and makes deletion complete including backups. Revisit if Turso's plan caps databases
   below six or if friend features (cross-user joins) become the priority.
2. **Retention of other users' history.** Spotify's terms say not to store content indefinitely (01f
   §1.5). Recommendation: unlimited for your own history (it is your record, and the backfill and
   import scripts exist to make it complete), and a stated window for invited users, enforced by one
   indexed delete per user per day (§8.8). The length of the window is the decision.
3. **Backups and deletion.** Each nightly snapshot is one file holding everything, kept 60 days
   offsite. Recommendation:
   per-user backup files, so a deleted user's backups go with them inside Spotify's five-day window (01f
   §1.6); the alternative is a privacy policy that says deletion reaches backups within 60 days.
4. **The backstop recorder.** It is your safety net against Zenbook outages and holds your token chain.
   Recommendation: keep it yours only (D35); covering other users means their refresh tokens on a laptop
   in your apartment, which lanes 01e and 01f weigh.
5. **Telemetry location** is already open in STORE_MIGRATION §4. The data layer's input (§10): with
   other users, `client_metrics` holds their song names wherever it lives; dropping names from the
   `handoff` beacon is worth doing either way.
