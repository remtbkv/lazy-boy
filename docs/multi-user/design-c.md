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
| T3 | history freshness within about 2 minutes for an active user | A play that ends while its user is listening is stored ≤ ~2 min 5 s later (p50 ~1 min), app open or closed; an open app shows it at once through its own provisional play. No play is lost while either pinger runs. If the shared Spotify quota forces it (§6.4), plays reach the store ≤ 30 min late for the rest of that quota day, and an open app still shows them at once. | 01c §5.1: five Rem-like users on today's policy need 800-1,700 recently-played calls a day against a shared budget of ~725-800; the target needs a stated fallback |
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
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- uid; 1 = Rem; never reused
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
a unique column, so Spotify ids stay out of cache keys, ETags and browser storage (01a §8.4).
`AUTOINCREMENT` matters: plain `INTEGER PRIMARY KEY` hands a deleted maximum id to the next row,
and a reused uid would inherit the dead user's database name and any cache entry still keyed by
it. There is no `env` column: dev gets an app database of its own (§8.2), so production's never
holds a dev row. And the user's database is derived from the uid, so the row carries no URL.

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

### 4.1 The session names its user (M4)

Today nothing on the server can say which Spotify account a session belongs to: Auth.js mints a
random `sub` at every sign-in, and the app stores no id on the token (01b §1.1, 01e §1.3-1.4). The
design follows 01e §5.1, with an integer uid in place of the `account_id` as the token's claim:

- **Sign-in.** The `signIn` callback (`auth.ts:344-347`) keeps its not-registered branch and
  replaces `isOwnerSignIn` with `admitSignIn(profile)`, which reads the app database: a user whose
  `account_id` equals `profile.account_id` and whose status is `active` or `needs_reconnect` is
  admitted; so is an `invited` row whose `spotify_id` equals `profile.id` and whose `account_id`
  is still empty. Everyone else gets AccessDenied, worded "not invited" on `/login`. A profile
  without `account_id` is refused and logged, never keyed on `id` instead (01e §5.5), and a store
  error refuses, as `owner.ts` does today. An env flag `SIGNUPS=owner|invite` keeps Phase 1
  owner-only and gives Phase 2 a one-variable way back.
- **The jwt callback's sign-in branch** (`auth.ts:352-377`) binds the row with a compare-and-set
  (`UPDATE users SET account_id = ?, status = 'active', spotify_id = ?, last_sign_in = ? WHERE id
  = ? AND (account_id IS NULL OR account_id = ?)`), writes the encrypted token with `granted_at =
  now`, and sets `token.uid` and `token.epoch` from the row, never from the incoming token (01e
  §5.6, fixation). If the token write fails, the sign-in fails visibly: the two paths that park
  tokens in the cookie (`auth.ts:367-374`, `388-405`) are removed, because a parked token is
  invisible to the cron (01e A18).
- **Every later request** reads the user row and the token row in one statement on the app
  database, `SELECT u.status, u.session_epoch, t.blob, t.expires_at FROM users u LEFT JOIN
  user_tokens t ON t.uid = u.id WHERE u.id = ?`, through a React `cache()` box keyed by uid (it
  replaces `tokenBox`, `auth.ts:73-83`). No `uid` on the cookie, an unknown uid, a status of
  `disabled`, `deleting` or `invited`, or an epoch that differs from the row's → the callback
  returns `null` and the request is signed out. Status `needs_reconnect` keeps today's behaviour
  for a missing token: `error = "RefreshAccessTokenError"`, and the gates send the user to
  `/login` (`auth.ts:406-409`). It is one round trip, as today's token read is (01e §5.1).
- **`requireUser()`**, server-only, wraps `auth()` and returns `{ uid }`, or redirects a page,
  answers 401 to a route and `{ ok: false }` to an action (01b S2). It is the only source of `uid`
  for an entry point. The session exposes `user.id = uid`; that integer is public by design
  (`GET /api/auth/session` serves whatever the session holds, `docs/SECURITY.md` "Tokens never
  reach the browser") and is also the browser's storage key (§5.3).

Every cookie minted before Phase 1 lacks `uid`, so at deploy every session ends once, the
owner's included. That closes 01b E1 / 01e F1 for good. M0a closes it now, because Phase 1 is
days to weeks away and the second account's cookie lasts until about Nov 13 (01e F1).

Home loses one parallel wave. Today the page runs `auth()` and three reads in one `Promise.all`
(`src/app/(app)/home/page.tsx:78-83`), so an anonymous request costs four store reads (01b E5).
The reads now need the uid, so they start after the gate: one extra sequential round trip to the
user's database, ~15 ms at STORE_MIGRATION R1's target. Keeping the wave by decoding the JWT
separately (01b S2) would save those milliseconds at the cost of a second decode path; this
design does not take it.

### 4.2 Tokens per user (M5)

The token core leaves `auth.ts` for a module with no next-auth import, so the simulated
environment can load it (`tests/owner-signin.test.ts:5-6` explains why it cannot today; 01e
A21). Every function in it takes the uid:

| today | design | why |
|---|---|---|
| `inflightRefresh`, one promise per instance (`auth.ts:188-196`) | `Map<uid, Promise>` | left as one promise, user B's refresh joins user A's and receives A's tokens (01e A2): the one change in this list that would leak silently |
| `acquireLock("spotify_refresh")` (`auth.ts:212`) | `lock:spotify_refresh:<uid>` in the app database | a shared lease makes B wait up to ~32 s for a token nobody is refreshing (01e A4) |
| `getSpotifyTokens()` / `setSpotifyTokens()` / `clearSpotifyTokens()` on Rem's `meta` (`db.ts:2514-2531`) | `getTokens(uid)` / `setTokens(uid, …)` / `clearTokens(uid)` on `user_tokens` | 01e A1, A5 |
| `getValidAccessToken()` (`auth.ts:278-289`), `refreshingToken()` (`actions.ts:46-57`), the library task's getter (`playlists-sync.ts:61-65`) | each takes the uid, and a background task binds it at creation | 01e A16 |
| `clearTokensIfStale` (`auth.ts:170-181`) | same rule, within one user's row | the fresh-token veto carries over unchanged (01e §2.5) |
| a terminal `invalid_grant` clears the row | clears that user's row and sets `status = 'needs_reconnect'`; the cron stops calling Spotify for them | 01e §5.7; nobody else is touched |

Write load: the cron probes every active user on every tick, so each user's access token is
refreshed about hourly, ~24 times a day, each a lock, a row write and a release: ~72 app-database
writes per user per day, ~11,000 a month at five users [estimate, 01e §5.2's arithmetic].

### 4.3 Encryption at rest

01e §5.3's design, adopted as written:

- AES-256-GCM from `node:crypto`, a random 12-byte IV per write, stored as
  `v1.<base64url(iv ‖ ciphertext ‖ tag)>`. Both tokens go in one blob.
- Associated data `lazyboy:tokens:<uid>`: a ciphertext copied into another user's row fails to
  authenticate, so write access to the store without the key cannot borrow someone's Spotify
  account through the app.
- Keys in one variable, `TOKEN_KEYS="v1:<base64 of 32 bytes>"`, a Vercel Secret, Production only.
  Preview gets none. Dev has its own key and its own app database (§8.2), so the production key
  never sits in `.env.local`.
- Rotation: put the new key first and redeploy; rows re-encrypt at their next refresh, about
  hourly; drop the old key once `SELECT count(*) FROM user_tokens WHERE blob LIKE 'v1.%'` is 0.
  Losing the key costs every user one sign-in and nothing else; a copy in Rem's password manager
  is the backup.
- A blob that fails to decrypt reads as no token (`needs_reconnect`), logged with the uid only.
- Cost: microseconds of CPU per request on a ~600-byte blob, and no extra round trip [estimate,
  01e §5.3].

What it protects: every copy of a token row outside the running app, which after the move means
Turso's own backups and point-in-time history, the nightly dumps on the Zenbook and OneDrive,
scratch copies, and anyone holding a leaked database or platform token (01e F2 lists today's
plaintext copies). What it does not protect: code running in production, which holds the key, and
a holder of `AUTH_SECRET`, who can drive the app as any user without seeing a token. Vercel KMS
only signs and AWS KMS brings the AWS dependency Rem ruled out for this app (01e §5.3).

The two plaintext rows already in Rem's database (`spotify_tokens`, `spotify_tokens_dev`) and
every copy in his 60 days of backups are not covered by this. §9 deletes the rows once the
rollback window closes, and STORE_MIGRATION's backup rewrite should strip them from the copies
now (§8.3, 01e §6 item 1).

### 4.4 Sign-out, revocation and the session-less paths

- **Sign out** clears this browser's cookie and the browser stores (M18). Capture continues.
  **Sign out everywhere** bumps `session_epoch`. **Disconnect** deletes the token, bumps the
  epoch, deletes the user's data (§10.3) and tells them to remove Lazy Boy at
  spotify.com/account/apps, since the app cannot revoke a grant (01e §1.6). Today's single
  `logout` both stops capture and signs out every device (`actions.ts:63-69`); the split is
  01e §5.6's recommendation and Rem's call (§15). Phase 0's M0c only adds the missing session
  check.
- The 30-day session stays unrenewed (01e §1.4). Every sign-in passes Spotify's consent screen
  (`show_dialog`, `auth.ts:322`), which restarts the 6-month refresh-token lifetime, so an active
  user never reaches it.
- A user who revokes the app at Spotify surfaces as `invalid_grant` at the next refresh (01e
  §5.7). What happens to their data afterwards is in §10.3.
- The cron and background tasks call `getValidAccessToken(uid)` for the user they serve.
  `CRON_SECRET` stays the cron's only gate; with fan-out a holder can make the app spend every
  user's share of the Spotify quota, though no data leaks through it (01e §3.2). One secret for
  both pingers is enough at this size; the cron-job.org job rejoins the holder list in
  `docs/SECURITY.md`.

## 5. Isolation: the enforcement points and the tests that prove them

### 5.1 Where a user could reach another user's data, and what closes each

| path | closed by | overview finding |
|---|---|---|
| a store read or write for the wrong user | the database: a statement only sees the database `getClient(uid)` returned; the uid is a required parameter, so a forgotten one fails `tsc`; an unmapped uid throws | 01a D2-D19, 01b B1-B7, C1-C6 |
| a uid taken from the request | the only sources are `requireUser()` (the session), the cron's user list, and a background task's binding at creation; no route or action reads a uid from params, body or query | 01b S2 |
| a playlist id, day or task id from the client | ids are looked up in the caller's own database, so another user's private playlist id finds nothing and falls to a live fetch with the caller's own token, which Spotify refuses in development mode ("Playlist contents (items) are only returned for playlists the user owns or collaborates on", 01f §1.2); tasks carry an owner (§5.3) | 01a D14, 01b B4, B9 |
| a Spotify call with the wrong account | every client is built from the uid's own token getter; the in-flight refresh map and the lock are keyed by uid (§4.2) | 01b A1-A6, 01e A2-A6 |
| a cached entry or a 304 for the wrong user | the uid is an argument of every cached read and part of both ETags (§5.2) | 01a D26-D27, 01b §3.1-3.2, 01d §4.1 |
| module-level state shared across users | deleted, or keyed by uid (§5.3) | 01b §3.4, 01c S3, S7-S8 |
| the next person on a shared browser | browser stores carry the uid and are cleared on sign-out (§5.3) | 01b B10, 01d §4.1 |
| the operator's telemetry | `/usage` admin-only; telemetry rows carry the uid so deletion reaches them (§10.2) | 01b B8, 01a D30 |
| a Preview build or a dev server | neither holds a credential for friends' databases (§8.2) | 01b E4, 01e §5.9 |

### 5.2 Cache keys and ETags (M6)

- **The seven `unstable_cache` wrappers** (`db.ts:983-994`, `1082-1090`, `1176-1191`,
  `1600-1623`, `1906-1914`) take the uid as their first argument. Next 16.2.6 builds a key from
  the callback's source text, the key parts and `JSON.stringify(args)` (01b §3.1, from the
  published `unstable-cache.js:55, 82`), so an argument separates users and a closure would not.
  The argument also changes every wrapper's source text and argument list, so the deploy moves
  every key at once and no single-user entry can be served to the new code (01b §3.1). Per-user
  counters alone would not be enough: two users at the same small `write_seq` would share an
  entry (01a §5, 01d §4.1).
- **Both search ETags** gain the uid: `"lib-v1-u<uid>-<library_seq>-<UTC day>"` and
  `"hist-v2-u<uid>-<slow seq>-<UTC day>"` (`src/app/api/search/library/route.ts:39`,
  `src/app/api/search/history/route.ts:26`). User B revalidating with user A's tag gets a 200 and
  B's body. A uid in the tag reveals nothing about anyone's Spotify account.
- **React `cache()` boxes**: the token box, `seqBox` (`db.ts:402`) and `orderedRealPlays`
  (`db.ts:854`) take the uid as an argument, so one request that touches two users (only the
  cron could) cannot mix them (01e A3, 01b §3.3).
- **A deleted user's entries** age out of the Data Cache within the longest TTL, 24 hours
  (`FROZEN_TTL_S`, `db.ts:958`), and no session can name a deleted uid, so nothing can be served
  from them in the meantime. Per-user cache tags would purge them at once; that is more machinery
  than a one-day expiry, inside Spotify's five-day deletion window, justifies.

### 5.3 Module state and the browser (M7, M18)

- `playlistsCache` (`src/lib/spotify/resources.ts:74-104`) is deleted. Its callers are the library
  sync (`myPlaylistsAll`, `src/lib/sync/library.ts:40`) and the live library union
  (`src/lib/spotify/service.ts:115-118`); the grid reads the store (GOTCHAS, "Persistent playlist
  library"), so the 60 s entry now saves a few `/me/playlists` pages at most, and unkeyed it would
  store user A's playlist list as user B's library whenever the cron rescans them back to back
  (01b A6, 01c S7).
- `currentSyncId` (`src/lib/playlists-sync.ts:22`), `uniqueRecomputeKickedAt` (`db.ts:1960`) and
  `storeSizeMemo` (`db.ts:2887`) become per-uid maps.
- Tasks record the uid that started them; `/api/tasks/[id]` answers 404 to anyone else
  (`src/lib/tasks/registry.ts:9-18`, `src/app/api/tasks/[id]/route.ts:13-15`; 01b S7).
- `cooldownUntil` (`src/lib/spotify/client.ts:48`) stays app-wide on purpose (§3.2).
- The `(app)` layout renders the uid into the page; `lb-days`, `lb-nowplaying`, `clean:active`
  and phase E's IndexedDB copy are namespaced by it, and the sign-out form clears all four in the
  browser before it submits (01b §3.6 and §7 item 1, 01d §4.1).

### 5.4 The tests (M11)

All in `tests/`, the simulated environment: real lib code against throwaway SQLite files and a
scripted fetch. Two harness changes come first. `tests/setup.ts` points the app database and each
user database at their own temp files (`app.db`, `u1.db`, `u2.db`). `tests/stubs/next-cache.ts`
stops being a pass-through (`tests/stubs/next-cache.ts:4-10`) and memoizes on callback source +
key parts + `JSON.stringify(args)`, as Next does, so a read that forgets the uid returns the other
user's entry in a test instead of passing silently (01a D29, 01b S5).

| test | what it proves |
|---|---|
| `isolation/store.test.ts` | Seeds users 1 and 2 with deliberately colliding data: the same track at the same `played_at` (D17), interleaved timelines (D18), the same playlist id in both libraries (D12-D14), one context URI resolved for 1 and negative-cached for 2 (D25). Runs every exported per-user function as user 1. User 2's database file has the same sha256 before and after, and nothing user 1 reads contains a user-2 marker string. |
| `isolation/cache.test.ts` | Users 1 and 2 with equal `write_seq`, `library_seq` and slow seq. Every cached read for 1, then for 2: 2 gets 2's rows. User 2's request carrying user 1's ETag answers 200 with 2's body. |
| `isolation/routes.test.ts` | Mocks `@/lib/auth` to return user 2's session (the pattern `tests/now-playing-route.test.ts:13-16` uses), calls every route handler and server action, and finds no user-1 marker in any response and every write in user 2's file. |
| `isolation/structural.test.ts` | Parses `db.ts` with the TypeScript compiler API (a dev dependency already): every export outside a named allowlist (telemetry, ledger) takes `uid` first. Calls every `"use server"` export and route handler with no session and asserts a refusal before `getClient` is called (01b S2's structural test). |
| `get-client.test.ts` | An unmapped uid throws; uid 2 never resolves to uid 1's URL; dev's file fallback is one file per uid. |
| `tokens.test.ts` | 01e §5.2's six known answers: two users refresh concurrently in one process and each ends with their own token, one token-endpoint call each; user 1 holding the lock does not delay user 2; `invalid_grant` for 1 clears only 1's row; 1's ciphertext pasted into 2's row fails to decrypt; a cookie with no uid, an unknown uid, a disabled user or a stale epoch yields `null`; no row means `null` and no Spotify call. |
| `cron-fanout.test.ts` | Three users: 1 playing, 2 answering `invalid_grant`, 3 answering 403 "not registered". One tick stores 1's play, marks 2 `needs_reconnect` and 3 `disabled`, answers 200 with three outcomes; a second tick inside 90 s does nothing. |
| `deletion.test.ts` | Deleting user 2 removes their database (Platform API mocked), their app rows and their telemetry rows; user 1's file hash is unchanged. |
| browser check (manual, one real session) | Sign in, load Home, sign out: IndexedDB, `lb-days` and `lb-nowplaying` are empty and the next payload request carries no `If-None-Match` (01d §4.3 test 5). |

The colliding seeds matter more than the count. D17's same-millisecond play and D18's interleaved
timelines are the two cases 01a §8.7 names as most likely to pass review unnoticed; under this
model they cannot occur, and the store test is what shows it.

## 6. Background sync for N users inside Spotify's limits

### 6.1 The limits

From 01c §4 and 01f §1.4, which quote Spotify's pages fetched on Oct 14:

- **A rate limit per app** over a rolling 30 s window, number unpublished. The highest rate this
  app has run without a 429 is 18 calls per 30 s (`db.ts:2655-2658`).
- **A quota per developer account**, in buckets, answered with a 429 whose body says
  `QUOTA_EXCEEDED`. The one bucket this app has exhausted is recently-played's daily budget:
  six bans Aug 11-16 after 629-700 logged calls plus the recorder's ~96, so **~725-800 calls a
  quota day**, resetting at ~10:46-10:51 AM ET. `/me` was banned in the same days, so it is treated
  as the same bucket (01c §4). The player endpoints have never been limited.
- **Shared or per user** is unknown. Spotify's pages say "a single developer account" and "a
  single budget"; one changelog sentence says "a user's quota" (01c §4). With one user the two
  readings cannot be told apart. This design plans for the shared reading, the one the
  documentation states, and finds out passively (§15).

01c §5.1 plans to 60% of the low end, ~450 recently-played calls a day; this design uses the same
line.

### 6.2 The tick (M8)

`GET /api/cron/sync`, every 2 minutes from each of two pingers (§6.5), one invocation for every
user (01c §5.2):

1. **Lease.** `acquireLock("tick", 90_000)` on the app database, never released, so it expires
   on its own. If it is held, the tick answers 200 `{skipped: "leased"}`: that is the second
   pinger's tick landing inside the first one's window. If the app database cannot be reached,
   the tick ends at once instead of letting five users each wait out the store fetch's three
   15-second attempts (`src/lib/store-fetch.ts:28-29`); nothing could be recorded anyway.
2. **Users.** One read of the active users and their token rows (≤ 5 rows).
3. **Steps.** `Promise.allSettled` over the users, each under its own 25 s deadline. A step is
   today's route body (`src/app/api/cron/sync/route.ts:95-172`) with the uid threaded through:
   the user's token, the player probe, the harvest decision, `syncRecentPlays(uid, …)`, then
   `maybeSyncLibrary(uid, …)` on the user's own 30-minute and 10-minute stamps (`route.ts:28-42`,
   per database already).
4. **Answer.** 200 with one outcome per user (counts only, as today: 01b §2.3). The Zenbook's
   `ping.sh` adds `?alarm=owner`, and for that caller alone the route still answers 503 when uid 1
   has no token, which keeps Rem's only capture alarm (`route.ts:103-111`; the Oct 3 review's M1).
   cron-job.org never gets a non-200, so its auto-disable after a failure streak (the hazard the
   route's comments describe, `route.ts:174-178`) cannot trip on one user's problem.

**Harvest on a track change** (policy (i), 01c §5.3), replacing "harvest on every playing tick"
(`src/lib/harvest-gate.ts:20-24`). Each user's `probe` key holds the last probed track id,
progress and time. A playing tick harvests when the track id differs from the last probe, when
the same track's progress went backwards (a replay), when playback stopped since the last probe
(today's session-tail rule), or when the last harvest is over an hour old (today's backstop).
Tracks that start and end between two probes are in the 50 the next harvest returns. Freshness is
unchanged; the spend drops from about two harvests per landed play to about one (264 playing
harvests for 129 plays on Rem's day, 01c §5.3). It is a pure function next to `shouldHarvest`,
with known answers in `tests/harvest-gate.test.ts`. It ships in Phase 1, with Rem alone, so the
halving can be checked on his own call counts before anyone else shares the bucket.

**Failure isolation** (01c §5.4):

| failure | effect | who |
|---|---|---|
| `invalid_grant` | token row cleared, `needs_reconnect`, no more calls (§4.2) | that user |
| 403 "not registered" (removed from the dashboard allowlist) | `disabled`, no more calls; re-enabled by Rem. Never applied to uid 1, and never when every user in the tick failed the same way, which is what an app-level failure such as a lapsed Premium looks like (01c §5.4 item 4) | that user |
| Spotify 5xx or a timeout | that user's step fails and retries next tick | that user |
| 429, rate limit | the app-wide cooldown, seconds long (`client.ts:150-183`) | everyone, correctly: the limit is per app |
| 429, `QUOTA_EXCEEDED` | the app-wide cooldown, re-probed at most every 30 min (`client.ts:27`) | everyone. Correct for the scarce bucket; it also pauses the player probe, as today. 01c S4's per-bucket cooldown is a later refinement |
| the app database down | the tick ends at once | everyone; plays inside each user's last 50 are recovered at the next tick |

### 6.3 The open-app paths (M9)

- `/api/sync` needs nothing: its 60 s debounce reads `last_sync` (`src/app/api/sync/route.ts:28-31`),
  which every harvest stamps (`db.ts:524-528`), and both now live in the user's database.
- `refreshHistoryAction` harvests on every call with no debounce (`history-actions.ts:133`): up
  to ~30 recently-played calls an hour per visible Home tab, plus one per track change (01c S6).
  M9 adds the same 60 s `last_sync` check before its `syncRecentPlays`. A track change still gets
  its play into the store within a minute while the tab is open, and the browser's own
  provisional play shows it at once.
- The now-playing poll (6 s per visible leader tab, 10-20 Spotify calls a minute per user,
  01c §2.5) touches only the player endpoints. Five users with a visible tab each could exceed the
  18-per-30-s rate this app has seen pass; the cost of that is a few seconds of app-wide cooldown,
  not lost data. M25 (15 s mid-track) waits until the per-user call log shows it happening.

### 6.4 The scarce bucket at five users

Recently-played plus `/me` calls a day [estimate: plays a day ≈ track-change harvests, plus ~5
session tails, 24 hourly backstops and one `/me` per library rescan (Rem: 32 a day, 01c §2.3);
the friend profiles are 01d §3.3's and 01f §5.1's assumptions, not data]:

| user | today's policy | (i) only | (i) + M23 (no `/me` in rescans; recorder hourly) |
|---|---|---|---|
| Rem, ~117-130 plays a day | 139-319 + 32 `/me` + 96 recorder = 267-447 | ~150 + 32 + 96 = ~278 | ~150 + 24 = ~174 |
| light friend, 40 plays | – | ~85 | ~69 |
| typical friend, 50 plays | – | ~99 | ~79 |
| Rem-like friend | – | ~182 | ~150 |

Against the ~450 planning line and the ~725-800 ban threshold:

| phase | users | (i) + M23 | verdict |
|---|---|---|---|
| 2 | Rem + 1 friend of any profile | 243-324 | fits with room |
| 3 | Rem + 4 light | ~450 | at the line |
| 3 | Rem + 4 typical | ~490 | over the line, under the ban |
| 3 | Rem + 4 Rem-like | ~774 | at the ban threshold: does not fit |

So Phase 2 needs only (i) and M23, and Phase 3 needs a brake before the third person joins.
**M22, the brake**: every recently-played and `/me` call increments `rp_spend:<quota day>` in the
app database, awaited before the call so a lost write cannot undercount (a re-sent increment
overcounts, the safe side; 01c §2.8 shows re-sends happen). The quota day starts at 14:51 UTC,
the boundary `getRecentlyPlayedQuotaWindows` already uses (01f §1.4). Past 450, every harvest
trigger (the cron, `/api/sync`, `refreshHistoryAction`) holds each user to one harvest per 30
minutes of playback, and the backstop goes two-hourly, for every user, Rem included, until the
reset. An open app keeps showing each finished play at once through its provisional play; only
the stored row waits. After a trip a user who listens nine hours spends ~30 more calls, so five
such users take the day to ~600 [estimate: 450 + 5 × (9 × 2 + 5 + ~7)], under the threshold. It
is a counter, a comparison and a branch in the harvest decision, with known answers for the
boundary. T3's fallback is this brake: on a day it trips, plays reach the store up to 30 minutes
late (§14 has the options that avoid it and their cost).

If the quota turns out to be per user, nothing here binds at five users and the brake never
trips. §15 decision 6 is how to find out.

### 6.5 Closed-app capture without the Zenbook (M19)

After the move the store leaves the Zenbook but the 2-minute pinger does not, so a Zenbook outage
still stops closed-app capture for every user (01c §6 item 4, 01f §3.5). The fix is the one 01c
§5.7(b) and 01f §3.5 recommend, made safe by the lease:

- A cron-job.org job (free, the service that ran this route until Aug 10) calls
  `/api/cron/sync` every 2 minutes with the current `CRON_SECRET`; its old job holds a stale
  secret (`docs/SECURITY.md`, `CRON_SECRET` holders).
- With both pingers alive, the 90 s lease turns one of them into a no-op costing two app-database
  statements, so the effective cadence stays ~2 minutes: the tick interval is between 90 and 120
  seconds depending on the two clocks' offset, never shorter.
- With the Zenbook down, cron-job.org keeps every user's capture running; the recorder and the
  nightly backup pause.
- With both down, capture resumes at the next app open (`/api/sync`) or the daily Vercel cron
  (`vercel.json`, `0 7 * * *`), and plays beyond each user's last 50 are lost (GOTCHAS,
  "`recently-played` only returns the last 50 plays").
- The recorder stays Rem's alone and runs hourly (M23; 01c §5.7(a)): 24 scarce-bucket calls a
  day instead of 96, and an hour is well inside 50 plays of any listening. Extending it to
  friends would put their refresh tokens in a plain file on the Zenbook (01e §5.9).

### 6.6 Library rescans

Each user's rescan runs inside their own step on their own stamps, as above. A new user's first
full scan (Rem's library is ~150 calls, one to two minutes at the 150 ms pacing, 01c §5.6) starts
from their first Home visit, where `PlaylistsSync` finds an empty store and kicks
`/api/playlists/sync` as a task in their own request (`src/components/playlists-sync.tsx:12`,
`src/lib/playlists-sync.ts:24-71`). If the cron reaches it first, the 25 s deadline caps how long
the tick waits; the scan commits per playlist and the next run skips finished ones (snapshot
gate, `src/lib/sync/library.ts:64-71`). M23 drops the rescan's `/me` call
(`src/lib/sync/library.ts:40`): the user's Spotify id is on the user row, refreshed at each sign-in
(01e §5.5).

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
