# Multi-user lazyboy: the plan

Lane 0223_lb_mu_synthesis of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. It synthesizes the six overviews
(`01a-data.md` to `01f-platform.md`, cited as 01a §n and so on) and the three designs (`design-a.md`,
`design-b.md`, `design-c.md`, cited as A §n, B §n, C §n). Code line numbers are against `ac6f7fe`,
which the overviews cite; `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json
next.config.ts package.json` is empty at `7e0c5b1`. Every number is **[measured]** with its source or
**[estimate]** with its arithmetic. §17 lists everything this lane ran.

Status: outline; sections are filled in order and committed one by one.

## 0. Summary

(to fill last)

## 1. Targets

The brief asked for multi-user support that is secure, keeps performance and uptime, scales with the
store's usage, and keeps search fast. The three designs turned that into checkable numbers in
slightly different ways (A §0.1, B §1, C §1); this plan takes the strictest version of each that the
evidence supports and states how it is measured. §14 walks every target step by step with its budget.

"Rem-like" means Rem's measured profile: ~115 real plays a day over 30 days (01a §6), 129 on Oct 14
(01c §2). A **heavy day** is Oct 14's activity as the store meter measured it (716 ticks, 129 landed
plays, 44 all-time recomputes, ~30 rescans, 01c §2.1-2.3), with three unscoped orphan passes (as that
day had) and eight Home visits (an app-heavy user, 01d §4.2's assumption). "A phone" is Chrome with
the CPU throttled 4×, the stand-in 01d §2.3 measured with; no real phone has been measured.

| id | target | today | measured by |
|---|---|---|---|
| **U** | **5 accounts, Rem included**, on the one Spotify app. Past five, each person runs their own copy, which is the one-user case of the same code | 1 (the owner guard, `src/lib/owner.ts:10-14`) | the dashboard's User Management list; `users` rows |
| **I** | No request, cache entry, browser store, background job or script returns, changes or caches another user's data. Every class of mistake that could do it meets one layer that prevents it and one that detects it (a test in `npm test`, or a runtime check that refuses and logs) | not applicable: one global token row, every read unscoped (01b §1) | the isolation suite (§6.4) on every `npm test`; runtime `isolation` events on `/usage`, expected count 0 |
| **I$** | Isolation costs at most one extra store round trip on Home (~15 ms at STORE_MIGRATION R1's target) and microseconds elsewhere | – | §14.6 |
| **S1** | Repeat visit: search usable ≤ 300 ms after Home's first paint, on a phone | no browser copy yet (STORE_MIGRATION phase E) | `lb:index-idb` (R3) |
| **S2** | First visit on a device: search usable ≤ 2 s after first paint, on a phone at 10 Mbit/s, for Rem today and for a typical one-year friend (18,250 plays, 8,000 library songs, 01d §3.3) | real users, mostly August: median 4.0 s, p90 8.7 s between rows painted and search ready [measured, 01d §2.3] | `lb:history-ready`; 01d's throttled-browser harness re-run on the new bodies |
| **S3** | Keystroke to painted rows ≤ 50 ms on a phone, for search sets up to ~30,000 entries (about twice Rem's) | matching 10.5-13.2 ms at 4× for one-letter queries; keystroke-to-paint 43.8 ms median on a desktop dev build [measured, 01d §2.3] | `lb-perf` `paint=` (GOTCHAS "Measuring a search") |
| **F1** | Observed freshness: any Home view shows every play that ended more than 2 minutes before it opened, and every play that ends while it is open | met for Rem through the on-load sync and the browser's provisional plays (01c §5.3) | the on-load harvest's outcome; the handoff beacon |
| **F2** | Stored freshness with the app closed: a finished play is in the store within ~2 minutes (p50 ~1 min). On a quota day the fair-share brake trips (§7.5): within 15 minutes for whoever is above their share, within 30 minutes for everyone once the app's daily budget is spent | ~2 min for Rem (one tick while playing, `src/app/api/cron/sync/route.ts:121-146`) | each harvest records `now − played_at` for the plays it lands; `/usage` shows p50/p95 per user |
| **F3** | Completeness: no play lost while either pinger runs and no quota ban is in force | one pinger, on the Zenbook (01c §1) | the recorder diff for Rem (STORE_MIGRATION §8 step 13); a harvest before 25 track changes pile up |
| **D1** | Store reads ≤ 1.5M rows (Turso's terms) per Rem-like user on a heavy day, so five such users stay inside R4 (≤ 250M of the free plan's 500M a month) | ~4.5-5.6M on a typical day, ~19M on a day with three unscoped orphan passes [estimate from the meter, 01c §2.7-2.8, §5.9] | Turso's per-database usage, recorded by the daily route |
| **D2** | No read on a per-play, per-tick or per-visit path grows with the user's total stored history | the all-time recompute scans every play up to 144 times a day and grows ~12,000 rows a day, every day (01c §5.9) | the §8 table, reviewed per change |
| **D3** | ≤ 5,000 core rows written and ≤ 50 KB of growth per Rem-like user a day (five users ≤ 10% of the free plan's 10M writes a month) | ~3,000 core rows and ~35 KB a day (01c §2.7, 01a §6) | Turso's per-database usage |
| **A1** | No user-visible request depends on the Zenbook | every authenticated page does (01f §3.2) | STORE_MIGRATION R2's fault injection, repeated with two users |
| **A2** | Closed-app capture survives a Zenbook outage of any length | the only frequent pinger is on the Zenbook (01c §1) | stop the Zenbook timer for 10 minutes; plays land from the other pinger |
| **A3** | One user's failure (a revoked grant, removal from the allowlist, a refused database, a hung Spotify call) costs that user's slot and nothing else | one token's failure stops all capture; one user's 403 fails the tick (01c S2) | the cron fan-out test (§6.4); per-user outcomes in every tick's reply |
| **$** | $0 a month until the first friend; ≤ $26 a month at five users | $0 | §15 |

What changed from the brief, and why:

- **25 users became 5.** Spotify's quota-modes page: "Up to 5 authenticated Spotify users can use an
  app that is in development mode", applied to existing apps from Mar 9, 2026; extended quota mode
  "only accepts applications from organizations (not individuals)" with "at least 250k MAUs"; several
  Client IDs break the one-Security-Code rule and share one quota anyway (all quoted in 01f §1.2-1.3,
  fetched Oct 14). The 25 on today's pages is Client IDs per developer. All three designs and four
  overviews reached the same number.
- **Freshness split into F1-F3**, as B §1 did. Under the documented reading of Spotify's quota (one
  pool per developer account, 01c §4), 2-minute closed-app freshness for five heavy listeners costs
  more recently-played calls a day than the budget August's bans measured (01c §5.1). Nobody sees
  stored freshness while the app is closed, so the plan protects F1 and F3 always and lets F2 degrade
  on the days the budget runs low.
- **D1 is set by need, not ambition.** B set 100,000 rows a day; that is reachable (B §10.2) but asks
  for more write-path machinery than five users need. 1.5M is what keeps five heavy users inside R4 on
  the free plan; D2 is the structural rule that keeps D1 true as histories grow.
- **I and I$ are added**, from "keep it all secure" (A §0.1, C T0).

Two numbers the targets rest on are not measured, and the rollout gates on both (§13): whether
Spotify's development-mode quota is one pool or one per user (01c §4, 01f §1.4), and how much of
Vercel Hobby's 4 Active-CPU-hours a month the team already uses (01f §2.3).

## 2. The three designs compared, and what this plan takes from each

### 2.1 Where they agree

The three designs were written independently from the same overviews and agree on most of the
skeleton, so none of these needed a choice:

- **A database per user on Turso**, plus a small app database for users, encrypted tokens and
  scheduling. Rem's `lazyboy` database, which STORE_MIGRATION's cutover creates, becomes his user
  database without being copied or rebuilt. Telemetry stays on the Zenbook and gains a nullable user
  column (A §2.1, B §4.1, C §2.2; 01a §8.1 recommended it first).
- **Five accounts**, Rem included; past five, people run their own copies (A §0.1, B T1, C T1).
- **A user id and a session epoch on the session cookie**, checked on every request in the one
  app-database query that also reads the token; a cookie without an id is refused, which ends the
  pre-guard sessions for good (01e §5.1).
- **Tokens encrypted with AES-256-GCM**, the user id as associated data, keys in a Production-only
  Vercel Secret; the token core moved out of `auth.ts` so it can be tested, with the in-flight
  refresh and the refresh lock keyed by user (01e §5.2-5.3).
- **The user id as an argument of every cached read** and a component of both search ETags; process
  state keyed by user or deleted; tasks with owners (01b S5-S8).
- **One cron invocation for all users**, each under its own deadline in `Promise.allSettled`; harvest
  on a track change instead of on every playing tick; a second pinger on cron-job.org; the recorder
  owner-only and hourly; `refreshHistoryAction` stops calling Spotify (01c §5).
- **An invite script on the Mac** behind Spotify's allowlist; **deletion that destroys the user's
  database**; **STORE_MIGRATION run as planned and first**, with small edits; **Phase 0 now**: rotate
  `AUTH_SECRET`, set `SPOTIFY_OWNER_ID`, gate `logout`; **$0-26 a month** at five users.

### 2.2 Which structure, and why

Each design is strongest on its own angle and weakest where the others are strong.

- **A (isolation first)** maps every class of cross-user mistake to a layer that prevents it and a
  layer that detects it (A §2.8), adds cheap runtime checks that turn a missed bug into a logged slow
  path instead of a leak (owner stamps on databases and cached values, tokens that carry their owner),
  and phases the work so nothing anyone but Rem can reach changes until the first friend. Its store
  budget is the loosest of the three on the read paths it leaves alone (~0.8M rows a heavy day, A
  §13.4).
- **B (performance first)** has the rule this plan adopts for cost, "a user's recurring cost follows
  what changed, never what is stored" (B §2), and the measured finding with the most leverage: the
  "From" verdict rewritten to start from the song's identity, which reads ~2.7 rows per play where
  today's walks up to ~411 (B §10.1; reproduced by this lane, §17). Its isolation rests on types and
  tests, with no runtime check, and it opens the user's database from a cookie field in parallel with
  the gate, a second way to reach user data. It also builds more write-path machinery (materialized
  payloads, version compare-and-sets, dirty marks, a nightly drift check) than five users need.
- **C (smallest safe change)** moves nothing of Rem's but the token, keeps today's SQL and `init()`,
  and is the most concrete operationally: a client lookup that fails closed, a one-variable kill
  switch, friends' backups that age out inside Spotify's five days with no bookkeeping, the owner
  alarm evaluated where a second pinger cannot hide it, and soak checks with numbers. It leaves each
  user's read cost as it is today and relies on Turso's paid plan for four heavy friends (C §12.4).

**The plan takes A's structure** (its targets, its layered enforcement, its phase order), because
Rem's first words were "keep it all secure" and A's is the only structure that says, for each way a
leak could be written, what stops it and what notices it. Into it go **B's cost rule and the three
levers that matter at five users** (stored listened time with an accumulator, the identity-first
orphan predicate, the Home payload patched in place), as a single-user track that pays off for Rem
whether or not anyone else signs in, and **C's operational choices** wherever they give the same
safety with less machinery.

### 2.3 Point by point

**Identity and data model**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| user key | INTEGER `AUTOINCREMENT`; an HMAC of it (`hk`) for the browser | random 12-char base32 text | INTEGER `AUTOINCREMENT`, raw in the browser | **B's random uid**, everywhere, the browser included | never reused, even if the app database is restored from a backup: a restored `sqlite_sequence` can re-issue an integer, and a stale cache entry (A's owner stamp would match) or C's derived database name would then point a newcomer at a departed user's data. It holds nothing personal, so it can sit raw in an ETag or URL without an HMAC secret |
| user → database | stored `db_url`, random names | stored `db_name`, also on the cookie | derived from the uid; unmapped throws | stored `db_name` (`lazyboy` for Rem, `lb-u-<uid>` for friends), one URL template, an unknown uid throws, never a fallback URL | one source of truth; C's fail-closed rule; no copy on the cookie |
| owner stamp | `meta.owner_uid` checked on first open | – | – | **A's** | a wrong mapping (a restore, a provisioning slip) becomes a refused open at one statement per process per database |
| schema changes | `init()` replaced by declared versions and an explicit migrate script | versions, a template database, per-user pause | `init()` per database, as today | a versioned open: one statement reads `owner_uid` and `schema_version`; pending additive steps apply as `init()` does today; a pending table rebuild refuses that user until the migrate script runs, with that user paused | keeps today's workflow for the additive changes that are nearly all of them (C), one round trip per cold open instead of eight (A), and the unsafe case becomes a refusal (A, B) |
| a new user's database | full schema at invite | seeded from `lb-template` | `init()` on first connection | **A's**: full schema at invite | no template database to keep migrated |
| `me_id` | stays in the user database | dropped for `users.spotify_id` | stays | stays (A, C) | the owned-playlist SQL is unchanged (`db.ts:2297, 2310`); only that user's own sync can write it now |
| time zone | `user_tz` in the user database | `users.tz_zone` | `user_tz`, with the DST check against the user's own zone | **C's** | C §3.3 found today's heuristic buckets a Chicago user in New York's days |
| token `env` column | none; dev has its own app database | `(uid, env)` | none | none (A, C) | production never holds a dev grant |

**Sessions, enforcement and caches**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| identity read | users ⋈ tokens | + `sync_state` and the cooldown in the same row | users ⋈ tokens | **B's wider row** | Home's cooldown and capture-health reads ride the identity read: two sequential reads per render, where today's one wave makes five (`home/page.tsx:78-83`, 01b E5) |
| Home's first wave | gate, then reads (+1 round trip) | user database opened in parallel from the cookie | gate, then reads | gate first (A, C); B's parallel open held in reserve if R1 misses badly | a parallel open is a second way to mint a user handle; ~15 ms is under 1% of S2 |
| reaching user data | branded `UserId` minted by three functions, a `forUser(uid)` handle | branded `UserDb` handle | branded `Uid` first parameter, `getClient(uid)` | **A's** `forUser(uid)` over a branded uid | no module-level per-user function survives, and a uid from request input does not compile |
| cache keys | one `userCache` helper: uid in key parts and arguments, an owner stamp checked on return, a tag | uid argument, a tag | uid argument, no tag | **A's helper with the stamp, no tag** | the stamp turns a key mistake into a slow request in production; a tag adds nothing a ≤ 24 h TTL and a never-reused uid do not (C §5.2) |
| tokens carry their owner | asserted on every Spotify call | – | – | **A's** | 01e A2, the shared in-flight refresh, is the one silent token leak in the census; the assertion catches its whole class |
| runtime `isolation` events | yes | – | – | **A's** | the first sign of a bug the tests missed |
| tests | T1-T12, static checks S1-S6, file hashes, a faithful cache stub, Spotify scripted per bearer | ten tests, each proven against a planted bug | similar; structural test via the TS compiler API | **A's suite, B's planted-bug rule** | the most complete, and a test that never failed proves nothing |

**Sync**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| tick | per-user claims (`UPDATE … RETURNING`), one tick a minute | global tick lock plus a per-user harvest lock, one a minute | global 90 s lease, ~2 minutes | **A's per-user claims**, with B's two pingers on alternate minutes | one lease serves the cron and the open tab; an overrunning step holds only its own user |
| owner alarm | non-200 when the owner's capture stops | only the Zenbook's caller, by its own secret | `?alarm=owner`, checked before the lease | the Zenbook's own secret (B), the verdict read from the owner's sync state (C's reason) | with two pingers, the other one may have done the owner's work this minute |
| probe | `/me/player` alone | the same, now-playing too | `/me/player` alone in the cron | cron only (A, C) | now-playing's two-step read is the UI's freshness path (GOTCHAS "Player simulation") |
| harvest | on a track change; completeness at 40 changes | on a track change; 25 | on a track change, plus one retry after a lagging change | track change, **C's retry, B's 25** | the retry covers a Spotify lag nobody has measured; 25 leaves half the 50-play window spare |
| quota brake | fair share: at ¾ of 450, users above their share go to 15 minutes; at 450, everyone to 30 | a daily projection picks one interval for all | at 450, everyone to 30 minutes, before the third user | **A's fair share**, C's counter (awaited before the call) and C's timing | light listeners never slow down; simple enough for known-answer tests |
| open-app harvest | the same step under the same claim | on load or focus, if a track change was seen | only when no tick ran in 5 minutes, or on load after 15 minutes | **all three**: A's step under the claim, B's load trigger, C's fallback | each covers a different case: overlap, catch-up, dead pingers |
| now-playing poll | 15 s mid-track | 15 s | only if logs show crowding | 15 s, in phase 3 | five visible tabs at 6 s pass the 18 calls per 30 s seen safe, and a rate-limit 429 pauses everyone |

**Store cost and search**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| all-time totals | an accumulator (01c) | `plays.listened_ms` + an accumulator | gate 10 → 60 min; accumulator later | **B's** | 53% of today's reads and the only term that grows every day (01c §2.2, §5.9) |
| Home payload | strip updated in place (01c) | patched in place, rebuilt on non-append events | unchanged | **B's**, before the second friend | 22% of today's reads, and ~30 round trips per landed play down to ~3 |
| orphan predicate | scoped by lanes 1910-1911 | rewritten identity-first, measured | scoped | **B's rewrite inside 1910-1911** | reproduced here: same verdicts on all 7,572 plays, ~2.7 rows per play against ~411 |
| history payload | monthly segments on demand, Data Cache, per-month counters | segments materialized in the user database, appended on write | the catalog split (01d O2); segments optional | **A's on-demand segments**, with B's listened seconds in the tuple | meets the December cliff and S2 with less write-path code; B's materialization is the named next lever |
| whole-history strip | unchanged | built in the browser from segments | bounded to the one width the client sends | **B's**, with the Home patch; C's bound now | ~43,500 rows per Home mount after listening today [estimate, B §3 row 4] |
| client | lazy days, first screenful | lazy days, ≤ 50 rows, narrowing | fetch at mount, lazy days | **all**, with the fetch at mount and the parse still deferred to idle | network starts earlier; main-thread work still yields to hydration |

**Lifecycle**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| deletion | destroy the database the same day; tombstone after 5 days | drop the tables at once; destroy within 5 days, off the runtime | destroy at the request; refuses uid 1 | destroy at day 0 (A, C); delete the users row at the end | a destroyed database leaves point-in-time recovery; dropped tables stay in it 1-10 days (A §2.1, C §8.1) |
| backups | one file per database, removed with the account | non-owner copies kept 5 days | friends' kept 4 days, taken only while active | **C's** | deletion reaches the backups with no bookkeeping that could miss a file |
| platform token | in the runtime, two uses | Mac only | in the runtime | runtime, Production only (A, C) | a same-day destroy cannot wait for a laptop |
| sign-up | `/join`: terms accepted before OAuth; compare-and-set claim | separate invites table | `invited` users row; `SIGNUPS` flag; consent after sign-in | **A's `/join` and claim, C's flag** | terms before anything is stored; a one-variable way back |
| dev | local files only | copies of production | uid of Rem → `lazyboy` on its own token; friends local | **C's** | Rem keeps his workflow; dev can never reach a friend |
| Rem's migration | the token and three `meta` keys; plaintext kept a week; `account_id` read first | adds columns and payloads in fenced windows | the token only; `account_id` bound at first sign-in | **A's** | learns whether `account_id` exists before deploying code that needs it |
| phases | 0-5, phases 1-3 single-user | performance first, then multi-user | one large owner-only phase | **A's split, B's performance track first, C's gates and soak checks** | small reversible deploys; the December deadline protected |

## 3. The plan on one page

```
browser ──► Vercel functions (iad1)
             ├─ app client ─────────► Turso lazyboy-app   users · user_tokens (AES-256-GCM) ·
             │                                            sync_state · app_meta (global keys, locks)
             ├─ forUser(uid) client ► Turso lazyboy       Rem's data: today's schema + plays.listened_ms
             │                        Turso lb-u-<uid>    one per friend (at most four), same schema
             └─ telemetry client ───► Zenbook sqld via the Funnel; one attempt, 4 s, never awaited
                                      api_log (+uid, +reason) · client_metrics (+uid) · usage_ledger
pingers:  Zenbook timer, even minutes, its own secret ─┐
          cron-job.org, odd minutes ───────────────────┴► /api/cron/sync: one tick a minute;
          each due user claimed by lease, probed every 2 min while active, harvested on track changes
Zenbook:  telemetry · Rem's recorder (hourly) · nightly backups of every database · one of two pingers
```

The rules the plan holds itself to:

1. **The database a statement is sent to is the user scope.** `forUser(uid)` is the only way to a
   user's database, and it takes a branded uid that only the request gate, the cron's claim and the
   script helper can mint. Every database, cached value and token names its owner, and the owner is
   checked on the way out (§6).
2. **A user's recurring store cost follows what changed, never what is stored** (B §2). A scan of a
   whole history survives only in a repair event, a daily chore or the nightly backup (§8).
3. **Shared budgets are held on the server.** Turso's rows read, Spotify's quota and rate limit and
   Vercel's CPU are shared by every user; no client call can spend more than the server allows, and
   one user's share is bounded (§6.6, §7.5).
4. **Nothing reaches a friend until it has run on Rem alone.** Phases 1-3 change how the app is
   built, never who can reach it; each soaks on Rem's account before the next, and the first friend
   arrives only after every isolation test has failed against a planted bug and then passed (§13).
5. **Rem's data does not move.** `lazyboy` becomes his user database. The only changes to it are a
   new derived column (`plays.listened_ms`, filled and verified once), two `meta` keys, and the token
   rows leaving for the app database a week after they are copied (§11).

The order of work, detailed in §13:

| when | what | for whom |
|---|---|---|
| now, before Oct 15, 8 PM if Rem approves | **Phase 0**: rotate `AUTH_SECRET`, set `SPOTIFY_OWNER_ID`, gate `logout`; six edits to STORE_MIGRATION; two dashboard reads; a dev sign-in that shows whether Spotify returns `account_id` | today's exposures |
| Oct 15 on | **STORE_MIGRATION lanes 1901-1911**, as planned; 1910-1911 also ship the identity-first orphan predicate (P1) | Rem |
| after lane 1911 | **P2**: `listened_ms` and the all-time accumulator. **P3**: monthly history segments, lazy days, fetch at mount; **must ship before mid-December** | Rem, single-user |
| after P3 | **Phase 1**: identity and isolation structure. **Phase 2**: the app database and encrypted tokens. **Phase 3**: the sync queue, the second pinger | Rem, single-user |
| after Phase 3 | **Phase 4**: the first friend | Rem + 1 |
| a week apart each | **P4** (Home payload patch, strip from segments) and the quota brake before the second friend; then **Phase 5**: friends two to four | up to 5 |

## 4. Data model

### 4.1 Three kinds of database

- **A user database** per user, holding today's seven core tables with today's columns, keys and
  indexes (`tracks`, `plays`, `contexts`, `meta`, `playlists`, `playlist_tracks`, `saved_tracks`;
  `db.ts:158-209` and the `ALTER`s at `:244-295`), plus one derived column, `plays.listened_ms` (§8.2).
  Every plan 01a measured with `EXPLAIN QUERY PLAN` (01a §4.2) holds unchanged, and each user gets
  01a §9.2's "user-led" timings without a new index. Rem's is Turso `lazyboy`; a friend's is
  `lb-u-<uid>`, in the same group (`default`, `aws-us-east-1`, beside Vercel's iad1).
- **The app database**, `lazyboy-app`: identity, ciphertext and scheduling, and no listening data at
  all. A mistake in its functions can mis-schedule or lock out a user; it cannot show one person's
  history to another (A §3).
- **The telemetry store**, the Zenbook's sqld after STORE_MIGRATION (its §5): `api_log` and
  `client_metrics` gain a nullable `user_id`, `api_log` a nullable `reason` for 429s; `usage_ledger`
  stays global.

Why a database per user rather than one shared store with a `user_id` column: in a shared store, 17
of 01a's 38 census items are SQL-level, more than fifty statements each need `user_id = ?`, four
tables are rebuilt over live data, and a single missed filter deletes other users' playlists (D12),
drops their plays on a timestamp collision (D17) or stores skip verdicts computed from another
person's previous play (D18) (01a §7.3, §8.1). SQLite has no row-level security, so that rule would
live in application code with nothing to check a `WHERE` clause. Per-user databases make those
statements correct without editing them and leave Rem's data where the cutover puts it. The costs at
five users are loops over six databases (backups, migrations), `tracks` stored once per user (at most
~4.2 MB each, 01a §8.1), and a future friends feature that merges two reads in code instead of
joining. Turso's free plan allows 100 databases and counts rows read per organization, so the model
changes neither the database limit nor the read budget in practice (01f §4.2).

### 4.2 The app database

```sql
CREATE TABLE users (
  uid               TEXT PRIMARY KEY,      -- random, 12 base32 chars; never reused
  account_id        TEXT UNIQUE,           -- Spotify account_id; NULL until an invite is claimed
  spotify_id        TEXT NOT NULL,         -- Spotify id: what an invite names; refreshed at sign-in
  db_name           TEXT NOT NULL UNIQUE,  -- 'lazyboy' for Rem, 'lb-u-<uid>' for a friend
  status            TEXT NOT NULL,         -- provisioning | invited | active | needs_reconnect
                                           -- | disabled | deleting
  is_admin          INTEGER NOT NULL DEFAULT 0,
  session_epoch     INTEGER NOT NULL DEFAULT 0,
  terms_version     TEXT,                  -- privacy policy and end-user agreement accepted (§12.2)
  terms_accepted_at INTEGER,
  invited_at        INTEGER NOT NULL,
  claimed_at        INTEGER,
  last_sign_in      INTEGER                -- drives the twelve-month inactivity rule (§12.3)
);
-- one open invite per Spotify id, so a claim can never match two rows (A §3.1)
CREATE UNIQUE INDEX idx_users_open_invite ON users (spotify_id) WHERE status = 'invited';

CREATE TABLE user_tokens (
  uid        TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,      -- 'v1.' || base64url(iv ‖ ciphertext ‖ tag), §5.3
  expires_at INTEGER NOT NULL,   -- plaintext, so the cron sees who needs a refresh
  granted_at INTEGER NOT NULL    -- last consent: Spotify's six-month refresh-token clock (01e §2.1)
);

CREATE TABLE sync_state (        -- 01c §5.2's due queue
  uid             TEXT PRIMARY KEY,
  state           TEXT NOT NULL, -- active | idle | backoff | needs_reconnect | removed | paused
  next_probe_at   INTEGER NOT NULL,
  next_rescan_at  INTEGER,
  lease_owner     TEXT,
  lease_until     INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,          -- a code, never a message body
  last_ok_at      INTEGER,       -- capture health for the banner and the owner alarm
  last_harvest_at INTEGER,
  quota_day       TEXT,          -- the recently-played quota day rp_calls counts (§7.5)
  rp_calls        INTEGER NOT NULL DEFAULT 0,
  lag_p50_s       INTEGER,       -- F2's instrument, rolled up daily (§7.8)
  lag_p95_s       INTEGER
);
CREATE INDEX idx_sync_due ON sync_state (next_probe_at);

CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
-- keys: schema_version; cooldown:<bucket>; played_at_convention; lock:spotify_refresh:<uid>
```

Choices in it: there is no `env` column on tokens, because dev runs its own app database (§5.6) and
production's never holds a dev grant (A, C). Invites are `users` rows in status `invited`, with the
database already provisioned, so one claim statement binds a sign-in to a row (A §10.2). What the
probe last saw (track, progress, the retry flag) stays in the user's own `meta` beside today's
`player_last_active` and `rp_last_harvest` (`db.ts:2364-2374`); `sync_state` holds times, counters
and leases only.

**Every client comes from one factory.** The app client, each user client and the telemetry client
are built by one function that passes `makeStoreFetch` (`src/lib/store-fetch.ts`): the gzip pin, the
retry ladder and the Request rebuilt per attempt are what two production incidents bought (GOTCHAS
"Never let the store compress with brotli", "The store fetch must rebuild its Request per attempt"),
and a per-user client built with a bare `createClient` would lose all three silently. URLs use the
`https://` form, since `@libsql/client` maps `libsql://` to WebSockets, where the fetch override does
not apply (STORE_MIGRATION §3). None of the designs names this; it is cheap to get right once and
easy to get wrong N times.

### 4.3 Every table and `meta` key

01a §2-3's census, with where each item goes:

| today | where it goes | how it is tied to one user |
|---|---|---|
| `tracks`, `plays`, `contexts`, `playlists`, `playlist_tracks`, `saved_tracks` | the user's database | by being in it. Per-user `contexts` also ends the shared negative cache: one user's 403 no longer hides a name from another for 30 days (01a D25) |
| `meta`: `last_sync`, `write_seq`, `library_seq`, `slow_seq_pub`, `home_payload`, `alltime_stats`, `alltime_at`, `unique_song_count`, `contexts_full_check_at`, `playlists_synced_at`, `library_synced_at`, `library_scan_attempt_at`, `saved_synced_at`, `liked_total`, `liked_top_added_at`, `plsnap:*`, `player_last_active`, `rp_last_harvest`, `clean_backup_pref`, `lock:clean:*` | the user's database, unchanged | by being in it. The version markers become per user without a line of code, which stops one user's plays from invalidating every other user's caches (01a D21) |
| `meta.me_id` | the user's database | written only by that user's own library sync with that user's own token; used by the owned-playlist filter (`db.ts:2297, 2310`) and the page's `isMine`; never read for sign-in again |
| `meta.user_tz_offset`, `HOME_TZ` (`db.ts:1270`) | `user_tz` (an IANA zone) in the user's database | written by `/api/sync` only when it changes; the Home payload buckets days in the user's zone, with the DST check against that zone (C §3.3) |
| `meta.spotify_tokens` | `user_tokens`, encrypted | the uid key and the associated data (§5.3); the plaintext row stays in `lazyboy` for a week, then goes (§11.3) |
| `meta.spotify_tokens_dev` | dev's own app database | not in production at all |
| `meta.lock:spotify_refresh` | `app_meta`, `lock:spotify_refresh:<uid>` | the uid in the name |
| `meta.spotify_cooldown_until` | `app_meta`, `cooldown:<bucket>` | global by meaning: Spotify's rate limit is per app and its quota per developer account (01f §1.4); split by bucket so a recently-played ban does not stop the player probe (01c S4) |
| `meta.played_at_convention` | `app_meta` | global by meaning; computed from the admin's plays by the daily route |
| new: `owner_uid`, `schema_version` | the user's database | written once at provisioning or migration, never by the app (§4.5) |
| new: `probe`, `seg_seq:<YYYY-MM>` | the user's database | the probe's last track and progress (§7.3); each month's segment version (§9.1) |
| `meta.last_sync_added`, `meta.pltracks_at:*` | dropped by the Phase 2 migration | dead: no reader (01a §3) |
| `api_log`, `client_metrics` | telemetry, `+ user_id`; `api_log` `+ reason` | the column; deletion deletes by it (§12.3) |
| `usage_ledger` | telemetry, unchanged | global; per-user store usage comes from Turso's per-database numbers |

### 4.4 The user key

A random opaque uid, 12 base32 characters (60 bits), names the user everywhere the app can see it:
the session claim, `forUser`, cache keys, payload URLs, ETags, browser storage, telemetry rows and a
friend's database name. Spotify's `account_id` is only the link used at sign-in (01e §5.1); Spotify's
mutable `id` is only what an invite matches once (§12.1).

The design question was integer or random (§2.3). The case for random is the failure it removes: if
the app database is ever restored from a backup, an `AUTOINCREMENT` integer can be issued again to a
newcomer, who would then match a departed user's cache entries for up to a day and, under C's
derived names, their database. A random uid cannot collide, so the owner stamps of §6 compare against
a value that is unique for good. It carries no personal data, so it can sit raw in an ETag, a URL or a
storage key where page scripts can read it, which removes A's need for an HMAC secret (`HK_SECRET`) to
make an opaque browser key. 01a §8.4's case for an integer (bytes per play) does not apply: no
per-play row carries the key in this model.

### 4.5 Schema versions in place of `init()`

Today `init()` runs one `executeMultiple`, four `PRAGMA table_info` reads and three `CREATE INDEX`
statements on every cold process, eight serial round trips, with no notion of a version
(`db.ts:153-297`; 28 cold starts on Oct 14, 01c §2.1). Against N databases that would be eight round
trips per database a process touches. The plan:

1. **Code declares `USER_SCHEMA` and `APP_SCHEMA` versions**, each a list of steps marked additive or
   rebuild.
2. **The first open of a database in a process** runs one statement: `SELECT key, value FROM meta
   WHERE key IN ('owner_uid', 'schema_version')`. A wrong `owner_uid` refuses the database and logs an
   `isolation` event (§6.2). A current version means nothing more is run. A version behind by
   additive steps only (a nullable column, an index) applies them as `init()` does today and bumps
   the version, so the house workflow for the common change is unchanged (C §3.4). A version behind
   by a rebuild refuses that user ("updating") until the migrate script runs; nobody else notices
   (A §3.5, B §4.6).
3. **Provisioning** creates a new user database at the current version in one `executeMultiple`, with
   `owner_uid` and `schema_version`, at invite time (§12.1), so sign-in never waits on it.
4. **`scripts/migrate.mjs`**, run from the Mac, applies rebuild steps one database at a time: set that
   user's `sync_state` to `paused`, take a restore point (Turso point-in-time, plus a dump), apply,
   verify, bump the version, resume (B §4.6). At six databases this takes minutes.
5. **Deploy order** stays what it is: an additive step first (old code tolerates it), then the code
   that needs it, then any destructive step.

Preview cannot run any of this against production, because Preview gets no store variables (§10.2).
The telemetry store keeps STORE_MIGRATION phase A's own telemetry init (its §6 item 2).

### 4.6 Storage

Rem's core data is 11.87 MB, growing ~35 KB a day (01a §2, §6) [measured]; `listened_ms` adds ~4 bytes
a play, ~0.1 MB [estimate]. A friend with a library like Rem's starts near 3.3 MB (01a §9.1) and has
no catalog backfill. Five Rem-like users are under 100 MB against the free plan's 5 GB [estimate];
storage does not bind (01f §4.4).

## 5. Identity, sessions and per-user tokens encrypted at rest

Today nothing on the server can say which Spotify account a session belongs to: Auth.js mints a
random `sub` at every sign-in and the app stores no id on the token (01b §1.1, 01e §1.3-1.4), every
request reads one global token row, and the owner guard runs only at sign-in (`src/lib/auth.ts:344-347`).
01e §5 designed the replacement; all three designs adopt it, and so does this plan, with the uid of
§4.4 as the session claim.

### 5.1 The session names its user

- **Sign-in** (`signIn` callback). The profile comes from `/v1/me` with `cache: "no-store"` (A §2.5:
  the one fetch whose cached answer would bind one person's sign-in to another's account). Then, in
  order: a 403 "not registered" goes to `/login?error=SpotifyNotRegistered` as today; a profile with
  no `account_id` is refused and logged, never keyed on `id` instead (01e §5.5); a `users` row with
  that `account_id` signs in if `active` or `needs_reconnect` (refreshing `spotify_id` if it
  changed) and is refused if `disabled` or `deleting`; otherwise the sign-in must claim an invite,
  which needs the terms cookie of §12.1:
  ```sql
  UPDATE users SET account_id = :aid, status = 'active', claimed_at = :now, last_sign_in = :now,
         terms_version = :tv, terms_accepted_at = :now
  WHERE status = 'invited' AND spotify_id = :sid AND account_id IS NULL
  RETURNING uid
  ```
  One row back signs in as that uid; none is AccessDenied, worded "this app is invite-only".
  `SIGNUPS=owner` refuses everyone but the admin row whatever the rows say: Phases 1-3 run with it,
  and it is Phase 4's one-variable way back (C §4.1). `userinfo.ts` today maps every non-2xx from
  `/v1/me` to "not registered" (`src/lib/spotify/userinfo.ts:33-36`), so a passing 429 would tell an
  invited friend they are not allowed; it narrows to a 403 (C §10.1).
- **The jwt callback's sign-in branch** writes the encrypted token row for that uid with
  `granted_at = now`, and puts `uid` and `ep` (the session epoch) on the cookie from the `users` row,
  never from the incoming cookie or the profile alone, which is what keeps session fixation out
  (01e §5.6). The two paths that park Spotify tokens inside the cookie when the store write fails
  (`auth.ts:367-374`, `388-405`) go: a token in a cookie is bound to no user row and invisible to the
  cron, so a sign-in that cannot write its row fails visibly and is retried (01e A18).
- **Every later request** reads identity, token, capture health and the cooldown in one app-database
  statement, through a React `cache()` box keyed by uid (it replaces `tokenBox`, `auth.ts:73-83`):
  ```sql
  SELECT u.status, u.session_epoch, u.is_admin, u.db_name,
         t.blob, t.expires_at, s.state, s.last_ok_at, s.last_harvest_at,
         (SELECT value FROM app_meta WHERE key = 'cooldown:recently-played') AS rp_cooldown
  FROM users u
  LEFT JOIN user_tokens t ON t.uid = u.uid
  LEFT JOIN sync_state  s ON s.uid = u.uid
  WHERE u.uid = :uid
  ```
  Primary-key probes only, ~4 rows read [estimate]. The callback returns `null`, which signs the
  request out, when the cookie has no `uid` (every cookie minted before Phase 1, which closes 01e F1
  for good), the uid is unknown, the status is not `active` or `needs_reconnect`, or `ep` is not
  `session_epoch`. One round trip, as today's token read is (01e §5.1), and it also carries what
  Home's chrome reads separately today (B §5).
- **`requireUser()`** (server-only) wraps `auth()` and returns the branded uid with `{ admin,
  canCallSpotify }`, or refuses: a redirect for a page, a 401 for a route, `{ ok: false }` for an
  action (01b S2). It is the only source of a uid for an entry point, and it merges the three gate
  strengths 01b §2.4 found into one rule.
- **The browser** gets the uid rendered into the page by the `(app)` layout, for its storage keys
  (§6.5). Nothing new goes on the `Session` type, whose fields Auth.js serves at
  `GET /api/auth/session` (docs/SECURITY.md "Tokens never reach the browser").
- **Home's gate runs before its reads**: the payload read needs the uid, so Home pays one sequential
  round trip it does not pay today (~15 ms at R1's target, I$). Decoding the cookie separately to
  start the read in parallel (B §5, 01b S2) is held in reserve for a badly missed R1; it is a second
  way to mint a user handle, and 15 ms is under 1% of S2's budget.

### 5.2 Tokens per user

The token core (`refreshAccessToken`, `coordinatedRefresh`, `waitForFreshToken`, `clearTokensIfStale`,
`getValidAccessToken`, the in-flight map) leaves `auth.ts` for a module with no `next-auth` import,
so the simulated environment can run it; today no test can load `auth.ts` (01e §2.7, A21).

| today | plan | why |
|---|---|---|
| `inflightRefresh`, one promise per instance (`auth.ts:188-196`) | `Map<Uid, Promise<Tokens>>` | shared, user B's concurrent refresh joins user A's and receives A's tokens: the one change in the census that leaks silently (01e A2) |
| `acquireLock("spotify_refresh")` (`auth.ts:212`) | `lock:spotify_refresh:<uid>` in `app_meta` | a shared lease makes B wait up to ~32 s for a token nobody is refreshing (01e A4) |
| `get/set/clearSpotifyTokens()` on `meta` (`db.ts:2514-2531`) | `getTokens(uid)`, `setTokens(uid, t)`, `clearTokens(uid)` on `user_tokens` | 01e A1, A5 |
| `getValidAccessToken()`, `refreshingToken()`, the library task's getter (`auth.ts:278-289`, `actions.ts:46-57`, `playlists-sync.ts:61-65`) | each takes the uid; a background task binds it at creation | 01e A16 |
| `clearTokensIfStale` (`auth.ts:170-181`) | the same rule within one user's row | the fresh-token veto carries over unchanged (01e §2.5) |
| a decrypted token is a bare object | `{ uid, accessToken, refreshToken, expiresAt }`; `setTokens` asserts `t.uid === uid`; the Spotify client asserts the token's uid is the caller's and tags every call with it in `api_log` | a future refactor that shares a promise or cache across users fails an assertion on the first mixed call instead of acting on someone else's account (A §2.5); one compare per call |

Six known answers come first (01e §5.2): two users refreshing concurrently in one process each end
with their own token, one token-endpoint call each; A holding the lock does not delay B;
`invalid_grant` for A clears A's row only; A's ciphertext in B's row fails to decrypt; a cookie with
no uid, an unknown uid, a disabled user or a stale epoch yields no session; no row means no Spotify
call. Write load: about 24 refreshes per active user a day, each a lock acquire, a row write and a
release, ~72 rows per user a day [estimate, 01e §5.2].

### 5.3 Encryption at rest

01e §5.3's scheme, adopted as written by all three designs:

- AES-256-GCM from `node:crypto`, a random 12-byte IV per write, stored as
  `v1.<base64url(iv ‖ ciphertext ‖ tag)>` where `v1` names the key; both tokens in one blob.
- Associated data `lazyboy:tokens:v1:<uid>`: a ciphertext copied into another user's row fails to
  authenticate, so write access to the app database without the key cannot graft a victim's grant
  onto the attacker's account. A checked this with the scheme itself (A §17).
- Plaintext columns: `uid`, `expires_at`, `granted_at`.
- Keys in `TOKEN_KEYS="v2:<base64 32 bytes>,v1:<…>"`, a Vercel Secret ("write-only after saving"),
  Production only; the first key writes, reads pick by prefix. Dev has its own key and its own app
  database, so the production key never sits in `.env.local`. Rotation: put a new key first and
  redeploy; active rows re-encrypt at their next refresh, about hourly; a one-off script does the
  rest; drop the old key when no blob carries its prefix. A copy in Rem's password manager is the
  backup; losing the key costs every user one sign-in and nothing else.
- A blob that fails to decrypt is no token: the user goes to `needs_reconnect`, and the log line
  carries the uid, never the blob.
- Cost: 1.67 µs to decrypt and 2.67 µs to encrypt a 450-byte blob [measured by A on the Mac, A §17.1],
  against a ~15 ms round trip.

It protects every copy of a token outside the Vercel runtime: Turso's backups and point-in-time
history, the nightly dumps on the Zenbook and OneDrive, scratch copies, a dev machine, a leaked store
token. Those matter more than usual here because Spotify does not rotate this app's refresh tokens
(unchanged across two weeks of hourly refreshes) and documents a six-month lifetime, so a copy is a
live 13-scope credential for months (01e F2). It does not protect against code running in production,
which holds the key, or a holder of `AUTH_SECRET`, who can drive the app as any user without seeing a
token. Vercel KMS only signs; AWS KMS brings the AWS dependency Rem ruled out (01e §5.3).

### 5.4 Sign-out, revocation and expiry

- **Three actions instead of today's one** (01e §5.6; Rem's call, §18): *sign out* clears this
  browser's cookie and its stores, and capture continues; *sign out everywhere* bumps
  `session_epoch`; *disconnect and delete* runs the deletion job (§12.3) and tells the user to remove
  Lazy Boy at spotify.com/account/apps, since the app cannot revoke a grant. Today's `logout` deletes
  the only token row, which stops capture and signs out every device (`actions.ts:63-69`).
- **Sessions stay a fixed 30 days**, never renewed (01e §1.4). Every sign-in passes Spotify's consent
  screen (`show_dialog`, `auth.ts:322`), which restarts the six-month refresh-token clock, so an
  active user never reaches it. The epoch is the server-side kill switch; `AUTH_SECRET` rotation is
  the everyone-out switch.
- **`invalid_grant`** clears that user's token row and sets `needs_reconnect`; the cron stops calling
  Spotify for them and nobody else is touched (01e §5.7). `granted_at` tells the two causes apart:
  under six months it was most likely revoked, and the plan treats it as a disconnect (§12.3,
  decision in §18); at six months it expired, and the data stays. The owner is exempt from any
  automatic deletion.
- A 401 on a token the store believes fresh zeroes that user's `expires_at`, so the next call
  refreshes and finds a revocation within seconds rather than within the hour (01e §5.7).
- **A dead grant and the pages**: a `needs_reconnect` session keeps today's behaviour, the page gates
  send it to `/login` (`auth.ts:406-409`), and the six history actions and two search routes that
  check only for a session today move onto `requireUser()`, which applies the same rule (C §15
  decision 20). 01b §2.4 recommends a read-only mode instead; with §12.3 deleting a friend's data on a
  revocation, the read-only state would mostly show data that is being deleted. Rem's call (§18).

### 5.5 Secrets, by environment

| secret | Production | Preview | dev (`.env.local`) | what it unlocks once friends exist |
|---|---|---|---|---|
| `AUTH_SECRET` | rotated in Phase 0 | its own value (C M0a) | its own | minting a cookie that names any uid |
| `TOKEN_KEYS` | Secret | none | a dev key | decrypting every grant |
| Turso group token, read-write | Secret | none | none | every user's data (group tokens "cannot be revoked individually", B §19) |
| Turso group token, read-only | – | – | – (Zenbook backup job) | reading every user's data |
| `lazyboy` database token | – | – | yes, so dev reaches Rem's data only (C §8.2) | Rem's data; invalidation is group-wide, so a leak rotates all three Turso tokens |
| `TURSO_PLATFORM_TOKEN` | runtime, used by two functions only: the deletion job's destroy and the daily usage read (§12.3) | none | yes, for the invite and migrate scripts | creating and destroying databases |
| `CRON_SECRET` (Zenbook) and `CRON_SECRET_EXT` (cron-job.org) | both | none | the Zenbook's | running ticks; each rotates alone, and the route knows which caller may get a non-200 (§7.2) |
| `SPOTIFY_CLIENT_SECRET` | unchanged | unchanged | unchanged | refreshing any refresh token it finds |

## 6. Isolation: enforcement in one place, and the tests that prove it

### 6.1 The mistakes it has to survive

The incident that started this program shows the shape of the risk: one global token row, so a
second account's sign-in turned every request and every cron tick into that account's, and its plays
were recorded into Rem's history (commit `044c9b6`, 01b §1.2). The overviews found how wide the
single-user assumption runs (01a §7, 01b §4, 01e §4). A §1 sorts the ways a multi-user build could
leak into thirteen classes, which this plan keeps:

| # | class | where an instance exists today |
|---|---|---|
| M1 | a store statement that forgets the user | 01a D12-D19: more than fifty statements in `db.ts`, five import scripts |
| M2 | a user id taken from request input | none yet; the natural bug once ids exist |
| M3 | a read before, or without, the gate | `/home` reads in the gate's `Promise.all` (`home/page.tsx:78-83`, 01b E5); `logout` has no gate (01b E3) |
| M4 | a cache key without the user, or with it captured in a closure Next cannot see | all seven `unstable_cache` entries (01a §5); Next 16.2.6 keys on the callback's source, the key parts and the arguments only (01b §3.1) |
| M5 | process state shared across users | `inflightRefresh`, `playlistsCache`, `currentSyncId`, argument-less `cache()` boxes (01b §3.3-3.4) |
| M6 | the wrong Spotify token for the user | 01b A1-A6, 01e A2 |
| M7 | browser state that outlives a change of user | ETags with no user; `lb-days`, `lb-nowplaying`, `clean:active` (01b §3.6) |
| M8 | background work that mixes users | a cron fan-out over today's code (01c S3, S7, S8) |
| M9 | a wrong mapping from a user to their storage | new in any multi-user design: provisioning, restore or migration mistakes |
| M10 | the shared tables and the operator's views of them | `/usage` shows everyone's telemetry (01b B8) |
| M11 | scripts and dev servers writing production data with no user | 01a D33, D38 |
| M12 | a sign-in bound to the wrong account | linking on Spotify's mutable `id` (01e §5.5); an invite claimed twice |
| M13 | one user spending a quota every user shares | Turso's org-wide rows read, Spotify's per-account quota, Vercel's team allowances (01f §1.4, §2.2, §4.2) |

The rule: every class meets at least one layer that makes the mistake impossible to write or
harmless when written, and at least one that detects it (a test in `npm test`, or a runtime check
that refuses and logs). M13 differs in kind: no code makes a shared quota private, so the plan
bounds each user's share (§6.6, §7.5).

### 6.2 The layers

1. **A database per user** (§4.1). A whole-table statement such as `storePlaylists`' `DELETE FROM
   playlists` (`db.ts:1848-1883`), the gap chains of `recomputeSkipFlags` (`db.ts:780-822`) or
   `recordPlays`' dedupe read (`db.ts:484-496`) is already correct when the table is one user's; 01a
   §8.1 counts what that removes (census items D4-D19, D21, D23, D25). A routing mistake becomes a
   wrong-database error, never a corrupted shared table. *Stops M1.*
2. **A uid only three functions can mint.** `type Uid = string & { readonly [brand]: "Uid" }` in a new
   `src/lib/identity.ts`. `requireUser()` mints one from the session (§5.1), `claimDueUsers()` from the
   rows it just leased (§7.2), `scriptUser(argv)` from a required `--user` checked against `users`.
   A plain string from a path, a query or a body does not compile where a `Uid` is wanted, and
   `npm run build` type-checks. *Stops M2 and M3: a read needs a `Uid`, so no read runs before the
   gate, which also ends the anonymous reads on `/home` (01b E5).*
3. **One handle per user, and databases that name their owner.** `db.ts` stops exporting per-user
   functions; its 74 async exports (01a D2) split into `forUser(uid): UserStore` (today's functions
   bound to the user's client and passing the uid into every cache key), `src/lib/app-db.ts` (every
   statement on the app database, a short list a reviewer can read in one sitting, A §2.7) and the
   telemetry client. `forUser` gets its client from a per-process map filled from `users.db_name`
   through one URL template; an unknown uid throws and nothing ever falls back to a default URL
   (C §2.2). The first open runs §4.5's statement and refuses a database whose `owner_uid` is not the
   uid it was opened for. *Stops M9 and the residue of M1: no module-level function is left that
   could run against "the" database.*
4. **Caches, process state and background work** (A §2.4):
   - `userCache` in `src/lib/user-cache.ts` is the only caller of `unstable_cache`. It builds
     `unstable_cache(fn, ["u", uid, ...keyParts], { revalidate })` and calls it as `fn(uid, ...args)`,
     so the uid separates entries twice over and a closure-captured id has no way in. It stores
     `{ o: uid, v: value }` and checks `o` on every return; a mismatch logs an `isolation` event and
     returns the right user's data uncached. That check is what turns a key mistake into a slow
     request in production, including the case no unit test sees: a Preview build writing entries
     under keys production reads, which 01b §8 could not rule out. The seven wrappers
     (`db.ts:983, 1082, 1176, 1181, 1600, 1615, 1906`) move onto it; the shape tokens stay in the key
     parts. Moving every key also strands every single-user entry at the first deploy (01b §3.1).
   - No cache tags. A deleted user's entries expire within 24 hours (`FROZEN_TTL_S`, `db.ts:958`) and
     no session can name a deleted uid, which is never reused (C §5.2).
   - The three `cache()` boxes (`auth.ts:73`, `db.ts:402`, `db.ts:854`) take the uid as their
     argument, so whether `cache()` is active in a route handler (01b §3.3, unverified) stops
     mattering.
   - Module state:

     | state | where | becomes |
     |---|---|---|
     | in-flight refresh | `auth.ts:188-196` | `Map<Uid, Promise<Tokens>>`, plus the token-owner assertion (§5.2) |
     | playlist-list cache | `src/lib/spotify/resources.ts:76-104` | deleted: it saves a second `/me/playlists` read within 60 s, and keyed or not it is the one cache that would store A's library as B's (01b A6) |
     | running library sync | `src/lib/playlists-sync.ts:22, 50-54` | `Map<Uid, string>` |
     | unique-song throttle, store-size memo | `db.ts:1960`, `db.ts:2887` | per uid |
     | Spotify cooldown | `src/lib/spotify/client.ts:48`; `app_meta` | app-wide by bucket, on purpose (§4.3) |
     | task registry | `src/lib/tasks/registry.ts:21-23` | each task records its owner; `/api/tasks/[id]` answers 404 to anyone else (01b S7) |

   - Background work receives everything it may touch as arguments: the cron's per-user step gets the
     `Uid`, its `UserStore`, a token getter bound to that uid and its deadline (§7.2). *Stops M4, M5,
     M8.*
5. **Spotify credentials that carry their owner** (§5.2-5.3): the associated data binds a ciphertext
   to its row, the owner field binds a token object to its user, locks and in-flight maps are keyed
   by uid, and the profile fetch at sign-in is never cached. *Stops M6, and M12 with §12.1.*
6. **The browser** (A §2.6, with the random uid of §4.4 in place of A's HMAC):
   - ETags become `"lib-<shape>-<uid>-<version>-<day>"` and `"hist-<shape>-<uid>-<version>-<day>"`
     (today `src/app/api/search/library/route.ts:39`, `history/route.ts:26`). Per-user counters are
     small integers that collide across users (01a §5), so without the uid a shared browser profile
     could get a 304 for the previous user's body.
   - Immutable segment URLs carry the uid in the path (§9.1), because an immutable response is never
     asked for again; the server compares the path's uid with the session's and answers 404 on a
     mismatch, and it builds every body from the session's database, never from the path.
   - Every payload carries `u: uid`, and the client drops any body, from the network, the HTTP cache
     or IndexedDB, whose `u` is not the page's.
   - Storage keys are prefixed with the uid: `lb-days`, `lb-nowplaying`, `clean:active`, phase E's
     IndexedDB store, and the `lb-nowplaying-leader` Web Lock and BroadcastChannel names, so two
     users' tabs in one browser neither read nor relay each other's state (01b §3.6).
   - Sign-out clears that storage in the browser before the sign-out form submits (sign-out is a
     server action, 01b §7 item 1), and the response sends `Clear-Site-Data: "cache", "storage"` where
     the browser honours it; the client-side clear is the one relied on. *Stops M7.*
7. **The shared remainder.** `app-db.ts` holds every statement on the app database; the handful that
   take no uid (sign-in's lookup and claim, the cron's claim, the admin list, the global keys) are
   cross-user by design and each has a test (T6). `/usage` and any admin page require `is_admin`,
   set by the migration for Rem and never derived from `me_id` (01b E2). Telemetry rows gain the uid,
   `handoff` beacons send a track id instead of "artist — title" (01a §10). Scripts take a required
   `--user`, and the backstop replay refuses anyone but the admin, since the recorder captures only
   Rem (01c §5.7). Preview gets no store variables; dev reaches only Rem's database and local files
   (§5.5). *Stops M10 and M11.*

### 6.3 Every class against the layers

| class | prevents | detects |
|---|---|---|
| M1 a statement forgets the user | a database per user | T1: user B's database file hash unchanged by every call made as A |
| M2 an id from request input | the branded `Uid` | static S2 (no casts); T3: A's identifiers in B's request return B's data or a 404 |
| M3 a read before the gate | a read needs a `Uid` | T3: every entry point with no session refuses before any user database opens |
| M4 a cache key without the user | `userCache` | T2 with equal counters; the owner stamp at runtime |
| M5 shared process state | keyed maps; the deleted cache | static S4; T4 (two users in one invocation) |
| M6 the wrong token | per-user rows, locks and maps | the token-owner assertion at runtime; T5 (Spotify scripted per bearer) |
| M7 browser state across users | uid in keys, ETags, URLs and bodies | T7 |
| M8 background work mixing users | a per-user step with explicit arguments | T4 |
| M9 a wrong user-to-database mapping | random uids; names written once | the owner check on every open; T8 |
| M10 shared tables and operator views | `app-db.ts`'s fixed list; the admin flag | T6; T3 for `/usage` as a non-admin |
| M11 scripts and dev on production | required `--user`; dev's credentials; Preview without store variables | T10 |
| M12 a sign-in bound to the wrong account | `account_id` link, compare-and-set claim, uncached profile read | T9 |
| M13 a shared quota | server-held limits (§6.6), the fair-share brake (§7.5), plan choices (§15) | per-database usage and per-user `api_log` on `/usage` |

### 6.4 The tests

They run in the existing simulated environment (`npm test`: vitest against throwaway SQLite files and
a scripted `fetch`, `tests/setup.ts`), touching no store, no Spotify and no Vercel. Each is written
red first, and each is shown failing against a planted bug before it is trusted (B §6): a test that
has never failed proves nothing.

**What the harness gains** (A §5.1): three database files per test file (`app.db`, `u1.db`, `u2.db`),
created by the production provisioning code so provisioning is under test too; a two-user seed with
deliberate collisions (the same track at the same `played_at`, D17; the same playlist id with
different members, D14; the same context URI named for one user and negative-cached for the other,
D25; interleaved timelines, D18; equal `write_seq`, `library_seq` and `slow_seq_pub`), with a marker
string (`A-only-…`, `B-only-…`) in every text column; a faithful `unstable_cache` stub keyed the way
Next 16.2.6 keys (`fn.toString()`, the key parts, `JSON.stringify(args)`) in place of today's
pass-through (`tests/stubs/next-cache.ts:4-10`), which can see no collision at all; a scripted Spotify
that answers per bearer token and logs which bearer each call carried; a session switch (the
`vi.mock("@/lib/auth")` pattern of `tests/now-playing-route.test.ts:13-16`); an open counter per uid;
and sha256 file hashes of the other user's database before and after.

| id | runs | must hold |
|---|---|---|
| T1 | every method of `UserStore`, enumerated from the object so a new method is covered automatically, as A then as B | the other user's file hash unchanged; no other-user marker in any return value |
| T2 | the seven cached reads as A then B with equal counters; then a forged entry under B's key stamped with A | B never sees an A marker; the forged entry is refused, B's data served uncached, an `isolation` event logged |
| T3 | every page, every `"use server"` export and every route handler, found by globbing `src/app`: with no session; as B; as B with A's identifiers in the input (playlist id, task id, A's uid in a segment path); `/usage` as non-admin B | refused with zero user-database opens; no A marker anywhere and A's file unchanged, every Spotify call on B's bearer; B's data or a 404, never A's; refused. Exempt by a named list: `/`, `/login`, `/join`, `/api/build`, `/api/auth/*`, `/api/cron/*` |
| T4 | one cron tick with A and B due, both tokens expired; then A failing three ways (403 "not registered", `invalid_grant`, a hang past the deadline); then library syncs for A and B within 60 s on one instance | each database gets only its own plays; one refresh per user; A's lock does not delay B; B's outcome `ok` whatever A does; the reply is 200 with both outcomes; each user's own playlist list stored (the `playlistsCache` trap) |
| T5 | the token core | 01e's six known answers (§5.2) |
| T6 | the app-database functions that take no uid | a claim never returns a leased user or the same user to two concurrent claims; an invite is claimed once; only listed global keys are accepted |
| T7 | the search routes and the client storage module (behind a storage interface, as STORE_MIGRATION §10 plans) | equal versions give A and B different ETags; B with A's ETag gets 200 and B's body; a segment path with A's uid under B's session is 404; a stored body whose `u` is not the page's is discarded; sign-out empties the store |
| T8 | a users row pointing B at A's database file; a database at the wrong schema version | B's open refuses before any read or write, logged, A's hash unchanged; the wrong version refuses that user only |
| T9 | sign-in | an invite claimed once; a profile without `account_id` refused; a returning user found by `account_id` after their `id` changed; Y cannot claim X's invite |
| T10 | every script | exits non-zero without `--user`; with `--user B` touches only B's file; the backstop replay refuses anyone but the admin |
| T11 | the deletion job for B | B's next request has no session; B's token, queue and telemetry rows are gone; B's database destroyed (the Platform API mocked); A's hash unchanged; a second run is a no-op; the job refuses the admin, `lazyboy`, and any name that is not `lb-u-<uid>` with a matching `owner_uid` |
| T12 | the Phase 2 migration on a local copy of a nightly backup, by hand (it needs Rem's data) | §11.3's checks |

Static checks, also in `npm test` (A §5.3): S1 `unstable_cache(` appears only in `user-cache.ts`; S2
no `as Uid` outside `identity.ts`, whose minting helper only the gate, the claim and the script
helper import; S3 no per-user function exported from `db.ts` at module level, and `app-db.ts`'s
exports match a snapshot a reviewer sees change; S4 every top-level `let`, module-scope `new Map(`
and `globalThis` write under `src/` is on a reviewed allowlist saying how it is keyed; S5 every
`fetch` to Spotify sets `cache: "no-store"` or goes through `src/lib/spotify/client.ts`; S6 every
`localStorage`, `sessionStorage`, IndexedDB, `BroadcastChannel` and Web Lock name is built by the
uid-prefixing helper.

### 6.5 In production

- **Isolation events.** The owner check on open, the cache stamp, the token-owner assertion and the
  segment path check each log an `isolation` event (to `client_metrics`, with the uid and a code, no
  data), counted at the top of `/usage` for the admin. The expected count is zero; anything else is
  a bug with its code path attached, and a candidate for Spotify's 24-hour breach notice (01f §1.5).
- **An adversarial review** of each multi-user phase's diff in a fresh context, told to find a
  cross-user path, before it deploys (the pattern of lanes 1902 and 1906).
- **A canary account** is optional (§18): a second Spotify account Rem controls, signed in on another
  browser through Phase 4's first week. It holds one of the five places while it exists.

### 6.6 Budgets one user could spend for everyone

Separate databases isolate data, not budgets (C §5.5). Four are shared: Turso's rows read (per
organization), Spotify's quota (per developer account), Spotify's 30-second rate limit (per app) and
Vercel Hobby's Active CPU (per team, and an overrun stops every project for up to 30 days, 01f §2.2).

- **Spotify's scarce bucket is spent only by the server**: the claim (§7.2), the open-app rules
  (§7.6), the library scan's server gate (`src/lib/playlists-sync.ts:45-48`) and the brake (§7.5). No
  client call can make the app harvest more often than they allow.
- **Client-chosen scans are bounded**: `dailyStatsAction` accepts any width up to 100,000 days and
  every distinct width is a fresh scan and a new cache entry (`history-actions.ts:68-72`); it accepts
  only the one value the client sends (`den-home.tsx:379`). `searchPlaysAction` runs an unindexable
  `LIKE` per call (`db.ts:884-904`); ten a minute per user per instance, the rest refused.
  `/api/playlists/[id]/tracks` gets the same per-user limit (01b S13).
- These stop a bug or a stuck tab from running away; they do not stop a determined invited user, who
  can spread calls across instances. The answer to that is `status = 'disabled'`, which takes effect
  on that user's next request.

## 7. Sync fan-out inside Spotify's limits

### 7.1 The limits

- **Five users at most** (U).
- **Recently-played has a daily budget**: six bans Aug 11-16, each after 629-700 logged calls plus the
  recorder's ~96, so ~725-800 calls a quota day for the whole app, each ban lifting at ~10:46-10:51 AM
  ET [measured, 01f §1.4]. `/me` was banned beside it and is treated as the same bucket (01c §4). The
  plan budgets **450 a day** (60% of the low end, 01c §5.1), less the recorder's 24, so **426** for
  the app.
- **Whether that budget is the developer account's or each user's is unknown.** Spotify's pages say
  "a single developer account" and "a single budget"; one changelog sentence says "a user's quota"
  (01c §4). With one user the readings cannot be told apart. The plan is built for the shared
  reading, which the documentation states, and relaxes if the passive check (§7.9) shows otherwise.
- **The player endpoints** have never returned a 429; Rem's cron alone spends 1,035-1,303 calls a day
  on them [measured, deduplicated `api_log`, 01c §2.7]. Their limit is unmeasured.
- **The 30-second rate limit** is per app and unpublished; 18 calls in 30 s have passed without a 429
  (`db.ts:2655-2658`, 01f §1.4).

### 7.2 The tick

Two pingers call `GET /api/cron/sync`: the Zenbook's timer on even minutes (`OnCalendar=*:0/2`, in
place of today's drifting `OnUnitActiveSec=2min`) with `CRON_SECRET`, and cron-job.org on odd
minutes with `CRON_SECRET_EXT` (B §7.2). With both alive the app ticks every minute; with either
alone, every two minutes, today's cadence. The tick:

0. **The owner alarm, Zenbook caller only.** Today the Zenbook timer's failed unit is Rem's only alarm
   that capture stopped (`route.ts:103-111`; the Oct 3 review's M1). The route answers that caller
   503 when the admin has no token row or is `needs_reconnect`, read from the app database before
   anything else, so the verdict does not depend on which pinger's tick did the owner's work this
   minute (C §6.2's reason). cron-job.org always gets 200, because it disables a job after a run of
   failures (`route.ts:174-178`).
1. **Claim.** One statement leases every due user: `UPDATE sync_state SET lease_owner = :tick,
   lease_until = :now + 50s WHERE next_probe_at <= :now + 30s AND (lease_until IS NULL OR lease_until
   < :now) AND state NOT IN ('needs_reconnect', 'removed', 'paused') RETURNING uid`, joined to the
   users' tokens and database names in the same round trip. A leased user is not due, so two ticks,
   or a tick and an open tab, never work on one user at once. This is also the tick's store health
   check: if it fails, the tick ends instead of letting each user wait out the store fetch's three
   15-second attempts (`src/lib/store-fetch.ts:28-29`).
2. **Steps, concurrently**, under `Promise.allSettled` and a 25-second deadline each. A step receives
   its `Uid`, `UserStore`, a token getter bound to the uid and its deadline, and nothing else: refresh
   the token if under 60 s remain, probe (§7.3), harvest if the policy says so (§7.4-7.5), record into
   the user's database, then write the next due times and release the lease with a compare-and-set
   on `lease_owner`, so a step that outlived its lease writes nothing to the queue.
3. **At most one library rescan**, for one user, under its own deadline, after the harvests (§7.7).
4. **Reply 200** with one outcome per user (codes and counts, no data, as today, 01b §2.3).

Cadence by state: `active` (a play in the last 30 minutes) is probed every 2 minutes; `idle` every 2
minutes while there are at most two users, then every 5 minutes after 30 idle minutes once there are
three or more (B §7.3: that keeps five users' probes near 2,250 a day); `backoff` 2, 4, 8 … 60
minutes; `needs_reconnect`, `removed` and `paused` make no Spotify calls. Due times are offset by a
hash of the uid so users spread across the minute, and counted due 30 s early so a late tick does not
stretch two minutes to four.

Each pinger hit is one invocation: 1,440 a day whatever N is. The tick lasts as long as its slowest
user's step: ~1-3 s at R1's target, under the 25-second deadline when a Spotify call hangs (01c §5.8).
The route sets `maxDuration = 60`; nothing under `src/app` sets one today, so the project's 300 s
default applies (01f §2.1).

### 7.3 The probe

The cron asks `/me/player` alone. It reports the active device's track, including in the window where
`/me/player/currently-playing` answers 204 mid-playback, and answers 204 only when no device is active
(GOTCHAS "Player simulation"), which is all the harvest decision needs. Today's idle tick spends two
calls, currently-playing and then `/me/player` on its 204 (413 of Rem's 436 idle ticks on Oct 14,
01c §2.1). Now-playing keeps its two-step read: it is the UI's path, and its cost is bounded
separately (§7.6).

The probe keeps the last track id, progress and time in the user's own `meta` (`probe`). A **track
change** is a different track id, the same track with progress gone backwards (a repeat), or playback
stopped since the last probe (the session tail).

### 7.4 When a harvest happens

A harvest is one recently-played call, which returns the last 50 plays. A user is harvested when:

| trigger | when | Rem-like calls a day [estimate] |
|---|---|---|
| track change | the probe saw one since the last harvest, subject to the brake's interval (§7.5) | ~117-130, one per play at most |
| session tail | the first probe that finds playback stopped (today's `>=` rule, `src/lib/harvest-gate.ts:20-24`) | ~5 |
| retry | a change-triggered harvest landed nothing new: Spotify may list a play a little after the player has moved on, so the next tick harvests once more (C §6.2) | unmeasured; Phase 3's soak counts it |
| completeness | 25 track changes since the last harvest, whatever the brake says (B §7.4: half of the 50-play window) | 0 unless the brake holds a user above 25 changes |
| backstop | 2 hours idle since the last harvest, for devices the probe cannot see (today hourly) | ~12 |
| open app | §7.6 | ~5 for Rem; more for an app-heavy friend |

That is ~150 a day for a Rem-like user against 139-319 cron harvests plus the recorder's 96 today
(01c §2.7). On Rem's day the tick harvested 280 times for 129 plays (01c §5.3); the rule predicts
~160, a number Phase 3's soak checks on his own traffic before anyone shares the bucket. The decision
is a pure function next to `shouldHarvest`, with known answers in `tests/harvest-gate.test.ts`.

### 7.5 The fair-share brake

Under the shared reading, one person's heavy day can get every user's capture banned until ~10:50 AM
(01f §1.4). No code makes the bucket private, so the plan decides who slows down first (A §6.4, with
C's counting):

1. Every recently-played and `/me` call increments the caller's `sync_state.rp_calls` for the quota
   day, **awaited before the call**, so a lost write cannot undercount; a re-sent increment overcounts,
   the safe side (01c §2.8 shows re-sends happen on this path). The quota day starts at 14:51 UTC, the
   boundary `getRecentlyPlayedQuotaWindows` already uses. The app's total is the sum over at most five
   rows.
2. Every user starts the day on track-change harvests.
3. When the app's total reaches ¾ of 426 (~320), any user above an equal share (426 ÷ N) moves to one
   harvest per 15 minutes of playback for the rest of the quota day.
4. At 426, every user moves to one per 30 minutes of playback.
5. In every mode, completeness (25 changes), the session tail and the 2-hour backstop still fire, so
   no play leaves the 50-play window unseen (F3), and opening the app still harvests (§7.6), so what a
   person sees on opening is current (F1).

Light listeners never slow down; the heaviest slows first; the app's total stays near the budget.
It is a counter, a comparison and a branch, with known answers at each boundary. It ships before the
third account (§13), since Rem plus one friend fits with room (§14.2). If the passive check (§7.9)
shows the quota is per user, 426 becomes a per-user number and everyone stays on track-change
harvests. The owner is not exempt (decision in §18): exempting him moves his ~150 calls a day out of
everyone else's share, so the brake trips earlier for friends.

### 7.6 The open-app paths

- **`/api/sync`** (on load, every 2 minutes while visible, on focus; `src/components/sync-on-load.tsx:12-27`)
  runs the same per-user step under the same claim, so an open tab and the cron never harvest one
  user twice in a minute. On a load or a return to the tab it also harvests once if the probe saw a
  track change since the last harvest, at least 60 s apart (B's H4), which is the catch-up for
  listening the probe could not see. When no tick has started in 5 minutes (read from the newest
  lease time: both pingers down, or every tick failing at its claim), the tab's own 2-minute timer
  makes the user due, so an open app keeps capturing on its own (C §6.3). Today the route harvests
  whenever the last harvest is over a minute old, playing or not (`src/app/api/sync/route.ts:28-31`);
  a friend with Home visible through an 8-hour workday would spend ~240 scarce calls a day that way
  (C §6.3). The browser's zone is written only when it changes (today on every call, `:24-27`).
- **`refreshHistoryAction`** stops calling Spotify and only re-reads the user's store; today it
  harvests on every call with no debounce (`history-actions.ts:133`, 01c S6). The browser's
  provisional plays (`src/lib/optimistic-play.ts`, `handoff.ts`) already cover the moment a track
  ends. One visible change for Rem: the forced refresh at a track change finds the stored row only
  after the next tick, up to ~2 minutes later, with the provisional row standing in until then.
- **Now-playing** polls every 15 s mid-track instead of 6 s, keeping the end-of-track and focus polls
  (01c §5.5): ~4-6 Spotify calls a minute per visible tab, so five users with a visible tab each stay
  near 12-15 calls per 30 s, under the 18 seen safe. The chip already interpolates progress between
  polls. It ships in Phase 3, measured on Rem's call log before a friend shares the rate window,
  because a rate-limit 429 pauses every user's capture for its duration.

### 7.7 Library rescans

- One user per tick, outside the harvest deadlines, resumable (rescans commit per playlist and the
  snapshot gate skips finished ones, `src/lib/sync/library.ts:64-71`); every 30 minutes while active,
  every 2-3 hours idle (01c §5.6).
- No `/me` call: the user's Spotify id is on the users row, refreshed at sign-in. That is one
  scarce-bucket call per rescan, 32 a day for Rem (01c §5.1).
- Every playlist's stored snapshot read in one statement over the user's `plsnap:` keys instead of
  ~110 serial `getMeta` reads (`library.ts:65-66`; about half of the day's `meta` reads, 01c §2.3).
- The Liked list re-fetched when its count or newest `added_at` moves, and weekly as the safety net
  instead of daily; the daily refetch always counts as a change today (`sync/library.ts:81-84`) and so
  triggers a ~39,000-row unique-song recount every day (B §3 row 6).
- A new user's first scan (~150 calls for a Rem-sized library, 1-2 minutes at 150 ms pacing, 01c §5.6)
  starts from their first Home visit or the cron, whichever comes first; the client kick also stamps
  `library_scan_attempt_at`, so the two never scan one user at once (C §6.6).

### 7.8 Failure isolation

| failure | effect | who |
|---|---|---|
| a Spotify call hangs | the step is abandoned at 25 s; it can still write later, and everything it writes is safe to repeat | that user |
| `invalid_grant` | token row cleared, `needs_reconnect`, no further calls (§5.4) | that user |
| 403 "not registered" (removed from the dashboard's list) | `removed`, no further calls. Never applied to the admin, and never when every user failed the same way in one tick, which is what the owner's Premium lapsing looks like (01c §5.4 item 4): then the whole tick backs off | that user |
| Spotify 5xx or a timeout | `backoff` | that user |
| 429, rate limit | the app-wide cooldown, seconds long (`client.ts:150-183`) | everyone, correctly: the limit is per app |
| 429, `QUOTA_EXCEEDED` (the body's `reason`, which nothing reads today, 01c S4) | `cooldown:<bucket>` until `Retry-After` or the observed reset; probes and rescans in other buckets continue | everyone's harvests, correctly |
| the app database unreachable | the tick ends at the claim | everyone; plays within each user's last 50 come back at the next tick |
| a user database refused (wrong owner, behind on schema) | that user's step skips, logged | that user |

Writes on this path are idempotent: claims and leases are compare-and-sets with an owner token,
inserts have natural keys (`plays` by `(track_id, played_at)` inside the user's own table), and
writes that must outlive a response go through `after()`, not a bare `void` (01c §5.4 item 8). Each
harvest records the lag of the plays it lands (`now − played_at`); the daily route rolls them into
`lag_p50_s` and `lag_p95_s`, F2's instrument on `/usage`.

### 7.9 Pingers, the recorder, and finding out how the quota is counted

- **The second pinger** is the cron-job.org job `CRONJOB_JOB_ID` already names in Production,
  updated with `CRON_SECRET_EXT` and an odd-minute schedule, so `ensureCronJobEnabled`
  (`src/lib/cronjob.ts:14-48`) keeps re-enabling it if cron-job.org disables it; that chore moves to
  STORE_MIGRATION's `/api/cron/daily` (C §6.5). It waits for Phase 3, because today's route has no
  lease and two pingers would double every call (01c §5.7 b).
- **The recorder** stays Rem's alone and runs hourly instead of every 15 minutes: 24 scarce calls a day
  instead of 96, and an hour is well inside 50 plays of any listening (01c §5.7 a). Extending it to
  friends would put their refresh tokens in a plain file on the Zenbook (01e §5.9). Its grant was
  adopted on Aug 6 and may age out by Feb 6, 2027 under Spotify's six-month rule, silently (01e F3);
  a fresh local sign-in copied into `~/lazyboy-recorder/tokens.json` restarts the clock.
- **How the quota is counted** is found passively (01c §7.3): `api_log` records the caller's uid and
  each 429's `reason` from Phase 3 on, friends join one at a time, and the first ban answers it
  (everyone refused at once is one pool; one user refused is per-user quotas). With the brake holding
  the total near 426, a ban may never come, and the plan is safe under both readings. A question on
  Spotify's developer forum costs nothing. Driving a test account into a ban would risk Rem's own
  capture for up to ~12 hours (01c §7 decision 3).

## 8. Store cost: the write path and the read levers

A database per user changes no user's read cost: each pays what Rem pays today for a history of the
same size (C §7.1), and the rows read are counted once for the whole Turso organization. Turso's free
plan blocks every query for every user when a month's reads pass 500M (01f §4.2), so the per-user
cost is what decides whether five users fit. This section is the single-user performance track (P1-P4
in §13); every lever in it pays off for Rem alone.

### 8.1 Where one user's reads go today

Rem's Oct 14, from the store meter's per-statement log (01c §2.2-2.8), with the orphan passes in
Turso's terms (the meter counts an `UPDATE`'s correlated subqueries at ~1/40 of what Turso billed for
the same work, 01c §2.8):

| term | trigger | rows per run | that day |
|---|---|---|---|
| all-time recompute: `orderedRealPlays`, a full ordered `plays` scan with a `tracks` probe per row (`db.ts:854-869`) | after a landed harvest, at most every 10 minutes (`db.ts:577-583`), app open or not | ~51,000, growing ~2.3 rows per stored play | 2.24M, 44 runs (53% of the meter's 4.25M) |
| Home payload rebuild: the 16-day strip and the opening day (`db.ts:1315-1343`) | every landed harvest | ~7,500 | 0.95M, 127 runs |
| unscoped orphan pass (`db.ts:724-751`) | the library's playlist id set moved | ~5.1M on Turso's terms | 3 runs: ~15M on Turso's terms (0.39M as the meter counted) |
| unique-song count (`db.ts:1969-1991`) | a library sync that changed anything | ~39,000 | 0.16M, 4 runs |
| history payload rebuild (`db.ts:1686-1730`) | a browser fetch after the slow marker moved | ~79,000 | 1 run; up to ~11M on a day Home stays open (01c §6 item 1) |
| whole-history strip, `dailyStatsAction(100000)` on every Home mount (`den-home.tsx:374-384`), re-read after any landed play | Home mounts after listening | ~43,500 [estimate, B §3] | ~0 that day |
| ticks and harvests that land nothing | 591 a day | ~3 and ~215 | ~0.06M |

STORE_MIGRATION §3 attributes the ~50,500-row daily scan to the history payload; it is the all-time
recompute (01c §2.2 separated the two by their logged SQL prefixes, and 01a §11.2 and 01d §2.2 reached
the same reading). The difference matters for which lever comes next: phase E's browser cache does not
touch the all-time recompute, which runs whenever plays land, app open or not, and grows ~12,000 rows
a day for every day of history (01c §5.9).

### 8.2 P1: the "From" verdict starts from the song (inside lanes 1910-1911)

The stored verdict `plays.ctx_orphan` asks whether a play's song is among the members of the playlist
it was played from. Today's predicate (`ORPHAN_PREDICATE`, `db.ts:700-709`) answers by walking that
playlist's members and probing `tracks` for each, so it costs about twice the playlist's size for every
play it judges (B §10.1). The rewrite starts from the play's own `tracks` row, finds the tracks that
share its identity through `idx_tracks_artist_name`, then their memberships through
`idx_pltracks_track`, filtered to the playlist; `CROSS JOIN` pins that loop order, because SQLite's
planner otherwise picks the member walk. No column, index or migration is added.

This lane re-ran B's two scripts on the Mac's Aug 11 copy (`data/replica.db`, opened `immutable=1`;
§17) [measured]:

- both predicates give the same verdict on all 7,572 plays: 764 orphans each, 0 differ;
- the rewrite's plan is `SEARCH me USING INDEX sqlite_autoindex_tracks_1 (id=?)`, `SEARCH tm USING
  INDEX idx_tracks_artist_name`, `SEARCH plm USING INDEX idx_pltracks_track (track_id=?)`;
- over the 6,801 plays from a cached playlist, today's form walks 411.3 rows per play on average (max
  2,256); the rewrite matches 2.7 (max 7).

[estimate] A landed play's verdict goes from ~130 rows to ~5-10 as Turso counts index and table
visits; a full pass at today's 22,040 plays from ~5.1M to ~0.1-0.2M; and a pass scoped to one busy
playlist (300 members, 3,000 plays from it) from ~900,000 to ~15,000-30,000. Lanes 1910-1911 scope
the pass to the playlists that changed; with today's predicate a scoped pass on a busy playlist still
costs plays × members, and the meter would hide it (01c §2.8). Shipping the rewrite with the scoping
makes both cheap. Before it ships, lane 1910 re-runs the equality check on a current backup copy
(the Aug 11 copy predates the catalog backfill and two months of plays) and pins it with a
known-answer test; one pass of each form on the Turso copy, read off Turso's usage before and after,
settles the real counts (01c §8).

### 8.3 P2: listened time stored per play, and the all-time totals as an accumulator

- **`plays.listened_ms`** is written beside `skipped`. Both come from the same gap: `isSkip` and
  `listenedMs` take the previous play's `played_at`, this play's, and the duration
  (`src/lib/skip-rule.ts:33-46`). For a tail append, the common case, the predecessor is the newest
  stored play, one indexed read in the harvest's read batch, so both values are computed in JS and
  written with the insert (B §8.1). That also retires the post-insert `recomputeSkipFlags` round
  trips for tail appends.
- **The accumulator** is `allTimeStats` (`skip-rule.ts:58-74`) applied one play at a time: for a
  counted play (real, not skipped), `plays + 1`, `durationMs + listened_ms`, `since` kept, and
  `uniqueTracks + 1` when no earlier counted play of that track id exists (an `EXISTS` on
  `idx_plays_track`). It equals the chain walk because `listened_ms` is the value the walk computes.
- **Non-append events keep today's path.** An out-of-order insert (the backstop replay, an import, a
  late play inside the 50-play window) re-opens its successor and rules it from its predecessor
  (`db.ts:547-561`), now rewriting its `listened_ms` too, and sets `alltime_dirty`; a duration change
  on a played track (`sync/library.ts:94-101`) re-rules that track's plays and their successors
  through `idx_plays_track`. A dirty flag makes the next tick recompute the totals from the stored
  columns: one scan of that user's plays, without the `tracks` probes, only on those events.
- **One-time fill on Rem's database**: one chain walk in JS with the same pure function (~45,000 rows
  read, ~14,500 written [estimate, B §8.1]), verified by `SUM(listened_ms)` over counted plays equal
  to `alltime_stats.durationMs` on the same snapshot, and by `scripts/verify-derived.mjs` extended
  with a `listened_ms` check.
- **Effect**: 2.24M rows on Oct 14 become a few thousand a day, and the only read that grew every day
  stops growing (D2). The all-time card also stops lagging a listening session by up to 10 minutes.

P2 comes before the history segments (P3) so the segment tuple can carry each play's listened
seconds from its first version (§9.1), which is what lets P4 move the whole-history strip into the
browser without a second shape change.

### 8.4 P4: the Home payload patched in place, and three smaller terms

Before the second friend (§13), or earlier if Turso's per-database usage at the first friend's month
says so:

- **The Home payload** is patched from the harvest in hand instead of rebuilt (B §8.2). The harvest's
  read batch includes the `home_payload` row; JS applies the new plays to that day's entry in the
  strip (plays, `durationMs` from `listened_ms`, the unique count from the opening day's rows), to the
  opening day's song rows, and to the all-time totals from the accumulator; a new local day starts a
  fresh opening day. Everything else falls back to today's rebuild: a play landing on a day other
  than the opening day, an out-of-order insert, a time-zone or shape change, and any derived-column
  event that touches a play in the payload's 16 days (a context name resolving, an orphan flip), which
  marks the payload dirty. Today the rebuild after every landed play is what heals those two derived
  columns; a patched payload needs the explicit mark or a stale "From" could sit in it for days.
  ~7,500 rows read per landed play become ~1, and a landed tick's ~30 round trips become ~3.
- **The whole-history strip** is built in the browser from the segments, which carry each play's
  listened seconds (B §9.3), replacing the `dailyStatsAction(100000)` prefetch on every Home mount;
  the server path stays as the fallback before the segments land.
- **The daily contexts pass** scans the `contexts` table for negative rows due a recheck (114 rows for
  Rem) instead of a full `plays` scan (`unresolvedContextUris`, `db.ts:646-667`); never-seen contexts
  already arrive through the per-batch check (`unseenContexts`, `db.ts:619-638`), and the import
  scripts register their own (B §8.5).
- **One write-marker bump per landed batch**, where a landed tick bumps two or three times today
  (`db.ts:522, 749, 819`).

### 8.5 Left for later, each with the measurement that would bring it in

B goes further, and its levers are sound; five users do not need them yet, and each adds write-path
code with its own drift risk.

| lever | B § | brings it in |
|---|---|---|
| history segments materialized in the user database and appended on write, instead of rebuilt on demand | §8.3 | the hot month's rebuilds showing up in Turso's per-database usage, or S2 missing on a cache miss |
| the library body patched per changed playlist, the unique count kept in the same pass | §8.4 | a user's library past ~12,000 songs (01d O7), or library rebuilds in the usage |
| a harvest that brings nothing new reading zero rows, by diffing against the previous batch's keys | §7.4 | the brake tripping often enough that steady harvests matter |
| an incremental nightly backup | §10.3 | more users than Spotify allows; not at five |
| the all-time list built in the browser and grouped by song identity | §9.3 | a product decision: relinked songs would show once instead of twice |

### 8.6 What it adds up to

Rows read on a heavy day (§1's definition) per user, Turso's terms, after each step. The terms that
move are §8.1's; "search" is the payload rebuilds a Home visit triggers after listening (~72,000 rows
today: the history body at ~3 rows per play plus the library on half of visits, 01d §2.2, §4.2;
~13,000 with segments: the current month to date plus the library half). Every figure is an
[estimate] built from the measured per-run costs above.

| term | today | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|
| all-time recompute | 2.24M | 2.24M | ~0.005M | ~0.005M | ~0.005M |
| Home payload | 0.95M | 0.95M | 0.95M | 0.95M | ~0.03M |
| orphan verdicts: new plays + library changes | 0.017M + 15.3M | ~0.001M + ≤ 0.05M | same | same | same |
| unique-song count | 0.16M | 0.16M | 0.16M | 0.16M | ~0.12M |
| ticks, harvests, rescans, identity, claims | ~0.08M | ~0.08M | ~0.08M | ~0.08M | ~0.08M |
| daily contexts pass | 0.04M | 0.04M | 0.04M | 0.04M | ~0 |
| nightly backup dump (with §10.2's count-check edit) | 0.05M | 0.05M | 0.05M | 0.05M | 0.05M |
| search, 2 visits (Rem) / 8 visits (an app-heavy user) | 0.14M / 0.58M | same | same | 0.03M / 0.10M | same |
| whole-history strip, 2 / 8 mounts | 0.09M / 0.35M | same | same | same | 0 |
| **total, Rem (2 visits)** | **~19.1M** | **~3.8M** | **~1.57M** | **~1.45M** | **~0.36M** |
| **total, an app-heavy Rem-like user (8 visits)** | **~19.8M** | **~4.5M** | **~2.26M** | **~1.79M** | **~0.44M** |

Against D1 (≤ 1.5M a heavy day): Rem meets it after P3 and with room after P4; an app-heavy Rem-like
user needs P4. Against R4 at five users (≤ 250M a month): after P3, Rem plus four light friends is
~92M (18% of the free plan) and Rem plus four app-heavy Rem-like friends a year in is ~258M (52%, at
the bar); after P4 the second is ~64M (13%). Friends start with no history and no catalog rows, so a
year in is where they arrive, not where they begin. §14.4 has the arithmetic.

Writes: ~3,000 core rows a day for Rem (01c §2.7), plus ~72 for tokens, ~900-1,440 for claims and
releases (two rows per probe, 450-720 probes a day), and ~150 counter increments: ~4,100-4,700 a day,
inside D3's 5,000 [estimate]. Five users: ~0.63M a month, 6% of the free plan's 10M, inside R4's 10%.
`api_log`, ~1,000 Spotify calls a user a day after Phase 3, stays on the Zenbook.
## 9. Search: per-user payloads, caching and the phone budget

## 10. The store, and STORE_MIGRATION (lanes 1901-1911)

## 11. Migrating Rem's data with nothing lost

## 12. Sign-up gating, privacy, deletion and backups

## 13. Rollout in reversible phases

## 14. Each target, step by step, with its budget

## 15. Costs

## 16. Unknowns and risks

## 17. What I ran

## 18. Decisions that are Rem's
