# 01d — Search and the client: the two payloads, Home's first paint, and how they grow

Lane 0221 of the multi-user planning program, written 2026-10-14. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `ac6f7fe`.
Every number is labelled **[measured]** (how, where, when) or **[estimate]** (the arithmetic).
The commands behind the measurements are in the appendix.

Status: outline — sections fill in order; each is committed as it lands. A section that still
reads "pending" was not reached.

## 0. Summary

_(pending)_

## 1. How search works today

Home's search box matches in the browser. Two JSON bodies are fetched once per visit, merged into
one in-memory set, and every keystroke filters that set with no request (`den-home.tsx:497-524`,
`db.ts:1371-1437`). The same history body also feeds Home's day list, so after it lands neither
search nor a day slide waits on the store (`den-home.tsx:215-263`). Source code is unchanged
between `1c7aabb` and this commit (`git diff --stat 1c7aabb HEAD -- src` is empty).

### 1.1 The library payload: query, shape, cache layers

`GET /api/search/library` (`src/app/api/search/library/route.ts:21-53`) returns every song that sits
in a playlist or in Liked Songs.

- **Build** (`readLibraryIndex`, `db.ts:1625-1684`): three reads in parallel — `playlist_tracks JOIN
  tracks` (one row per membership), `saved_tracks JOIN tracks`, `SELECT id, name FROM playlists` —
  then a JS pass that collapses rows to one per song identity, `lower(artist) + "\n" + lower(name)`
  (`db.ts:1653-1667`), and records each song's playlists once (`db.ts:1668-1674`).
- **Shape** (`db.ts:1459-1471`): `{images, albums, playlists, tracks}`, where `tracks` is
  `[name, artist, imageIdx, albumIdx, playlistIdx[]]` and the three string tables are interned
  (`interner()`, `db.ts:1441-1455`), so a repeated art URL or album name is sent once.
- **Version** (`getLibraryIndexVersion`, `db.ts:1528-1534`): `meta.library_seq`, bumped in the same
  batch as any write to `playlists`, `playlist_tracks` or `saved_tracks` (`db.ts:362-383`; bump
  sites at `db.ts:1887, 2022, 2094, 2178, 2196, 2255`). A re-tag of a track's name or art does not
  move it; the daily TTL bounds that (`db.ts:1520-1523`).

### 1.2 The history payload: query, shape, the slow marker

`GET /api/search/history` (`src/app/api/search/history/route.ts:15-39`) returns every played song and
every individual play.

- **Build** (`readHistoryIndex`, `db.ts:1686-1730`): one query, a full `plays` scan joined to `tracks`
  and left-joined to `contexts`, skipped plays excluded (`NOT_SKIPPED`, `db.ts:768`), newest first.
  Catalog rows (`context_type = 'backfill'`, played_at fixed at the 2026-05-30 sentinel) are
  included on purpose (`db.ts:753-760`).
- **Shape** (`db.ts:1481-1498`): `{images, albums, sources, tracks, plays}`; `tracks` is
  `[name, artist, imageIdx, albumIdx, durationMs]` per played identity and `plays` is
  `[trackIdx, epochMinute, sourceIdx]` per play. `durationMs` exists for the day list, not for
  search (`db.ts:1473-1480`).
- **Version** (`getHistoryIndexVersion`, `db.ts:1591-1596`): the slow marker `meta.slow_seq_pub`, a
  copy of `write_seq` republished at most every 10 minutes (`db.ts:1536-1589`). `write_seq` moves on
  every write to `plays`, `tracks`, `contexts`, `playlists`, `playlist_tracks` or `saved_tracks`
  (`db.ts:326-328`), so while anyone listens the history version moves every 10 minutes.

### 1.3 The two cache layers: the server data cache and the browser's ETag/304

**Server.** Each payload is wrapped in `unstable_cache` keyed on `["library-index", "v1"]` /
`["history-index", "v2"]` plus the arguments `(version, shape)`, with `revalidate: 86400`
(`db.ts:1600-1623`, `FROZEN_TTL_S` at `db.ts:958`). A request under a version nobody has built yet
runs the full read; later requests under that version are served from Vercel's Data Cache. A version
the store cannot read (`null`) is served fresh with `Cache-Control: no-store` and never cached
(`library/route.ts:24-32`, `history/route.ts:18-25`).

**Browser.** Both routes send `Cache-Control: private, max-age=0, must-revalidate` and an ETag of
`"lib-<shape>-<version>-<UTC day>"` / `"hist-<shape>-<version>-<UTC day>"`
(`library/route.ts:39-43`, `history/route.ts:26-30`). The browser keeps the body and revalidates on
every load; an unchanged tag answers 304 with no body (`library/route.ts:45-47`,
`history/route.ts:31-33`). The UTC day in the tag forces one full download per day at most.

**Shape tokens.** `LIBRARY_INDEX_SHAPE = "v1"` and `HISTORY_INDEX_SHAPE = "v2"` (`db.ts:1511-1513`) sit
in both the cache key and the ETag, because the Data Cache outlives a deploy and once served an
old-shaped body to new code (GOTCHAS "The Data Cache OUTLIVES THE DEPLOY").

**Neither layer has a user in it.** That is listed in 01a-data (D21 markers, D27 ETags) and
01b-surface (B2, B10, C4); §4 covers what it means for search specifically.

### 1.4 Home's first paint and the idle loads, in order

1. **Server render** (`home/page.tsx:69-137`): `auth()`, the materialized Home payload (one `meta`
   row, `meta.home_payload`, rebuilt on the write path by `rebuildHomePayload`, `db.ts:1227-1357`),
   the Spotify cooldown and capture health, all in one `Promise.all` (`page.tsx:78-83`). The page
   ships the 14-day strip, the all-time totals and the opening day's rows; `loading.tsx` paints a
   skeleton before the first byte. The chrome (`(app)/layout.tsx:39-71`) mounts the now-playing
   poller (every 6 s, `now-playing-context.tsx:76, 358`), `SyncOnLoad` (POST `/api/sync` on load,
   every 2 min and on focus, `sync-on-load.tsx:12-26`) and the metrics collector.
2. **On mount**: the action dock's playlists (`dockDataAction`, `dock-loader.tsx:21-50`), the
   whole-history day strip for the strip's "see all" (`dailyStatsAction(100000)`,
   `den-home.tsx:371-385`), and, until the history payload lands, the two days either side of the
   selected one (`den-home.tsx:468-495`).
3. **On idle** (`requestIdleCallback`, 2 s timeout; `setTimeout(800)` where it does not exist):
   `loadIndex()` fetches both payloads in parallel (`den-home.tsx:595-641, 652-676`). When BOTH have
   settled it builds the search set (`buildEntries`, `den-home.tsx:168-213`) and stores the history
   body, which derives every day's rows (`buildDays`, `history-days.ts:37-135`, run in a `useMemo`,
   `den-home.tsx:296`). The `lb:history-ready` mark fires then (`den-home.tsx:313-317`).
4. **While the payloads are in flight** a query goes to the server fallback, `searchPlaysAction` →
   `searchHistory`'s unindexable `LIKE '%q%'` over the history only (`history-actions.ts:184-195`,
   `db.ts:884-904`), debounced 120 ms (`den-home.tsx:689-713`).
5. **While the tab stays open**, `refreshHistoryAction` runs every 120 s, on each track change and on
   focus (`den-home.tsx:735-829, 990-999`). It syncs from Spotify and returns the plays the in-memory
   payload is missing (`history-actions.ts:140-161`); the client patches its copy
   (`patchHistoryPayload`, `history-patch.ts:34-102`) and rebuilds the search set and all days from it
   (`den-home.tsx:766-780`). An open tab never re-downloads the history body.

The history-ready mark waits for the library body too (`Promise.all`, `den-home.tsx:620`), although
the day list needs only the history half.

### 1.5 Client-side matching: the search box, `fuzzyFilter`, `hanFold`, the day list

- **The search set** is one `Entry` per identity across both payloads, with `fn`/`fa` precomputed:
  name and artist lower-cased and Han-folded once at load (`den-home.tsx:96-112, 184-185`).
- **A keystroke** runs one `useMemo` (`den-home.tsx:1047-1131`): fold the query, `String.includes`
  over every entry's `fn` (Songs) or `fa` (Artists), sort by exact/prefix/substring tier, then most
  recently played, then name (`localeCompare`), cap at 400 rows (`MAX_RESULTS`, `den-home.tsx:143`).
  No debounce on this path; the 120 ms debounce is the server fallback's (`den-home.tsx:144, 711`).
  On a phone in search mode a picked day narrows results by filtering each hit's plays to that day's
  minute range (`den-home.tsx:1040-1066`).
- **`hanFold`** (`han-fold.ts:43-49`): lower-case, then one regex test for any Han code point
  (`HAS_HAN`, `han-fold.ts:39`); only strings with Han characters walk the 18.6 KB traditional →
  simplified table (GOTCHAS "Simplified vs traditional Han"). Latin text costs a `toLowerCase` and a
  regex test.
- **`fuzzyFilter`** (`filter.ts:11-28`) is not on Home. Its one caller is the playlists grid
  (`playlists-grid.tsx:52`) over ~114 playlist names; its header comment (`filter.ts:3`) still names
  the merge panel, which no longer calls it.
- **The day list** comes from `buildDays`, which walks every play once and builds two maps: per day,
  one row per song with a count; and per day, one row per play for the phone view
  (`history-days.ts:64-120`). It builds every day in the history up front, including the catalog
  rows' sentinel day that the strip never shows (the strip's counters exclude backfill,
  `db.ts:753-760`).

## 2. Measured on the owner's data

Source: the nightly offsite backup `onedrive-backup:lazyboy-db/lazyboy-20261014-0840.db.gz` (taken
2026-10-14 04:40 by `~/lazyboy-backup/backup.py`, quota-forensic/BRIDGE.md "The nightly snapshot"),
copied to a private scratch directory, `PRAGMA integrity_check` = ok. Nothing was read from the
Zenbook store or Vercel. The payloads were rebuilt with `db.ts`'s SQL and build code copied verbatim
(`readLibraryIndex`/`readHistoryIndex`), under Node 24.5 with `node:sqlite`. Counts in the copy:
22,040 plays (21,559 served after skips; 7,529 of them catalog rows), 15,859 tracks, 7,400 playlist
memberships, 114 playlists, 48 liked songs, newest play 2026-10-14 06:36 UTC.

### 2.1 Payload sizes (raw, gzip, brotli)

**[measured]** Bodies as the routes serve them (`JSON.stringify({ v, ...index })`). gzip at level 6,
brotli at quality 5 and 11 (which one Vercel's edge uses for these routes was not checked; §8).

| | library | history |
|---|---|---|
| raw | 807,315 B | 1,791,138 B |
| gzip -6 | 285,049 B | 614,708 B |
| brotli q5 / q11 | 257,332 / 213,896 B | 511,150 / 441,710 B |
| identities | 6,457 | 11,358 |
| plays | – | 21,559 |
| art URLs (interned) | 5,617 = 376 KB | 9,256 = 620 KB |
| album names (interned) | 5,470 = 116 KB | 8,892 = 188 KB |
| playlist / source names | 114 = 1.3 KB | 112 = 1.6 KB |
| song tuples | 314 KB | 575 KB |
| play tuples | – | 407 KB |
| Next data-cache item (§3.2) | 824,322 = 39.3% of 2 MiB | 1,815,171 = 86.6% of 2 MiB |

Per unit: **125 B per library identity**; for history, **~19 B per play** plus **~122 B per played
identity** (its tuple and, when new, its art URL and album name). Compressed is ~34-35% of raw
with gzip.

**The volatile half is now the big half.** On 2026-08-06 the library body was 1,638,540 B raw and the
history 476,206 B (`db.ts:1409-1412`), which is why the route comments call history "the small,
volatile half" (`history/route.ts:9-12`). Since then the library shrank (180 → 114 playlists,
15,326 → 7,400 memberships) and the history grew 3.8×, mostly from the 7,529 catalog rows added on
2026-08-15 (`db.ts:753-760`). **[measured]** Split out:

| history body | raw | plays | identities |
|---|---|---|---|
| everything (served today) | 1,791,126 B | 21,559 | 11,358 |
| without catalog rows | 774,035 B | 14,030 | 4,187 |
| catalog rows alone | 1,046,979 B | 7,529 | 7,427 |

The catalog rows never change, yet they make up 58% of the body that is downloaded again after
every listening session.

### 2.2 Build time

**[measured, local floor]** On the Mac against the local copy (no network), medians of n=7: library
SQL 9.5 ms + JS 4.9 ms + stringify 1.4 ms; history SQL 71.6 ms + JS 26.8 ms + stringify 3.3 ms. This
is the CPU floor only. In production the rows cross the network before the JS runs.

**[recorded by others; not re-measured]** Production builds are a full scan, which this lane's rules
exclude from production reads.
- Against Turso, 2026-08-06, n=5: library member scan 5,424 ms median, history 2,557 ms
  (`db.ts:1421-1425`), at 15,326 memberships and 7,050 plays.
- Through the Funnel, 2026-08-22, gzip transfer, n=5: history plays scan 648 ms for 16,375 rows,
  library member scan 367 ms for 7,087 rows (GOTCHAS "Never let the store compress with brotli").
- Rows read per rebuild: the ledger models 64,656 for the history (3 per play over 21,552 plays) and
  14,800 for the library (2 per membership) on 2026-10-14 (usage_ledger in the copy); the meter
  measured 65,608 rows for a `plays JOIN tracks` over 21,870 plays (READ_QUOTA "Measured reads").

**[estimate]** Today's history build through the Funnel scales the Aug 22 figure by rows:
648 ms × 21,559 / 16,375 ≈ 850 ms, before any stall (STORE_MIGRATION §1 records stalls of 20 s+).

**How often the server builds.** The ledger in the copy records 1-2 rebuilds of each payload on each
day Home was opened in Sep-Oct (Sep 21, Sep 27, Oct 12, Oct 14) and none on other days. Both
versions move several times a day: the slow marker every 10 minutes while music plays, and
`library_seq` (now 603) with every library write, which the ledger shows as 3-5 playlist-list
rewrites and 2-7 unique-song recomputes a day on Oct 12-14. So a visit hours after the last one
finds both versions moved: the server rebuilds both bodies and the browser downloads both in full.
The 304 path pays off only for visits close together. Nothing counts 304s (§8).

**The Oct 13 attribution in STORE_MIGRATION §3.** That section names "the history payload's plays scan
(~50,500 rows read per run)" with 23 runs on Oct 13 as the dominant read. The ledger in the copy
records no `history_payload` or `library_payload` rebuild on Oct 13 UTC, and `readHistoryIndex` is
reachable only from `GET /api/search/history` (grep of `src/`). The statement the meter saw is more
likely `orderedRealPlays` (`db.ts:854-869`), the all-time recompute's full plays scan, which runs
after landed syncs at most every 10 minutes (`db.ts:577-581`); 01a-data notes the same mismatch.
The meter log's SQL text settles it (§6, §8).

### 2.3 Client cost: download, parse, build, filter per keystroke

**[measured, real users]** `client_metrics` in the copy, hard loads of `/home` (views that carry a
TTFB), 2026-08-11 to 2026-10-14, grouped into views by the `pv:` tag. Device mix is unknown: nothing
records the user agent. 130 of the 135 hard loads are from August; only seven Home views (five hard
loads) are recorded since Sep 14, too few to describe today.

| ms from navigation | n | p50 | p75 | p90 | max |
|---|---|---|---|---|---|
| TTFB | 135 | 113 | 381 | 1,290 | 2,415 |
| FCP | 125 | 896 | 1,784 | 2,206 | 18,385 |
| `data-rendered` (server rows on screen) | 128 | 1,109 | 1,919 | 2,428 | 20,040 |
| `history-ready` (search + days from memory) | 116 | 5,543 | 8,658 | 10,602 | 49,429 |
| history-ready − data-rendered | 116 | 4,038 | 7,142 | 8,735 | 29,389 |

13 of 172 recorded views reached `data-rendered` but never `history-ready`. The 4 s median between
the two marks covers the idle wait (up to 2 s), both requests (auth, version read, Data Cache or
rebuild, transfer), parse and both builds.

**[measured, browser]** Chromium 145 headless on the Mac with CDP CPU throttling
(`Emulation.setCPUThrottlingRate`), payloads served from memory (no network), app code from
`han-fold.ts` and `history-days.ts` with types stripped, `buildEntries` and the search memo copied
from `den-home.tsx`. Each cell is the median of three fresh pages, so the one-off builds are cold as
on a real visit. Rendering is not included.

| CPU | parse library | parse history | buildEntries | buildDays | main-thread total |
|---|---|---|---|---|---|
| 1× (the Mac) | 1.9 | 3.0 | 12.0 | 46.9 | 64 ms |
| 4× | 6.4 | 11.9 | 46.6 | 199.4 | 264 ms |
| 6× | 9.9 | 18.9 | 71.9 | 318.8 | 420 ms |

`buildDays` is three quarters of the client's work. It materializes a row object with ISO strings for
every play on every day (`history-days.ts:66-120`); the catalog rows' sentinel day alone is 7,529 of
those rows and is never shown.

Per keystroke (match, rank, cap at 400; median of 10 warm runs, ms):

| CPU | "a" songs (7,474 hits) | "e" songs (8,599) | "lo" (1,297) | "love" (545) | "a" artists (3,503) | "taylor" artists (4) |
|---|---|---|---|---|---|---|
| 1× | 2.4 | 2.9 | 0.6 | 0.4 | 1.9 | 0.2 |
| 4× | 10.5 | 13.2 | 2.7 | 1.9 | 9.0 | 0.9 |
| 6× | 17.3 | 21.0 | 4.6 | 3.0 | 15.4 | 1.1 |

Matching is not where a keystroke's time goes at this size. The app's own measurement from keystroke
to painted frame is 43.8 ms median (15.8-130.2, n=25, dev build, desktop, 2026-08-05,
`den-home.tsx:514-518`), and STORE_MIGRATION §10 cites 18 ms per query in `lb-perf`; most of either is
React rendering up to 400 complete rows.

**What "a phone" means here [assumption].** The 4× and 6× rows follow Lighthouse's convention of
throttling a fast desktop to stand in for a mid-tier and a low-end phone. Recent iPhones run
JavaScript at roughly 1-2× of this Mac; this is not measured on any real device (§8). A throttled CPU
also leaves out a phone's smaller memory and thermal limits.

**Download on a phone [estimate].** Today's cold visit moves 900 KB gzipped (285 + 615), a visit
after listening at least 615 KB (the history half; plus 285 KB when the library version moved too,
which §2.2 says is usual). At 10 Mbit/s that is ~0.5-0.7 s of transfer; at Lighthouse's "slow 4G"
1.6 Mbit/s, ~3-4.5 s.

## 3. How each grows with a user's library and history

### 3.1 Bytes per library identity, per played song, per play
### 3.2 The ceilings: Vercel's 4.5 MB response cap, build time, phone memory and parse
### 3.3 Projections for a light, a typical and a heavy user

## 4. What multi-user changes for search

### 4.1 Keys: every cache key, ETag and version marker that has no user in it
### 4.2 Server cache footprint and rebuild load with N users
### 4.3 Security of the payloads (cross-user leakage paths)

## 5. What keeps it fast per user: caching and incremental updates

### 5.1 The options, each with its mechanism and cost
### 5.2 Recommendation and order of work

## 6. What multi-user needs from STORE_MIGRATION.md

## 7. Decisions that are Rem's

## 8. Unknowns and what I did not measure

## Appendix: commands run
