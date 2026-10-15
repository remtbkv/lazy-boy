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

## 5. Derived data and caches built on the store

## 6. Volumes: row counts, sizes and growth per day (the owner's data)

## 7. Census: every single-user assumption in the data layer

## 8. What the data model needs for multi-user

## 9. How the data scales with N users

## 10. STORE_MIGRATION.md: what multi-user needs from it, and what should change before it runs

## 11. Measurement log and unknowns

## 12. Decisions that are Rem's
