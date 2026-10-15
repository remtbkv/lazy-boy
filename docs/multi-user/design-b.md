# Design B — multi-user lazyboy, performance and scale first

Lane 0222_lb_mu_design_b, Oct 14, 2026. Planning only: nothing here changed code, data, the Zenbook
store or Vercel. One of three independent designs; this one starts from performance and scale: search
stays instant and sync stays fresh at 250 users on the cheapest store that holds, with the arithmetic
for every budget. Built on the six overviews (`01a-data.md` to `01f-platform.md`), cited as 01a §n
and so on; code line numbers are against `ac6f7fe` (no file under `src/`, `scripts/`, `ops/` or
`tests/` changed since). Every number is labelled **[measured]** with its source, or **[estimate]**
with the arithmetic.

Status: outline. Sections are filled and committed one at a time.

## 0. Summary

(to be written last)

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
  miss for first visits above a light user (§17), not a target, unless Rem decides otherwise.
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
- *Completeness* is a floor, not a target: no play is lost while either pinger runs, because every
  user is harvested before 25 tracks pile up, half of recently-played's 50 (GOTCHAS "`recently-played`
  only returns the last 50 plays").

Why split: 2-minute stored freshness for five Rem-like users costs ~750-830 recently-played calls a day
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

These put five users under 5% of Turso's free plan on every dimension and 250 users on a plan under
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
3. **A per-minute scheduler with a per-user due queue, leases and a quota governor.** Freshness signals
   come from the player probe, a bucket Spotify has never rationed here; recently-played harvests are
   rationed across users inside the developer account's daily budget; one user's failure stays in that
   user's slot (§7).
4. **Search from the browser's own copy**: segments under versioned, immutable URLs, kept in IndexedDB
   per user and segment (STORE_MIGRATION phase E, with a finer key), day lists built on demand, and a
   virtualized result list (§9).
5. **Two independent pingers** (the Zenbook's timer and cron-job.org) behind the queue's lease, so
   closed-app capture survives either one (§12).

```
browser ─► Vercel functions (iad1)
             ├─ app DB, Turso `lazyboy-app`: users · user_tokens (AES-256-GCM) · invites ·
             │        sync_state (due queue, leases, harvest state) · quota_ledger · meta (global)
             ├─ user DBs, Turso, one per user, same group (Rem's is `lazyboy`):
             │        tracks · plays (+listened_ms) · contexts · playlists (+snapshot_id) ·
             │        playlist_tracks · saved_tracks · meta · payloads (segments, library, home)
             └─ telemetry, Zenbook sqld via the Funnel, best effort, never awaited:
                      api_log · client_metrics · usage_ledger, each with a nullable uid
pingers: Zenbook timer (1 min) + cron-job.org (1 min) ─► /api/cron/sync, deduplicated by the lease
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
| 5 | unscoped orphan pass (`db.ts:724-751`) | the library's playlist id set moved, ~3 a week | ~5,100,000 as Turso counts it (01c §2.8) | 394,820 as the meter counted 3 runs | plays × members | lanes 1910-1911 scope it; kept scoped (§8) |
| 6 | unique-song count (`db.ts:1969-1991`) | a library sync that changed anything; the daily Liked refetch always counts as a change (`sync/library.ts:81-84`) | ~39,000 | ~160,000, 4 runs | library members | counted inside the library body's build and patch (§8) |
| 7 | library payload rebuild (`db.ts:1625-1684`) | a fetch after `library_seq` moved, which every list rewrite does | ~15,000 | 0-2 runs a day (ledger, 01d §2.2) | members | patched per changed playlist (§8) |
| 8 | library rescan's snapshot reads (`sync/library.ts:65-66`) | every rescan, ~30 a day | ~110 serial one-key reads | ~3,500 round trips | owned playlists | one statement over a `snapshot_id` column (§7) |
| 9 | daily contexts pass, `unresolvedContextUris` (`db.ts:646-667`) | once a day | ~43,000 [estimate: ~2 rows per contexted play, READ_QUOTA "Attribution": 14.1K at 7,194 plays] | one run | stored plays | a scan of the 114-row `contexts` table (§8) |
| 10 | harvest that lands nothing (`db.ts:480-496`, `unseenContexts`) | 155 a day | ~215 | ~33,000 | – | diff against the previous batch's keys in sync state: 0 user-DB rows (§7) |
| 11 | idle tick: token, two gate stamps | 436 a day | ~3 | ~1,300 | – | one claim statement for all due users (§7) |
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
- **Each user's cost is measured, not modeled.** Turso reports rows read, rows written and storage
  per database (§1, T4). In a shared store the per-user split would come from the ledger and
  `api_log`, which disagree by ~30% on the same events (01c §2.8).
- **Every statement and plan carries over unchanged**, so §8's changes are measured against today's
  plans and the 50-plus unscoped statements need no user predicate (01a §8.1: D4-D19 vanish).
- **Deletion and backups are per database** (§14).

What it costs: Turso's free plan allows 100 databases, so 98 users plus the app and template
databases (250 needs the Developer plan, which 250 users' writes need anyway, §10); one more warm
connection per active user per function instance (an in-region TLS handshake, a few milliseconds
[estimate]; undici keeps an idle connection ~4 s by default); a schema change is a loop over
databases (§4.6); cross-user features (the roadmap's friends) merge two reads in code; and `tracks`,
public catalog rows, is stored once per user (4.2 MB for Rem, ≤ 1 GB at 250 such users, §10).

One group token reaches every database in the group ("a new token that can be used to connect to any
database in the group", https://docs.turso.tech/cli/group/tokens/create, fetched 2026-10-14), so the
runtime holds one store secret, as today. A user's database URL is derived from its name, so a request
can open the user's database from the uid in its session cookie without a lookup, in parallel with
the app database's identity check (§5).

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
  created_at     INTEGER NOT NULL
);
CREATE TABLE user_tokens (             -- 01e §5.2, encrypted blob (§5)
  uid TEXT NOT NULL, env TEXT NOT NULL, blob TEXT NOT NULL,
  expires_at INTEGER NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (uid, env)
);
CREATE TABLE invites (                 -- what Rem can see before the person signs in (01e §5.4)
  spotify_id TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at INTEGER NOT NULL, claimed_at INTEGER
);
CREATE TABLE sync_state (              -- the due queue and harvest state (§7)
  uid TEXT PRIMARY KEY, state TEXT NOT NULL, next_due_at INTEGER NOT NULL,
  lease_owner TEXT, lease_until INTEGER,
  last_probe_at INTEGER, last_track TEXT, last_progress_ms INTEGER, last_active_at INTEGER,
  changes_since_harvest INTEGER NOT NULL DEFAULT 0, last_harvest_at INTEGER,
  batch_keys TEXT,                     -- the previous harvest's 50 played_at stamps, ~0.6 KB
  next_rescan_at INTEGER, last_rescan_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_ok_at INTEGER,
  lag_p50_s INTEGER, lag_p95_s INTEGER -- T3's instrument, rolled up by the daily route
);
CREATE INDEX idx_sync_due ON sync_state (next_due_at);
CREATE TABLE quota_ledger (            -- Spotify calls per quota day and bucket (§7.4)
  quota_day TEXT NOT NULL, bucket TEXT NOT NULL, calls INTEGER NOT NULL,
  PRIMARY KEY (quota_day, bucket)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- global keys only
```

### 4.3 Each user's database

Today's seven core tables, with two columns added and one table:

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
| `playlist_tracks`, `saved_tracks` | user DB | none |
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
statements on every cold instance (`db.ts:153-297`); against N databases that is ~10 statements per
database per cold instance, on the request path. Instead:

- Every database carries `meta.schema_version`, mirrored in `users.schema_version`. Code declares the
  version it needs and never runs DDL on a request; a user whose database is behind gets a short
  "updating" state, and nobody else notices.
- A new user's database is created from a template, `lb-template`, which holds the current schema and
  no rows: Turso's create-database call takes `seed: {type: "database", name}` (names: "lowercase
  letters, numbers, dashes. No longer than 64 characters",
  https://docs.turso.tech/api-reference/databases/create, fetched 2026-10-14). The provisioning
  script runs when Rem creates an invite (§14), so sign-in never waits on it and the platform token
  stays out of the Vercel runtime (01e §6).
- A migration is `scripts/migrate-dbs.mjs`: per user, pause that user's sync through its lease, apply,
  verify, bump the version, resume. Additive changes only on live databases; anything that rebuilds a
  table runs on one user at a time behind a snapshot (Turso's point-in-time restore: 1 day on Free, 10
  on Developer, pricing page fetched 2026-10-14).

## 5. Tokens: per user, encrypted at rest

## 6. Isolation, and the tests that prove it

## 7. Sync: fan-out, freshness and Spotify's budget

## 8. The write path: derived data updated by append

## 9. Search: payloads, caching, and the budget for every step

## 10. The store budget per user per day, and the plan that holds at 5, 25 and 250

## 11. The store choice, and what STORE_MIGRATION needs

## 12. Uptime: the Zenbook and the other single points

## 13. Migrating Rem's data with nothing lost

## 14. Sign-up gating, privacy and account deletion

## 15. Rollout in reversible phases

## 16. Costs

## 17. Scorecard: each target met or missed, and the options where missed

## 18. Decisions that are Rem's

## 19. What I ran, and what I did not measure
