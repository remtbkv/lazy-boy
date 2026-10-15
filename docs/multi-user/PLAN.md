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

## 7. Sync fan-out inside Spotify's limits

## 8. Store cost: the write path and the read levers

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
