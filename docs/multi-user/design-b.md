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
- A migration is `scripts/migrate-dbs.mjs`: per user, pause that user's sync through its lease, apply,
  verify, bump the version, resume. Additive changes only on live databases; anything that rebuilds a
  table runs on one user at a time behind a snapshot (Turso's point-in-time restore: 1 day on Free, 10
  on Developer, pricing page fetched 2026-10-14).

## 5. Tokens: per user, encrypted at rest

01e §5 specifies this part and I take it as written, with three changes that follow from the data
model and the round-trip budget.

**The session names the uid, and every request checks it in one statement.** At sign-in the jwt
callback finds the user by `profile.account_id` (refusing a profile without one, 01e §5.5) and puts
`uid` and `session_epoch` on the token, taken from the users row only. On every later request the
callback runs one app-database statement through the request box:

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
or a stale epoch returns `null`, which ends the session; this one rule closes F1 (01e §1, F1) and asks
everyone to sign in once at rollout. `needs_reconnect` keeps a session that can read its stored history
but makes no Spotify call (01b §2.4's recommendation). The same row carries what Home's chrome and
capture banner need today from three separate reads (`home/page.tsx:78-83`: cooldown, capture health),
so identity costs no round trip that today's token read does not already pay. The page's user-database
reads start in parallel, from the uid in the decoded cookie, and nothing renders until both settle
(01b S2).

**Ciphertext bound to the uid.** AES-256-GCM, Node's built-in `crypto`, a random 12-byte IV per write,
stored as `v1.<base64url(iv ‖ ciphertext ‖ tag)>`, associated data `lazyboy:tokens:<uid>:<env>`, keys in
`TOKEN_KEYS` as a Vercel Secret in Production only; rotation re-encrypts at each user's next refresh,
about hourly (01e §5.3). A blob copied into another user's row fails to authenticate. Cost: an AES-GCM
pass over a ~600-byte blob, microseconds [estimate], against a ~15 ms round trip at STORE_MIGRATION's
R1 target.

**Refresh is per user everywhere.** The lock is `lock:spotify_refresh:<uid>:<env>`; the in-flight
refresh is a map keyed the same way (01e A2: shared, it hands user A's tokens to user B); the request
box is keyed by uid; `clearTokensIfStale` compares within one row; the cookie-held-token paths go
(01e A18). The cron's claim statement (§7.2) joins `user_tokens` for every due user, so a tick reads
all its tokens in one statement and refreshes only users whose access token has under 60 s left.
Writes: ~24 refreshes a day per active user, each a lock acquire, a token write and a release, ~72
rows [01e §5.2, estimate]; 1,800 a day at 25 users, 18,000 at 250.

The token core moves out of `auth.ts` into a module the simulated environment can load, and 01e §5.2's
six known-answer tests come first (01e A21): concurrent refreshes for two users, A's lock not blocking
B, `invalid_grant` clearing one row, a moved ciphertext failing, the four ways a cookie is refused,
and no Spotify call for a user without a row.

## 6. Isolation, and the tests that prove it

**One way in.** `db.ts` stops exporting per-user functions that reach a module-level client. Each takes
a `UserDb` first: a branded type wrapping that user's libSQL client, minted only by `forUser(uid)`,
whose `uid` comes from `requireUser()` (the verified session, §5) or from the cron's claim (§7.2),
never from request input and never from an ambient "current user" (01e §5.1 explains why
AsyncLocalStorage is the wrong tool here). App-database and telemetry functions stay module-level. A
call site that forgets the user does not compile. The client cache (`g.__listenDbReady`,
`db.ts:133-146`) becomes a small map of clients by database name, capped (64 entries, least recently
used out) so a long-lived instance does not hold every user's connection.

**What a per-user database leaves open**, and the change for each:

| surface | today | change |
|---|---|---|
| Data Cache entries (`unstable_cache`) | 7, no user in any key (01a D26) | after §8-§9 only three remain (playlist grid, the server fallbacks for a day and for the all-time list); each takes `uid` as its first **argument**, never through a closure, because Next 16.2.6 keys on the callback's source text, the key parts and `JSON.stringify(args)` (01b §3.1); each carries a `user:<uid>` tag so deletion can purge it |
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
6. The cron: two due users, B's refresh answering `invalid_grant` and B's Spotify answering 403 "not
   registered"; A's harvest lands, the tick answers 200 with per-user outcomes, B ends in
   `needs_reconnect` and `removed`.
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

Two pingers hit `/api/cron/sync` every minute: the Zenbook's timer (today every 2 minutes) and
cron-job.org (§12). The tick:

1. Takes a global tick lock, a compare-and-set on app `meta` `lock:tick` with a 55 s lease, the
   pattern `acquireLock` already uses (`db.ts:2541-2557`). The second pinger's hit in the same minute
   loses it and returns at once. This is also the tick's store health check: if the app database
   does not answer, the tick ends instead of letting each user wait out the store fetch's three
   15-second attempts (`src/lib/store-fetch.ts:28-29`).
2. Reads every user's sync state and token in one batch (`sync_state` joined to `user_tokens`;
   one row per user, 250 rows at 250 users). Who is due is computed, not stored: `active` users (a
   play in the last 30 minutes) every 2 minutes and `idle` users every 5, offset by a hash of the uid
   so users spread across the cycle. A user's state row is written only when something changed (a
   track change, a state transition, a harvest, a failure), not on every tick.
3. Processes the due users concurrently (up to 16 at a time), each under its own 25 s deadline, with
   `Promise.allSettled`: refresh the token if under 60 s remain (§5), probe, harvest if the governor
   says so (§7.4), record (§8).
4. Runs at most one due library rescan (up to 8 at 250 users), under its own deadline, after the
   harvests (§7.6).
5. Answers 200 with per-user outcomes. Non-200 only when the tick could not run, or when the owner's
   own capture is failing: the Zenbook timer's failed unit is Rem's only alarm today (01c §5.2).

Each pinger hit is one invocation: 2,880 a day whatever N is. Tick-lock writes: 2 per tick, 2,880 a
day in total [estimate]. Wall time: the slowest due user, about 1-3 s at five users through Turso;
at 250 users ~125 users fall due per minute, ~0.5-1 s each at 16-way concurrency, ~4-8 s per tick
[estimate]. The route sets `maxDuration = 60`; nothing under `src/app` sets one today, so the
project's 300 s default applies (01f §2.1).

### 7.3 The probe

`/me/player` alone, one call: it reports the active device's track and answers 204 when there is
none (GOTCHAS "Player simulation"), where today's idle tick spends two (currently-playing, then
`/me/player` on its 204; 01c §2.1). The probe records the track id, progress and `is_playing` in the
user's state; a **track change** is a different track id, or the same track with progress gone
backwards (a repeat). Calls per Rem-like user a day: ~9 h active at one per 2 min (270) plus ~15 h
idle at one per 5 min (180), ~450 [estimate] against 1,035-1,303 today.

### 7.4 The harvest governor

A user is harvested (one recently-played call, the last 50 plays) when any of these holds:

| trigger | when | calls a day, Rem-like [estimate] |
|---|---|---|
| H1 session tail | the first probe that finds playback stopped (today's `>=` rule, `src/lib/harvest-gate.ts:20-24`) | ~5 |
| H2 completeness | 25 track changes since the last harvest, half the 50-play window | 0 while F ≤ 30 min |
| H3 backstop | 2 hours since the last harvest (devices the probe cannot see; 50 plays is ~2.5-3 h of nonstop listening) | ~7 (today hourly, 24) |
| H4 open app | a visible tab's load or focus, if a track change was seen since the last harvest; ≥ 60 s apart | ~5 for Rem, ~20 for an app-heavy friend |
| H5 freshness | a track change seen, and ≥ F minutes since the last harvest | 9 h × 60 / F, at most one per play |

**F is the governor's one knob.** The quota ledger (§4.2) counts the scarce bucket's calls per quota
day; every hour the governor compares the day's spend with a straight line from 0 to 426 (450 less the
recorder's 24) across the quota day: ahead of the line, F doubles (to at most 30 minutes); behind it,
F halves (to at least 2). With one or two users F sits at 2 and closed-app capture is what it is today.
If the passive experiment (01c §7.3) shows the quota is per user, the budget becomes per user and F
stays at 2 for everyone.

The arithmetic, per Rem-like user (9 h playing, ~130 plays, H1+H3+H4 ≈ 17 a day):

| F | H5 | per user | 1 user | 2 | 5 | 25 | 250 |
|---|---|---|---|---|---|---|---|
| 2 min | ~130 | ~150 | 150 ✓ | 300 ✓ | 750 ✗ | – | – |
| 5 min | ~90 | ~107 | | | 535 ✗ | – | – |
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
  `sync_state.lease_until`, written only when a harvest starts), and harvests only by H4. Today it
  harvests whenever the last harvest is over a minute old (01c §2.4).
- `refreshHistoryAction` stops calling Spotify and only reads the store (01c S6, §5.5).
- Now-playing polls every 15 s mid-track, plus the existing end-of-track and visibility polls (01c
  §5.5): at most ~4 calls a minute per visible tab. Five users with a visible tab each: ~10 per 30 s,
  plus ~3 from the ticks' probes, inside the planned 12.
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
  not elapsed: ≤ ~2 minutes at F = 2, ≤ ~12 at F = 10.
- **Completeness.** H2 fires at 25 changes, H3 at 2 hours, H1 at every session end; at Rem's peak
  (~20 plays an hour, 01c §5.7), 25 plays take 75 minutes, so H5 fires first whenever F ≤ 30. No play is
  lost while a pinger runs.

### 7.9 Failure isolation

01c §5.4 lists the cases; each lands in this design as a state on one user's row. A user whose calls
hang uses its 25 s and is retried at its next due time. `invalid_grant` clears that user's token row
and sets `needs_reauth` (§5). A 403 "not registered" sets `removed`. The same error for every user at
once (the owner's Premium lapsing, 01f §1.2) backs the whole tick off instead of marking anyone
removed. A store failure ends the tick at step 1. Every write on this path is idempotent: the lease and
the tick lock are compare-and-sets, counters are written as values, inserts have natural keys, and
writes that outlive a response go through `after()` (01c §5.4 item 8; §2.8 there shows re-sent INSERTs
happen).

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
