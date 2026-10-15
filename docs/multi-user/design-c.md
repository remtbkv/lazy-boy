# Design C — simplest safe migration first: a database per user

Lane 0222_lb_mu_design_c of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store or Vercel. Line numbers are against `774bb21` (`src/`,
`scripts/`, `ops/` and `tests/` are unchanged since `ac6f7fe`, the commit the six overviews cite;
`git diff --stat ac6f7fe HEAD -- src scripts ops tests` is empty). Every number is **[measured]**
with its source, or **[estimate]** with the arithmetic. Inputs: the six overviews `01a`-`01f` in
this directory, `docs/STORE_MIGRATION.md`, `docs/GOTCHAS.md`, `docs/SECURITY.md` and the code.
I did not read the other two designs.

Status: outline (sections fill in order; §0 is written last).

## 0. Summary

## 1. Targets, as briefed and as refined

The brief set five targets. Three of them needed a sharper definition before a design could be
checked against them, and one could not stand as written: Spotify's development mode allows five
users, not 25. Isolation is implied by "keep it all secure" and is listed first because every
other target assumes it.

| id | as briefed | as this design plans to it | why the change |
|---|---|---|---|
| T0 | "keep it all secure" | No request, background job, cache entry or browser store can return or change another user's data, and a test suite run on every `npm test` proves it. A user's revoked token, de-allowlisting or Spotify error never stops another user's capture. | made explicit |
| T1 | 25 users under development mode, with the path to more | **5 accounts, Rem included** (Rem plus four friends). Past five, each person runs their own copy (option E in 01f §5.2); nothing in Spotify's current policy lets one app serve more. | quota-modes page: "Up to 5 authenticated Spotify users can use an app that is in development mode"; extended quota mode "only accepts applications from organizations (not individuals)" with "at least 250k MAUs" (both quoted in 01f §1.2-1.3, fetched Oct 14). 01c §4 and 01e §5.4 reach the same number. `docs/SECURITY.md:70-71` still says 25; that figure is Spotify's Client-ID limit, not a user limit (01f §1.2). |
| T2 | first search payload under 2 s on a phone; keystroke filtering under 50 ms | On a mid-tier phone (Chrome's 4× CPU throttle as the stand-in, the convention 01d §2.3 measured with) on a 10 Mbit/s mobile connection: search usable (`lb:history-ready`) ≤ 2 s after Home's first paint on a **first visit**, ≤ 300 ms on a **repeat visit** (STORE_MIGRATION R3). A keystroke's match, rank and cap ≤ 50 ms at 4×; keystroke-to-paint ≤ 50 ms measured with `lb-perf` on a real phone. A first visit on slow 4G (1.6 Mbit/s) is outside the target (§14). | "a phone" and "first payload" needed a device, a network and a clock to be testable; R3 already defines the two visit kinds |
| T3 | history freshness within about 2 minutes for an active user | A play that ends while its user is listening is stored ≤ ~2 min 5 s later (p50 ~1 min), app open or closed; an open app shows it at once through its own provisional play. No play is lost while either pinger runs. If the shared Spotify quota forces it (§6.4), closed-app plays reach the store ≤ 15 min late for the rest of that quota day, and an open app still shows them at once. | 01c §5.1: five Rem-like users on today's policy need 800-1,700 recently-played calls a day against a shared budget of ~725-800; the target needs a stated fallback |
| T4 | the store's reads and growth per user per day | Reads: a per-user daily budget by listening profile (§12.4), totalling ≤ 50% of Turso's free 500M rows a month at five users with typical friends (R4's bar), with the levers that hold it named. Writes ≤ 10% of 10M. Core growth ≤ ~50 KB a day per user. | reads bind first on every Turso plan by two orders of magnitude (01f §4.4); storage does not (01a §9.1) |
| T5 | uptime with the Zenbook's single point of failure addressed | No user-visible request depends on the Zenbook (STORE_MIGRATION R2, delivered by the move). Closed-app capture survives a Zenbook outage of any length (a second pinger off the Zenbook, §6.5). The shared-fate dependencies that remain (Vercel, Turso, the Spotify app's standing, Rem's Premium) are named with what each failure costs (§12.5). | after the move the 2-minute pinger is still on the Zenbook and is every user's closed-app capture (01c §6 item 4, 01f §3.5) |

Two numbers the targets rest on are not measured, and the rollout gates on both (§11): whether
Spotify's dev-mode quota is one pool for every user of the app or one per user (01c §4, 01f §1.4),
and how much of Vercel Hobby's 4 Active-CPU-hours a month the team already uses (01f §2.3).

## 2. The design on one page: what changes and what does not

### 2.1 The shape

Each user's data lives in a libSQL database of its own on Turso, with today's seven core tables
and today's SQL. A small app database holds the user list, the encrypted Spotify tokens and the
few keys that are app-wide. The database a statement is sent to is the user scope. Rem's
database is the one STORE_MIGRATION's cutover creates (`lazyboy`, §8 step 6 there); it becomes
user 1's database without being copied, rebuilt or rewritten.

```
Vercel functions (iad1)
  ├─ app client ──────────► Turso lazyboy-app       users, user_tokens (AES-256-GCM), meta (app-wide keys)
  ├─ user client, uid 1 ──► Turso lazyboy           Rem's data: today's schema, untouched
  ├─ user client, uid 2-5 ► Turso lazyboy-u<uid>    one friend's data each, the same schema
  └─ telemetry client ────► Zenbook sqld (Funnel)   api_log, client_metrics (+ user_id), usage_ledger
Pingers: the Zenbook timer and a cron-job.org job, both → /api/cron/sync every 2 min.
         One tick serves every user; a 90 s lease turns the second pinger's tick into a no-op.
Zenbook: the telemetry store, Rem's backstop recorder, nightly backups of every database,
         one of the two pingers. Nothing a user waits on.
```

### 2.2 Why a database per user is the smallest safe change

01a §8.1 lays out both data models; its census (§7) is the measure. Under a shared store with a
`user_id` column, 17 of its 38 items are SQL-level (D4-D9, D12-D19, D21, D23, D25): five table
rebuilds, five new user-led indexes on `plays` alone, a `user_meta` table, and more than fifty
statements that each have to gain `user_id = ?`. The misses are not cosmetic. One user's library sync deletes every user's playlists (D12,
`db.ts:1848-1883`); a play is dropped when another user played the same track in the same
millisecond (D17); skip verdicts and listened time chain each play to the previous play of any
user and are then stored (D18). No compiler or type checks a `WHERE` clause.

With a database per user, none of those statements changes: a statement sent to user 2's
database cannot see user 1's rows. The meta keys that are per user (markers, stamps, payloads,
locks) are per user because each database has its own `meta`. What is left to get right moves to
four places both models share: which client a function gets, the cache keys, the module-level
state, and the tokens. Rem's data stays where the cutover puts it.

The scope travels as an explicit argument. Every per-user function in `db.ts` takes `uid` as its
first parameter and gets its connection from `getClient(uid)`, so a call site that forgets the
user does not compile. The edit is large and mechanical: 74 exported async functions in `db.ts`,
54 `getClient()` sites inside it, and about 235 call lines elsewhere in `src/` plus about 300 in
`tests/` [measured: grep over `774bb21`; the call-line counts are upper bounds, since a grep for
`name(` also catches same-named methods in other modules]. `tsc --noEmit` is the oracle for
whoever makes it, which suits a mechanical lane.

The smaller-diff alternative, an ambient user in `AsyncLocalStorage` set at each of the ~45 entry
points, is rejected. React renders the Server Components a page returns from its own work loop,
so a store set by `run()` inside the page function is not guaranteed to reach them; whether it
does depends on framework scheduling I have not tested, and `after()` and the task registry add
two more such questions. 01e §5.1 rejects it for the same family of reasons. Isolation should
not rest on details like that.

`getClient(uid)` fails closed. Uid 1 maps to `TURSO_DATABASE_URL`; any other uid maps to
`lazyboy-u<uid>` through one URL template; a uid with no mapping throws. It never falls back to
the default URL, which is the one way this model could hand Rem's data to someone else.

The model's costs, at five users: the nightly backup loops over six databases instead of one;
a schema change runs once per database (additive changes already do, through `init()` on each
client's first use); a future friends feature reads two databases and merges in code rather than
joining; and Turso must allow the databases (the free plan allows 100, 01f §4.2). Rows read are
counted per organization, so the model does not change the read budget (01a §8.1).

### 2.3 The change list

Sizes as in the overviews: **S** one place; **M** a function's contract changes and callers
follow; **L** a mechanical edit across many files, or a loop over users. Every item cites the
overview finding it answers.

| id | change | size | phase | detail |
|---|---|---|---|---|
| M0a | rotate `AUTH_SECRET` in Production and Preview (ends every session minted before the owner guard, the second account's included) | config | 0 | 01b E1, 01e F1 |
| M0b | set `SPOTIFY_OWNER_ID` in Production (the guard runs on the stored `me_id` today) | config | 0 | 01b E2, 01e §1.2 |
| M0c | `logout` checks the session before it clears the token row | S | 0 | 01b E3 |
| M1 | the app database and `src/lib/app-db.ts`: users, user_tokens, app-wide meta; the identity read, the user list, the Spotify cooldown, the refresh lock | M | 1 | §3, §4 |
| M2 | `db.ts`: `getClient(uid)`; `uid` first on every per-user function; the token and cooldown functions move to M1 | L, mechanical | 1 | §2.2, §3 |
| M3 | every caller passes `uid`: entry points from `requireUser()`, background tasks and the cron from the user they serve | L, mechanical | 1 | §5.1 |
| M4 | `uid` and a session epoch on the JWT; cookies without them refused; `requireUser()` | M | 1 | §4.1 |
| M5 | the token core in its own module: per-uid in-flight map and lock, AES-256-GCM with the uid as associated data, the cookie-held-token paths removed | M | 1 | §4.2-4.3 |
| M6 | `uid` as an argument of the seven `unstable_cache` wrappers, a uid in both search ETags, React `cache()` boxes keyed by uid | S-M | 1 | §5.2 |
| M7 | module state: `playlistsCache` deleted; `currentSyncId`, `uniqueRecomputeKickedAt`, `storeSizeMemo` per uid; tasks carry an owner the route checks | S each | 1 | §5.3 |
| M8 | the cron tick loops over users (`allSettled`, 25 s each), takes a 90 s lease, answers per-user outcomes, and harvests on a track change instead of on every playing tick | M | 1 | §6 |
| M9 | `refreshHistoryAction` honours the per-user 60 s harvest debounce `/api/sync` already has | S | 1 | §6.3 |
| M10 | nullable `user_id` on `api_log` and `client_metrics` | S | 1 | §10.2 |
| M11 | tests: a keyed `unstable_cache` stub, the two-user isolation suite, token-core known answers, a structural uid test, cron isolation | M-L | 1 | §5.4 |
| M12 | a one-shot setup script: the app database's tables, Rem's user row, his token copied and encrypted | S | 1 | §9 |
| M13 | the invite gate replaces the owner guard; `scripts/invite.mjs` creates a friend's database and user row; a cap of five | S-M | 2 | §10.1 |
| M14 | terms and privacy pages; consent recorded at first sign-in | S | 2 | §10.2 |
| M15 | sign out, sign out everywhere, disconnect-and-delete; the deletion job | M | 2 | §10.3 |
| M16 | `/usage` and the telemetry admin-only | S | 2 | §10.2 |
| M17 | a per-user time zone (IANA name) for the Home payload | S | 2 | §3.3 |
| M18 | browser storage stamped with the uid and cleared on sign-out | S | 2 | §5.3 |
| M19 | a second pinger on cron-job.org | config | 2 | §6.5 |
| M20 | Preview and dev cannot reach friends' databases | config | 2 | §8.2 |
| M21 | backups loop over databases; friends' and the app database's files kept five days | S | 2 | §10.3 |
| M22 | a daily recently-played budget brake: batch closed-app harvests past a threshold | S-M | 3 | §6.4 |
| M23 | library rescans stop calling `/me`; the recorder runs hourly | S + config | 3 | §6.4 |
| M24 | read levers if the projection needs them: the all-time recompute gate 10 → 60 min, then an incremental accumulator | S, then M | 3 | §12.4 |
| M25 | the now-playing poll 6 → 15 s mid-track, only if per-user call logs show visible tabs crowding Spotify's 30 s window | S | 3, if needed | §6.4 |

Two items on the search target's path are single-user work with their own deadline, not part of
the multi-user change: building the day list lazily (01d O6) and moving the 7,529 catalog rows
into a body of their own (01d O2), before the owner's history entry outgrows the Data Cache's
2 MiB item limit in late December (01d §3.2). §7 covers both.

### 2.4 What stays exactly as it is

- Every SQL statement in `db.ts`, and the schema of user data.
- Rem's data: no copy, no table rebuild, no rewrite. The only row that moves is his token, and its
  original stays in place until the rollback window closes (§9).
- The harvest, skip, orphan, Home payload and search payload logic, now run per user.
- The scripts. They already take a database URL (`backfill-from-backstop.mjs --db`, STORE_MIGRATION
  §8 step 13); pointed at a user's database they are scoped to that user.
- STORE_MIGRATION's lanes 1901-1911, apart from four small edits (§8.3).

## 3. Data model: where every table and meta key lives

### 3.1 Three kinds of database

**A user database**, one per user: `tracks`, `plays`, `contexts`, `meta`, `playlists`,
`playlist_tracks`, `saved_tracks`, exactly as `init()` creates them today (`db.ts:153-297`). A new
user's database starts empty and gets its tables from `init()` on the first connection, the same
way the dev file does. Uid 1's database is Turso `lazyboy`; uid N's is `lazyboy-u<N>`.

**The app database**, `lazyboy-app`, new and small:

```sql
CREATE TABLE users (
  id             INTEGER PRIMARY KEY,   -- uid; 1 = Rem
  account_id     TEXT UNIQUE,           -- Spotify account_id; NULL until an invitee first signs in
  spotify_id     TEXT NOT NULL UNIQUE,  -- what an invite names; refreshed at every sign-in
  status         TEXT NOT NULL,         -- invited | active | needs_reconnect | disabled | deleting
  admin          INTEGER NOT NULL DEFAULT 0,
  session_epoch  INTEGER NOT NULL DEFAULT 0,
  agreed_version TEXT,                  -- terms and privacy version accepted (M14)
  agreed_at      INTEGER,
  last_sign_in   INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE TABLE user_tokens (
  uid        INTEGER PRIMARY KEY,       -- users.id
  blob       TEXT NOT NULL,             -- "v1." + base64url(iv ‖ ciphertext ‖ tag), §4.3
  expires_at INTEGER NOT NULL,          -- plaintext, so the cron sees who needs a refresh
  granted_at INTEGER NOT NULL           -- last consent: the 6-month refresh-token clock (01e §2.1)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- app-wide keys only, §3.2
```

This is 01e §5.2's sketch with three differences. The key is an integer uid with `account_id` as
a unique column, so Spotify ids stay out of cache keys, ETags and browser storage (01a §8.4). There
is no `env` column: dev gets an app database of its own (§8.2), so production's never holds a dev
row. And the user's database is derived from the uid, so the row carries no URL.

**The telemetry store**, the Zenbook's sqld after STORE_MIGRATION (§5 there): `api_log` and
`client_metrics` each gain a nullable `user_id` (M10, an additive column `init()` can add);
`usage_ledger` stays global.

### 3.2 Every `meta` key

01a §3's table lists every key kind the code writes. Each lands in one place:

| key | today | in this design |
|---|---|---|
| `spotify_tokens`, `spotify_tokens_dev` | Rem's `meta`, plaintext (`db.ts:2511-2531`) | the token moves to `user_tokens`, encrypted. Both old rows stay untouched in Rem's database until the Phase 1 rollback window closes, then are deleted (§9) |
| `lock:spotify_refresh` | one lease for everyone (`auth.ts:212`) | app `meta`, as `lock:spotify_refresh:<uid>` |
| `spotify_cooldown_until` | Rem's `meta` (`db.ts:2376-2392`) | app `meta`, still one cooldown: Spotify's rate limit is per app and its quota per developer account (01f §1.4), so a ban is everyone's (01a D22) |
| `played_at_convention` | written only by the dead daily block (`route.ts:90`) | app `meta`, computed from uid 1's plays by the daily route |
| `me_id` | rewritten by every library sync (`db.ts:1804, 1819`) | the user's own database, unchanged. Only that user's own sync can write it now. The sign-in gate stops reading it (M13); `users.spotify_id` is the authority |
| `lock:clean:<playlist>` | `actions.ts:130, 156` | the user's database, unchanged: per user and playlist by construction (01b C8 needs nothing more) |
| `last_sync`, `write_seq`, `library_seq`, `slow_seq_pub`, `home_payload`, `alltime_stats`, `alltime_at`, `unique_song_count`, `contexts_full_check_at`, `playlists_synced_at`, `library_synced_at`, `library_scan_attempt_at`, `saved_synced_at`, `liked_total`, `liked_top_added_at`, `plsnap:<id>`, `user_tz_offset`, `player_last_active`, `rp_last_harvest`, `clean_backup_pref` | one global row each | the user's database, unchanged. These are 01a's D21 and D23 and the stored offset of D24: per user because each database has its own `meta` |
| `pltracks_at:<id>` | written, never read (01a §3) | unchanged; deleting it is unrelated cleanup |
| `last_sync_added` | dead since `1d43bc7` | left alone |
| `user_tz` (new) | – | the user's database: the browser's IANA zone (§3.3) |
| `probe` (new) | – | the user's database: last probed track id, progress and time, for harvesting on a track change (§6.2) |
| `lock:tick` (new) | – | app `meta`: the cron's 90 s lease (§6.2) |
| `rp_spend:<quota day>` (new, Phase 3) | – | app `meta`: the budget brake's counter (§6.4) |

### 3.3 The time zone

The Home payload is built on the write path, where there is no browser, so it buckets days with
the offset `/api/sync` last stored, unless that offset differs from New York's current one by
exactly 60 minutes, which it reads as a DST change no browser has reported yet
(`payloadTzOffset`, `db.ts:1304-1311`; `HOME_TZ`, `db.ts:1270`). For a friend in Chicago the
stored offset (−300 in CDT) differs from New York's (−240) by exactly 60, so their payload would
be bucketed in New York's days. The same holds for Atlantic time. M17: `TimezoneCookie`
(`src/components/timezone-cookie.tsx`) also publishes `Intl.DateTimeFormat().resolvedOptions().timeZone`,
`/api/sync` stores it as `user_tz` in the user's database when it changes, and
`rebuildHomePayload(uid)` computes the zone offset from `user_tz`, falling back to `HOME_TZ`. The
DST heuristic then compares against the user's own zone. Rem's behaviour does not change.

### 3.4 What a database per user costs in storage and schema work

Storage: `tracks` is copied per user instead of shared. A friend with a library like Rem's
starts near 3.3 MB (`tracks` 1.75 MB + `playlist_tracks` 1.45 MB, 01a §9.1) and grows ~35 KB a
day at Rem's listening rate (01a §6). Five such users are under 100 MB against the free plan's
5 GB. 01a §5's cross-user staleness of a shared catalog does not arise.

Schema changes: an additive change runs through `init()` once per database per server process,
as today. A non-additive one (a table rebuild) needs a script that loops over the databases with
writers paused, the discipline 01a §8.6 describes, once per database. `init()` costs one
`executeMultiple` plus seven small statements per database on a cold instance (`db.ts:153-297`);
with five users the cron's cold instance pays that five times, in parallel [estimate: ~40 small
schema statements per cold start; Rem's day had 28 cold starts, 01c §2.1]. A `schema_version`
key that lets `init()` skip its DDL when current would remove it; it is optional.

## 4. Identity, sessions and per-user tokens encrypted at rest

## 5. Isolation: the enforcement points and the tests that prove them

## 6. Background sync for N users inside Spotify's limits

## 7. Search: per-user payloads, caching, and the phone budget

## 8. The store: Turso, a database per user, and STORE_MIGRATION

## 9. Migrating Rem's data with nothing lost

## 10. Sign-up gating, privacy, and account deletion

## 11. Rollout in reversible phases

## 12. Each target, step by step, with its budget

## 13. Costs

## 14. Targets no design meets, and the options

## 15. Decisions that are Rem's

## 16. Unknowns, risks, and what I ran
