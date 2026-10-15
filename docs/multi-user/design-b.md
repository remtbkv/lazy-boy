# Design B — multi-user lazyboy, performance and scale first

Lane 0222_lb_mu_design_b, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. One of three independent designs; this one starts from performance and scale: search
stays instant and sync stays fresh at 250 users on the cheapest store that holds, with the arithmetic
for every budget. Built on the six overviews (`01a-data.md` to `01f-platform.md`), cited as 01a §n
and so on; code line numbers are against `ac6f7fe` (no file under `src/`, `scripts/`, `ops/` or
`tests/` changed since). Every number is labelled **[measured]** with its source, or **[estimate]**
with the arithmetic.

Status: complete, 2026-10-14.

## 0. Summary

- **Targets, refined (§1).** Five users, because Spotify's development mode allows five per app and
  extended quota is closed to individuals; 250 stays as the sizing point for everything Spotify does
  not control. Search: first visit ≤ 2 s and repeat ≤ 300 ms after first paint, keystroke ≤ 50 ms, on a
  4×-throttled CPU at 10 Mbit/s. Freshness split in two: what any screen shows is always within 2
  minutes; what the store holds with the app closed is within 2 minutes for up to two heavy listeners
  and ~10 at five, if the quota is shared as Spotify documents. Per heavy user a day: ≤ 100,000 rows
  read, ≤ 2,500 written, ≤ 50 KB stored. No machine in Rem's apartment on a request path or as the only
  capture trigger.
- **The rule: a user's recurring cost follows what changed, never what is stored (§2).** Today Rem's
  store reads 4.25M rows a day, half of it one full `plays` scan repeated 44 times (§3). With this
  design ~75,000 [estimate], about 60% of that the nightly backup (§10.2).
- **How (§4-§9).** A Turso database per user plus an app database; listened time stored per play and
  the all-time totals kept as an accumulator; the Home payload patched in place; history as monthly
  segments stored in the user's database and appended to on write, which also removes the 2 MiB cache
  cliff the owner hits in late December; the library body patched per playlist; the "From" verdict
  rewritten to probe the song's identity through two existing indexes instead of walking the
  playlist, a cost the store meter cannot see (§10.1); a one-minute tick with a quota governor; two
  independent pingers.
- **Results [estimates].** A landed play costs ~20 rows read and 3 round trips, against ~7,700 rows
  (59,000 with the all-time scan) and ~30 round trips today. Search is usable ~1.4 s after first paint
  on Rem's first visit, ~80 ms on a repeat visit; a keystroke paints in ~25-35 ms.
- **Store.** Turso's free plan holds five users under 5% of its reads, writes and storage, and 25 under
  16%; 250 need
  the Developer plan, $4.99-5.99 a month (§10.3). At 250 it is Spotify that fails: its five-user cap,
  a shared recently-played budget that cannot keep 250 users complete, and a 30-second rate limit their
  probes alone exceed.
- **Misses (§17):** 25 and 250 users on one app; a heavy three-year user's first visit (~2.6 s); slow
  4G; 2-minute closed-app freshness for five heavy listeners under a shared quota. Each has its options
  and their costs.
- **STORE_MIGRATION: run it as planned (§11).** Six small edits, none blocking: correct §3's
  attribution of the dominant read, key phase E's browser copy per segment, loop the backup over
  databases and strip token rows, consider the identity index in lanes 1910-1911, give R4 a growth
  term, flip Production only.
- **Rollout (§15):** single-user performance first (it pays off for Rem alone, and its segment step must
  ship before mid-December), then identity, then the multi-user plumbing with its two-user tests, then
  one friend, then up to five. **Rem's decisions** are in §18.

## 1. Targets, as briefed and as refined

Each target below gives the brief's wording, what the overviews force it to become, today's value,
and the instrument that checks it. §17 scores the design against each.

**T1 — Users.** Briefed: 25 under Spotify's development mode, with the path to more. Refined: **five
accounts on the one Spotify app, Rem included.** Spotify's quota-modes page says "Up to 5
authenticated Spotify users can use an app that is in development mode" (quoted in 01f §1.2, 01c §4,
01e §5.4); extended quota mode takes only organizations with "at least 250k MAUs" (01f §1.3); and
spreading users over several Client IDs breaks the Developer Terms' one-Security-Code rule and buys no
quota, because development-mode quota is "counted per developer account" (01f §1.3, 01c §4). So 25 and
250 cannot be served from this app. The brief for this design still asks for 250, and I keep it as
the sizing point for everything Spotify does not control (store, Vercel, the scheduler, the payloads):
if the cap ever lifts (a grandfathered list on the dashboard, a policy change), Spotify should be the
only thing that binds. §10 carries every budget at 5, 25 and 250. The path past five on today's
policy is each person running their own copy (01f §5.2, option E); the per-user work in this design
speeds those copies up too, since a one-user copy runs the same code. Today: one account (the owner
guard, `src/lib/owner.ts:10-14`). Checked by: the dashboard's User Management list, which also says
whether the owner counts toward the five (01f §1.2, unverified).

**T2 — Search.** Briefed: first payload under 2 s on a phone, keystroke filtering under 50 ms.
Refined, using 01d's definitions (01d §2.3, §5.2, decision 3):

- *A phone* is Chrome on the Mac with the CPU throttled 4× (Lighthouse's stand-in for a mid-tier
  Android, the setting 01d measured at) on a 10 Mbit/s connection. Slow 4G (1.6 Mbit/s) is a stated
  miss for first visits above a light user (§17) unless Rem decides otherwise.
- *First payload* is Home's first paint to search usable over the user's whole library and history
  (`lb:history-ready`), on a first visit with an empty browser cache: **≤ 2 s**. A repeat visit:
  **≤ 300 ms** (STORE_MIGRATION R3).
- *Keystroke* is keystroke to results painted: **≤ 50 ms at 4×** for search sets up to ~30,000
  entries, about twice Rem's today. Past that size the design names the lever (§9) rather than
  promising the number.

Today [measured, 01d §2.3]: real users waited a median 4.0 s (p90 8.7 s) between the page's rows and
search being ready (130 of 135 hard loads from August); the client spends 264 ms at 4× parsing and
building, 199 ms of it materializing every day of history; matching a one-letter query is 10.5 ms at
4×, and the app's own keystroke-to-paint was 43.8 ms median on a desktop (dev build, 2026-08-05).
Checked by: `lb-perf` and the client metrics' `history-ready` mark, plus 01d §2.3's throttled-browser
harness re-run on the new bodies.

**T3 — Freshness.** Briefed: history within about 2 minutes for an active user. Refined into two
numbers, because the quota cannot buy the second one for five heavy listeners:

- *Observed freshness*: any Home view, on any device, shows every play that ended more than 2
  minutes before the view opened, and every play that ends while it is open. **Target: always.**
- *Stored freshness*: with the app closed, how long until a finished play is in the store. **Target:
  ≤ 2 minutes while Spotify's shared budget allows it** (one or two Rem-like users), **≤ 10 minutes at
  five Rem-like users** if the recently-played quota belongs to the developer account, as Spotify's
  docs say (01c §4).
- *Completeness* is a floor: no play is lost while either pinger runs, because every
  user is harvested before 25 tracks pile up, half of recently-played's 50 (GOTCHAS "`recently-played`
  only returns the last 50 plays").

Why split: 2-minute stored freshness for five Rem-like users costs ~750-850 recently-played calls a day
(01c §5.1, policy i) against a budget measured at ~725-800 for the whole app in August (01f §1.4), and
nobody sees stored freshness while the app is closed. Today [code]: a play reaches the store within
one 2-minute tick while something plays (`src/app/api/cron/sync/route.ts:121-146`). Checked by: the
harvest records each landed play's lag (`now − played_at`) in the user's sync state (§7), and /usage
shows its p50/p95 per user.

**T4 — Store cost per user per day.** Briefed: the store's reads and growth per user per day, with no
number. Refined, for a user who listens like Rem at today's history (22,040 plays, 01a §6):

- **reads ≤ 100,000 rows a day**, with no term on the request or sync path that grows with the
  user's stored history (only the nightly backup and rare repair events read whole tables);
- **writes ≤ 2,500 rows a day**; **storage growth ≤ 50 KB a day**.

These put five users under 5% of Turso's free reads, writes and storage, and 250 users on a plan under
$10 a month (§10). Today [measured, the store meter, 01c §2.7]: 4,252,260 rows read on Oct 14, 53% of
it one full `plays` scan repeated 44 times; 13,480 rows written, ~3,000 of them core; core data grows
~35 KB a day (01a §6). Checked by: Turso's per-database usage endpoint, which returns `rows_read`,
`rows_written`, `storage_bytes` and `bytes_synced` for one database over a window
(https://docs.turso.tech/api-reference/databases/usage, fetched 2026-10-14). With a database per user
(§4) that is each user's exact cost, and the daily route records it.

**T5 — Uptime.** Briefed: with the Zenbook's single point of failure addressed. Refined: **no machine
in Rem's apartment sits on any user's request path, and none is the only trigger of closed-app
capture**; a Zenbook outage of any length loses no page and no play; one user's failure (a revoked
token, removal from the allowlist, a Spotify error) costs that user's slot and nothing else. Turso and
Vercel remain single providers, accepted, with the quota block turned into a bill (§12). Today: every
authenticated page and the 2-minute pinger run through the Zenbook (01f §3.2). Checked by:
STORE_MIGRATION's R2 fault injection, repeated with the Zenbook's pinger stopped.

**T6 — Isolation.** Not in the brief's list, but Rem's first words were "keep it all secure": **no
request, cache entry, browser store or background job returns or changes another user's data.**
Checked by: the two-user test suite in §6, which has to fail on purpose before it is trusted.

## 2. The design on one page

**The rule: every recurring cost of a user is proportional to what changed (a new play, an edited
playlist), never to what that user has stored.** A full scan survives only inside a bounded scope (one
month of one user's plays, one playlist's members), in a rare repair event, or in the nightly backup.
Today the opposite holds: the dominant reads re-scan a user's whole history on every listening
session or every visit (§3), so cost grows with N × history × activity, and the owner alone is ~10
weeks from the history payload's 2 MiB cache cliff (01d §3.2). Five mechanisms carry the rule:

1. **A database per user, plus one app database** (Turso, one group, one group token). The app
   database holds users, encrypted tokens, invites, the sync queue and the quota ledger; each user's
   database holds today's seven core tables unchanged plus a `payloads` table. A statement can only
   see the database it was sent to, Turso reports usage per database, and Rem's data stays in the
   `lazyboy` database STORE_MIGRATION creates (§4, §11).
2. **Derived data maintained by append on the write path.** Each play stores its listened time beside
   its skip verdict; the all-time totals become an accumulator; the Home payload is patched in place;
   history payloads become monthly segments stored in the user's database, the current month appended
   to on every landed harvest; the library body is patched per changed playlist. A page visit reads
   rows and never scans (§8).
3. **A one-minute tick with a global lock, per-user state and a quota governor.** Freshness signals
   come from the player probe, a bucket Spotify has never rationed here; recently-played harvests are
   rationed across users inside the developer account's daily budget; one user's failure stays in that
   user's slot (§7).
4. **Search from the browser's own copy**: segments under versioned, immutable URLs, kept in IndexedDB
   per user and segment (STORE_MIGRATION phase E, with a finer key), day lists built on demand, and a
   virtualized result list (§9).
5. **Two independent pingers** (the Zenbook's timer and cron-job.org) behind the tick lock, so
   closed-app capture survives either one (§12).

```
browser ─► Vercel functions (iad1)
             ├─ app DB, Turso `lazyboy-app`: users · user_tokens (AES-256-GCM) · invites ·
             │        sync_state (probe and harvest state) · quota_ledger · meta (global, tick lock)
             ├─ user DBs, Turso, one per user, same group (Rem's is `lazyboy`):
             │        tracks · plays (+listened_ms) · contexts · playlists (+snapshot_id) ·
             │        playlist_tracks · saved_tracks · meta · payloads (segments, library, home)
             └─ telemetry, Zenbook sqld via the Funnel, best effort, never awaited:
                      api_log · client_metrics · usage_ledger, each with a nullable uid
pingers: Zenbook timer (even minutes) + cron-job.org (odd minutes) ─► /api/cron/sync, one tick lock
Zenbook: telemetry · the owner's recorder (hourly) · nightly per-database backups, which also
         recompute every derived value from the dump and flag drift
```

It replaces, in order of what it saves: the all-time full scan after every listening session; the
Home payload's 16-day re-read per landed play; the history payload's full rebuild per visit, and with
it the 2 MiB cliff; the whole-history day strip re-read on Home mount; the unique-song and library
rebuilds per library change; the rescan's 110 serial snapshot reads; the daily contexts full pass; the
second Spotify call on every idle tick; and a recently-played harvest on every playing tick.

## 3. Where one user's cost goes today

Rem's day, UTC Oct 14 [measured by the store meter, 01c §2]: 4,252,260 rows read, 13,480 written, 716
cron ticks, 129 plays landed. Home was barely opened that day, so the two terms that scale with visits
(rows 3 and 4) are near zero for Rem and would not be for a friend who keeps the app open.

| # | term | trigger and cadence | rows read per run | rows that day | grows with | replaced by |
|---|---|---|---|---|---|---|
| 1 | all-time recompute: `orderedRealPlays` full scan + a `tracks` probe per row (`db.ts:854-869`) | after a landed harvest, at most every 10 min (`db.ts:577-583`), app open or not | ~51,000 | 2,244,004 (53%), 44 runs | stored plays: ~2.3 rows per play per run, so +~12,000 rows a day per day (01c §5.9) | accumulator over stored `listened_ms` (§8) |
| 2 | Home payload rebuild: 16-day strip + the opening day (`db.ts:1315-1343`) | every landed harvest | ~7,500 | 954,265 (22%), 127 runs | plays per 16 days | patched in place from the harvest in hand (§8) |
| 3 | history payload rebuild (`db.ts:1686-1730`) | a browser fetch after the slow marker moved | ~79,000 | 78,781, 1 run; ceiling 144 × 79,000 ≈ 11M with Home open all day (01c §6) | stored plays; hits the 2 MiB Data Cache limit in late December (01d §3.2) | monthly segments in the store, current month appended on write (§8, §9) |
| 4 | whole-history day strip, `dailyStatsAction(100000)` prefetched on every Home mount (`den-home.tsx:374-384`), cached on `write_seq`, so the first mount after any landed play re-reads every real play | Home mounts after listening | ~43,500 [estimate: 14,511 real plays × ~3 rows for a `plays JOIN tracks`, READ_QUOTA "Measured reads"] | ~0 (no mounts) | stored plays × visits | built in the browser from segments that carry listened seconds (§9) |
| 5 | unscoped orphan pass (`db.ts:724-751`) | the library's playlist id set moved, ~3 a week (3 on Oct 14) | ~5,100,000 as Turso counts it (01c §2.8) | 394,820 as the meter counted 3 runs | plays × members | the rewritten predicate, ~0.1-0.2M a full pass [estimate], and lanes 1910-1911 scope it (§10.1) |
| 6 | unique-song count (`db.ts:1969-1991`) | a library sync that changed anything; the daily Liked refetch always counts as a change (`sync/library.ts:81-84`) | ~39,000 | ~160,000, 4 runs | library members | counted inside the library body's build and patch (§8) |
| 7 | library payload rebuild (`db.ts:1625-1684`) | a fetch after `library_seq` moved, which every list rewrite does | ~15,000 | 0-2 runs a day (ledger, 01d §2.2) | members | patched per changed playlist (§8) |
| 8 | library rescan's snapshot reads (`sync/library.ts:65-66`) | every rescan, ~30 a day | ~110 serial one-key reads | ~3,500 round trips | owned playlists | one statement over a `snapshot_id` column (§7) |
| 9 | daily contexts pass, `unresolvedContextUris` (`db.ts:646-667`) | once a day | ~43,000 [estimate: ~2 rows per contexted play, READ_QUOTA "Attribution": 14.1K at 7,194 plays] | one run | stored plays | a scan of the 114-row `contexts` table (§8) |
| 10 | harvest that lands nothing (`db.ts:480-496`, `unseenContexts`) | 155 a day | ~215 | ~33,000 | – | diff against the previous batch's keys in sync state: 0 user-DB rows (§7.4) |
| 11 | idle tick: token, two gate stamps | 436 a day | ~3 | ~1,300 | – | one batch read of every user's state per tick (§7.2) |
| 12 | orphan verdict for new plays | every landed harvest | ~130 | 16,528 | one playlist's size | kept: bounded (§8) |
| 13 | nightly backup dump (STORE_MIGRATION phase D, after the cutover) | nightly | ~45,800 [estimate: the core row counts in 01a §2] | not yet running | every stored row | kept; an incremental form past 25 users (§10) |

Spotify, same user per day [measured, deduplicated `api_log`, 01c §2.7]: player probes 1,035-1,303,
recently-played 139-319 plus the recorder's 96, library ~127-175.

## 4. Data model: how every table and meta key gets a user

### 4.1 A database per user, chosen on performance grounds

01a §8.1 recommends a database per user for isolation, migration and deletion. I reach the same
model from the performance side; per query, the two models cost the same once a shared store has
user-led indexes (01a §9.2 measured a per-user history scan at 32-36 ms from 25 to 100 users with
them). What separates them at scale:

- **No statement can become O(all users).** In a shared store, any statement or index that forgets the
  user degrades silently from one user's rows to everyone's: 01a §9.2 measured the same scan at
  130-527 ms from 25 to 100 users without user-led indexes, ×4 for ×4 users, and at 250 it would be
  another ×2.5 [estimate, linear]. In a per-user database that failure mode does not exist; the
  worst a forgotten scope can do is read the right user's own rows.
- **Turso measures each user's cost.** It reports rows read, rows written and storage per database
  (§1, T4). In a shared store the per-user split would come from the ledger and
  `api_log`, which disagree by ~30% on the same events (01c §2.8).
- **Every statement and plan carries over unchanged**, so §8's changes are measured against today's
  plans and the 50-plus unscoped statements need no user predicate (01a §8.1: D4-D19 vanish).
- **Deletion and backups are per database** (§14).

What it costs: Turso's free plan allows 100 databases, so 98 users plus the app and template
databases (250 needs the Developer plan, which 250 users' writes need anyway, §10); one more warm
connection per active user per function instance (an in-region TLS handshake, a few milliseconds
[estimate]; undici keeps an idle connection ~4 s by default); a schema change is a loop over
databases (§4.6); cross-user features (the roadmap's friends) merge two reads in code; and `tracks`,
public catalog rows, is stored once per user (4.2 MB for Rem, ~1 GB at 250 such users, §10).

One group token reaches every database in the group ("a new token that can be used to connect to any
database in the group", https://docs.turso.tech/cli/group/tokens/create, fetched 2026-10-14), so the
runtime holds one store secret, as today. A user's database URL is derived from its name, and the
name rides the session cookie beside the uid (§5), so a request opens the user's database without a
lookup, in parallel with the app database's identity check. The name cannot be derived from the uid,
because Rem's database keeps the name `lazyboy` that STORE_MIGRATION gives it.

### 4.2 The app database (`lazyboy-app`)

```sql
CREATE TABLE users (
  uid            TEXT PRIMARY KEY,     -- random, 12 base32 chars: cache keys, URLs, ETags, DB names
  account_id     TEXT NOT NULL UNIQUE, -- Spotify account_id, the immutable link (01e §5.1)
  spotify_id     TEXT NOT NULL,        -- mutable; playlist ownership (replaces meta.me_id)
  db_name        TEXT NOT NULL UNIQUE, -- 'lazyboy' for Rem, 'lb-u-<uid>' for everyone else
  schema_version INTEGER NOT NULL,
  status         TEXT NOT NULL,        -- active | needs_reconnect | disabled | deleting
  is_admin       INTEGER NOT NULL DEFAULT 0,
  session_epoch  INTEGER NOT NULL DEFAULT 0,
  tz_zone        TEXT,                 -- IANA zone the browser reports; payloads bucket in it
  terms_accepted_at INTEGER,           -- privacy policy and end-user agreement (§14)
  created_at     INTEGER NOT NULL
);
CREATE TABLE user_tokens (             -- 01e §5.2, encrypted blob (§5)
  uid TEXT NOT NULL, env TEXT NOT NULL, blob TEXT NOT NULL,
  expires_at INTEGER NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (uid, env)
);
CREATE TABLE invites (                 -- what Rem can see before the person signs in (01e §5.4)
  spotify_id TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER
);
CREATE TABLE sync_state (              -- probe and harvest state; due times are computed (§7.2)
  uid TEXT PRIMARY KEY,
  state TEXT NOT NULL,                 -- active | idle | backoff | needs_reconnect | removed | paused
  harvest_lock_owner TEXT, harvest_lock_until INTEGER,  -- the per-user harvest lock (§7.7)
  last_probe_at INTEGER, last_track TEXT, last_progress_ms INTEGER, last_active_at INTEGER,
  changes_since_harvest INTEGER NOT NULL DEFAULT 0, last_harvest_at INTEGER,
  batch_keys TEXT,                     -- the previous harvest's 50 (played_at, track_id) keys, ~2.4 KB
  next_rescan_at INTEGER, last_rescan_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_ok_at INTEGER,
  lag_p50_s INTEGER, lag_p95_s INTEGER -- T3's instrument, rolled up by the daily route
);
CREATE TABLE quota_ledger (            -- Spotify calls per quota day and bucket (§7.4)
  quota_day TEXT NOT NULL, bucket TEXT NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY (quota_day, bucket)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- global keys only
```

### 4.3 Each user's database

Today's seven core tables, with two columns and one table added:

- `plays.listened_ms INTEGER`: the play's listened time, written with its skip verdict (both come
  from the same `min(gap, duration)`, `src/lib/skip-rule.ts:33-46`). Everything that sums listened
  time then sums a column instead of walking the gap chain (§8.1).
- `playlists.snapshot_id TEXT`: replaces the 110 `plsnap:<id>` meta rows, so a rescan compares every
  snapshot in the list probe it already makes (§7.6).
- `payloads (kind, key, version, shape, body, dirty, built_at, PRIMARY KEY (kind, key))`: the
  materialized bodies: `home` (today's `meta.home_payload`), `hist`/`<YYYY-MM>` per UTC month,
  `hist`/`catalog`, and `lib`. Each read is one row; each write is a compare-and-set on `version`
  (§8).

### 4.4 Every table and meta key, mapped

| today | goes to | change |
|---|---|---|
| `tracks` | user DB | none; public catalog rows, copied per user |
| `plays` | user DB | `+ listened_ms` |
| `contexts` | user DB | none; per user, so one account's 403 never hides a name from another (01a D25) |
| `playlists` | user DB | `+ snapshot_id` |
| `playlist_tracks` | user DB | none; the "From" predicate over it is rewritten (§10.1) |
| `saved_tracks` | user DB | none |
| `api_log` | telemetry (Zenbook) | `+ uid` (nullable), `+ reason` (the 429 body's `QUOTA_EXCEEDED` or not, 01c S4) |
| `client_metrics` | telemetry | `+ uid`; `handoff` beacons stop carrying song names (01a §10) |
| `usage_ledger` | telemetry | unchanged; per-user truth now comes from Turso's per-database usage |
| new: `users`, `user_tokens`, `invites`, `sync_state`, `quota_ledger` | app DB | §4.2 |
| new: `payloads` | user DB | §4.3 |

| `meta` key today (01a §3) | goes to |
|---|---|
| `spotify_tokens`, `spotify_tokens_dev` | app `user_tokens (uid, env)`, encrypted (§5) |
| `lock:spotify_refresh` | app `meta`, `lock:spotify_refresh:<uid>:<env>` |
| `lock:clean:<playlist>` | user `meta`, unchanged |
| `me_id` | dropped; `users.spotify_id` |
| `last_sync`, `player_last_active`, `rp_last_harvest` | app `sync_state` |
| `playlists_synced_at`, `library_synced_at`, `library_scan_attempt_at` | app `sync_state` (`last_rescan_at`, `next_rescan_at`) |
| `write_seq`, `library_seq` | user `meta`, unchanged (they still version the remaining cached reads and the library body) |
| `slow_seq_pub` | dropped: nothing rebuilds a whole payload on a visit any more |
| `home_payload` | user `payloads` (`home`) |
| `alltime_stats` | user `meta` `alltime`, now an accumulator (§8.1) |
| `alltime_at` | dropped (no throttled recompute) |
| `unique_song_count` | user `meta`, written by the library body's build and patch (§8.4) |
| `contexts_full_check_at` | user `meta` `contexts_checked_at` (a scan of `contexts`, §8.5) |
| `saved_synced_at`, `liked_total`, `liked_top_added_at`, `clean_backup_pref` | user `meta`, unchanged |
| `plsnap:<id>` (110 rows) | `playlists.snapshot_id` |
| `pltracks_at:<id>` (110 rows), `last_sync_added` | dropped (never read, 01a §3) |
| `user_tz_offset` | `users.tz_zone`; the offset is computed from the zone at build time (`zoneOffsetMinutes`, `db.ts:1286-1302`) |
| `spotify_cooldown_until` | app `meta`, split per bucket: `cooldown:<bucket>` (§7.5) |
| `played_at_convention` | app `meta` (a fact about Spotify, checked on the owner's plays) |

### 4.5 The user key

A random opaque `uid` (12 base32 characters, 60 bits) names the user everywhere the app can see it:
cache keys, payload URLs, ETags, IndexedDB keys, telemetry rows, database names. Spotify's
`account_id` is only the link, used at sign-in (01e §5.1). Two reasons: the uid carries no personal
data, so it can sit raw in an ETag or a URL that page scripts can read (01a D27 asked for a keyed hash
of the Spotify id for the same job); and Turso's dashboards, logs and database names never show an
account id. 01a §8.4's case for an INTEGER key (bytes per play) does not apply here, because no
per-user table carries the key.

### 4.6 Schema versions in place of `init()`

`init()` runs `CREATE TABLE IF NOT EXISTS`, four `PRAGMA table_info` reads and three `CREATE INDEX`
statements on every cold instance (`db.ts:153-297`), eight round trips; against N databases that is
eight round trips per database each instance touches, on the request path. Instead:

- Every database carries `meta.schema_version`, mirrored in `users.schema_version`. Code declares the
  version it needs and never runs DDL on a request; a user whose database is behind gets a short
  "updating" state, and nobody else notices.
- A new user's database is created from a template, `lb-template`, which holds the current schema and
  no rows: Turso's create-database call takes `seed: {type: "database", name}` (names: "lowercase
  letters, numbers, dashes. No longer than 64 characters",
  https://docs.turso.tech/api-reference/databases/create, fetched 2026-10-14). The provisioning
  script runs when Rem creates an invite (§14), so sign-in never waits on it and the platform token
  stays out of the Vercel runtime (01e §6).
- A migration is `scripts/migrate-dbs.mjs`: per user, set that user's sync state to `paused`, apply,
  verify, bump the version, resume. Additive changes only on live databases; anything that rebuilds a
  table runs on one user at a time behind a snapshot (Turso's point-in-time restore: 1 day on Free, 10
  on Developer, pricing page fetched 2026-10-14).

## 5. Tokens: per user, encrypted at rest

01e §5 specifies this part and I take it as written, with three changes that follow from the data
model and the round-trip budget.

**The session names the uid, and every request checks it in one statement.** At sign-in the jwt
callback finds the user by `profile.account_id` (refusing a profile without one, 01e §5.5) and puts
`uid`, `session_epoch` and `db` (the user's database name) on the token, taken from the users row
only. On every later request the callback runs one app-database statement through the request box:

```sql
SELECT u.status, u.session_epoch, u.db_name, u.schema_version, u.tz_zone, u.is_admin,
       t.blob, t.expires_at, s.state, s.last_harvest_at,
       (SELECT value FROM meta WHERE key = 'cooldown:recently-played') AS cooldown
FROM users u
LEFT JOIN user_tokens t ON t.uid = u.uid AND t.env = :env
LEFT JOIN sync_state  s ON s.uid = u.uid
WHERE u.uid = :uid
```

Primary-key probes only, ~4 rows read [estimate]. No `uid`, an unknown one, `disabled` or `deleting`,
a stale epoch, or a `db` that differs from `u.db_name` returns `null`, which ends the session; this one
rule closes F1 (01e §1, F1) and asks everyone to sign in once at rollout. `needs_reconnect` keeps a
session that can read its stored history but makes no Spotify call (01b §2.4's recommendation). The same row carries what Home's chrome and
capture banner need today from three separate reads (`home/page.tsx:78-83`: cooldown, capture health),
so identity costs no round trip that today's token read does not already pay. The page's user-database
reads start in parallel, from the `db` in the decoded cookie (encrypted under `AUTH_SECRET`, so only
the server can have written it), and nothing renders until both settle (01b S2).

**Ciphertext bound to the uid.** AES-256-GCM, Node's built-in `crypto`, a random 12-byte IV per write,
stored as `v1.<base64url(iv ‖ ciphertext ‖ tag)>`, associated data `lazyboy:tokens:<uid>:<env>`, keys in
`TOKEN_KEYS` as a Vercel Secret in Production only; rotation re-encrypts at each user's next refresh,
about hourly (01e §5.3). A blob copied into another user's row fails to authenticate. Cost: an AES-GCM
pass over a ~600-byte blob, microseconds [estimate], against a ~15 ms round trip at STORE_MIGRATION's
R1 target.

**Refresh is per user everywhere.** The lock is `lock:spotify_refresh:<uid>:<env>`; the in-flight
refresh is a map keyed the same way (01e A2: shared, it hands user A's tokens to user B); the request
box is keyed by uid; `clearTokensIfStale` compares within one row; the cookie-held-token paths go
(01e A18). The tick's state read (§7.2) joins `user_tokens`, so a tick reads every user's token in
one statement and refreshes only due users whose access token has under 60 s left.
Writes: ~24 refreshes a day per active user, each a lock acquire, a token write and a release, ~72
rows [01e §5.2, estimate]; 1,800 a day at 25 users, 18,000 at 250.

The token core moves out of `auth.ts` into a module the simulated environment can load, and 01e §5.2's
six known-answer tests come first (01e A21): concurrent refreshes for two users, A's lock not blocking
B, `invalid_grant` clearing one row, a moved ciphertext failing, the four ways a cookie is refused,
and no Spotify call for a user without a row.

## 6. Isolation, and the tests that prove it

**One way in.** `db.ts` stops exporting per-user functions that reach a module-level client. Each takes
a `UserDb` first: a branded type wrapping that user's libSQL client, minted only by `forUser()`,
whose uid and database name come from `requireUser()` (the verified session, §5) or from the tick's
state read (§7.2),
never from request input and never from an ambient "current user" (01e §5.1 explains why
AsyncLocalStorage is the wrong tool here). App-database and telemetry functions stay module-level. A
call site that forgets the user does not compile. The client cache (`g.__listenDbReady`,
`db.ts:133-146`) becomes a small map of clients by database name, capped (64 entries, least recently
used out) so a long-lived instance does not hold every user's connection.

**What a per-user database leaves open**, and the change for each:

| surface | today | change |
|---|---|---|
| Data Cache entries (`unstable_cache`) | 7, no user in any key (01a D26) | after §8-§9 five small ones remain: the playlist grid, and the server fallbacks for the day strip, one day (frozen and live) and the all-time list; each takes `uid` as its first **argument**, never through a closure, because Next 16.2.6 keys on the callback's source text, the key parts and `JSON.stringify(args)` (01b §3.1); each carries a `user:<uid>` tag so deletion can purge it |
| payload URLs and ETags | no user (01a D27) | the server reads the uid from the session only; a segment URL names a key and version, and a key the session's user lacks is a 404; ETags carry the uid |
| process memory | `inflightRefresh`, `playlistsCache`, `currentSyncId`, `uniqueRecomputeKickedAt`, three `cache()` boxes (01b §3.3-3.4) | the refresh map and boxes keyed by uid; `playlistsCache` keyed by uid or removed; one running library sync per uid; the unique-count kick goes (§8.4); the rate-limit cooldown stays app-wide by bucket, which is correct (§7.5) |
| tasks | no owner (01b B9) | an owner per task; `/api/tasks/[id]` answers 404 to anyone else |
| browser storage | `lb-days`, `lb-nowplaying`, `clean:active`, the HTTP cache, the planned IndexedDB copy (01b §3.6) | stamped with the uid, cleared on sign-out by a client hook before the redirect and on any 401 |
| operator surfaces | `/usage` for any session (01b B8) | admin only (`users.is_admin`, bootstrapped from `SPOTIFY_OWNER_ID`) |
| Preview deployments and dev | production store variables (01b E4, 01e §5.9) | Preview gets none; dev gets its own app and user databases copied from production |

**The tests** (vitest, the simulated environment in `tests/`):

1. A two-user fixture: an app database file and one file per user, seeded with deliberately colliding
   data (the same track at the same `played_at`, the same playlist id, one context URI named for A and
   negative-cached for B, 01a §8.7) and a marker string per user in every table.
2. A faithful `unstable_cache` stub, keyed as Next 16.2.6 keys, in place of today's pass-through
   (`tests/stubs/next-cache.ts:4-10`, 01b S5). It must catch two planted bugs before it is trusted:
   equal `write_seq` values for A and B sharing an entry, and a uid captured in a closure.
3. Every entry point in 01b §2 (8 pages, 24 actions, 12 route files) called as B: none of A's markers in
   any response, and A's database file unchanged (a checksum over every table's rows).
4. The payload routes: B's request with A's ETag answers 200 with B's body; a segment key only A has is
   a 404 for B.
5. The token core: 01e's six tests (§5).
6. The cron: two due users, with B failing two ways in turn, a refresh answering `invalid_grant` (B
   ends `needs_reconnect`) and Spotify answering 403 "not registered" (B ends `removed`); each time A's
   harvest lands and the tick answers 200 with per-user outcomes.
7. Process state: library syncs for A then B within 60 s in one process store B's own playlists; B
   polling A's task id gets a 404.
8. A structural test: parse `db.ts`'s exports and fail on any function that names a per-user table
   without taking `UserDb` first (01b S3's allowlist idea, made mechanical).
9. Deletion (§14): B's database file and rows gone, A untouched.
10. Browser sign-out clearing, by hand with two dev accounts (no headless Spotify login, STORE_MIGRATION
    §10).

Isolation costs no round trip: the handle is a client object and the uid rides the cookie.

## 7. Sync: fan-out, freshness and Spotify's budget

### 7.1 The limits this section plans to

- **The scarce bucket** (recently-played, and `/me`, which was banned beside it in August): ~725-800
  calls per quota day for the whole app [measured, six bans Aug 11-16, 01f §1.4], resetting at about
  10:50 AM ET, and documented as the developer account's budget, shared by every user (01c §4).
  Planned to 450 a day, 60%, as 01c §5.1 does, because Spotify says the limits "are subject to
  change". The owner's recorder, kept and run hourly (01c §5.7a), takes 24 of it.
- **The player bucket**: never rationed here; Rem alone spends 1,035-1,303 a day today [measured,
  01c §2.7]. Planned to stay under ~2,500 a day at five users, about twice a volume that has never
  drawn a 429.
- **The 30-second rate limit**, per app: 18 calls per 30 s has passed without a 429 (01f §1.4).
  Planned to stay under 12.

### 7.2 One tick a minute, any number of users

Two pingers hit `/api/cron/sync` every 2 minutes each, on alternate minutes: the Zenbook's timer on
the even minutes (`OnCalendar=*:0/2`, in place of today's `OnUnitActiveSec=2min`, which drifts) and
cron-job.org on the odd ones (§12). While both run, a tick runs every minute; on either alone, every
2 minutes, today's cadence. The tick:

1. Takes a global tick lock, a compare-and-set on app `meta` `lock:tick` with a 55 s lease, the
   pattern `acquireLock` already uses (`db.ts:2541-2557`). A hit that arrives while a tick holds it
   (the pingers drifted together, or a tick overran) returns at once. This is also the tick's store
   health check: if the app database does not answer, the tick ends instead of letting each user
   wait out the store fetch's three 15-second attempts (`src/lib/store-fetch.ts:28-29`).
2. Reads every user's sync state, token and database name in one batch (`sync_state` joined to
   `users` and `user_tokens`; one row per user, 250 rows at 250 users). Who is due is computed from
   the state: `active` users (a play in the last 30 minutes) every 2 minutes, `idle` users every 5
   (every 2 while there are at most two users, which keeps today's cadence for Rem alone, §7.3),
   offset by a hash of the uid so users spread across the cycle, and counted due 30 s early so a
   late tick does not stretch a 2-minute interval to 4. A user's state row is written only when
   something changed (a track change, a state transition, a harvest, a failure).
3. Processes the due users concurrently (up to 16 at a time), each under its own 25 s deadline, with
   `Promise.allSettled`: refresh the token if under 60 s remain (§5), probe, harvest if the governor
   says so (§7.4), record (§8).
4. Runs at most one due library rescan (up to 8 at 250 users), under its own deadline, after the
   harvests (§7.6).
5. Answers 200 with per-user outcomes. Only the Zenbook's call, told apart by its own secret (§12),
   can get a non-200: when the tick could not run, or when the owner's own capture is failing, since
   the Zenbook timer's failed unit is Rem's only alarm today (01c §5.2). cron-job.org always gets
   200, because it disables a job after a run of consecutive failures (the route's own comment,
   `src/app/api/cron/sync/route.ts:174-176`), and a store outage or a dead owner token would
   otherwise switch off the second pinger when it is most needed.

Each pinger hit is one invocation: 1,440 a day whatever N is (two pingers each running every minute
would pay 2,880 for the same tick rate). Tick-lock writes: 2 per tick, 2,880 a day [estimate]. Wall
time: the slowest due user, about 1-3 s at five users through Turso; at 250 users up to ~125 users fall
due in a minute, ~0.5-1 s each at 16-way concurrency, ~4-8 s per tick [estimate]. The route sets
`maxDuration = 60`; nothing under `src/app` sets one today, so the project's 300 s default applies
(01f §2.1).

### 7.3 The probe

`/me/player` alone, one call: it reports the active device's track and answers 204 when there is
none (GOTCHAS "Player simulation"), where today's idle tick spends two (currently-playing, then
`/me/player` on its 204; 01c §2.1). The probe records the track id, progress and `is_playing` in the
user's state; a **track change** is a different track id, or the same track with progress gone
backwards (a repeat). Calls per Rem-like user a day: ~9 h active at one per 2 min (270) plus ~15 h
idle at one per 5 min (180), ~450 [estimate] against 1,035-1,303 today. With one or two users, idle
probes stay at one per 2 minutes, ~720 a day each: under today's spend, and the first play after an
idle stretch then reaches the store as fast as it does today. From three users on, the 5-minute idle
probe is what keeps five users' probes near 2,250 a day (§7.1); its cost is that the first play of a
session can reach the store up to ~5 minutes after it ends while the app is closed (§7.8).

### 7.4 The harvest governor

A user is harvested (one recently-played call, the last 50 plays) when any of these holds:

| trigger | when | calls a day, Rem-like [estimate] |
|---|---|---|
| H1 session tail | the first probe that finds playback stopped (today's `>=` rule, `src/lib/harvest-gate.ts:20-24`) | ~5 |
| H2 completeness | 25 track changes since the last harvest, half the 50-play window | 0 while F ≤ 30 min |
| H3 backstop | 2 hours since the last harvest (devices the probe cannot see; 50 plays is ~2.5-3 h of nonstop listening) | ~7 (today hourly, 24) |
| H4 open app | a visible tab's load or focus, if a track change was seen since the last harvest; ≥ 60 s apart | ~5 for Rem, ~20 for an app-heavy friend |
| H5 freshness | a track change seen, and ≥ F minutes since the last harvest | 9 h × 60 / F, at most one per play |

**What a harvest costs the store.** The tick compares the 50 plays Spotify returns with the previous
harvest's keys in `sync_state.batch_keys`. Plays already seen cost nothing, so a harvest that brings
nothing new reads and writes no user-database row (today ~215 rows read, §3 row 10); new plays go to
§8.6's two batches. The `(track_id, played_at)` unique key stays the authority: a lost or stale key
list only sends more candidates to §8.6, whose read batch finds the ones already stored. That holds
only if the new keys are written after the plays: the state row goes last, once the user-database
batch has committed, so a failure between the two re-sends candidates rather than dropping plays.

**F is the governor's one knob.** Once a day the governor takes each user's measured harvests over
the last week, projects what each would spend at a given F, and picks the smallest F (2, 5, 10, 15 or
30 minutes) whose projected total fits 426, the 450 budget less the recorder's 24. Listening is not
spread evenly across the day, so a projection beats pacing against a straight line, which would throttle
a single listener during their own peak hours. A brake guards the projection: when the quota ledger
(§4.2) shows 80% of 426 spent before the day's reset, F goes to 30 minutes until the reset. The ledger
is summed in memory and written as one upsert per bucket a tick or an open-app harvest touched, ~2,000
writes a day whatever N is; now-playing polls are counted in `api_log` only. With one
or two users F sits at 2 and closed-app capture is what it is today. If the passive experiment (01c
§7.3) shows the quota is per user, the budget becomes per user and F stays at 2 for everyone.

The arithmetic, per Rem-like user (9 h playing, ~130 plays, H1+H3+H4 ≈ 17 a day). H5 is taken at its
ceiling, 540 / F capped at one per play; a harvest waits for the next track change after F has passed,
so real counts run somewhat lower:

| F | H5 | per user | 1 user | 2 | 5 | 25 | 250 |
|---|---|---|---|---|---|---|---|
| 2 min | ~130 | ~150 | 150 ✓ | 300 ✓ | 750 ✗ | – | – |
| 5 min | ~108 | ~125 | | | 625 ✗ | – | – |
| 10 min | ~54 | ~71 | | | **355 ✓** | 1,775 ✗ | – |
| 30 min | ~18 | ~35 | | | 175 ✓ | 875 ✗ | 8,750 ✗ |

Against 426. So: F = 2 for up to two Rem-like users, about 10 at five. At 25, completeness alone (H1,
H2 with no H5, H3 every 3 h: ~15 a user) is ~375, inside the budget with nothing left for freshness;
at 250 completeness needs ~3,750, nine times the budget, and plays would be lost. Under the shared
reading, Spotify's quota rules out 250 users independently of the user cap (T1).

Today [measured, 01c §2.7]: 139-319 cron harvests a day plus the recorder's 96, for one user.

### 7.5 429s by kind

`client.ts` keeps one module-scoped cooldown and persists bans over 120 s to one global key
(`src/lib/spotify/client.ts:43-48, 170-186`), and never reads the 429 body. The design reads it: a
`QUOTA_EXCEEDED` sets that bucket's cooldown (`cooldown:<bucket>` in app `meta`) until `Retry-After` or
the observed reset, while probes and rescans in other buckets carry on; any other 429 is the
per-app rate limit and keeps today's app-wide pause (01c §5.4 item 5). `api_log` records the `reason`
and the uid, which is how the passive experiment learns whose calls a ban followed (01c §7.3).

### 7.6 Library rescans

- Every 30 minutes while a user is active, every 3 hours while idle (01c §5.6); outside the harvest
  deadlines; resumable, because rescans already commit per playlist.
- No `/me`: the user's Spotify id is known from sign-in. That removes one scarce-bucket call per
  rescan, 32 a day for Rem today (01c §5.1).
- Every owned playlist's snapshot compared in the list probe the rescan already makes, through
  `playlists.snapshot_id`, instead of ~110 serial `plsnap:` reads (`src/lib/sync/library.ts:65-66`).
- The Liked list re-fetched in full when its count or newest `added_at` moved, and weekly rather than
  daily as a safety net (today's daily refetch always counts as a change, `sync/library.ts:81-84`).
- Spotify calls per Rem-like user a day: ~23 rescans × ~4 calls (three playlist pages, one Liked
  probe) plus the changed playlists' item pages, ~100 [estimate] against ~127-175 today.
- A new user's first full scan (Rem's library is ~150 calls, one to two minutes at 150 ms pacing,
  01c §5.6) runs across several ticks, one rescan slot at a time.

### 7.7 Open-app paths

- `POST /api/sync` (on load, every 2 minutes, on focus; `src/components/sync-on-load.tsx:12-27`) runs
  the same per-user step as the tick, under a per-user harvest lock (a compare-and-set on
  `sync_state.harvest_lock_until`, written only when a harvest starts), and harvests only by H4. Today it
  harvests whenever the last harvest is over a minute old (01c §2.4).
- `refreshHistoryAction` stops calling Spotify and only reads the store (01c S6, §5.5).
- Now-playing asks `/me/player` alone, like the probe (an idle poll pays two calls today:
  `currentlyPlaying()` and then its `/me/player` fallback on a 204), and polls every 15 s mid-track,
  plus the existing end-of-track and visibility polls (01c §5.5): at most ~4 calls a minute per
  visible tab. Five users with a visible tab each: ~10 per 30 s,
  plus ~1-2 from the ticks' probes (five active users probed every 2 minutes), about the planned 12.
- The browser's instant handoff (`src/lib/optimistic-play.ts`, `handoff.ts`) is unchanged; it is what
  puts a finished track on screen the moment the tab sees it end.

### 7.8 Freshness, step by step (T3)

- **App opened after listening elsewhere.** First paint is the stored Home payload (§9). If the user's
  state shows a track change since the last harvest, the on-load `/api/sync` harvests: one Spotify call
  (a few hundred ms [estimate]), one read batch and one write batch on the user's database (~30 ms at
  R1's 15 ms target), and the open tab patches in the delta through the existing
  `refreshHistoryAction` → `patchHistoryPayload` path (`src/lib/history-patch.ts`). Every play that
  ended before the open is on screen within ~1-2 s of first paint [estimate]. Observed target met.
- **App open while listening.** A finished track appears at once as a provisional row; the stored row
  follows within F.
- **App closed.** Stored lag is at most one probe interval (2 min while active) plus whatever of F has
  not elapsed: ≤ ~2 minutes at F = 2, ≤ ~12 at F = 10. The one exception is the first play of a
  session at three or more users: idle users are probed every 5 minutes then (§7.3), so that play can
  land up to ~5 minutes after it ends, inside the ≤ 10-minute target that applies at five.
- **Completeness.** H2 fires at 25 changes, H3 at 2 hours, H1 at every session end; at Rem's peak
  (~20 plays an hour, 01c §5.7), 25 plays take 75 minutes, so H5 fires first whenever F ≤ 30. No play is
  lost while a pinger runs.

### 7.9 Failure isolation

01c §5.4 lists the cases; each lands in this design as a state on one user's row. A user whose calls
hang uses its 25 s and is retried at its next due time. `invalid_grant` clears that user's token row
and sets `needs_reconnect` (§5). A 403 "not registered" sets `removed`. The same error for every user at
once (the owner's Premium lapsing, 01f §1.2) backs the whole tick off instead of marking anyone
removed. A store failure ends the tick at step 1. Every write on this path is idempotent: the harvest
lock and the tick lock are compare-and-sets, counters are written as values, inserts have natural keys, and
writes that outlive a response go through `after()` (01c §5.4 item 8; §2.8 there shows re-sent INSERTs
happen).

## 8. The write path: derived data updated by append

Plays arrive at "now" in almost every case, so almost every write is an append. Each derived value
below is updated from the harvest already in hand, and rebuilt from rows only inside a bounded scope
when a non-append event (§8.3's table) touches it.

### 8.1 `listened_ms` and the all-time accumulator

Today the skip verdict is stored per play but listened time is re-derived by walking the gap chain:
the all-time recompute walks every real play (~51,000 rows, up to 144 times a day) and the Home
payload walks 16 days per landed harvest (§3, rows 1-2).

- **Store `listened_ms` beside `skipped`.** Both come from the same `min(gap, duration)`
  (`src/lib/skip-rule.ts:33-46`; `listenedMs` adds the 5-second floor). For a tail append (every new
  play newer than everything stored) the predecessor is the newest stored play, one indexed read in
  the harvest's read batch, so both values are computed in JS and written with the insert. That also
  retires the post-insert `recomputeSkipFlags` round trips and the two partial-index updates per play.
- **Out-of-order inserts** (the backstop replay, imports, a late offline play inside the 50-play
  window) keep today's path: re-open the successor and rule it from its predecessor
  (`db.ts:547-561`), now rewriting its `listened_ms` too, and set `alltime_dirty`.
- **The accumulator** is `allTimeStats` (`skip-rule.ts:58-74`) applied one play at a time: for a
  non-skipped real play, `plays += 1`, `durationMs += listened_ms`, `since` kept, and `uniqueTracks += 1`
  when no earlier counted play of that track id exists (an `EXISTS` probe on `idx_plays_track`; real
  plays average ~3.4 per track id [estimate: 14,511 / 4,279, 01a §6]). It equals the chain walk
  because `listened_ms` is the value the walk computes.
- **A duration change on a played track** (a library sync can rewrite `duration_ms`, the case
  `sync/library.ts:94-101` guards today) recomputes that track's plays and their successors through
  `idx_plays_track`, and marks their months dirty (§8.3).
- **`alltime_dirty`** makes the next tick recompute the totals from the stored columns: one scan of
  that user's plays (~22,000 rows for Rem), only on that event.
- One-time cost at migration: a full chain walk to fill `listened_ms` (~45,000 rows read with the
  `tracks` probes, ~14,500 written for Rem [estimate]), verified by `SUM(listened_ms)` equalling
  today's `alltime_stats` on the same snapshot.

### 8.2 The Home payload, patched in place

Today it is rebuilt after every landed harvest: the 16-day strip read and the opening day's plays,
~7,500 rows (`db.ts:1315-1343`; 01c §2.2). Instead, the harvest's read batch includes the `home` row,
and JS applies the new plays: the day's entry in `daily` (plays, `durationMs` from `listened_ms`, the
unique count from the opening day's rows), the opening day's song rows (`plays`, `lastPlayed`,
`source`, or a new row from the fields in hand), and `allTime` from the accumulator. A new local day
starts a fresh opening day from the plays in hand. Anything else falls back to today's rebuild: a play
landing on a day other than the opening day (a late arrival, or the first harvest after midnight), an
out-of-order insert, a time-zone change, a shape change, and any §8.3 event that touches a play in the
payload's 16 days (a context name resolving, an orphan flip), which marks `home` dirty for the next
harvest or the daily route. Today the rebuild after every landed play is what heals those two derived
columns; a patched payload needs the explicit mark, or a stale "From" could sit in it for days. Cost:
1 row read instead of ~7,500, the same 1 row written.

### 8.3 History segments, appended on write

Today the history payload is one body rebuilt by a full scan (~79,000 rows) on a fetch after the slow
marker moved (`db.ts:1686-1730`); at 1.79 MB raw it is 86.6% of the Data Cache's 2 MiB item limit
and crosses it in late December (01d §3.2). Instead, 01d's monthly segments (O3), materialized:

- One `payloads` row per UTC month (`hist`, `2026-10`) plus `hist`/`catalog` for the 7,529 backfill
  rows. Each body is self-contained, in today's tuple format with one addition: a play becomes
  `[trackIdx, minute, sourceIdx, listenedS]` (shape `v3`), so the browser can build any day's totals
  exactly (§9). Cost [estimate]: ~4 bytes per play raw, ~+5% on Rem's body.
- **Append.** The harvest's read batch includes the row of each month the new plays fall in (one, or
  two across a month boundary); JS merges the new non-skipped plays with the function the browser
  already uses for the same job (`patchHistoryPayload`, `src/lib/history-patch.ts:34-102`, known-answer
  tested, extended for the fourth field), and the write batch stores it with a compare-and-set on
  `version`. The first play of a month creates that month's row.
- **Non-append events mark months dirty** (`dirty = 1`, `version + 1`); the daily route, or the next
  fetch, rebuilds just those months from an index range (~3 rows per play, at most ~10,000 for one of
  Rem's months, 01d O3):

| event | how its months are found |
|---|---|
| out-of-order insert, and the successor it re-opens | the two `played_at` values |
| `ctx_orphan` flips after a playlist's membership moved | `UPDATE … RETURNING played_at` on the scoped orphan pass |
| a context name resolves or changes | `SELECT DISTINCT substr(played_at, 1, 7) … WHERE context_uri = ?` on `idx_plays_context` |
| a played track's name, artist, art, album or duration changes | the same on `idx_plays_track` |
| backstop replay, history import, catalog backfill | the scripts mark the months they wrote, and `catalog` |

- **Safety net.** The nightly backup rebuilds every segment from its dump of the user's database and
  compares; a mismatch marks the month dirty and records which month and field differed, which points
  at the event path that missed its mark. Each event path also gets 01d's known-answer test: write to
  an old month, and that month's version moves and no other does.
- Sizes [measured, 01d O3]: Rem's months are 220-303 KB raw (81-113 KB gzipped); the catalog 1.05 MB
  raw (358 KB gzipped). No normal month approaches 2 MiB, and segments no longer use the Data Cache
  at all (§9.2).
- Cost: one row read and one written per landed harvest, the body at most ~300 KB raw at a month's
  end; Turso counts rows, not bytes.

### 8.4 The library body, patched per changed playlist

Today the library payload is rebuilt from every membership (~15,000 rows) on a fetch after
`library_seq` moved, and every list rewrite moves it, including rewrites that change no membership
(01d §8); the unique-song count re-reads every member (~39,000 rows) on any library change.
Instead, `payloads` row `lib` is built once at migration and then patched where `storePlaylistTracks`
already computes each playlist's diff (`diffPositions`): drop the playlist from identities that left,
add it to identities that joined, add new identities from the fields in hand, remove identities in no
playlist and not liked, and keep the unique-song count (identities in at least one playlist) in the
same pass. A rename patches one string; artwork-only or count-only changes do not touch it; a Liked
change patches a per-identity flag (shape `v2`). `library_seq` moves only when the body did. Cost: 1
row read and 1 written per changed playlist [estimate], instead of ~15,000 + ~39,000. The nightly
dump check covers drift, as for segments.

### 8.5 The smaller terms

- **Daily contexts pass**: a scan of the `contexts` table for negative rows due a recheck (114 rows
  for Rem) instead of a full `plays` scan. Never-seen contexts already come in through the per-batch
  check (`unseenContexts`, `db.ts:619-638`); the import scripts register their own contexts instead of
  relying on the daily scan to find them.
- **Orphan verdict for a new play**: computed in the read batch with the song's identity bound as
  parameters, then written with the insert. The stored predicate (`db.ts:700-709`) looks the identity
  up in `tracks`, which has no row yet for a never-seen track in the same batch. With §10.1's
  rewritten predicate the verdict is a few index probes, ~5-10 rows instead of ~130.
- **The write marker**: one bump per landed batch, where today a landed tick bumps two or three times
  (the insert batch, the orphan flags, the skip verdicts: `db.ts:522, 749, 819`).

### 8.6 One landed harvest, end to end

Two round trips on the user's database (a read batch and a write batch) and one write on the app
database, against a p50 of 30 store round trips per landed tick today [measured, 01c §2.1].

| | today, per landed play [measured, 01c §2.2] | this design [estimate] |
|---|---|---|
| rows read | ~7,700, or ~59,000 when the all-time gate opens | ~20: the orphan verdict ~5 (§10.1; ~130 with today's predicate), the newest stored play, new track ids (~3 each), new contexts, the uniqueness probe, three payload and meta rows; up to ~50 more when a candidate is older than the newest stored play and its key must be checked |
| rows written | 15-20 | ~10: the play with its index entries (~6), the `alltime`, `home` and segment rows, the marker |
| round trips | ~30 | 3 |

The cron harvest and an open tab's `/api/sync` serialize on the per-user harvest lock (§7.7); a
payload write that loses its compare-and-set anyway marks the row dirty for the daily rebuild.

## 9. Search: payloads, caching, and the budget for every step

### 9.1 What the browser fetches

- **The manifest rides the page.** Home's server render already reads the user's database for the
  `home` row; the same batch reads the manifest (`kind, key, version, bytes` for every `payloads` row:
  ~8 rows for Rem today, ~40 after three years), so the browser knows at first paint which segments
  exist and which it lacks. No extra request.
- **Segments by versioned URL**: `GET /api/search/seg/<kind>/<key>?v=<version>&s=<shape>`, served from
  the session's uid only, one `payloads` row read by primary key, `Cache-Control: private,
  max-age=31536000, immutable`. If the stored version has moved past the URL's (the current month after
  a new play), the route answers with the current body, its version in a header, and `no-store`, so
  nothing is cached under the wrong URL.
- **The library body** comes the same way (`lib`), patched per playlist on the server (§8.4).
- **The server fallback** (`searchHistory`'s `LIKE`, `db.ts:884-904`) answers only while nothing is in
  memory; in a per-user database it scans one user's plays.

### 9.2 Caching layers, from the device out

1. **IndexedDB**, keyed `(uid, kind, key, version, shape)`: STORE_MIGRATION phase E with a per-segment
   key (01d §6 item 3). Read on Home mount before any network request.
2. **The browser's HTTP cache**: a segment URL never changes meaning, so a device never re-requests a
   segment version it holds.
3. **The user's database**: one row per segment the device lacks. A request never rebuilds anything
   except a month marked dirty (§8.3), bounded at ~10,000 rows.

**No Data Cache for payloads.** One store row costs ~15 ms at R1's target, and dropping the Data Cache
for these bodies removes three problems at once: the 2 MiB item limit (01d §3.2), the cross-deploy
shape hazard (GOTCHAS "The Data Cache OUTLIVES THE DEPLOY"), and per-user entries in an LRU cache that
Rem's other Vercel projects share (01f §2.2). The Data Cache keeps only the small per-user reads
in §6, keyed by uid.

### 9.3 What changes in the client

- **Lazy days** (01d O6): a day's rows are built when the day is selected, by binary search on the
  minute-ordered plays, instead of every day up front. That removes ~199 of the 264 ms the client
  spends at 4× today (01d §2.3).
- **The whole-history strip from the segments**: per-day totals from each play's listened seconds,
  replacing the `dailyStatsAction(100000)` prefetch on mount (§3, row 4). The server path stays as the
  fallback before segments land. A day's unique count then counts songs by identity, since segments
  carry identities, not track ids: the same change as the all-time list below.
- **The all-time list from the segments**: plays, last play and the latest play's source per song,
  replacing `readAllTimePlays` (~25,000 rows per rebuild, READ_QUOTA "Sibling sweep"). It groups by
  song identity where the server groups by track id, so a song Spotify relinked under two ids shows
  once instead of twice: a visible change, and the same identity rule search already uses
  (`db.ts:1403-1407`).
- **A shorter result list**: the first ~50 rows painted, the rest on scroll (01d O6). Rendering up to
  400 full rows is most of a keystroke's time today (01d §2.3).
- **Narrowing**: a query that extends the previous one filters the previous matches, so only the first
  keystroke scans the whole set.
- **`history-ready` stops waiting for the library half** (`den-home.tsx:620`, 01d §1.4): the day list
  needs only history.
- A Web Worker only past ~30,000 entries (01d O6).

### 9.4 The budget, step by step

**First visit, empty browser cache, Rem today, 4× CPU, 10 Mbit/s.** Sizes and client times are
measured (01d §2.1, §2.3, O3); network and server times are estimates.

| step | time | basis |
|---|---|---|
| server render: identity (app DB) ∥ `home` + manifest (user DB), one round trip each, in parallel | ~15-30 ms of store time | R1 target, p50 ≤ 15 ms |
| first paint → idle callback | ≤ 300 ms | after hydration; the 2 s timeout is only a ceiling |
| all segment requests in parallel: identity + one row each | ~100-150 ms to first byte | a mobile round trip of 50-100 ms |
| transfer: library 285 KB + history segments 798 KB gzipped | ~870 ms | 1.08 MB at 10 Mbit/s; listened seconds add a few percent [estimate] |
| parse and build the search set | ~80 ms | 6.4 + 11.9 + 46.6 ms at 4× today, plus the segment merge |
| build the selected day | < 5 ms | lazy days |
| **search usable after first paint** | **~1.4 s** | target ≤ 2 s |

| profile | gzipped bytes, cold | search usable [estimate] | ≤ 2 s? |
|---|---|---|---|
| light, 1 year (01d §3.3) | ~250 KB | ~0.7 s | yes |
| typical, 1 year | ~700 KB | ~1.1 s | yes |
| Rem today | ~1.08 MB | ~1.4 s | yes |
| heavy, 1 year | ~1.3 MB | ~1.6 s | yes |
| heavy, 3 years | ~2.35 MB | ~2.6 s | no; one art and album dictionary per user instead of per segment removes the ~30% segment overhead (01d §5.2), ~2.3 s; loading the library and the newest months first makes the box usable in ~1.2 s with older months following (§17) |
| Rem on slow 4G (1.6 Mbit/s) | ~1.08 MB | ~5.9 s | no; §17 |

**Repeat visit**: IndexedDB read ~20 ms at 4× [measured, 01d O5] + building the set ~47 ms [measured]
+ the selected day < 5 ms: **~80 ms** against a 300 ms target. The manifest in the page then names the
segments that moved, usually just the current month (≤ 113 KB gzipped, ~90 ms at 10 Mbit/s), patched
in behind a usable box.

**Keystroke at 4×.** Matching is ≤ 13.2 ms over Rem's set (the worst one-letter query, "e", 8,599
hits; 01d §2.3), and rendering ≤ 50 rows instead of up to 400 brings painting to ~10-20 ms
[estimate]: **~25-35 ms** against 50. At twice Rem's size (29,014 entries) one-letter matching is
25.6 ms (01d §3.2), ~45 ms in all; at four times (58,028) it is 55.9 ms and needs the worker. Later
keystrokes narrow the previous matches and cost a few milliseconds.

**Server cost of a visit.** Today a visit after any listening can rebuild the history payload (~79,000
rows), the library payload (~15,000) and the whole-history strip (~43,500). Here: identity ~4 rows,
`home` and manifest ~8, one row per segment the device lacks: **≤ ~20 rows a visit** [estimate].

## 10. The store budget per user per day, and the plan that holds at 5, 25 and 250

### 10.1 One more term the overviews did not size: the orphan predicate per play

The stored "From" verdict (`ctx_orphan`) asks, for a play from a cached playlist, whether the song's
identity is among that playlist's members. The predicate (`db.ts:700-709`) answers it by walking the
playlist's members (`SEARCH plm USING INDEX idx_pltracks_pl`) and probing `tracks` for each: up to 2M
rows for a playlist of M members, for every play it judges, fewer when the walk meets the song early.
That fits the ~130 rows per landed play the meter saw (01c §2.2; Rem's playlists average ~65 members,
7,400 / 114) and the ~350 a play Turso billed for a full pass in August (2,544,558 at 7,194 plays,
READ_QUOTA "Sibling sweep"). It also makes a pass scoped to one playlist cost (plays from that
playlist) × M: for a playlist holding 300 songs with 3,000 plays from it, ~900,000 rows [estimate;
Rem's per-playlist play counts were not measured]. The meter cannot show the scoped or the full pass,
because it counts the correlated subqueries in an `UPDATE`'s `WHERE` at about 1/40 of what Turso bills
(01c §2.8), and lanes 1910-1911 scope the pass without changing the predicate.

The design rewrites the predicate to start from the song instead of the playlist: the play's own
`tracks` row, the tracks sharing its identity through `idx_tracks_artist_name`, then their memberships
through `idx_pltracks_track`, filtered to the playlist. `CROSS JOIN` pins that loop order, since
SQLite's planner otherwise picks the member walk. No column, index or migration is added. Checked on
the Mac's Aug 11 copy (`data/replica.db`, opened read-only: 7,572 plays, 15,328 memberships, 181
playlists; §19):

- the plan becomes `SEARCH me USING INDEX sqlite_autoindex_tracks_1 (id=?)`, `SEARCH tm USING INDEX
  idx_tracks_artist_name`, `SEARCH plm USING INDEX idx_pltracks_track (track_id=?)` [measured];
- over the 6,801 plays from a cached playlist, today's form walks up to 411 rows per play on average
  (twice the playlist's members; max 2,256), and the rewrite matches 2.7 (max 7) [measured], ~5-10 as
  Turso counts index and table visits [estimate];
- both forms give the same verdict on all 7,572 plays: 764 orphans each, 0 differ [measured].

So a landed play's verdict costs ~5-10 rows instead of ~130, a scoped pass ~5-10 × (plays from the
playlist), and a full pass at today's 22,040 plays ~0.1-0.2M instead of ~5.1M [estimate]. That is why
§8.6 counts ~20 rows per landed play, not ~150.

### 10.2 Per Rem-like user per day

At today's history (22,040 plays) and Rem's Oct 14 activity (129 plays landed, 716 ticks, ~30
rescans). Everything is an estimate built from the measurements cited in §3, §7 and §8.

| reads | rows a day | basis |
|---|---|---|
| landed plays, 129 × ~20 | ~2,600 | §8.6 with §10.1 |
| tick state: the user's state and token rows on every tick | ~2,900 | §7.2 step 2 |
| token refreshes | ~70 | §5 |
| library rescans, ~23 × ~230 (the list probe reads 228 rows today, 01c §2.3) | ~5,300 | §7.6 |
| changed playlists, ~3 a day: cached positions, a scoped orphan pass at ~5-10 rows per play from that playlist, the body patch | ~3,000-20,000 | §8.4, §10.1 |
| Home visits, ~20 rows each: Rem ~5 a day, an app-heavy friend ~30 | ~100-600 | §9.4 |
| daily chores: the `contexts` scan; the played-at convention check (owner only, ~2,400) | ~100-2,500 | §8.5 |
| dirty months rebuilt, 0-2 a day at ≤ ~10,000 each | ~0-20,000, typically ~5,000 | §8.3 |
| totals recomputed after an out-of-order insert, about weekly | ~3,000 averaged | §8.1 |
| nightly backup dump of the user's database, checked against the dump itself (integrity check, derived values recomputed) rather than by `count(*)` on Turso, which would read every row a second time | ~45,800 | §3, row 13 |
| **total** | **~63,000-103,000, typically ~75,000** | target ≤ 100,000 |

The top of the range needs every rare term at its maximum on the same day. Today [measured, 01c §2.7]:
4,252,260. About 60% of what remains is the backup, which every other design pays too; without it the
user's own work is ~17,000-57,000 rows a day. The only terms that grow
with stored history are the backup (+~117 rows a day per day) and the scoped orphan passes (plays per
playlist); neither is on a request or sync path.

| writes | rows a day | basis |
|---|---|---|
| landed plays, 129 × ~10 | ~1,300 | §8.6 |
| probe state: one write per track change or state transition | ~150 | §7.2 |
| token refreshes | ~72 | §5, 01e §5.2 |
| rescans: artwork-only updates (198 on Oct 14, 01c §2.3) and stamps | ~220 | §7.6 |
| changed playlists: member diffs, flipped orphan flags, the body patch | ~60 | §8.4 |
| **total per user** | **~1,800** | target ≤ 2,500 |
| shared, whatever N is: the tick lock (2 × 1,440) and the quota ledger (~2,000) | ~4,900 | §7.2, §7.4 |

Today [measured]: ~3,000 core rows a day (01c §2.7), plus 8,472 `api_log` rows that stay on the
Zenbook.

| storage | Rem-like user | basis |
|---|---|---|
| core tables | 11.87 MB | [measured, 01a §2] |
| added: `listened_ms` | ~0.1 MB | [estimate: 22,040 plays × ~4 bytes] |
| payload bodies: segments ~2.2 MB, library ~0.8 MB, Home ~30 KB | ~3.0 MB | [measured raw sizes, 01d §2.1 and O3] |
| **total today** | **~15.0 MB** | |
| growth | ~40 KB a day (plays ~33 KB, tracks ~2.4 KB, segment growth ~4.5 KB) | target ≤ 50 KB |

A new user starts near 3.3 MB (01a §9.1) plus ~0.5 MB of bodies.

### 10.3 Totals at 5, 25 and 250, against Turso's plans

Every user Rem-like, typical day; the free plan's limits and the Developer plan's are from the
pricing page (fetched 2026-10-14): Free 100 databases, 500M rows read, 10M written, 5 GB; Developer
$4.99 a month billed yearly ($5.99 monthly), unlimited databases, 2.5B read, 25M written, 9 GB.

| per month | 5 users | 25 users | 250 users |
|---|---|---|---|
| rows read | 11.3M: 2.3% of Free | 56M: 11% | 563M: 113% of Free, 23% of Developer |
| rows read, worst-case days (~103,000 a user) | 15.5M: 3.1% | 77M: 15% | 773M: 31% of Developer |
| rows written | 0.42M: 4.2% of Free | 1.5M: 15% | 13.6M: 136% of Free, 54% of Developer |
| storage, today's histories | 75 MB: 1.5% | 375 MB: 7.5% | 3.75 GB: 75% of Free, 42% of Developer |
| storage growth a year | +73 MB | +365 MB | +3.7 GB |
| databases (users + app + template) | 7 | 27 | 252: over Free's 100 |
| **cheapest plan that holds** | **Free** | **Free** | **Developer**, $4.99-5.99 a month |

Five users sit under 5% of the free plan's reads, writes and storage (T4), and use 7 of its 100
databases. At 250 the free plan fails on writes,
database count and reads; on Developer every dimension sits at or under 54%, and past its allowances
it bills $1 per million writes and $1 per billion reads instead of blocking. Replacing the nightly full
dump with an incremental one (plays since the last backup through `(played_at)`, ~130 rows, and the
other tables weekly, ~3,400 a day averaged) would take 250 users' reads to ~31-91% of Free, which
still leaves writes and the database count over it.

### 10.4 Spotify and Vercel at the same sizes

| per day | per Rem-like user | 5 users | 25 users | 250 users | limit |
|---|---|---|---|---|---|
| recently-played + `/me` | 35-150 by F (§7.4) | ~379 with F ≈ 10 and the recorder | ~375, completeness only, no freshness | ~3,750 | ~725-800 measured, 450 planned; shared by the account |
| player | ~450 + ~4 a minute per visible tab | ~2,250 + tabs | ~11,250 | ~112,500 | unmeasured; ≤ 2,500 planned at five |
| library | ~100 | ~500 | ~2,500 | ~25,000 | unmeasured; never a 429 |
| per 30 s, peak | – | ~1-2 from ticks + ~10 from five visible tabs | ~6 + tabs | ~40-60 from ticks alone | 18 observed safe |

| per month | 5 users | 25 users | 250 users | Hobby allows |
|---|---|---|---|---|
| invocations: ticks 43,200 + ~6,000 browsing a user (01f §2.3) | ~73,000 | ~193,000 | ~1.54M | 1M; Pro past it |
| Active CPU | unmeasured (01f: Rem alone 0.5-2.4 CPU-h estimated) | | | 4 CPU-h |
| largest response | a segment, ≤ ~300 KB raw | | | 4.5 MB |

The design moves server CPU off the request path (no full payload builds on a visit, no 22,000-row
chain walks) and onto small JSON patches on the write path, ~5-10 ms per landed harvest for a
month-end segment [estimate]. Whether five users fit Hobby's 4 CPU-hours is the number 01f says Rem
can read on the dashboard in a minute; I could not measure it either.

## 11. The store choice, and what STORE_MIGRATION needs

### 11.1 Turso, as planned, one database per user

The cheapest store that holds is the one STORE_MIGRATION already moves to: Turso's free plan in
aws-us-east-1, beside Vercel's iad1. By §10.3 it holds five users at under 5% of its reads, writes and
storage, and 25 at under 16%; 250 need the Developer plan at $4.99-5.99 a month. The alternatives,
from this design's angle:

- **One shared Turso database with a user column.** The same plan at every size: Turso meters reads
  and writes per organization, so 250 users' writes exceed the free plan either way, and only the
  database count differs. It needs user-led indexes on every per-user table to keep per-query cost
  flat (§4.1), and it gives up per-user usage numbers.
- **Self-hosted sqld**, on the Zenbook as today or on a $5 VPS: unmetered, but the Zenbook is the
  single point T5 removes, and a VPS is a machine to patch and back up for about the price of
  Turso's Developer plan. STORE_MIGRATION §4 rejected AWS hosting on cost.
- **A Postgres service**: a rewrite of the 3,212-line, SQLite-dialect `db.ts`, which no budget here
  calls for.

### 11.2 What multi-user takes from the migration

- **Rem's database.** Turso `lazyboy` becomes Rem's user database as it stands; `users.db_name` names
  it, so nothing is renamed.
- **R1**, a store round trip of p50 ≤ 15 ms from the functions: every latency in §9 assumes it. The
  row budgets in §10 do not depend on it. If R1 fails, STORE_MIGRATION stops before phase E by its own
  rule (§2 there), and §9's numbers fail with it.
- **Phase A's telemetry split**: two clients, telemetry never awaited on a user path. `api_log` and
  `client_metrics` keep that shape and gain a uid.
- **Phase A's daily route** (item 7), written as a loop over users from day one (01c §6 item 3): rebuild
  dirty months, recompute dirty totals, read each user's Turso usage, prune telemetry.
- **Phase D's backup**, written as a loop over database names (01a §10 item 3), one file per database,
  token rows stripped (01e §6 item 1), with the derived-value check of §8 run against each dump.
- **Phase E's browser copy**, keyed `(uid, kind, key, version, shape)` (01d §6 item 3), the uid coming
  from the session (01b §7 item 1).

### 11.3 What should change before Oct 15, 8 PM

Nothing blocks the cutover, and none of these touches its runbook:

1. **Correct §3's attribution.** The ~50,500-row statement that dominates reads is the all-time
   recompute (`orderedRealPlays`, `db.ts:854-869`), not the history payload: the meter's own Oct 14
   rollup counts 44 runs of it at ~51,000 rows against one history-payload rebuild (01c §2.2, §6 item 1;
   01a §11.2; 01d §2.2). 01f §4.3 reads the same 44 runs as the history payload from the meter's
   report; 01c's lookup on the logged SQL text, whose prefixes differ (`SELECT p.played_at AS
   playedAt…` against `SELECT t.name AS name…`), separates them. Phase E's browser copy does not
   touch it; §8.1's accumulator does.
2. **Phase E's store key** gains the segment dimension now, so segments arrive without a second
   migration of browser data (01d §6 item 3).
3. **Phase D's backup** loops over database names and strips token rows (01a §10, 01e §6). Its count
   check ("counts equal to Turso's", STORE_MIGRATION §9) is better made against the dump itself: a
   `count(*)` per table on Turso reads every row a second time, ~45,800 rows a night at Rem's size.
4. **Lanes 1910-1911** should ship §10.1's rewritten predicate with the scoping, or ahead of it. On the
   Aug 11 copy it gives the same verdict on every play and matches ~2.7 rows per play where today's
   walks up to ~411, which takes a full pass from ~5.1M rows to ~0.1-0.2M [estimate] with no schema
   change; a pass scoped to a busy playlist with today's predicate still costs plays × members, which
   the meter undercounts about 40× (01c §2.8). One pass of each form on the Turso copy, read off
   Turso's usage before and after (01c §8), measures both.
5. **R4** gains a growth term and, for multi-user, a per-dimension bar at the planned N (01c §6 item 2).
6. **Step 9 flips Production only**; Preview gets its own database or none (01b §7 item 2).

The app database, the template and every user database join `lazyboy` in group `default`, so one group
token reaches all of them: the same blast radius as today's single store token.

## 12. Uptime: the Zenbook and the other single points

After STORE_MIGRATION no user request touches the Zenbook (its R2). What still runs there: the
2-minute pinger, which is every user's closed-app capture; telemetry and the log sections of
`/usage`; the owner's recorder; the nightly backups; and the Funnel certificate that expires Nov 8
(01f §3.1, §3.4; lane 1907 repairs it). The design changes four things:

1. **A second, independent pinger.** cron-job.org (free; it drove this route until Aug 10, 01f §3.5)
   hits `/api/cron/sync` every 2 minutes on the odd minutes, the Zenbook's timer on the even ones
   (§7.2). The tick lock makes a collision cost one extra invocation and nothing else; either pinger
   alone keeps every user's capture running at today's 2-minute cadence. Vercel Pro's per-minute cron
   is the alternative if Pro is bought for other reasons (01f §6, decision 5). Each caller holds its
   own secret, so either can be rotated alone (01e §5.9) and the route can tell them apart: only the
   Zenbook's call ever gets a non-200, because cron-job.org switches a job off after a run of failures
   (§7.2 step 5).
2. **Quota protection lives on Turso.** The quota ledger and the per-bucket cooldowns sit in the app
   database, so the governor keeps working through a Zenbook outage.
3. **Telemetry stays best effort**: one attempt, 4 s, never awaited (STORE_MIGRATION phase A). An
   outage loses diagnostics, never a page or a play.
4. **The app captures on open.** Even with both pingers down, a user who opens the app is harvested
   on load (§7.7) and loses nothing within the last 50 plays.

| failure | today | this design |
|---|---|---|
| Zenbook down, including the ~3 AM reboot (6-8 min daily, 0.47% of the meter's 48.5 h, 01f §3.3) | every authenticated page errors; capture stops | nothing a user sees; telemetry rows dropped; the owner's recorder and the backups wait |
| Zenbook frozen | each store query waits ~46 s (01f §3.2) | nothing (R2: ≤ 50 ms) |
| one pinger down | (one pinger today) | the other covers |
| both pingers down for T hours | capture stops | capture waits; a user who plays more than 50 tracks after their last harvest and does not open the app loses the excess (50 plays is ~2.5-3.5 h of listening, 01c §5.7) |
| Turso down | (after the move) everything | everything; accepted |
| Turso quota block | (after the move) every query fails until the 1st | five users use under 5% of the free plan, so only a regression gets there; Developer with overages turns it into a bill (§18) |
| a Vercel Hobby allowance overrun | up to 30 days down, for every project on the team (01f §2.2) | the same; Rem decides Hobby or Pro after reading Active CPU (§18) |
| recently-played `QUOTA_EXCEEDED` | one global cooldown stops every Spotify call (01c S4) | that bucket waits for its reset; probes and rescans continue; the next harvest recovers up to 50 plays |
| the owner's Premium lapses | the app stops (01f §1.2) | the same, by Spotify's rule; the tick backs off as one |
| one user's token revoked, or the user taken off the allowlist | the tick answers 500 for everyone (01c S2) | that user's slot only |
| the Funnel certificate lapses (Nov 8 unless fixed) | the whole app | telemetry only |

## 13. Migrating Rem's data with nothing lost

The migration adds columns, tables and databases; it rewrites no row of `plays`, `tracks` or the
library except to fill new derived columns, and it deletes nothing until a week after it lands. It
runs after STORE_MIGRATION's cutover and aftercare (lanes 1903-1904), and after lanes 1906 and 1911
have shipped, since it touches the same files.

**Before it.** F1 closed (`AUTH_SECRET` rotated, `SPOTIFY_OWNER_ID` set in production; 01e §7 decision
1, 01b E1-E2), and the second account's plays that the Oct 14 incident recorded into Rem's history
removed (01b E6): they are another person's listening, and once the store has owners they would be
filed as Rem's. They can be told apart by the incident window and by comparison with the recorder,
which captured on Rem's own token chain throughout. Rem confirms the window; it is the one step that
needs a person.

**The fenced window** (~15 minutes, the discipline of STORE_MIGRATION §8 steps 2-3; Spotify's 50-play
buffer covers any plays in it). The rollout (§15) lands step 3 with the single-user phase P1 and step 4
with P2, so in practice this runs twice, each time with steps 1-2, its own checks from step 5, and its
own rollback:

1. Pause both pingers; wait for no writes for 5 minutes.
2. Restore point: Turso's point-in-time restore (1 day on Free) plus a dump by the backup script.
3. On `lazyboy`: add `plays.listened_ms`, `playlists.snapshot_id` and the `payloads` table. Fill
   them: `listened_ms` by one chain walk in JS (the same pure function the skip verdicts use),
   `snapshot_id` from the `plsnap:*` rows, the segments, the library body and the Home payload from
   the existing builders, the `alltime` accumulator from today's `alltime_stats`.
4. Create `lazyboy-app` and `lb-template`. In the app database: Rem's users row (a new uid; his
   `account_id` read once from `/v1/me` with the stored token, never bound through `me_id`, 01e §5.5;
   `db_name = 'lazyboy'`; `is_admin = 1`; `tz_zone = 'America/New_York'`); both token rows encrypted
   into `user_tokens`; his `sync_state` from `last_sync`, `player_last_active`, `rp_last_harvest` and
   `library_synced_at`. The plaintext token rows stay in `lazyboy.meta` for the week.
5. Verify, each a known answer that has to match exactly: per-table row counts unchanged; the 7,529
   backfill plays, 1,162 orphan flags and 481 skip verdicts unchanged (S-Oct14's counts, 01a §8.6, to be
   re-counted on the day); `SUM(listened_ms)` over counted plays equal to `alltime_stats.durationMs`;
   every month's segment equal to the same month's slice of `readHistoryIndex()` run on the same
   snapshot; the library body equal to `readLibraryIndex()` plus the Liked flags; both token blobs
   decrypting to their plaintext rows; `scripts/verify-derived.mjs` green with its new checks.
6. Deploy the new code, still owner-only. Resume the pingers; three ticks land; Rem signs in once
   (the uid and epoch check ends every older session, closing F1 for good).
7. The recorder's plays from the paused window are present after the first harvest (STORE_MIGRATION
   step 13's rule).

**Rollback**: before step 6, redeploy the previous build: it reads the untouched plaintext token rows
and ignores the new columns and tables. After step 6, the same, carrying any newer token back to the
plaintext row (the later `expiresAt` wins, STORE_MIGRATION step 10's rule); plays written by the new
code are ordinary rows the old code reads. On day 7, drop the plaintext token rows and the retired
`meta` keys (§4.4).

Cost on Turso, once [estimate]: ~200,000 rows read (the column additions, the chain walk, the payload
builders) and ~30,000 written: 0.04% of a free month's reads and 0.3% of its writes.

## 14. Sign-up gating, privacy and account deletion

**Gating.** Two gates, both required: Spotify's allowlist in the dashboard (five accounts at most),
and the app's `invites` table, which also fails closed on a store error as `owner.ts:8-9` does today
(01e §5.4).

- Rem invites by running `scripts/invite.mjs <spotify id>` on his Mac, where the Turso platform token
  lives: it picks a uid, creates `lb-u-<uid>` from the template, writes the invite, and reminds him to
  add the account to the dashboard's allowlist. Provisioning at invite time keeps database creation off
  the sign-in path and the platform token out of the Vercel runtime (01e §6).
- First sign-in by an invited Spotify id: the privacy policy and an end-user agreement shown and
  accepted before anything is stored (Developer Terms §V, 01f §1.5; `users.terms_accepted_at`), then
  the users row under `account_id`, the tokens, and a `sync_state` row in `active`. The first library
  scan runs across the next ticks (§7.6); history starts empty, or from the person's own Extended
  Streaming History export through the importer, once it takes `--user` (01c S17) and only after
  segments exist (01d decision 2).
- Scopes trimmed to what the app uses, dropping `user-read-email` and `user-read-private` (01f §1.5,
  01e).
- `users.status` lets Rem cut anyone off without the dashboard; admin is a flag bound to his
  `account_id`.

**Privacy.**

- Stored per user: their listening history, library, the derived values, encrypted tokens. In
  telemetry: Spotify call counts and client timings tagged with the uid; no song names (§4.4).
- Visible to: the user, and Rem as operator, who can read any database; the privacy policy says so.
  No other user, by construction (§6).
- Retention: Rem's history unlimited; an invited user's history kept for a window Rem chooses (01a
  decision 2), enforced daily by one indexed delete per user on `played_at` and by dropping that
  user's segments past the window. Telemetry 30 days, enforced by the daily route.
- Policy risk: Spotify's Developer Policy prohibits "creating new or derived listenership metrics"
  (01f §1.5), which listened time and skip verdicts arguably are. Each user's stats stay visible to
  that user only. Accepting the risk is Rem's call (01f decision 6).

**Deletion** ("Disconnect", complete within the Developer Terms' five days, 01e §5.7-5.8):

1. In the app, at once: bump `session_epoch`, set `status = 'deleting'`, delete the user's
   `user_tokens` rows, set `sync_state` to `removed` (the tick stops calling Spotify for them), and
   drop every table in the user's database with the group token. The data is gone within seconds; an
   empty database remains.
2. `revalidateTag('user:<uid>')` purges the user's remaining cached reads (§6).
3. Within five days, a job holding the platform token (the Zenbook's nightly backup job, or the script
   on Rem's Mac) deletes the database, the user's backup files on the Zenbook and OneDrive (one file
   per database, §11.2), the telemetry rows carrying the uid, and last the users row, so a crash midway
   leaves a row the job can find and finish (01e §5.8).
4. The user is told to remove Lazy Boy at spotify.com/account/apps; the app cannot revoke a grant.

Non-owner backup files are kept five days at most, so a deletion is complete within the window even if
step 3 is late (01a decision 3, 01e §5.8); the owner's keep today's 60 days. One gap I could not close:
none of the Turso pages I read says whether deleting a database also deletes its point-in-time history
(1 day on Free, 10 on Developer). On Developer, ten days would outlast the five-day window; Turso
should be asked before a friend's data is on that plan.

## 15. Rollout in reversible phases

Ordered so the work that pays off for Rem alone ships first, and so a second account arrives only
after every isolation test has failed on purpose and passed. Every phase is its own deploy; rolling one
back is redeploying the previous build, because each adds columns, tables or code paths that the
previous build ignores. Sizes as in 01a §7: S one place, M a contract or key with callers to follow,
L a design change.

| phase | ships | removes or proves | verified by | size |
|---|---|---|---|---|
| P0, before this design | F1 and E2 (rotate `AUTH_SECRET`, set `SPOTIFY_OWNER_ID`), E3 (gate `logout`), STORE_MIGRATION's lanes | live exposures today (01b §6, 01e §7) | those lanes | – |
| P1a | `listened_ms`, the all-time accumulator, the Home payload patch, the `contexts` scan, one marker bump per batch, with §13's fenced fill | §3 rows 1, 2 and 9: ~75% of Rem's reads [estimate: (2.24M + 0.95M + ~0.04M) / 4.25M] | known-answer tests (accumulator = `allTimeStats` over fixtures with out-of-order inserts; patched payload = rebuilt payload after a day of synthetic harvests); `verify-derived.mjs` extended; Turso's usage before and after | M |
| P1b | segments in `payloads`, the manifest in the page, the segment route, lazy days, the strip and the all-time list from segments, phase E keyed per segment | §3 rows 3-4, and the 2 MiB cliff; **must ship before mid-December** (01d §3.2) | segments equal `readHistoryIndex()` slices; 01d §2.3's throttled-browser harness; T2's numbers on `/usage` | L |
| P1c | `/me/player`-only probe, harvest on track change (F = 2, one user), rescans through `snapshot_id`, no `/me`, weekly Liked refetch, `refreshHistoryAction` without Spotify, 15 s now-playing, 429s read by reason | §3 rows 8, 10, 11; Spotify calls roughly halved | `tests/harvest-gate.test.ts` extended; `api_log` counts per source before and after | M |
| P1d | the rewritten orphan predicate (§10.1), the library body patch with the unique count | §3 rows 5-7 | known answers: both predicates give the same verdict on every play of a full pass (done once on the Aug 11 copy, §10.1); patched body = rebuilt body after member diffs | M |
| P2 | app database, `users`, encrypted `user_tokens`, `sync_state`; uid and epoch on the session; the per-user token core and its six tests; §13 step 4 | one identity per request, F1 closed for good | 01e §5.2's tests; Rem signs in once | M-L |
| P3 | the `UserDb` handle; uid in every remaining cache key, ETag and browser store; task owners; admin-only `/usage`; the tick with its lock, state and governor; the second pinger; uid on telemetry; per-database backups with dump checks; the deletion path, exercised on a throwaway test database; Preview and dev off production | §6's surfaces | the two-user suite (§6), each test first shown failing against a planted bug | L |
| P4 | the privacy policy and end-user agreement, `scripts/invite.mjs`, the first friend on the allowlist | the quota question (01c decision 3, the passive way): a week of quota days on `/usage` with per-user attribution | the week's ledger; no cross-user marker in any response | S-M |
| P5 | up to four friends, one a week | the governor finds F | T3's lag numbers per user | S |

Backing out of P4 or P5 needs no deploy: setting a friend's `status` to `disabled` stops their sync and
their sessions and keeps their data; the owner guard can come back behind a flag.

## 16. Costs

Monthly, every user Rem-like. Vendor prices from 01f §2.2 and §4.2 and the Turso pricing page
(fetched 2026-10-14).

| | 5 users | 25 users (Spotify does not allow) | 250 users (Spotify does not allow) |
|---|---|---|---|
| Turso | Free, $0; or Developer at $4.99 billed yearly ($5.99 monthly) as insurance against a block (§18) | Free, $0 | Developer, $4.99-5.99 |
| Vercel | Hobby, $0, if Active CPU fits (unmeasured); else Pro, $20 | invocations fit Hobby (~193,000); CPU unmeasured, so $0-20 | Pro, $20, with usage drawn from its $20 credit first; invocations ~$1 at $0.60 per million |
| cron-job.org (second pinger) | $0 | $0 | $0 |
| the Zenbook | $0; it runs anyway | $0 | $0 |
| Spotify | $0; Rem's Premium is required for the app to work at all (01f §1.2) | | |
| **total** | **$0-26** | **$0-26** | **~$25-30**, plus Active CPU beyond the credit |

01f §5.3 priced today's code at $5-26 for five Rem-like users (Turso's free plan cannot hold their
reads) and $93-161 at 250 (Vercel ~$68-132 of it, mostly Active CPU and provisioned memory estimated
linearly from Rem's instance time). Here the tick is one invocation a minute of ~4-8 s at 250 users,
~70 hours of instance time a month, ~150 GB-hours [estimate], instead of per-user rebuild work; page
renders are the unmeasured remainder in both. Friends cannot be charged: lazyboy is a Streaming SDA,
and Spotify permits no commercial use of one (01f §1.5).

The engineering cost is the phases of §15: three M-sized single-user steps and one L, then an M-L and
an L before the first friend.

## 17. Scorecard: each target met or missed, and the options where missed

| target | met? | where | if missed: the options and what they cost |
|---|---|---|---|
| T1: five users | yes, at Spotify's cap | §1 | – |
| T1: 25 and 250 | **no, on one Spotify app** | §1, §7.4, §10.4 | a grandfathered list, if the dashboard shows one (a one-minute read); each person running their own copy (01f option E: $0 hosting each, about an hour of setup each, their own Premium). Even with the cap lifted, the shared recently-played budget cannot keep 250 users complete, and their probes alone exceed the 30-second rate limit observed safe |
| T2: first visit ≤ 2 s at 4×, 10 Mbit/s | yes for light, typical and heavy one-year users and for Rem (0.7-1.6 s); **no** for a heavy three-year user (~2.6 s) | §9.4 | one art and album dictionary per user (M, ~2.3 s); loading the library and the newest months first, with the box saying older history is still loading (M, usable in ~1.2 s) |
| T2: slow 4G | **no** (Rem ~5.9 s) | §9.4 | the same newest-first loading: the library and the current month (~400 KB) usable in ~2.5 s, everything in ~6 s |
| T2: repeat visit ≤ 300 ms | yes, ~80 ms | §9.4 | – |
| T2: keystroke ≤ 50 ms at 4× | yes up to ~30,000 entries (Rem ~25-35 ms) | §9.4 | past that, a worker with precomputed one-letter candidates (M) |
| T3: observed freshness | yes, ~1-2 s after an open | §7.8 | – |
| T3: stored ≤ 2 min | yes for one or two Rem-like users; **~10-12 min at five** if the quota is shared | §7.4 | server-side provisional plays from the probe (01c §5.3 ii): 2-minute stored freshness for everyone at ~47 harvests a day each, for medium-to-large work (a provisional flag through the skip chain, the totals and the payloads, plus a reconciliation and its tests); or the quota proves per user and F stays at 2 |
| T3: completeness | yes while either pinger runs | §7.8, §12 | – |
| T4: reads ≤ 100,000, writes ≤ 2,500, growth ≤ 50 KB a day | yes on a typical day: ~75,000 read, ~1,800 written, ~40 KB; a worst-case day, every rare term at its maximum, reads ~103,000 | §10.2 | an incremental backup removes ~42,000 reads a day |
| T4: five users under 5% of Free | yes: reads 2-3%, writes 4.2%, storage 1.5% | §10.3 | – |
| T4: 250 users under $10 a month of store | yes: Developer, $4.99-5.99 | §10.3 | – |
| T5: no apartment machine on a request path or as the only capture trigger | yes | §12 | – |
| T6: isolation | by construction, plus tests that do not exist yet | §6 | proven only once the two-user suite has failed against planted bugs and then passed |

## 18. Decisions that are Rem's

Specific to this design, each with my recommendation:

1. **Plan for five, and use 25 and 250 only for sizing.** Recommended: Spotify's policy allows no more
   on one app and money does not change that (T1). One minute on the dashboard's User Management list
   settles the count and whether you count toward it.
2. **Do the single-user performance phase (P1) before any multi-user work.** Recommended: it removes
   ~98% of your own store reads [estimate, §10.2: ~75,000 of 4.25M a day remain] and the late-December
   cache cliff, whether or not anyone else ever signs in. P1b has a deadline: mid-December.
3. **A database per user, or one shared database.** Recommended: per user (§4.1). No query can
   silently become O(all users), each user's cost is measured by Turso, and your data stays where the
   migration puts it. The shared store wins only if friend features that join across users become the
   priority.
4. **Closed-app freshness if the quota is shared.** Recommended: the governor (§7.4): 2-minute stored
   freshness while one or two people listen like you, ~10 minutes at five, with what anyone sees on
   screen unaffected. The alternative, server-side provisional plays, keeps 2 minutes for everyone at
   medium-to-large cost (§17).
5. **Turso's Developer plan before the second user.** Recommended, $4.99 a month billed yearly. Not for
   capacity (five users use under 5% of the free plan) but because on a shared plan one regression
   blocks every user's every query until the 1st, and August showed regressions happen (READ_QUOTA
   "Where August actually went"). The alternative is staying free and watching the daily usage record,
   which R6 keeps from alerting anyone.
6. **Hobby or Pro on Vercel**, after reading Active CPU on the dashboard (01f decision 3). I could not
   measure it.
7. **The search target's network.** Recommended: 10 Mbit/s, with slow 4G a stated miss; meeting slow
   4G takes the newest-first loading in §17 (M).
8. **The all-time list grouped by song identity**, so a song Spotify relinked under two ids shows once
   (§9.3). Recommended: yes; search already uses that identity.

Carried from the overviews, unchanged by this design: retention for invited users and five-day backups
for non-owners (01a decisions 2-3, 01e decision 4); what sign-out means (01e decision 2: sign out,
sign out everywhere, disconnect); whether an `invalid_grant` under six months counts as a disconnect
(01e decision 3); the recorder owner-only and hourly (01c decision 4); the derived-metrics policy risk
(01f decision 6); F1 tonight (01e decision 1); and confirming the window of the Oct 14 incident's
foreign plays so they can be removed before your history is labelled yours (01b E6, §13).

## 19. What I ran, and what I did not measure

Nothing ran against the production store, the Zenbook, any Turso database or Vercel. Every
**[measured]** number above is an overview's measurement, cited with its source there, except §10.1's,
which are mine; every design number is an **[estimate]** with its arithmetic beside it.

- §10.1, Oct 14 about 10:50 PM, on the Mac only: `sqlite3 -readonly
  'file:data/replica.db?immutable=1'` (the Aug 11 local copy; nothing written, no WAL opened) running
  two files from `~/.claude/broke/scratch/lazyboy_mu/0222_design_b/`: `orphan_plans.sql`
  (`EXPLAIN QUERY PLAN` of the newOnly `UPDATE` in both forms, then per-play counts of the rows each
  form matches) and `orphan_equal.sql` (both predicates as `SELECT`s over every play, compared).

- Read in full: the six overviews (`01a`-`01f`), `docs/STORE_MIGRATION.md`, `docs/READ_QUOTA.md`,
  `docs/SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/GOTCHAS.md`, the project's `CLAUDE.md`. Not read:
  the other two designs, as the brief requires.
- Code read, at `ac6f7fe`: `src/lib/db.ts` lines 1-1739 and 1925-1995, `src/lib/skip-rule.ts`,
  `src/lib/harvest-gate.ts`, `src/lib/sync/history.ts`, `src/lib/sync/library.ts`,
  `src/app/api/cron/sync/route.ts`, both `src/app/api/search/*/route.ts`,
  `src/app/(app)/home/den-home.tsx` lines 366-390, 590-700 and 735-830,
  `src/app/(app)/history-actions.ts` lines 60-80.
- `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json next.config.ts package.json`:
  empty, so the overviews' line numbers hold.
- Vendor pages, fetched read-only about 10:15 PM on Oct 14: https://turso.tech/pricing (plans and
  limits; no mention of archiving idle databases), https://docs.turso.tech/help/usage-and-billing (how
  rows are counted; `BLOCKED` past a quota), https://docs.turso.tech/api-reference/databases/usage
  (per-database usage), https://docs.turso.tech/api-reference/databases/create (seeding from another
  database; name rules), https://docs.turso.tech/cli/group/tokens/create and
  https://docs.turso.tech/api-reference/groups/create-token (a group token reaches any database in the
  group; "cannot be revoked individually").

Not measured, and what each would change:

- **Whether the recently-played quota is the developer account's or each user's** (01c §4). It sets F
  at five users (§7.4) and decides whether 25 or 250 could ever be complete.
- **The player and library buckets' limits** and the development-mode rate limit's number.
- **Vercel Active CPU** (01f §2.3): Hobby or Pro.
- **Rem's plays per playlist context**, which size the scoped orphan pass (§10.1); one pass on the
  Turso copy, read off Turso's usage before and after, would.
- **Latency to many databases from one function**: R1 measures one database. An idle connection is
  kept ~4 s, so most page loads open one in-region connection to the user's database; untimed.
- **Whether deleting a Turso database deletes its point-in-time history** (§14).
- **Real phones and real networks** (01d §8); every phone figure is 01d's 4× throttle on the Mac.
- **How friends listen and use the app.** Every budget assumes a Rem-like listener; the app-heavy
  visit counts are assumptions.
- **Whether `/v1/me` returns `account_id`** to this development-mode app (01e §8); the first sign-in
  after P2 settles it.
- **Whether cron-job.org holds a one-minute schedule** reliably; it ran this route every 2 minutes
  until Aug 10.
