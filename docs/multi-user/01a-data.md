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

Status: outline. Sections fill in order; each is committed as it lands.

## 0. Summary

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
| `write_seq` | `writeSeqStmt` 348 in the batches at 522, 598, 1841, 1887, 2021, 2094, 2177, 2195, 2255; `bumpWriteSeq` 357 at 749, 819; scripts `backfill-scan.mjs:108`, `import-tail.mjs:65`, `migrate-skip-rule.mjs:104` | `readWriteSeq` 388 via `liveKey` 965 and `slowSeq` 1552: every LIVE cached read | on every write that lands data (each landed tick bumps 2-3 times) | per user (§5) |
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
| `orderedRealPlays` 854 | all real plays in time order; SCAN `plays` via `idx_plays_played_at` | `recomputeAllTimeStats` 1033 | ≤ every 10 min while plays land; daily heal (dead) | per user; same gap-chain hazard |
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
| `readHistoryIndex` 1686 | SCAN `plays` via `idx_plays_played_at`, join `tracks`, LEFT JOIN `contexts` | `getHistoryIndex` 1620 ← `api/search/history/route.ts:21, 35` | on slow-marker change (≤144/day); the meter saw 23 runs and ~50,500 rows read per run on Oct 13 (STORE_MIGRATION §3) while the ledger recorded none that day | per user; **leak** unscoped |
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

## 6. Volumes: row counts, sizes and growth per day (the owner's data)

## 7. Census: every single-user assumption in the data layer

## 8. What the data model needs for multi-user

## 9. How the data scales with N users

## 10. STORE_MIGRATION.md: what multi-user needs from it, and what should change before it runs

## 11. Measurement log and unknowns

## 12. Decisions that are Rem's
