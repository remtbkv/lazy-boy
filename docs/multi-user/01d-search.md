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

### 2.1 Payload sizes (raw, gzip, brotli)
### 2.2 Build time
### 2.3 Client cost: download, parse, index, filter per keystroke (desktop measured, phone estimated)

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
