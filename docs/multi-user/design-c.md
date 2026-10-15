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
