# 01d — Search and the client: the two payloads, Home's first paint, and how they grow

Lane 0221 of the multi-user planning program, written 2026-10-14. Planning only: nothing here
changed code, data, the Zenbook store or Vercel. Line numbers are against commit `ac6f7fe`.
Every number is labelled **[measured]** (how, where, when) or **[estimate]** (the arithmetic).
The commands behind the measurements are in the appendix.

Status: complete, 2026-10-14.

## 0. Summary

- **The history payload's server cache stops working around late December 2026, for the owner
  alone.** Vercel's Data Cache (and Next 16.2.6's own check) refuses items over 2 MB without an error.
  The history entry is at 86.6% and grows ~6 points a month (§3.2). Past the limit, every Home open
  re-runs the full plays scan, and the only signal is a warning in logs that age out within an hour.
- **The "small, volatile" half is now the big one.** History is 1.79 MB raw / 615 KB gzipped, the
  library 0.81 MB / 285 KB; 58% of the history body is catalog rows that never change (§2.1). Both
  versions move several times a day, so in practice a visit hours after the last one rebuilds both
  bodies on the server and downloads both in full (§2.2).
- **On a phone-class CPU (4× throttled) the client spends 264 ms** parsing and building, three quarters
  of it `buildDays` materializing every day of history up front. Matching a keystroke is ≤ 13 ms;
  rendering the rows is the larger share (§2.3). Real users (mostly August, device unknown) waited a
  median 4.0 s, p90 8.7 s, between the page's rows and search being ready.
- **Multi-user** needs a user in every key, marker, ETag, delta and browser store (01a, 01b). The two
  traps specific to search are payload cache keys built from small per-user counters, which collide
  and serve one user's payload to another, and the in-memory delta patch, which phase E would persist
  into IndexedDB (§4.1, §4.3 with six tests).
- **Full-body rebuilds do not scale.** At ~3 store rows per play per visit, 25 typical users cost
  ~380M rows a month (76% of Turso's free plan); monthly history segments, a delta at visit start and
  per-playlist library deltas bring it to ~2M (§4.2).
- **Recommended order (§5.2):** lazy days and monthly segments (catalog as its own segment) now, for
  the cliff; per-user keys with the isolation tests before a second account; STORE_MIGRATION phase E
  storing segments, plus the visit-start delta; per-playlist library chunks later. Nothing in the
  store migration has to change before it runs (§6), but its §3 likely misattributes the ~50,500-row
  read to the history payload.

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
`history/route.ts:31-33`). Because the tag carries the UTC day, the first visit of each UTC day
downloads both bodies in full even when nothing changed.

**Shape tokens.** `LIBRARY_INDEX_SHAPE = "v1"` and `HISTORY_INDEX_SHAPE = "v2"` (`db.ts:1511-1513`) sit
in both the cache key and the ETag, because the Data Cache outlives a deploy and once served an
old-shaped body to new code (GOTCHAS "The Data Cache OUTLIVES THE DEPLOY").

**Neither layer has a user in it.** That is listed in 01a-data (D21 markers, D27 ETags) and
01b-surface (B2, B10, C4); §4 covers what it means for search specifically.

### 1.4 Home's first paint and the idle loads, in order

1. **Server render** (`home/page.tsx:69-137`): `auth()`, the materialized Home payload (one `meta`
   row, `meta.home_payload`, rebuilt on the write path by `rebuildHomePayload`, `db.ts:1227-1357`),
   the Spotify cooldown and capture health, all in one `Promise.all` (`page.tsx:78-83`). The page
   ships the 14-day strip, the all-time totals and the opening day's rows; `loading.tsx` streams a
   skeleton that waits on no query. The chrome (`(app)/layout.tsx:39-71`) mounts the now-playing
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

**[measured]** The history body rebuilt from the same copy as it stood at monthly cutoffs (plays with
`played_at` up to the cutoff, today's tracks and flags):

| cutoff | plays | identities | body | data-cache item |
|---|---|---|---|---|
| 2026-07-14 | 12,624 | 9,759 | 1,428,118 B | 69.1% of 2 MiB |
| 2026-08-14 | 15,176 | 10,369 | 1,546,651 B | 74.8% |
| 2026-09-14 | 18,172 | 10,899 | 1,661,250 B | 80.3% |
| 2026-10-14 | 21,559 | 11,358 | 1,791,126 B | 86.6% |

It grows 115-130 KB a month at the owner's ~3,000 plays and ~450-600 new songs a month. The per-unit
model from §2.1 (19 B per play + 122 B per new played identity) reproduces it: 3,387 × 19 + 459 × 122
≈ 120 KB for the last month against 130 KB measured. New identities per month are falling as the
owner's repertoire saturates (first plays: 1,900 in June, 934 July, 780 August, 404 September), so
the plays term will dominate.

The library body is 125 B per identity and moves only when playlists do. It has gone both ways:
13,464 identities in August, 6,457 now.

Server rebuild cost grows the same way: ~3 store rows per play for the history and ~2 per membership
for the library (§2.2). Client parse and build grow linearly in plays and entries (§2.3 at 1×, 2×, 4×
scale below).

### 3.2 The ceilings

**1. The Data Cache's 2 MB item limit — the owner reaches it in about ten weeks.** Next 16.2.6 stores an
`unstable_cache` result as a JSON string inside a wrapper and checks
`JSON.stringify(wrapper).length > 2 * 1024 * 1024` before writing (`next/dist/server/web/
spec-extension/unstable-cache.js:17-33`, `next/dist/server/lib/incremental-cache/index.js:471-487`,
read from the published 16.2.6 package). Over the limit, with no custom cache handler (this app has
none; `next.config.ts` sets no `cacheHandler`), production logs a warning and does not cache; `next
dev` throws (`E1003`). Vercel documents the same limit: "Item size 2 MB (items larger won't be cached)"
(https://vercel.com/docs/data-cache, "Limits and usage", fetched 2026-10-14).

The history entry is at 1,815,171 of 2,097,152 (86.6%) and grows ~123,000 a month (the slope over the
last two months above). **[estimate]** It crosses in ~2.3 months: **late December 2026.** From then on
every request for the history payload runs the full plays scan, ~850 ms+ through the Funnel today
(§2.2) and ~65,000 rows read on Turso after the move, on every Home open. Nothing reports it: the
warning goes to Vercel runtime logs, which age out within about an hour (STORE_MIGRATION §3).
Removing the catalog rows from this body alone would drop it to 37% (§2.1); monthly segments remove
the cliff (§5).

**2. Vercel's 4.5 MB response cap.** "The maximum payload size for the request body or the response
body of a Vercel Function is 4.5 MB ... it will return an error 413: FUNCTION_PAYLOAD_TOO_LARGE"
(https://vercel.com/docs/functions/limitations, fetched 2026-10-14). That is a 413 and no payload at all,
so the box degrades to the server fallback. The library body reaches it at ~36,000 identities; the
history body, by §3.1's model, at roughly 110,000 plays with 20,000 identities (§3.3).

**3. Client main-thread time.** Measured at 4× in §2.3: 264 ms at today's size; **[measured]** 496 ms
at 2× and 1,013 ms at 4× synthetic scale (identities and plays duplicated under suffixed names, so
match rates hold; the interned art tables were not duplicated, so parse at 2-4× is a lower bound).
One-letter keystrokes at 4×: 10.5 ms (14,507 entries), 25.6 ms (29,014), 55.9 ms (58,028). All of it is
on the main thread today.

**4. Memory.** **[measured, Node]** The merged search set holds ~8 MB of heap at today's size and
~65 MB at 8× (116,056 entries), on top of the parsed payloads. A browser tab on a low-memory phone is
the place this would show first; not measured on a device.

### 3.3 Projections for a light, a typical and a heavy user

**[estimate]** Profiles are assumptions to argue from, not data: plays a day and library size are
guesses about Rem's friends; the owner sits at ~100 plays a day (93-121 per day in Aug-Oct) and had
13,464 library identities in August. Played identities after a year are taken as ~25% / 20% / 17% of
plays for light / typical / heavy, between the owner's 30% at 4.5 months and his falling monthly rate.
Sizes use §2.1's per-unit model; main-thread time scales §2.3's 4× measurement (~12 ms per 1,000
plays at the owner's mix); store rows are ~3 per play + ~2 per membership.

| profile | library ids | plays | history body | library body | parse + build at 4× | rows per full rebuild |
|---|---|---|---|---|---|---|
| light, 1 yr (20/day) | 2,000 | 7,300 | ~360 KB | ~250 KB | ~100 ms | ~26K |
| typical, 1 yr (50/day) | 8,000 | 18,250 | ~790 KB | ~1.0 MB | ~230 ms | ~71K |
| heavy, 1 yr (100/day) | 15,000 | 36,500 | ~1.45 MB | ~1.9 MB | ~450 ms | ~140K |
| heavy, 3 yr | 15,000 | 109,500 | ~3.7 MB, **over 2 MiB** | ~1.9 MB | ~1.3 s | ~360K |
| any user + 5-yr history import | – | ~91,000 + | ~4.2 MB, **over 2 MiB, 93% of 4.5 MB** | – | ~1.1 s + | ~270K + |
| the owner today | 6,457 | 21,559 | 1.79 MB (87% of 2 MiB) | 0.81 MB | 264 ms (measured) | ~80K |

Two things follow. A one-year heavy listener's library alone sits at ~90% of the Data Cache limit,
and anyone given the owner's tools — the Extended Streaming History import
(`scripts/import-extended-history.mjs`) or the catalog backfill (`scripts/backfill-scan.mjs`) —
starts above the limit on day one. And under today's design every visit after listening re-downloads
the whole history body: ~270 KB gzipped for the typical user after a year, ~500 KB for the heavy one.

## 4. What multi-user changes for search

01a-data (D16 whole-table reads, D21 markers, D27 ETags, D28 module state) and 01b-surface (B2, B5,
B10, C4, S6) already list every unscoped read, key and browser store. This section adds what is
specific to the search path and what those censuses do not size.

### 4.1 Keys: every cache key, ETag and version marker that has no user in it

| what | where | today | multi-user failure if only the data is scoped | needs |
|---|---|---|---|---|
| Data Cache key, library | `db.ts:1600-1604` | `["library-index", shape]` + `(library_seq, shape)` | per-user counters are small integers, so users A and B at the same count share one entry: B is served A's library. A leak, not staleness | the user's internal id in the key parts and the arguments |
| Data Cache key, history | `db.ts:1615-1619` | `["history-index", shape]` + `(slow seq, shape)` | the same, with A's whole listening history | the same |
| version markers | `db.ts:345, 374, 1550-1596` | one `write_seq`, `library_seq`, `slow_seq_pub` | with a global marker, every user's play moves every user's version (01a D21): each visit by anyone rebuilds | per-user markers; the 10-minute republish per user |
| ETags | `library/route.ts:39`, `history/route.ts:26` | shape, version, UTC day | two accounts in one browser profile: B's revalidation carries A's tag, and if B's version string equals A's the server answers 304 and B's browser shows A's body | a keyed hash of the user id in the tag (01a D27); a per-user path or query segment so the two accounts do not share one HTTP cache entry and thrash it |
| the in-memory patch | `history-actions.ts:140-161` → `den-home.tsx:766-780` | `searchHistory("", ≤50)`, newest plays of the whole table | other users' newest plays are patched into this user's search set and day list, and under STORE_MIGRATION phase E the patched body is what gets stored in IndexedDB, so the leak would persist across visits | the delta read scoped by user, with a `(user_id, played_at)` index (01a lists the read) |
| the server fallback | `history-actions.ts:190-195`, `db.ts:884-904` | `LIKE` over every play | another user's songs in the results while the payloads load | scoped by user |
| browser copies | `den-home.tsx:325-365` (`lb-days`), `now-playing-context.tsx:240, 376` (`lb-nowplaying`), the HTTP cache of both bodies, the planned IndexedDB copy | stamped by build or by age only | the next person on a shared browser sees the last one's days, song or payloads | stamped by user (phase E already keys IndexedDB by user id); cleared on sign-out in client code, with `Clear-Site-Data: "cache", "storage"` on the sign-out response where the browser supports it (support not checked) |

### 4.2 Server cache footprint and rebuild load with N users

**[estimate]** Assumptions: the typical one-year user of §3.3 (18,250 plays, 8,800 memberships), 8 Home
visits a day, the history version moved before every visit (it moves every 10 minutes while music
plays) and the library version before half of them (the owner's moves several times a day, §2.2).
Rows are store rows read by full rebuilds; Turso's free plan is 500M rows read a month
(STORE_MIGRATION §3).

| users | today's design | history in monthly segments, library whole | segments + a delta at visit start + library per playlist |
|---|---|---|---|
| 5 | ~76M a month (15% of free) | ~16M (3%) | < 1M |
| 25 | ~380M (76%) | ~80M (16%) | ~2M |
| 250 | ~3.8B (7.6× the plan) | ~800M (1.6×) | ~22M (4%) |

Per visit behind each column: today 3 × 18,250 + ½ × 2 × 8,800 ≈ 63,500 rows. With the history in
segments only the hot month rebuilds (~1,500 plays ≈ 4,500 rows), and the library half (≈ 8,800 a
visit) becomes the larger term. With the visit-start delta (~50 new plays ≈ 150 rows), only the changed
playlists rebuilt (~200 rows assumed) and a manifest (~20), a visit is ~370 rows. The visit rate is
the weakest input: at 3 visits a day every figure is ×⅜, which still leaves today's design at ~140M a
month for 25 users.

The owner alone does not show this today because his visits are rare and his open tab patches in
memory instead of re-fetching (§1.4 step 5).

**Data Cache footprint.** Each rebuild writes a new entry of the body's size, and superseded entries
stay until their 24 h TTL. For 25 typical users at 8 visits that is ~25 × 8 × (0.8 + 0.5) MB ≈ 260 MB
written a day into a cache that Vercel's Hobby and Pro plans share across every project in the team,
with LRU eviction past "a fixed storage limit" (https://vercel.com/docs/data-cache, "Storage scope by
plan", "Storage and eviction"; the size is not stated there). Eviction turns a cache hit back into a
rebuild. Segments shrink the churn to the hot month's entry.

**Function time.** Each full rebuild holds a Vercel function for the store round trip plus the build
(§2.2: ~0.85 s+ through the Funnel today). 01f-platform owns the cost of that.

### 4.3 Security of the payloads (cross-user leakage paths)

The routes already refuse a request without a session (`library/route.ts:22`, `history/route.ts:16`)
and mark the bodies `private` so no shared cache stores them. Multi-user adds these rules for the search
path, each with the test that proves it:

1. **The user comes from the session, never from the request.** A per-user path or query segment for
   the HTTP cache may exist, but the server reads the user id from `auth()` and either ignores or
   checks the segment. Test: a request for user B's segment with A's session returns A's data or 403,
   never B's.
2. **Every cache key that holds a payload carries the user id.** Test: in `tests/`, two users with
   equal version counters; build A's payload, then request B's; B's body has none of A's identities.
   This is the one that fails silently, because both bodies have the right shape.
3. **An ETag never matches across users.** Test: the same two users; B's request with A's ETag answers
   200 with B's body, never 304.
4. **Deltas are scoped.** Test: A and B play the same song in the same minute; each one's
   `refreshHistoryAction` delta contains only their own play (01a notes the `playKey` collision in
   `recordPlays` for exactly that case).
5. **A shared device forgets on sign-out.** Test (Playwright): sign in as A, load Home, sign out,
   confirm IndexedDB, `lb-days` and `lb-nowplaying` are empty and the next payload request has no
   `If-None-Match` from A.
6. **The ETag does not reveal the Spotify id** (01a D27: a keyed hash).

## 5. What keeps it fast per user: caching and incremental updates

### 5.1 The options, each with its mechanism and cost

Sizes as in 01-current-system: **S** = one place, **M** = a function's contract or a key changes with
callers to follow, **L** = a design change.

**O1. Per-user keys, markers, ETags and browser stores (§4.1). M. Required.** It makes multi-user
correct and does nothing for size or growth.

**O2. Move the catalog rows out of the history body into an immutable third body. M.** The catalog rows
never change after `scripts/backfill-scan.mjs` writes them, so they can sit behind their own version
(bumped only by that script) and a long-lived browser copy. **[measured]** Effect today: the volatile
history body drops from 1,791,126 to 774,035 B (§2.1), its data-cache item from 86.6% to 37.1%, and
the next crossing moves from ~late December 2026 to ~10.7 months out at the current slope (§3.1).
`buildDays` loses 35% of its plays. It does not stop the history growing ~123 KB a month, and it
leaves every visit after listening re-downloading the rest.

**O3. Split the history into monthly segments behind a manifest. L.** One body per (user, UTC month),
plus the catalog as its own segment; each self-contained in today's tuple format. A small manifest
(`[segment, version, plays]`, a few hundred bytes for years of history) tells the client which ones
moved. A segment's URL carries its version, so the browser keeps it with
`Cache-Control: private, max-age=31536000, immutable` and never asks again, and the server builds it
once per version from an index range on `(user_id, played_at)`.

**[measured]** The owner's history split this way:

| segment | plays | raw | gzip |
|---|---|---|---|
| 2026-06 | 3,459 | 303,184 B | 112,436 B |
| 2026-07 | 2,879 | 246,175 B | 92,014 B |
| 2026-08 | 3,632 | 291,369 B | 106,716 B |
| 2026-09 | 2,692 | 220,230 B | 81,484 B |
| 2026-10 (to the 14th) | 1,367 | 126,902 B | 47,372 B |
| catalog | 7,529 | 1,046,987 B | 357,537 B |
| all segments | 21,559 | 2,235,069 B (+24.8%) | 797,780 B (+29.8%) |
| one body (today) | 21,559 | 1,791,134 B | 614,713 B |

A cold visit pays ~30% more bytes because each segment interns its own art and album strings. A
visit after listening pays only the hot month: 47 KB gzipped mid-month and ~110 KB at month's end,
against 615 KB today. A rebuild reads ~3 rows × the month's plays, ~10,000 at most for the owner,
against ~65,000. No segment of a normal listener comes near 2 MiB (a 100-plays-a-day month is
~300 KB); an import produces many bounded months, and the catalog segment splits by size if it ever
grows.

The hard part is the version of a closed month. Old rows do change: `ctx_orphan` flips when a
playlist's membership changes (`recomputeOrphanFlags`, `db.ts:724-751`), a context name resolves
weeks later (`contexts`, GOTCHAS "Dead playback contexts"), a track is re-tagged, the backstop replay
and history imports insert into past days, and an out-of-order insert re-opens its neighbours' skip
verdicts (`db.ts:770-822`). Two ways to version it:

- **Per-month counters bumped by the writes that touch the month.** Every one of those writes can
  name its months cheaply: inserts carry `played_at`; the orphan pass can `UPDATE … RETURNING
  played_at`; a context or track change can read its plays' months through `idx_plays_context` /
  `idx_plays_track`. Correct and fine-grained; it adds a step to five write paths, and a missed bump
  serves a stale month for as long as the browser keeps it (the same failure class as a missed
  `write_seq` bump, `db.ts:337-340`).
- **Immutable facts plus small mutable dictionaries.** Segments carry only what cannot change — the
  identity, the minute, the context's index — and the mutable parts (context names, orphan flags,
  re-tagged strings) ride in a small per-user dictionary that versions on its own. Closed months
  then never change except by insert, but the payload format and the client merge change more.

I lean to the per-month counters: they keep today's tuple format and the client merge, and each bump
site has a known-answer test in `tests/` (write to an old month → that month's version moves, no
other does).

**O4. Fetch only what changed since the last visit (a cursor delta). S-M, needs O5.**
`refreshHistoryAction` already returns the plays newer than the minute the client holds
(`history-actions.ts:122-161`) and the client already merges them (`history-patch.ts`). Run the same
read as a scoped GET when Home mounts, with the cursor taken from the stored copy, and a repeat visit
moves ~150 store rows and a few KB instead of a whole body. Non-append changes still need O3's
versions (or a full reload) to reach the client.

**O5. Paint search from IndexedDB before the network (STORE_MIGRATION phase E). M, already planned
(lanes 1905-1906).** **[measured, browser]** Reading today's two bodies back as stored objects takes
18-20 ms at 4× and ~30 ms at 6× (5.5 ms at 1×); stored as text it is 12 ms to read plus 16 ms to parse
at 4×. That is from the Mac's SSD with a warm OS cache, so a phone's storage adds an unknown amount.
Today, phase E's 300 ms budget (R3) is mostly spent by `buildDays` (199 ms at 4×), not by
IndexedDB.

**O6. Cheaper client work. S-M each, independent of multi-user.**
- *Lazy days.* Plays arrive sorted newest-first, so each local day is one contiguous run of the
  `plays` array. Find a day's run by binary search on the minute bounds and build that day's rows
  when it is selected (~100 rows), instead of every day's rows up front. That removes ~75% of today's
  client work (199 of 264 ms at 4×) and makes the rest independent of history length.
  `history-days.ts` is pure and already known-answer tested against `getPlaysByDay`
  (`history-days.ts:1-5`, `den-home.tsx:239-246`), so the change has a ready check.
- *A worker.* Parse and `buildEntries` (~65 ms at 4× today; ~0.2 s at the 3-year heavy size, scaled
  from the 4× synthetic runs) can run in a Web Worker, with keystrokes answered there and the ≤ 400
  results posted back. That only pays once lazy days are in and the sizes are past the typical user's.
- *Render fewer rows per keystroke.* Matching is 10.5 ms at 4× for a one-letter query (§2.3); the
  desktop keystroke-to-paint is 18-44 ms, so rendering 400 complete rows is the larger share. Painting
  the first screenful and the rest on scroll is the lever for the 50 ms keystroke target on a phone.
  Not measured on a device.

**O7. The library half per playlist. M-L. Later.** For a repeat visit, the client sends the
`(playlist, snapshot_id)` pairs it holds and the server returns only the playlists whose snapshot moved
(Spotify's `snapshot_id` already gates the track cache, GOTCHAS "Playlist detail pages"). A cold visit
keeps one body, chunked by playlist below 2 MiB for libraries past ~12,000 identities (75% of the
limit). Worth it before 250 users (§4.2's last column assumes it). For the owner it depends on why
`library_seq` moves several times a day (§8).

**Not recommended.** Materializing each user's payload into the store on the write path, as
`home_payload` does: it moves the build off the request, but every rebuild still scans the user's
plays, stores multi-MB rows, and does nothing about the 2 MiB limit. Server-side search per
keystroke: even indexed (SQLite FTS5), each keystroke pays a round trip (STORE_MIGRATION's R1 target is
p50 ≤ 15 ms to the store, plus the request to Vercel) and the box gives up the instant answer it has
today.

### 5.2 Recommendation and order of work

1. **Now, single-user, before late December: O6 lazy days, and O3 with the catalog as its own segment**
   — or **O2** as the stopgap if O3 cannot land by mid-December. The 2 MiB cliff hits the owner whether
   or not anyone else ever signs in, and O3 is also the change that makes per-user rebuilds affordable
   (§4.2).
2. **With multi-user, blocking the second account: O1** and the six tests in §4.3.
3. **STORE_MIGRATION phase E (O5), keyed by user and shape, storing segments rather than whole bodies,
   plus O4's visit-start delta.** If phase E ships first with whole bodies, its store interface should
   take `(user, kind, segment, version)` so segments drop in without a second migration of browser
   data.
4. **O7 and the worker** when a user's library passes ~12,000 identities or the phone budget below
   fails on a real device.

**Budget against the design targets [estimate, from §2.3 and above, 4× CPU as "a phone"]:**

| step | repeat visit, owner today | first visit, typical 1-yr user |
|---|---|---|
| payload source | IndexedDB, ~20 ms | manifest: 1 round trip; library ~350 KB + history segments ~350 KB gzipped, in parallel: ~0.6 s at 10 Mbit/s, ~3.5 s at 1.6 Mbit/s |
| server | none on the critical path; manifest + delta after paint | each segment built once from an index range (~4,500 rows), then cached |
| parse + search set | no parse (stored objects) + `buildEntries` ~47 ms | ~50 ms |
| days | lazy: < 5 ms per day selected | the same |
| search usable after the effect runs | **~80 ms** (R3: ≤ 300 ms) | **~1.0-1.4 s** at 10 Mbit/s, **~4 s** on slow 4G |
| one-letter keystroke | 10.5 ms matching + rendering | ~7 ms matching + rendering |

The first-visit target of 2 s on a phone holds on a normal mobile connection and misses on slow 4G for
anything above a light user (a light user's ~250 KB lands in ~1.8 s there). Today the client waits
for both halves (`den-home.tsx:620`); letting the history half build the days and the played songs
before the library lands would make the first visit usable sooner without moving fewer bytes. That is set by compressed bytes, so the remaining lever is fewer of them
on a cold visit, for example one art and album dictionary shared by all of a user's segments instead
of one per segment (the 30% overhead above). Stripping the `https://i.scdn.co/image/` prefix is not
that lever: it was measured at −16% raw but −1% gzip (`db.ts:1428-1431`), so it helps the 2 MiB and
4.5 MB limits and not the download. Whether slow 4G is in the target is for the design lanes to set.

## 6. What multi-user needs from STORE_MIGRATION.md

Nothing in the planned move has to change for search before it runs. Five points for the lanes that
carry it and for the multi-user design:

1. **The move brings billed rows back, and search rebuilds are the term that grows with users.**
   Turso's free plan counts rows read (500M a month, STORE_MIGRATION §3). One user's full rebuilds
   are small (~80,000 rows per visit that moved both versions, 1-2 such visits a day lately). Per
   user and per visit they are what §4.2 multiplies: ~380M a month at 25 typical users under today's
   design. Multi-user on the free plan needs O3/O4 before it passes about five active users.
2. **Schema.** The migration copies the single-user tables as they are, which is right: adding
   `user_id` afterwards is an `ALTER TABLE` plus a backfill of ~22,000 `plays` rows (~0.2% of the free
   plan's 10M monthly writes) and index builds. Search needs `plays (user_id, played_at)` for the
   payload, the segment ranges and the deltas, and the library's three tables reachable by user. If
   the index does not lead with `user_id`, a per-user rebuild reads every user's plays: N× §4.2.
3. **Phase E (lanes 1905-1906).** It already keys the IndexedDB copy by user id and payload shape.
   Two additions: give its store interface a `(user, kind, segment, version)` key now, so segments do
   not need a second migration of browser data; and count `buildDays` in R3's budget, since at 4× it
   is 199 of the 300 ms (§2.3, O5) — lazy days (O6) belong with phase E or before it.
4. **R4's attribution.** §3 of STORE_MIGRATION sizes Turso headroom on "the history payload's plays scan
   (~50,500 rows read per run)", 23 runs on Oct 13. The ledger records no search payload rebuild that
   day, and the description fits the all-time recompute (§2.2). The headroom arithmetic still
   holds whichever query it is; what changes is which query 1910-1911 or a follow-up should target,
   and the all-time recompute is also a per-user, per-landed-sync scan under multi-user (01a D18,
   01c). Check the meter log's SQL text before relying on it.
5. **The 2 MiB cliff does not depend on the store.** It arrives around late December on the Zenbook or
   on Turso. On Turso, an uncached history payload bills ~65,000 rows per Home open, ~20M a month at
   10 opens a day for the owner alone [estimate], and each open waits for a full build (~850 ms
   through the Funnel today by §2.2's estimate; not measured on Turso).

The phase A bench route's `getHistoryIndex(null)` ×2 (STORE_MIGRATION §6 item 5) will give the first
production-path timing of the full history build on Turso, which this document does not have (§8).

## 7. Decisions that are Rem's

1. **Fix the 2 MiB cliff before late December, single-user, by doing monthly segments (O3) now?**
   Recommendation: yes. It is needed for multi-user anyway, and the alternative is the O2 stopgap
   followed by O3 later — two changes to the payload format and two browser-cache transitions instead
   of one. The cost is priority against other work; if O3 cannot be scheduled by mid-December, ship
   O2 by then.
2. **Do friends get the history import and the catalog backfill?** Recommendation: not until segments
   exist. A five-year import is a ~4.2 MB history body (§3.3), over the cache limit on day one and near
   Vercel's 4.5 MB response cap, and it makes every first visit on a new device a multi-MB download.
3. **Which phone and which network the search target is for.** Recommendation: a mid-tier Android
   (the 4× rows) on a normal mobile connection, with slow 4G a stated miss for first visits by heavy
   users (§5.2). Including slow 4G is possible but buys a cold-visit byte project (shared
   dictionaries) that nothing else needs.
4. **A limit on library size for other accounts.** Recommendation: no hard limit; per-playlist
   chunks (O7) before anyone's library passes ~12,000 songs. A hard cap would be a product rule
   enforced only to protect a cache size.

## 8. Unknowns and what I did not measure

- **Production build time today.** A full scan is not a cheap read, so I ran none against the Zenbook
  or Turso. §2.2's ~850 ms is a row-scaled estimate from Aug 22. STORE_MIGRATION's bench route will
  measure it on Turso.
- **Real phones.** Every phone figure is Chrome's CPU throttling on the Mac, which models neither a
  phone's memory, its storage I/O (IndexedDB reads were measured on the Mac's SSD), nor its thermal
  limits. Rendering per keystroke was not measured anywhere in this lane.
- **Who opened Home on what.** `client_metrics` records no user agent, so the RUM split by device is
  unknown, and only seven Home views are recorded since Sep 14. Whether Home use fell in
  Sep-Oct or recording stopped is not established; the `/api/metrics` path was not checked.
- **Compression on Vercel's edge** for these two routes (gzip or brotli) was not checked; §2.1 gives
  both.
- **The 304 rate.** Nothing counts 304s. §2.2's "each visit hours apart re-downloads both" comes from
  how often the versions move and from the ledger's one-rebuild-per-visit pattern, not from a count.
- **Why `library_seq` moves several times a day.** It stands at 603. The ledger averages 1.9-2.8
  playlist-list rewrites (`playlist_rewrite`, `storePlaylists`' delete-and-reinsert branch,
  `db.ts:1762-1800`) and 2.4-3.4 unique-song recomputes a day over the days they ran in Sep-Oct (3-5
  and 2-7 on Oct 12-14). Each list rewrite moves the version and costs every browser a full library
  download. Whether those rewrites reflect real changes was not traced.
- **Which statement the meter counted at ~50,500 rows** on Oct 13 (§2.2, §6 item 4): the meter log is
  on the Zenbook and was not read.
- **Vercel Data Cache size and eviction.** The docs state LRU eviction at "a fixed storage limit" shared
  by every project in a Hobby or Pro team, without the size. 01f-platform owns the plan.
- **The projection profiles in §3.3 and §4.2** (plays a day, library size, visits a day) are
  assumptions about people who have not signed up.
- **The 2 MiB check counts UTF-16 code units of the cache wrapper**, which for these bodies came out
  1.3% (history) and 2.1% (library) above their UTF-8 bytes. A library heavier in CJK titles would sit lower per byte;
  measured on the owner's mix only.

## Appendix: commands run

Nothing ran against the Zenbook store, Turso, Vercel or Spotify. Scratch directory
`S=~/.claude/broke/scratch/lazyboy_mu/0221_search` (mode 700); scripts in `$S/bin`.

1. Backup copy: `rclone copy onedrive-backup:lazyboy-db/lazyboy-20261014-0840.db.gz $S/dl/`,
   `gunzip -k`, `cp` to `$S/db/work.db`; `sqlite3 work.db "PRAGMA integrity_check"` → ok; table counts
   with `SELECT count(*)` and the month and context-type breakdowns of §2 and §3.1.
2. Real-user timings: `python3 -I $S/bin/rum.py work.db` and `… work.db 2026-09-14` (reads
   `client_metrics` for `/home`, groups by the `pv:` tag); page views and TTFB rows per month with
   `sqlite3`.
3. Payload sizes, local build times, Node-side client timings at 1-8× scale:
   `node --expose-gc $S/bin/measure.mjs work.db`.
4. Data-cache item sizes: `node $S/bin/itemsize.mjs work.db`; growth at monthly cutoffs:
   `node $S/bin/growth.mjs work.db`; monthly segments: `node $S/bin/segments.mjs work.db`.
5. Browser: `node $S/bin/bodies.mjs work.db $S/bodies` (bodies at 1/2/4/8× and the type-stripped
   `han-fold.ts` + `history-days.ts`), then `node $S/bin/browser.mjs $S/bodies` (Chromium 145 headless
   via `playwright-core` 1.58.0 from `~/projects/handy/node_modules`, CDP
   `Emulation.setCPUThrottlingRate` 1/4/6, three fresh pages per cell) and
   `node $S/bin/idb.mjs $S/bodies 1` (IndexedDB read-back).
6. Ledger and markers: `sqlite3 work.db` over `usage_ledger` (`history_payload`, `library_payload`,
   `playlist_rewrite`, `unique_song_count`, all readers for Oct 12-14) and `meta` (`library_seq`,
   `write_seq`, `slow_seq_pub`).
7. Next's cache limit: `npm pack next@16.2.6` into `$S/next`, read
   `dist/server/lib/incremental-cache/index.js:35-75, 455-500` and
   `dist/server/web/spec-extension/unstable-cache.js:1-60, 160-260`.
8. Vercel docs: `curl -sL https://vercel.com/docs/functions/limitations` and
   `https://vercel.com/docs/data-cache`, text extracted and searched for the quoted lines.
9. Code: `grep` over `src/` for every caller of the payload functions, `fuzzyFilter`, `hanFold`,
   `localStorage`/`sessionStorage`, and `git diff --stat 1c7aabb HEAD -- src` (empty).

The backup copy (it holds the Spotify token row), the payload bodies, the Next package and the fetched
pages were deleted from `$S` after the measurements; the scripts were kept so each number can be
re-run against a newer backup.
