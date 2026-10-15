# Multi-user lazyboy: the plan

Lane 0223_lb_mu_synthesis of the multi-user planning program, Oct 14, 2026. Planning only: nothing
here changed code, data, the Zenbook store, Turso or Vercel. It synthesizes the six overviews
(`01a-data.md` to `01f-platform.md`, cited as 01a §n and so on) and the three designs (`design-a.md`,
`design-b.md`, `design-c.md`, cited as A §n, B §n, C §n). Code line numbers are against `ac6f7fe`,
which the overviews cite; `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json
next.config.ts package.json` is empty at `7e0c5b1`. Every number is **[measured]** with its source or
**[estimate]** with its arithmetic. §17 lists everything this lane ran.

Status: complete, Oct 14, 2026.

## 0. Summary

- **Targets (§1).** Five accounts, Rem included: Spotify's development mode allows five per app and no
  path to more, so the brief's 25 is out of reach; past five, people run their own copies. No path
  returns or caches another user's data, and every way it could is met by one layer that prevents it
  and one that detects it. On a mid-tier phone at 10 Mbit/s: search usable ≤ 2 s after first paint on
  a first visit, ≤ 300 ms on a repeat, a keystroke painted ≤ 50 ms. Freshness: what any screen shows
  is always current; with the app closed, a play is stored within ~2 minutes while Spotify's shared
  budget allows; no play is lost while a pinger runs. Store: ≤ 1.5M rows read per heavy user on a heavy
  day, and nothing on a per-visit path that grows with history. No user path on the Zenbook. $0 until
  the first friend, ≤ $26 a month at five.
- **Structure (§2).** The three designs agree on the skeleton: a Turso database per user plus a small
  app database, a user id and session epoch checked on every request in one query, AES-256-GCM tokens,
  one cron tick for all users. The plan takes A's structure (layered enforcement and phases that
  change nothing a friend can reach until Phase 4), B's cost rule and its three levers that matter at
  five users, and C's operational choices. The picks that differ from one or more designs: a random
  uid, never reused (B); a versioned open with an owner stamp in place of `init()` (A with C); per-user
  leases on the tick (A); a fair-share quota brake (A); monthly history segments built on demand (A)
  carrying listened seconds (B); destroy-at-once deletion with four-day friend backups (A, C).
- **A finding this lane reproduced (§8.2).** B's rewrite of the "From" verdict, starting from the song
  instead of walking the playlist, gives the same verdict on all 7,572 plays of the Aug 11 copy and
  reads ~2.7 rows a play where today's walks ~411. Lanes 1910-1911 should ship it with their scoping.
- **Gaps the designs left, closed here**: every per-user client must be built through the store fetch
  that two incidents hardened (§4.2); the search manifest stores each month's play count so it never
  scans history (§9.1); and deletion has to reach the telemetry store's 60-day backups and the app
  database's point-in-time copy of the friend's token, which four-day telemetry backups and a token-key
  rotation do (§12.3).
- **Store cost (§8).** Rem's heavy day is ~19M rows on Turso's terms today (most of it three unscoped
  orphan passes and the all-time recompute); ~1.45M after the predicate, a stored listened time with an
  accumulator, and segments; ~0.36M after the Home payload is patched in place. Five app-heavy
  Rem-like users a year in: ~70M a month, 14% of the free plan.
- **Search (§9, §14.1).** First visit ~1.1-1.4 s for Rem, ~0.8-1.1 s for a typical friend; repeat
  ~80 ms; a keystroke ~25-35 ms. The segments must ship before mid-December: Rem's history body passes
  the Data Cache's 2 MiB limit around late December, multi-user or not.
- **Sync (§7, §14.2).** One tick a minute from two pingers (the Zenbook's and cron-job.org's), each user
  under a lease and their own deadline; harvests on track changes. Rem plus one friend fits Spotify's
  scarce budget with room; five heavy listeners need the brake, which slows the heaviest first and
  holds closed-app freshness to 15-30 minutes late on heavy days.
- **STORE_MIGRATION (§10).** No lane waits. Six small edits before Oct 15, 8 PM; one widens lane
  1910's scope to the predicate rewrite. Rem's data moves nowhere: `lazyboy` becomes his user database,
  and only his token rows leave it, a week after they are copied (§11).
- **Rollout (§13).** Phase 0 now; the migration; the single-user performance track; three owner-only
  phases; the first friend no earlier than early to mid-December [estimate]; the quota brake and the
  Home patch before the second; friends one at a time.
- **Not met (§14):** 25 accounts on one Spotify app; a first visit on slow 4G; a heavy three-year
  user's first visit (~2.2-2.6 s); two-minute closed-app freshness for five heavy listeners if the
  quota is shared. Each has its options.
- **Rem's decisions (§18):** 25, each with a recommendation. Five are for now: Phase 0's production
  changes, STORE_MIGRATION's edits, the predicate in lanes 1910-1911, where the logs live, and two
  dashboard reads.

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
  and phases the work so nothing anyone but Rem can reach changes until the first friend. On cost it
  adopts the overviews' levers (an accumulator, the strip updated in place, scoped orphan passes) and
  stops there (~0.8M rows a heavy day, A §13.4), without counting the whole-history strip Home
  prefetches on every mount (B §3 row 4).
- **B (performance first)** has the rule this plan adopts for cost, "a user's recurring cost follows
  what changed, never what is stored" (B §2), and the measured finding that saves the most: the
  "From" verdict rewritten to start from the song's identity, which reads ~2.7 rows per play where
  today's walks up to ~411 (B §10.1; reproduced by this lane, §17). Its isolation rests on types and
  tests, with no runtime check, and it opens the user's database from a cookie field in parallel with
  the gate, a second way to reach user data. It also builds more write-path machinery (materialized
  payloads, version compare-and-sets, dirty marks, a nightly drift check) than five users need.
- **C (smallest safe change)** moves nothing of Rem's but the token, keeps today's SQL and `init()`,
  and is the most concrete operationally: a client lookup that fails closed, a one-variable kill
  switch, friends' backups that age out inside Spotify's five days with no bookkeeping, the owner
  alarm evaluated where a second pinger cannot hide it, and soak checks with numbers. It leaves each
  user's read cost close to today's (one constant, the all-time gate, moves from 10 to 60 minutes when
  the usage asks) and relies on Turso's paid plan for four heavy friends (C §12.4).

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
5. **Rem's data does not move.** `lazyboy` becomes his user database. Beyond what the app's own code
   writes, the only changes to it are a new derived column (`plays.listened_ms`, filled and verified
   once), two `meta` keys, the incident's foreign plays (removed with his yes), and the token rows
   leaving for the app database a week after they are copied (§11).

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
  `db.ts:158-209` and the `ALTER`s at `:244-295`), plus one derived column, `plays.listened_ms` (§8.3).
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
  terms_version     TEXT,                  -- privacy policy and end-user agreement accepted (§12.1)
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
-- keys: schema_version; cooldown:<bucket>; played_at_convention; lock:spotify_refresh:<uid>;
--       last_tick_at (stamped by every tick, read by the open app's fallback, §7.6)
```

Choices in it: there is no `env` column on tokens, because dev runs its own app database (§5.5) and
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
| `meta.spotify_tokens` | `user_tokens`, encrypted | the uid key and the associated data (§5.3); the plaintext row stays in `lazyboy` for a week, then goes (§11.4) |
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
  (§6.2 layer 6). Nothing new goes on the `Session` type, whose fields Auth.js serves at
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
     the browser honours it; the client-side clear is the one relied on. A 401 from any of the app's
     own routes clears it too (B §6), so a device whose session died elsewhere (sign out everywhere, a
     deletion) forgets on its next request. *Stops M7.*
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
| T12 | the Phase 2 migration on a local copy of a nightly backup, by hand (it needs Rem's data) | §11.4 step 6's checks |

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
| backstop | 2 hours idle since the last harvest, for devices the probe cannot see (today hourly; 50 plays is ~2.5-3 hours of nonstop listening, 01c §5.1) | ~7 |
| open app | §7.6 | ~5 for Rem; more for an app-heavy friend |

That is ~145-150 a day for a Rem-like user, before the retries, against 139-319 cron harvests plus
the recorder's 96 today (01c §2.7). On Rem's day the tick harvested 280 times for 129 plays (01c
§5.3); the rule predicts ~145 plus the retries, a number Phase 3's soak checks on his own traffic
before anyone shares the bucket. The decision is a pure function next to `shouldHarvest`, with known
answers in `tests/harvest-gate.test.ts`.

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
  listening the probe could not see. When no tick has started in 5 minutes (`app_meta.last_tick_at`,
  which every tick stamps: both pingers down, or every tick failing at its claim), the tab's own
  2-minute timer makes the user due, so an open app keeps capturing on its own (C §6.3). Today the route harvests
  whenever the last harvest is over a minute old, playing or not (`src/app/api/sync/route.ts:28-31`);
  a friend with Home visible through an 8-hour workday would spend ~240 scarce calls a day that way
  (C §6.3). The browser's zone is written only when it changes (today on every call, `:24-27`).
- **`refreshHistoryAction`** stops calling Spotify and only re-reads the user's store; today it
  harvests on every call with no debounce (`history-actions.ts:133`, 01c S6). The browser's
  provisional plays (`src/lib/optimistic-play.ts`, `handoff.ts`) already cover the moment a track
  ends. One visible change for Rem: the forced refresh at a track change finds the stored row only
  after the next tick, up to ~2 minutes later, with the provisional row standing in until then.
- **Now-playing** polls every 15 s mid-track instead of 6 s, keeping the end-of-track and focus polls
  (01c §5.5): ~4-6 Spotify calls a minute per visible tab, so five users with a visible tab each make
  ~10-15 calls per 30 s, plus ~2-3 from the ticks, at or under the 18 seen safe (the limit itself is
  unpublished and higher). The chip already interpolates progress between polls. It ships in Phase 3, measured on Rem's call log before a friend shares the rate window,
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
~94M (19% of the free plan), and Rem plus four app-heavy Rem-like friends at Rem's history size is
~258M (52%, at the bar). The strip is the one per-visit term left that grows with history (~3 rows
per real play per mount), so a year in, at ~42,000 plays each, the second case is ~337M (67%). After
P4 it is ~64-70M (13-14%) at either size, because nothing left on a per-visit path grows with
history. Friends start with no history and no catalog rows, so a year in is where they arrive, not
where they begin. §14.4 has the arithmetic.

Writes: ~3,000 core rows a day for Rem (01c §2.7), plus ~72 for tokens, ~900-1,440 for claims and
releases (two rows per probe, 450-720 probes a day), and ~150 counter increments: ~4,100-4,700 a day,
inside D3's 5,000 [estimate]. Five users: ~0.63M a month, 6% of the free plan's 10M, inside R4's 10%.
`api_log`, ~1,000 Spotify calls a user a day after Phase 3, stays on the Zenbook.

## 9. Search: per-user payloads, caching and the phone budget

Search keeps today's model: the browser holds the user's library and history and filters them on
every keystroke with no request (`den-home.tsx:497-524`, 01d §1). Two things change. Every key, URL,
ETag and stored copy carries the uid (§6.2 layer 6). And the history stops being one body, for a
reason that applies to Rem alone: it is 1.79 MB raw, 86.6% of the Data Cache's 2 MiB item limit, and
crosses it around late December 2026, after which every Home open rebuilds it with a full plays scan
and nothing reports it (01d §3.2: Next 16.2.6 skips caching an item over the limit and only warns, in
runtime logs that age out within the hour). The step-by-step phone budget is §14.1.

### 9.1 What the browser fetches (P3)

- **The manifest rides the page.** Home's server render already reads the user's database for the
  Home payload; the same batch reads the manifest (each segment's key, version and play count, a few
  hundred bytes; B §9.1), so the browser knows at first paint which segments it lacks. No extra
  request.
- **History in monthly segments** (01d O3): one body per (user, UTC month), plus the 7,529 catalog rows
  as a segment of their own, since they never change and are 58% of today's body (01d §2.1). Each is
  self-contained in today's tuple format with one field added: a play becomes `[trackIdx, minute,
  sourceIdx, listenedS]`, so the browser can build any day's totals (B §8.3), at ~4 bytes a play.
  The URL is `/api/search/h/<uid>/<segment>?v=<version>&s=<shape>`, served `private,
  max-age=31536000, immutable`. The server takes the user from the session, answers 404 when the path's
  uid is not the session's, and builds from the session's database through `userCache`, keyed by
  segment, version and shape; a miss reads one month through `idx_plays_played_at`, ~3 rows a play,
  at most ~10,000 rows for Rem's busiest month (01d O3). If the month's version has moved past the
  URL's (the current month after a new play), the route answers the current body with its version in
  a header and `no-store`, so nothing is cached under the wrong URL (B §9.1).
- **The library**, one body per user as today, `/api/search/l/<uid>?v=<library_seq>&s=<shape>`,
  immutable per version; split per playlist when a library passes ~12,000 songs (01d O7, §8.5).
- **A delta at visit start** (01d O4): the plays newer than the newest minute the browser holds, ~50
  rows, today's `refreshHistoryAction` read made a scoped GET.
- **Phase E's IndexedDB copy** stores bodies under `(uid, kind, segment, version, shape)`, so a repeat
  visit paints search from disk before the network (STORE_MIGRATION §10, 01d O5).

**Segment versions** are per-month entries in the user's `meta` (`seg_seq:<YYYY-MM>`, holding the
version and the month's play count), bumped by every write that can change a closed month (A §7.1,
B §8.3). Keeping the count beside the version is what lets the manifest be one `meta` range read of a
dozen rows; counting plays per month at render time would be a scan of the whole history on every
Home open, the thing D2 forbids.

| event | how its months are found |
|---|---|
| a play inserted, in order or not, and the successor it re-opens | their `played_at` |
| `ctx_orphan` flips after a playlist's membership moved | `UPDATE … RETURNING played_at` on the scoped pass |
| a context name resolves or changes | `SELECT DISTINCT substr(played_at, 1, 7) … WHERE context_uri = ?` on `idx_plays_context` |
| a played track's name, artist, art, album or duration changes | the same on `idx_plays_track` |
| the backstop replay, a history import, the catalog backfill | the scripts bump the months they wrote, and `catalog` |

Each bump site gets a known-answer test: write to an old month, and that month's version moves and no
other does. The manifest's play count per month lets the client catch a missed insert bump (its
stored copy's count differs) and refetch. A missed bump on a derived column leaves a stale "From"
label or name in that month until its next bump, the same failure class as a missed `write_seq` bump
today (`db.ts:337-340`), and for one user only. Moving the shape token re-fetches every segment, the
escape hatch for a bug in this list.

### 9.2 What changes in the client

- **Lazy days** (01d O6): plays arrive newest first, so a day is one contiguous run found by binary
  search on the minute bounds, built when the day is selected instead of every day up front. That
  removes 199 of the client's 264 ms at 4× [measured, 01d §2.3] and makes the rest independent of
  history length; `history-days.ts` is pure and already known-answer tested against `getPlaysByDay`.
- **Fetch at mount, parse at idle.** Today the requests start after `requestIdleCallback` (up to 2 s)
  or, on Safari, an 800 ms timer (`den-home.tsx:665-676`), so a first visit loses that time before the
  first byte (C §7.2). The requests start at mount; the parse and build still run in an idle callback
  once the bodies land, because yielding to hydration is why the code waits today
  (`den-home.tsx:655-664`).
- **`history-ready` stops waiting for the library half** (`den-home.tsx:620`, 01d §1.4): the day list
  needs only the history.
- **A shorter result list**: the first ~50 rows painted and the rest on scroll; rendering up to 400
  complete rows is most of a keystroke's time today (01d §2.3, O6). A query that extends the previous
  one filters the previous matches (B §9.3).
- **The whole-history strip from the segments** (P4, §8.4).
- A Web Worker only past ~30,000 entries (01d O6).

### 9.3 Server caching with N users

Every entry is one user's (`userCache`, §6.2), and with months as the unit no entry comes near 2 MiB
however long a history grows: a 100-plays-a-day month is ~300 KB raw (01d O3), and an import becomes
many bounded months. Vercel's Data Cache is one least-recently-used store shared by every project on
the team (01f §2.2), so one user's entries can evict another's; an eviction costs one month's
rebuild, ~4,500-10,000 rows, never correctness. Closed months mostly live in the browser (IndexedDB
and the HTTP cache), so the server rebuilds one only for a device that lacks it.

### 9.4 Order and the December deadline

P3 must ship before mid-December. If it cannot, the catalog split alone (01d O2) is the stopgap: the
history entry drops from 86.6% to 37.1% of the limit and the next crossing moves ~10.7 months out
[measured, 01d §5.1]. P3's client edits touch the load path phase E rewrites (lane 1905), so P3
starts after lane 1906 merges, never in a parallel branch (C §7.2). Friends' history imports wait for
segments: a five-year import is a ~4.2 MB history body today, over the item limit on day one and near
Vercel's 4.5 MB response cap (01d §3.3, §7 decision 2).

## 10. The store, and STORE_MIGRATION (lanes 1901-1911)

### 10.1 The store

Turso, one database per user plus `lazyboy-app`, all in group `default` in `aws-us-east-1`, the region
of Vercel's iad1, which is where STORE_MIGRATION puts Rem's data (its §4-5). One group token reaches
every database in the group (`turso group tokens create`, quoted in A §2.1 and C §8.1), so the runtime
holds one store secret, as today. The alternatives:

- **One Turso database with a `user_id` column**: the model 01a §8.2-8.6 specifies in full, which leaves
  isolation to more than fifty statements (§4.1).
- **Postgres with row-level security**: isolation in the database, at the price of rewriting
  `db.ts`'s SQLite dialect (3,212 lines: `INSERT OR IGNORE`, `date(played_at, '±N minutes')`, partial
  indexes) and abandoning STORE_MIGRATION the day after it runs (A §2.1).
- **sqld namespaces on the Zenbook**: every user path stays on the laptop the migration exists to take
  them off (STORE_MIGRATION §1, R2), and namespace routing through the Funnel is untried (C §8.1).
- **A small VPS**: a machine to patch and back up for about the price of Turso's Developer plan;
  STORE_MIGRATION §4 rejected AWS hosting on cost.

One risk to note: Turso's pricing page carried a banner on Oct 14, "Turso is joining Supabase to give
every agent its own database" (A §8.1). Plans and prices may change. Each user's data is a plain
SQLite database that the nightly backup already dumps to a file, so a move to another libSQL or SQLite
host is a copy and a URL change per user.

### 10.2 What multi-user needs from STORE_MIGRATION, and what should change before it runs

**None of lanes 1901-1911 should wait.** The cutover moves today's single-user schema to Turso as it
is and flips the env under code that expects it, with "flip the env back" as its rollback (STORE_MIGRATION
§8). The database it creates, `lazyboy`, becomes Rem's user database unchanged, so nothing in this plan
wants the move to do anything differently, and folding any multi-user schema into it would turn a
reversible move into a migration (01a §10). Every overview and all three designs say the same. What the
plan takes from the move: the user paths off the Zenbook (A1 rests on R2); R1's round trip, which
every latency in §14 assumes; phase A's telemetry client, where `user_id` is added; the daily route,
home of the per-user chores, the usage read and the deletion job's retries; lanes 1910-1911's scoped
orphan pass; phase E's browser copy.

**Six edits before Oct 15, 8 PM**, each small and none touching the cutover's logic; each is the
director's and Rem's call (§18 decisions 2 and 3):

| # | where | edit | why | from |
|---|---|---|---|---|
| 1 | §3 and R4 (doc) | name the all-time recompute, not the history payload, as the ~50,500-row scan that dominates reads; give R4 a growth term (~12,000 rows a day more for every day of history at today's 44 runs, 01c §5.9) and note that R4 holds for one user and the multi-user plan re-checks it at N | it decides which lever comes next (P2, §8.3) and what lane 1908's outcome check should watch | 01a §11.2, 01c §6 items 1-2, 01d §6 item 4; A, B, C |
| 2 | §8 step 9 (lane 1903) | flip Production only, and delete Preview's `TURSO_*` variables | as written it carries today's preview exposure to the new store: a preview's `init()` would run a branch's schema against production, and any preview could read every row (01b §3.7, E4). `origin` has only `main`, so nothing depends on previews | 01b §7 item 2, 01e §6 item 4; A, B, C |
| 3 | §10 (lane 1905) | key IndexedDB by an opaque user key the `(app)` layout renders, a constant until Phase 1's uid replaces it; stamp each stored body with it; make the store's key `(userKey, kind, segment, version, shape)`; clear the store in the browser when the sign-out form submits | no user id reaches the browser today (01b §1.1), and the lane would otherwise reach for the email, the random `sub` or `me_id`, each wrong in its own way; the segment dimension now saves a second migration of browser data when P3 lands | 01b §7 item 1, 01d §6 item 3, 01e §6 item 3; A, B, C |
| 4 | §9 (lane 1904) and lane 1909's archive | write the backup as a list of `(database, retention)` pairs, starting with `("lazyboy", 60 days)`; strip the `spotify_tokens%` and `lock:%` rows from every copy before it is compressed; check the counts against the dump itself rather than `count(*)` on Turso | a list costs nothing now and saves a rewrite; every copy today holds live 13-scope grants valid up to six months (01e F2); a `count(*)` per table reads every row a second time, ~45,800 rows a night at Rem's size. The cutover's own snapshot keeps the token rows (R5) | 01a §10 item 3, 01e §6 item 1, B §11.3 item 3, C §8.3 |
| 5 | lane 1903's last step | delete the plaintext scratch copies on the Mac: the core snapshot (both token rows) and the mode-600 copy of `.env.local` (every secret) | the same exposure as edit 4 | 01e §6 item 2, C §8.3 |
| 6 | lanes 1910-1911 | ship the identity-first orphan predicate with the scoping, after re-running the equality check on a current backup copy | the scoped pass with today's predicate still costs plays × members on a busy playlist; the rewrite makes it ~5-10 rows a play (§8.2) | B §10.1, §11.3 item 4; reproduced here |

**Considered and not recommended before the move**: deriving the Zenbook fence's table list from
`init()` (01b §7 item 3), because the multi-user tables live in new databases that no pre-multi-user
deployment knows, so the hand-written list stays complete (C §8.3); writing `/api/cron/daily` as a
loop over users now (01c §6 item 3), because Phase 1 threads the uid through every caller anyway, so
the lane should just write each chore as a function of one user's store; an accumulator lane inside
the migration (01c §6 item 2), which is P2 here, queued after lane 1911; and shipping the uid claim
before lane 1905 (01e §6 item 3), since edit 3's constant gives 1905 the same interface without
moving auth work in front of the cutover. Two free additions for lane 1904, optional: copy the meter's
per-statement logs (`~/lazyboy-sqld/querylog/*.jsonl`) with 1909's archive, the only exact per-path
record of the single-user workload (01a §10 item 1); and compare `api_log`'s row count with its
distinct count for a day, since phase A's one-attempt telemetry client is a free test of 01c §2.8's
hypothesis that 25-30% of rows are re-sent INSERTs.

**Ordering after the move.** Phase 2's token table lands after lanes 1903 and 1904, because the
cutover compares one plaintext token row on both stores (STORE_MIGRATION §8 steps 10 and 16; 01b §7),
and R5's "Rem stays signed in" rests on it. Phase 1's branch is cut after lane 1911 merges: the
orphan scoping and the mechanical edit both rewrite `storePlaylists` and `recomputeOrphanFlags`, and
both at once would make a merge nobody can review (C §11.2). If R1 fails and the move stops
(STORE_MIGRATION §2), multi-user waits: on the Zenbook it fails A1 by construction.

**STORE_MIGRATION §4's open question**, whether the three log tables move to Turso too: from the
multi-user side, keep them on the Zenbook (§18 decision 4). Telemetry becomes personal data with a
deletion duty wherever it lives, which the user column handles in both places (01a §10). On Turso,
five users' `api_log` would be ~0.6M rows written a month even after Phase 3's call cuts (~1,000 calls
a user a day, ~4 rows written per insert counting index entries, 01c §2.1) [estimate], which with the
~0.63M core writes of §8.6 passes R4's 10% write bar. On the Zenbook the cost is `/usage`'s log
sections during an outage and a dependency on the Funnel certificate that lane 1907 renews.

## 11. Migrating Rem's data with nothing lost

### 11.1 What changes in Rem's database

Almost nothing. After the cutover Rem's data is the Turso database `lazyboy`, which becomes his user
database as it stands: the seven tables are not copied, rebuilt or re-keyed (A §9.1, C §9.1).

| what | when | change | why nothing can be lost |
|---|---|---|---|
| the incident's foreign plays | after lane 1904, before Phase 2 | deleted, with Rem's yes on the list (§11.2) | snapshot first; nothing goes without his confirmation |
| `plays.listened_ms` | P2 | a nullable column added and filled (§11.3) | additive; old code ignores it; verified by a sum that must match exactly |
| `meta.owner_uid`, `meta.schema_version` | Phase 1 | written once | two new keys; no reader before Phase 1 |
| `meta.user_tz`, `probe`, `seg_seq:*` | Phases 3 and P3 | written by the app's ordinary code | new keys |
| the token rows | Phase 2 | encrypted into `user_tokens`; the plaintext rows stay a week as the way back (§11.4) | both copies hold the same grant (Spotify does not rotate this app's refresh token, 01e F2); the later `expiresAt` wins any compare |
| dead and moved `meta` keys | a week into Phase 2 | `spotify_tokens`, `spotify_tokens_dev`, `lock:spotify_refresh`, `spotify_cooldown_until`, `last_sync_added`, `pltracks_at:*` deleted | moved or never read (01a §3); `scripts/` reads no token row (C §16.3) |

### 11.2 First, the incident's foreign plays

While the second account's token sat in the row, the cron recorded that account's plays into Rem's
history (commit `044c9b6`; 01b E6), and `plays` has no column to tell them apart. Once the store has
owners they would be filed as Rem's for good, inside his stats. The backstop recorder captured Rem's
own plays throughout, on his own grant, every 15 minutes (01c §1, §2.6), so (A §9.2, C §9.5):

1. On a local copy of the latest verified nightly backup, list the plays from the start of Oct 14 to
   Rem's first sign-in after the incident that are in the store and not in
   `~/lazyboy-recorder/backstop.db`. A real play of Rem's missing from the recorder would need 50 plays
   in a quarter hour or the recorder down; its timer's log shows the second. 01e's probe found `me_id`
   back on Rem's account by 9:32 PM (01e §1.2), so the window closes before then; its exact bounds are
   not in the repo.
2. Show Rem the list (time, track, artist, context). Nothing is deleted without his yes.
3. In one transaction: delete the confirmed rows; set `skipped = NULL` (and `listened_ms = NULL` once
   P2 exists) on the play after each deleted run, since its verdict came from a foreign predecessor
   (01a D18); reset `contexts` rows resolved during the window to unresolved, so Rem's token resolves
   them again; bump `write_seq` (and the affected months' `seg_seq` once P3 exists).
4. Let the next sync re-rule the reopened verdicts, recompute the all-time totals, and run
   `scripts/verify-derived.mjs`.

The library tables healed on Rem's next sync (`storePlaylists` rewrites the list and purges stale
snapshot keys, 01b E6). Run it on Turso after lane 1904, before Phase 2, so the owner tag goes onto
clean data.

### 11.3 P2: filling `listened_ms`

In a fenced window of ~15 minutes, STORE_MIGRATION §8 steps 2-3's discipline (Spotify's 50-play window
covers plays in it): pause both pingers and wait for 5 minutes without writes; take a restore point
(Turso's point-in-time, plus a dump by the backup script); add the column; fill it with one chain walk
in JS through the same pure function the skip verdicts use; verify `SUM(listened_ms)` over counted
plays equals `alltime_stats.durationMs`, and `verify-derived.mjs` green with its new check; deploy the
code that writes the column on insert; resume the pingers; check that the recorder's plays from the
paused window arrive with the first harvest (STORE_MIGRATION §8 step 13's rule). Rollback: redeploy the
previous build, which ignores the column. Cost on Turso, once: ~45,000 rows read and ~14,500 written
[estimate, B §8.1], 0.01% and 0.15% of a free month.

### 11.4 Phase 1 and Phase 2: the owner tag and the tokens

**Phase 1** (no app database yet) generates Rem's uid once and keeps it as a Production constant
(`OWNER_UID`, not a secret). The jwt callback puts that uid and epoch 0 on the cookie when the signing-in
profile passes today's owner guard; the identity check compares against the constants; cookies with
no uid are refused, so Rem signs in once and the pre-guard sessions end for good. Before the deploy,
one step writes `owner_uid` and `schema_version` into `lazyboy.meta`, which the first open of
`forUser(OWNER_UID)` then checks. Those two keys are the only writes Phase 1 makes to Rem's data.

**Phase 2** (A §9.3, with C's and B's checks). Preconditions: Phase 1 has soaked; lanes 1903 and 1904
are done; §11.2 is done; a fresh verified backup exists.

1. On the Mac: create `lazyboy-app` in group `default` and apply the app schema; mint the runtime's
   read-write group token and the backup job's read-only one, straight into mode-600 files (as
   STORE_MIGRATION §8 step 8 does).
2. Read Rem's `account_id` with one `GET /v1/me` on the stored production token. If it is absent, stop
   before deploying anything: the design keys on it (§18 decision 25).
3. Insert Rem's `users` row: `uid = OWNER_UID`, that `account_id`, `spotify_id = SPOTIFY_OWNER_ID`,
   `db_name = 'lazyboy'`, `status = 'active'`, `is_admin = 1`, `session_epoch = 0`. Phase 1's cookies
   name the same uid and epoch, so Rem stays signed in.
4. Pause the pingers and wait for quiet. Encrypt the production token row into `user_tokens` for
   Rem's uid with `granted_at` = now − 30 days (every session is at most 30 days old and every sign-in
   re-authorizes, 01e §5.7), corrected at his next sign-in. Write his `sync_state` from `last_sync`,
   `player_last_active`, `rp_last_harvest` and `library_synced_at`.
5. Set Production's environment (the group token in place of `lazyboy`'s own, `TOKEN_KEYS`, the app
   database's URL; C §9.2 step 4), values on stdin as STORE_MIGRATION §8 step 9 does, and deploy
   Phase 2, still `SIGNUPS=owner`. Compare the two token copies on `expiresAt` and keep the later,
   since an old instance may have refreshed in between (STORE_MIGRATION §8 step 10's rule). Pingers
   on; three ticks answer 200 with Rem's outcome `ok`.
6. Verify, each a known answer that must match exactly: the seven tables' counts at or above the
   pre-migration counts and `max(played_at)` moving; `verify-derived.mjs` green; `lazyboy.meta`'s key
   set unchanged (the moved keys go only in step 7); the blob decrypting to the plaintext row;
   Rem still signed in; the recorder diff over the pause empty. This is test T12 run for real.
7. A week later, delete the keys in §11.1's last row.

**Rollback.** Before step 7: redeploy Phase 1, which reads the plaintext row; if a refresh happened in
between, the access token has expired and the unchanged refresh token renews it. If Spotify has
started rotating refresh tokens by then, the old code's refresh fails, `clearTokensIfStale` deletes
the row and Rem signs in once (C §9.4). After step 7: a script decrypts Rem's blob back into
`meta.spotify_tokens`, then redeploy. Whenever a rollback lands on a build from before Phase 3, pause
the cron-job.org pinger first: the older route has no lease, and two pingers would double Rem's
Spotify calls (C §9.4). Nothing else in Rem's database changed, so nothing else needs undoing.

## 12. Sign-up gating, privacy, deletion and backups

### 12.1 Sign-up gating

Two gates, both required (01e §5.4). **Spotify's allowlist** (the dashboard's User Management, five
accounts at most) is what lets an account's token work at all; an account not on it completes OAuth
and then gets a 403 from `/v1/me`, which `userinfo.ts` already routes to
`/login?error=SpotifyNotRegistered`. **The app's invite row** is what the app can see, carries the
cap, and lets Rem cut someone off without the dashboard. Every user's calls count against Rem's
developer account (01c §4), so the gate is also the cost control.

- **Invites** are made on the Mac: `scripts/invite.mjs --spotify-id <id>` (Spotify's `id` is in the
  person's profile URL, so Rem can see it before they ever sign in). It refuses if active plus invited
  users already number five (`--force` for a grandfathered list, if the dashboard shows one); inserts
  the `users` row as `provisioning`, which reserves the uid; creates `lb-u-<uid>` in group `default`
  with the platform token, applies the user schema and writes `owner_uid` and `schema_version`; sets
  the row to `invited`; prints the join link and the reminder to add the person on the dashboard. A
  crash leaves a `provisioning` row the script resumes or removes. Provisioning stays a script
  because it happens four times, ever, at five users, and it keeps database creation out of the
  sign-in path (A §10.1, B §14).
- **`/join`** needs no session. It shows the privacy policy and the end-user agreement, which the
  Developer Terms require before sign-up (§V, 01f §1.5); "I agree" sets a short-lived signed cookie
  naming the terms version; then "Connect Spotify". The claim of §5.1 succeeds only with that cookie,
  so nothing is stored for a person who has not agreed (A §10.2).
- **`SIGNUPS=owner|invite`**: `owner` refuses everyone but the admin whatever the rows say. Phases 1-3
  run with it, and it is Phase 4's one-variable way back (C §4.1).
- **`status = 'disabled'`** ends the user's sessions at their next request (the identity check) and
  their sync at the next claim, which skips users who are not `active`.
- **Scopes** drop `user-read-email` and `user-read-private` (`src/lib/auth.ts:32-46`): development mode
  returns no email, nothing reads `product`, and no request uses `market=from_token` (C §10.2). It
  waits until a dev sign-in shows `/v1/me` still returns `account_id` with the smaller set, since no
  fetched page says which scope the field needs, and takes effect at each user's next consent.
- `src/lib/owner.ts` goes in Phase 4, after everything it guards against is gone (01c S18). Rem's
  Premium subscription becomes a dependency of every user: "If the owner's Premium subscription lapses,
  the app will stop working" (migration guide, quoted in 01f §1.2).

### 12.2 Privacy

- **Who sees what.** Each user sees only their own data; the plan has no cross-user feature. If the
  roadmap's friends features come, the one sanctioned way to read another user's data would be a
  single function, `forFriend(viewer, owner)`, that checks a consent table and opens the owner's
  database read-only, so a cross-user read is one call a reviewer can find (A §11). A sketch, not part
  of this build.
- **The operator.** Rem holds the credentials and can technically read any user's database; the
  privacy policy says so. The admin views show operational state per user (status, last success,
  failures, quota spend, store usage per database) and telemetry without song names; there is no admin
  view of anyone's listening.
- **Telemetry** holds a uid, endpoint paths, timings and 429 reasons, no song names, for 30 days once
  the daily route's prunes run (01a D32), and is deleted with the account.
- **Derived metrics.** Listened time, skip verdicts and the all-time stats are "derived listenership
  metrics" on a plain reading of the Developer Policy (01f §1.5). They are shown only to the person they
  describe; comparisons between friends wait for Rem's decision (§18).
- **Retention.** Rem's own history: kept indefinitely; it is his record, and the importers exist to
  complete it. A friend's: kept while connected, deleted at a disconnect (§12.3) and after twelve
  months without a sign-in (`users.last_sign_in`), so nobody's history is stored "indefinitely"
  (Developer Terms §IV, 01f §1.5). The twelve months is Rem's number to choose.
- **No e-mail.** Development mode returns no address and the policy forbids unsolicited mail (01f §1.5),
  so every notice (a dead grant, a pending deletion) appears in the app.
- **Breach duty.** A suspected breach goes to `security@spotify.com` within 24 hours (Data Protection
  Appendix §9, 01f §1.5); the isolation events of §6.5 are the in-app tripwire most likely to surface
  one.
- **The policy text** is Rem's to write or approve. It needs at least: what is collected (Spotify account
  and profile ids, display name, encrypted tokens, listening history, library, the stats derived from
  them), where it is stored and by whom (Turso in AWS us-east-1; Vercel's iad1 functions; request
  telemetry and backup staging on a laptop in Rem's apartment, through Tailscale; backups on OneDrive;
  cron-job.org, which sees the cron secret and count-only replies), retention, how to disconnect and
  delete, the operator's access, and the Developer Terms' minimum end-user terms (disclaimers, Spotify
  as third-party beneficiary).

### 12.3 Account deletion

**Triggers**: the user's "Disconnect and delete" (the mechanism the Developer Policy requires, 01e
§5.8); Rem removing a user; an `invalid_grant` within six months of `granted_at`, which most likely
means the user revoked the app at Spotify (Rem's call, §18); and twelve months without a sign-in. All
run one idempotent job, inline in `after()` for a disconnect or a removal and from the daily route for
the rest and for retries. Before it touches anything, it refuses the admin, the database `lazyboy`,
and any database that is not `lb-u-<uid>` for the departing uid with a matching `owner_uid`; test T11
pins all three refusals.

1. `status = 'deleting'` and `session_epoch + 1`, so every session dies; delete the `sync_state` row,
   so the cron stops; delete the token row, so every Spotify call stops.
2. Destroy `lb-u-<uid>` through Turso's Platform API.
3. Delete the user's `api_log` and `client_metrics` rows on the telemetry store; if the Zenbook is
   down, the daily route retries.
4. Nothing for the backups: the nightly job copies only active users' databases and keeps a friend's
   copies four days (§12.4), so the last one is gone by day four with no bookkeeping.
5. Delete the `users` row last, so a crash midway leaves a row the job can find and finish. The uid is
   never reused, so any cache entry still keyed by it (≤ 24 hours) cannot be served to anyone.
6. The page tells the person to remove Lazy Boy at spotify.com/account/apps, since the app cannot
   revoke a grant, and the response sends `Clear-Site-Data`.

**Why destroy, not empty, and the five days.** Rows deleted inside a living database stay restorable
through Turso's point-in-time recovery for 1 day on Free and 10 on Developer, which on Developer
outlasts Spotify's five-day deletion term. A destroyed database leaves point-in-time recovery, and on
paid plans "deleted databases can be restored for up to five days" (Turso's docs, quoted in A §2.1 and
C §8.1). Destroyed at day 0, with friends' backups aging out by day 4, every copy is gone within five
days under any reading of "in your possession or control", including the strict one C §10.3 worried
about. The grace for an accidental revocation is Rem restoring by hand, from a backup at most four
days old or from Turso's undelete, if the person reconnects and asks; otherwise they start empty.

So the ambiguous case 01e §5.7 raised (an earlier purge is irreversible, a later one is outside the
Terms) needs no waiting period: the destroy is immediate, and the copies Rem already keeps are the
recovery window.

**Two copies outside the friend's database**, which none of the designs closed:

- **The telemetry store's backups.** STORE_MIGRATION phase D backs up the Zenbook file nightly and keeps
  60 days on OneDrive (its §9), so the friend's `api_log` and `client_metrics` rows deleted in step 3
  would survive there for two months. From Phase 4 the telemetry backup takes the friends' four-day
  retention (§12.4); it is diagnostics, and four days of restore points is enough.
- **The app database's point-in-time history** (1 day on Free, 10 on Developer) keeps the friend's
  `users` row and token blob after steps 1 and 5 delete them. The identifiers in it (`account_id`,
  Spotify id, timestamps) are what the privacy policy names as held by the database vendor for up to
  ten days. The token matters more: the app cannot revoke a grant, so after an in-app disconnect it
  stays valid at Spotify until the person removes the app there. Rotating `TOKEN_KEYS` within five days
  of a deletion (§5.3's procedure: new key first, redeploy, re-encrypt the active rows, drop the old
  key) leaves that copy undecryptable. At five users that is at most four rotations, ever; the
  deletion job records the due date on `/usage` (§18 decision 16).

The destroy needs `TURSO_PLATFORM_TOKEN` in the runtime (§5.5). 01e §6 recommends taking it out once a
second user exists. The runtime already holds a group token that can read and drop every table, so the
platform token adds the power to create and destroy databases, and a deletion then cannot wait on a
laptop that is not always on. Keeping it, Production only and used by two functions, is the
recommendation (A, C; Rem's call, §18).

### 12.4 Backups

STORE_MIGRATION phase D's nightly job (lane 1904) with edit 4 of §10.2, extended (C §10.3):

- One `(database, retention)` entry per database: `("lazyboy", 60 days)` as today, `("lazyboy-app",
  4 days)`, and `("lb-u-<uid>", 4 days)` for each friend whose status is `active`, read each night from
  the app database through the read-only group token; from Phase 4, the Zenbook's telemetry file at 4
  days too (§12.3). Retention applies on the Zenbook and on OneDrive alike. A destroyed database, or
  one whose user is not active, drops out of the list by itself.
- Plaintext token and lock rows stripped from every copy before compression (until Phase 2's week is
  over, `lazyboy` still holds them). `user_tokens` rows are ciphertext whose key never leaves Vercel,
  so the app database's copies keep them and a restore keeps everyone signed in.
- Integrity check and per-table counts against the dump; one file per database; a restore test of each
  kind of database in lane 1904's restore drill.
- The cost: a friend's data lost more than four days back cannot be restored from a backup; Turso's
  point-in-time recovery covers the last day (ten on Developer). Rem's backups are unchanged.

## 13. Rollout in reversible phases

Every phase is its own deploy, and each has an exit check and a rollback measured in minutes. Until
Phase 4, `SIGNUPS=owner` keeps everyone but Rem out, so Phases 1-3 change how the app is built and
never who can reach it. Sizes as in the overviews: **S** one place; **M** a contract that callers
follow; **L** a design change or a mechanical edit across many files.

### 13.1 The phases

| phase | ships | starts after | exit check | rollback | size |
|---|---|---|---|---|---|
| **0**, now | Rem: rotate `AUTH_SECRET` in Production and give Preview its own value; set `SPOTIFY_OWNER_ID` in Production and `.env.local`; read the dashboard's User Management list and Vercel's Active CPU (team → Usage, 30 days); approve §10.2's six edits. One lane: gate `logout` (01b E3); a dev sign-in at `127.0.0.1:3000`, with `TURSO_DATABASE_URL` unset so nothing reaches production, that logs the key names `/v1/me` returns, with and without the two scopes §12.1 drops. Rem: `/home?perf=1` on his phone, reading `paint=` (S3's unmeasured half) | – | an old cookie refused after the redeploy; Rem signed in; `SPOTIFY_OWNER_ID` listed by `vercel env ls production`; whether `account_id` arrives | re-set the variables; revert the one-line guard | S |
| STORE_MIGRATION | lanes 1901-1911 with §10.2's edits; **P1** (the orphan predicate) inside 1910-1911 | Oct 15, 8 PM | its own R1-R6; P1's equality check on a current copy | its own (STORE_MIGRATION §8) | – |
| foreign plays | §11.2 | lane 1904 | Rem's yes on the list; `verify-derived` green | restore from the snapshot taken first | S |
| **P2** | `plays.listened_ms`, the accumulator, the fenced fill (§11.3) | lane 1911 | `SUM(listened_ms)` = `alltime_stats.durationMs`; Turso's per-database reads for the all-time term near zero; a week of capture matching the recorder | redeploy the previous build; the column is ignored | M |
| **P3** | segments with their manifest and version bumps, lazy days, fetch at mount, `history-ready` on the history half, ≤ 50 painted rows, phase E's store keyed per segment | P2 and lane 1906; **before mid-December** (the catalog split, 01d O2, is the stopgap if it slips) | every month's segment equals that month's slice of `readHistoryIndex()` on one snapshot; 01d's throttled harness meets S1-S3 at 4×; `history-ready` on `/usage` | revert; browsers re-download once | L |
| **1**, owner only | `identity.ts` and the branded `Uid`; `requireUser()` on every entry point; `OWNER_UID` and epoch 0 on the cookie, cookies without a uid refused (Rem signs in once); `forUser` over `lazyboy` with the versioned open; `userCache` with owner stamps; keyed `cache()` boxes and module state; `playlistsCache` deleted; task owners; uid in ETags, URLs, bodies and storage keys; sign-out clearing storage; the token core in its own module with keyed maps and owner-carrying tokens, still reading the plaintext row; §6.4's harness and T1-T3, T7, T8, T10, S1-S6, each shown failing first | P3 | `npm test` and `npm run build` green; an adversarial review of the diff; then a week with zero isolation events, capture matching the recorder, Rem signed in | redeploy the previous build: it ignores the cookie's extra claim and the two `meta` keys | L |
| **2**, owner only | `lazyboy-app`, `app-db.ts`, the users row, encrypted tokens, the one-statement identity check, T5, T6, T9; §11.4's steps | Phase 1's week, lane 1904, the foreign-play cleanup | §11.4 step 6, then three days | §11.4's rollback | M |
| **3**, owner only | `sync_state` and the claim; the per-user step; the `/me/player` probe; track-change harvests with the retry, completeness at 25 and a 2-hour backstop; the owner alarm by caller; per-bucket cooldowns and the 429 `reason`; the uid on telemetry and the `handoff` beacon without song names; the open-app rules; the per-user time zone (`user_tz`); `refreshHistoryAction` off Spotify; now-playing at 15 s; the rescan changes; the brake's counter, counting but inert; T4; then the second pinger and the recorder hourly | Phase 2's soak | a week in which Rem's harvests come to his plays plus ~15 and the retries (~145 against 280 on Oct 14, 01c §5.3), every tick answers 200, the open app harvests only catch-ups, no play is first stored by a backstop while Rem was listening (the check on `/me/player` alone), the recorder diff is empty; the second pinger proven by stopping the Zenbook timer for ten minutes | disable the second pinger, then revert the route | M-L |
| **4**, the first friend | `/join`, the terms pages, `invite.mjs`, the claim (`SIGNUPS=invite`); `/v1/me`'s non-403 failures no longer read as "not registered"; the two scopes dropped; the log-out split; the deletion job with its key-rotation reminder; per-database backups, friends' and telemetry's at four days; admin-only `/usage`; the bounds on client-chosen scans (§6.6); `owner.ts` removed; T11 | Phase 3's week, plus the gates in §13.2 | after a week: each user's scarce-bucket calls near §14.2's table; Turso's per-database usage near §8.6; no `QUOTA_EXCEEDED`; isolation events at zero; the friend confirms Home shows only their own plays | `status = 'disabled'` (sessions die and sync stops at once) or `SIGNUPS=owner`; the deletion job if they leave | M |
| **P4** and the brake | the Home payload patch, the strip from segments, the `contexts` scan, one marker bump per batch; the fair-share brake switched on | Phase 4's week, **before the second friend** | patched payload = rebuilt payload after a day of synthetic harvests; the brake's boundary known answers; the usage drop on Turso | redeploy; the brake has a flag | M |
| **5**, friends two to four | one person at a time, a week apart | P4 and the brake | each addition: the last week's recently-played spend plus the newcomer's expected share under ~426, or the brake tripping rarely; the read projection under 50% of the plan; Active CPU inside the plan | per friend, as in Phase 4 | S each |

The irreversible steps, each named where it happens: deleting the incident's foreign plays (§11.2,
snapshot first, Rem's yes), deleting the plaintext token rows a week into Phase 2 (§11.4 step 7,
still recoverable by decrypting), and a friend's account deletion once the four-day backups and
Turso's undelete window have passed (§12.3), which is irreversible by design.

### 13.2 Gates before the first friend

- Phases 1-3 have each soaked on Rem alone.
- **Vercel Active CPU** read (team → Usage → Active CPU over 30 days). No API open to Hobby reports
  it, and overrunning a Hobby allowance stops the feature for up to 30 days for every project on the
  team (01f §2.2-2.3). Stay on Hobby only if the team uses under ~2 of its 4 CPU-hours a month.
- **The dashboard's User Management list** read: how many accounts it holds, whether more than five
  survived Mar 9, and whether Rem's own account takes one of the five (01f §1.2).
- **The Turso plan** decided, before the friend's first sync (§15, §18).
- **Deletion proven** on a throwaway invite: create the row and its database, run the job, see the
  database gone from `turso db list` and the rows gone.
- **Preview without store variables and dev on its own app database**, both confirmed.
- **Rem's decisions** on the policy text, retention, log-out, and the `invalid_grant` rule (§18).
- **An adversarial review** of the whole multi-user diff in a fresh context, told to find a
  cross-user path.

### 13.3 Order and timing

| step | waits for |
|---|---|
| Phase 0 | nothing; before Oct 15, 8 PM keeps it out of the cutover window (01b §7) |
| STORE_MIGRATION | its own gates (Oct 15, 8 PM; STAT 139 first) |
| the foreign-play cleanup | lane 1904 |
| P2 | lane 1911 (both change `recordPlays`' neighbours and the derived checks) |
| P3 | P2 (the segment tuple carries listened seconds) and lane 1906 (the same load path) |
| Phase 1 | P3 (one lane in `db.ts` at a time; the mechanical edit should run over the final read paths) |
| Phase 2 | Phase 1's soak, lane 1904, the cleanup |
| Phase 3 | Phase 2's soak |
| Phase 4 | Phase 3's soak and §13.2 |
| P4 and the brake | Phase 4's week |
| Phase 5 | P4 and the brake |

[estimate, at the lane program's pace and with STAT 139 work first] STORE_MIGRATION through lane 1911
takes about a week from Oct 15; P2 a few days; P3 one to two weeks with its review; Phases 1-3 three to
five weeks with their soaks. That puts the first friend around early to mid-December at the earliest,
and P3 comfortably ahead of its deadline. The only hard date in the plan is P3, or the O2 stopgap,
before mid-December. If Phase 1 has to start before P3 for any reason, P3 is written against the
uid-keyed interfaces of §6.2 with Rem's constant uid, as phase E is (§10.2 edit 3), so nothing is
written twice.

### 13.4 How it turns into lanes

- The mechanical part of Phase 1, threading `forUser` through `db.ts` (74 async exports, 54
  `getClient()` sites) and its callers (~235 call lines in `src/`, ~300 in `tests/`, upper bounds by
  grep, C §2.2), suits a Sonnet lane at medium effort with `tsc --noEmit` as its oracle.
- The pieces that carry the risk (the gate, the jwt callback and token core, the claim and the tick,
  the open-app rules, the deletion job) are Opus lanes at high effort, each followed by an adversarial
  review lane in a fresh context before deploy, the pattern of lanes 1902, 1906 and 1911.
- One branch per phase, rebased on `origin/main` before it pushes; one lane in `db.ts` at a time.
- Each phase's lane updates the docs its change touches in the same branch: the `db.ts` header rule
  ("ONE client" becomes the client factory and `forUser`), `CLAUDE.md`, `docs/ARCHITECTURE.md`,
  `docs/GOTCHAS.md`, and `docs/SECURITY.md`, whose checklist still says development mode allows 25
  users (01f §1.2).
- Rem's own steps: Phase 0's environment changes and dashboard reads, the foreign-play list, the
  policy text, each friend's dashboard entry, and the decisions in §18.

## 14. Each target, step by step, with its budget

Store round trips use STORE_MIGRATION R1's target (p50 ≤ 15 ms), which lanes 1902-1903 will measure;
if R1 misses, every serial round trip below grows by the difference. Phone figures are 01d's 4× CPU
throttle on the Mac; no real phone has been measured (01d §8).

### 14.1 Search (S1-S3)

**S1, a repeat visit, Rem's data today, 4× CPU** (after P3 and phase E):

| step | budget | basis |
|---|---|---|
| read the stored segments and library from IndexedDB | ~20-25 ms | measured 18-20 ms at 4× for today's two bodies (01d O5); segments are ~25% more raw bytes (01d O3) |
| check each body's `u` against the page's uid | < 1 ms | a string compare per body |
| build the search set | ~47 ms | measured 46.6 ms at 4× (01d §2.3) |
| build the selected day | < 5 ms | lazy days, ~100 rows [estimate] |
| **search usable** | **~75-80 ms of 300** | |
| after that, off the critical path: the moved months named by the manifest already in the page, and the visit-start delta | ~100-250 ms | one request each [estimate] |

A heavy one-year user's set is ~1.45× Rem's (01d §3.3), which puts the build near 70 ms and the read
near 30 ms: ~105 ms.

**S2, a first visit, 4× CPU, 10 Mbit/s:**

| step | a typical one-year friend | Rem today | basis |
|---|---|---|---|
| first paint → requests start | ~100 ms | ~100 ms | fetch at mount (§9.2); today up to 2 s of idle wait, or 800 ms on Safari |
| the gate and the bodies on the server, in parallel | ~50-300 ms | ~50-300 ms | identity ~15 ms; a Data Cache hit ~50 ms, a miss rebuilds one month from an index range (~4,500-10,000 rows) [estimate]; the current month always rebuilds after listening |
| transfer | ~710 KB gzipped → ~0.57 s | library 285 KB + segments 798 KB → ~0.87 s | 01d §2.1 and O3 [measured sizes]; 01d §3.3 [projected sizes] |
| parse and build the set, at idle | ~50 ms | ~80 ms | 6.4 + 11.9 + 46.6 ms at 4× plus the segment merge (01d §2.3) |
| the selected day | < 5 ms | < 5 ms | lazy days |
| **search usable** | **~0.8-1.1 s of 2 s** | **~1.1-1.4 s of 2 s** | |

| profile | gzipped bytes, cold | search usable [estimate] | ≤ 2 s? |
|---|---|---|---|
| light, one year (01d §3.3) | ~250 KB | ~0.6 s | yes |
| typical, one year | ~710 KB | ~0.8-1.1 s | yes |
| Rem today | ~1.08 MB | ~1.1-1.4 s | yes |
| heavy, one year | ~1.3 MB | ~1.3-1.6 s | yes |
| heavy, three years | ~2.35 MB (B §9.4) | ~2.2-2.6 s | **no**: one art and album dictionary per user instead of per segment recovers the ~30% that segments add to a cold visit (01d O3), ~2.0-2.3 s; loading the library and the newest months first makes the box usable in ~1.2 s with older months following (B §17) |
| Rem on slow 4G (1.6 Mbit/s) | ~1.08 MB | ~5.5 s | **no**: the same newest-first loading, ~2.5 s to a usable box; slow 4G stays a stated miss (§18) |

The build row is the weakest estimate. The only Turso build timings on record (5.4 s for the library,
2.6 s for the history, Aug 6) ran from the Mac across the public internet (`db.ts:1421-1425`), so they
bound the build from above rather than predict it from iad1 (C §12.2). STORE_MIGRATION phase A's bench
route runs `getHistoryIndex(null)` from the production function and will give the first real number;
segments cap any rebuild at one month either way.

**S3, a keystroke, 4× CPU:**

| step | budget | basis |
|---|---|---|
| fold, match, rank and cap | ≤ 13.2 ms at Rem's size (the worst one-letter query, "e", 8,599 hits); ~25.6 ms at twice his size | 01d §2.3, §3.2 [measured] |
| later keystrokes narrow the previous matches | a few ms | §9.2 |
| paint the first ~50 rows, the rest on scroll | ~10-20 ms | [estimate]; rendering on a phone is unmeasured (01d §8), which is why Phase 0 reads `paint=` on Rem's phone |
| **filtered rows painted** | **~25-35 ms at Rem's size; ~40-45 ms at twice it** | ≤ 50 ms |

At four times Rem's size (58,028 entries) one-letter matching alone is 55.9 ms (01d §3.2), and the
lever is a Web Worker (01d O6).

### 14.2 Freshness (F1-F3)

**F2, a play that ends while the app is closed**, after Phase 3:

| step | budget | basis |
|---|---|---|
| the play ends → its user's next probe | 0-120 s, ~60 s on average | active users are probed every 2 minutes; ticks run every minute while both pingers live (§7.2) |
| the claim | ~15 ms | one app-database statement |
| the token | < 1 ms to decrypt; up to ~3 s when the hourly refresh lands on this tick | 3 s per token-endpoint attempt (`auth.ts:121`) |
| the probe, then the harvest | ~0.5-1.1 s | two Spotify calls [estimate] |
| record: insert, verdicts, Home payload | ~0.45 s today (~30 round trips); ~0.05 s after P4 (~3) | 01c §2.1; §8.4 |
| **stored after the play ends** | **p50 ~1 minute, worst ~2 minutes 5 s** | F2: ~2 minutes |

When Spotify lists a play only after the player has moved on, the retry stores it one probe later
(§7.4); how often that happens is unmeasured and Phase 3's soak counts it. **F1**: an open app shows a
finished track at once through its provisional play, and opening the app after listening elsewhere
runs the on-load harvest and the delta patch, so plays that ended before the open appear within ~1-2 s
of first paint [estimate, B §7.8]. **F3**: a harvest fires by 25 track changes, at every session's end,
and every 2 hours idle; at Rem's peak of ~20 plays an hour (01c §5.7), 25 changes take ~75 minutes,
longer than any brake interval, so no play leaves Spotify's 50-play window unseen while a pinger runs.

**The scarce bucket, a quota day** [estimate, from §7.4; the friend profiles are 01d §3.3's and 01f
§5.1's assumptions, not data]:

| user | track changes | session tails | idle backstops | open-app catch-ups | recorder | total |
|---|---|---|---|---|---|---|
| Rem, ~117-130 plays | ~125 | ~5 | ~7 | ~5 | 24 | ~165 |
| light friend, 40 plays | ~40 | ~5 | ~10 | ~10 | – | ~65 |
| typical friend, 50 plays | ~50 | ~5 | ~9 | ~10 | – | ~75 |
| Rem-like friend | ~125 | ~5 | ~7 | ~10 | – | ~145 |

| users | demand a day | against 450 (426 + the recorder) | what the brake does | closed-app freshness |
|---|---|---|---|---|
| Rem alone | ~165 | 37% | nothing | ~2 min |
| Rem + one friend, any profile | ~230-310 | 51-69% | nothing | ~2 min |
| Rem + four light | ~425 | ~94% | the app passes ~320 late in the day; Rem, above 426 ÷ 5 ≈ 85, moves to 15-minute batches | ~2 min for everyone until then; ≤ 15 min for Rem after |
| Rem + four typical | ~465 | ~103% | Rem moves to 15-minute batches past ~320; everyone to 30 near the day's end | ~2 min for most of the day, then ≤ 15-30 min |
| Rem + four Rem-like | ~745 | ~166% | everyone is above their share at ~320, about 40% into the listening day, and moves to 15 minutes; 30 near the end; the day's total is held near 475-505 (A §13.3) | ~2 min for ~40% of the day, then ≤ 15-30 min |
| any mix, if the quota is per user | – | – | nothing | ~2 min all day |

Today, for comparison: 139-319 cron harvests plus the recorder's 96 for Rem alone (01c §2.7). Five
Rem-like users on today's policy would need ~800-1,700 a day (01c §5.1).

### 14.3 Users (U)

| resource | per Rem-like user a day | five Rem-like | limit |
|---|---|---|---|
| allowlist places | 1 | 5 | 5 (01f §1.2) |
| Turso databases | 1 | 6, plus the old `lazy-boy` | 100 on Free |
| recently-played and `/me` calls | ~145-165 | held near 450-505 by the brake | ~725-800 observed; 450 planned |
| player calls | ~720 with up to two users; ~450 from three on (idle probes every 5 minutes) | ~2,250 | unmeasured; ≤ ~2,500 planned |
| Spotify calls per 30 s, at peak | – | ~2-3 from ticks, ~10-15 from five visible tabs | 18 seen safe; the limit itself is unpublished |
| Turso rows read | ≤ 1.5M on a heavy day (§8.6) | 26-258M a month by profile and step (§14.4) | 500M (R4: 250M) |
| Turso rows written | ~4,100-4,700 | ~0.63M a month | 10M (R4: 1M) |
| Vercel invocations | ~200 browsing; the tick is 1,440 a day in total | ~73,000 a month | 1,000,000 (Hobby) |
| Vercel Active CPU | unmeasured; Rem's share today estimated at 0.5-2.4 CPU-hours a month (01f §2.3) | 2.5-12 if it scaled linearly, an upper bound | 4 (Hobby, team-wide) |

Five accounts fit every budget but one unknown, Active CPU, which Rem reads before the first friend
(§13.2). Above five, possible only with a grandfathered list, things bind in this order: Active CPU
(if the users are Rem-like), closed-app freshness (each share of the scarce bucket is 426 ÷ N), and
Turso Free's reads under R4 at roughly 15-20 users after P4 [estimate: 250M ÷ (0.44M × 30)]; the first
structural limit is Free's 100 databases.

### 14.4 Store reads, writes and growth (D1-D3)

Per user on a heavy day, §8.6's table: Rem ~1.45M after P3 and ~0.36M after P4; an app-heavy Rem-like
user ~1.79M after P3 and ~0.44M after P4. D1 (≤ 1.5M) is met by Rem after P3 and by everyone after P4;
D2 holds after P4, when nothing on a per-play, per-tick or per-visit path grows with history.

Five users, a month, all friends app-heavy (eight Home visits a day). The friend profiles are
assumptions [estimate, the same per-run costs applied to each profile's history and library]:

| five users | per friend a day, after P3 / P4 | after P3 | after P4 |
|---|---|---|---|
| Rem + four light (40 plays a day, 7,200 plays, 2,000 library songs) | ~0.42M / ~0.13M | ~94M (19%) | ~26M (5%) |
| Rem + four typical (50 a day, 18,250 plays, 8,000 songs) | ~0.9M / ~0.27M | ~152M (30%) | ~43M (9%) |
| Rem + four app-heavy Rem-like, at Rem's history size | ~1.79M / ~0.44M | ~258M (52%) | ~64M (13%) |
| the same a year in, ~42,000 plays each | ~2.4M / ~0.5M | ~337M (67%) | ~70M (14%) |

Each cell is (Rem's day + 4 × the friend's day) × 30 against the free plan's 500M. The light and
typical friends' biggest term after P3 is the whole-history strip (~3 rows per real play per Home
mount), which is why P4 ships before the second friend: it is the one per-visit read left that grows
with each user's history. On the Developer plan (2.5B included, 01f §4.2) the largest cell is 13.5%,
and even today's code at five Rem-like users on an average day (~1B a month [estimate: 5 × ~6.7M ×
30, §8.6's today column with the orphan passes averaged]) fits with no block, which is why §15
recommends it as insurance rather than as capacity.

**D3**: ~4,100-4,700 rows written per Rem-like user a day (§8.6), ~0.63M a month at five, 6% of the
free plan. **Growth**: ~35 KB of core data a day for a Rem-like user (01a §6), ~12 KB for a light one;
five heavy users add ~64 MB a year against 5 GB.

### 14.5 Uptime (A1-A3)

| failure | user requests | closed-app capture | plays lost |
|---|---|---|---|
| the Zenbook down, including the ~3 AM reboot (6-8 minutes daily, 0.47% of the meter's 48.5 hours, 01f §3.3) | unaffected; telemetry dropped; `/usage` shows its log sections empty | cron-job.org's ticks keep every user at 2 minutes | none |
| the Zenbook frozen (103 stalls over 100 s in four weeks, STORE_MIGRATION §1) | unaffected: telemetry is never awaited on a user path and gives up at 4 s (R2) | as above | none |
| the Funnel certificate (expires Nov 8; lane 1907) | `/usage`'s log sections | unaffected | none |
| cron-job.org down | none | the Zenbook's timer | none |
| both pingers down | none | an open app captures for its own user (§7.6); otherwise the daily Vercel cron (07:00 UTC ± 59 min) | each user's plays beyond their newest 50, ~2.5-3.5 hours of nonstop listening (01c §5.7), unless they open the app; Rem's recorder covers him unless the Zenbook is the one down |
| one user's grant revoked, allowlist entry removed, database refused, or Spotify calls hanging | that user only | that user only | that user's, beyond 50, until they reconnect |
| Turso down | everyone | everyone | the 50-play rule, everyone |
| Turso Free's read quota exceeded | everyone, until the 1st (01f §4.2) | everyone | the same; Developer with overages turns it into a bill |
| Vercel down, or a Hobby allowance overrun | everyone; an overrun lasts up to 30 days and takes the team's other projects too (01f §2.2) | everyone | the same |
| Spotify suspends the app, or Rem's Premium lapses | Spotify features, everyone | everyone | the same |
| a recently-played `QUOTA_EXCEEDED` | none beyond history updates | harvests wait for the ~10:50 AM reset; probes and rescans continue | the 50-play rule; the brake makes it unlikely |

A1 and A2 hold once STORE_MIGRATION and Phase 3's second pinger are in; A3 holds by §7.8. What remains
is shared fate on managed services and on Spotify's policy, none of which this app can remove at its
scale (C §14 item 5).

### 14.6 Isolation and its cost (I, I$)

I is met by §6.3: each class has a layer that prevents it and one that detects it, and the suite runs
on every `npm test`. Its cost:

| what | per request | per tick | how known |
|---|---|---|---|
| identity, status, token, capture health and cooldown in one statement | no extra round trip where the gate already ran first; Home +1 sequential round trip (~15 ms) and three fewer reads | one claim; one token row per due user | from the code |
| the owner check on a database's first open | none when warm; one statement per database per cold process, seven fewer than `init()`'s eight | the same | §4.5 |
| token decrypt / encrypt | 1.67 µs / 2.67 µs | per due user | measured by A on the Mac (A §17) |
| the owner stamp on cached values; the token-owner assertion | a few bytes and a compare; one compare per Spotify call | – | from the design |
| uid in browser keys, ETags and URLs | none: a random uid needs no HMAC | – | §4.4 |

I$ holds: one round trip on Home, microseconds elsewhere.

## 15. Costs

Money, a month, at 01f §2.2 and §4.2's prices (fetched Oct 14):

| item | Phases 0-3, Rem alone | five users | basis |
|---|---|---|---|
| Turso | $0 (Free) | **$4.99 billed yearly ($5.99 month to month)** on Developer with overages, recommended before the first friend; $0 if Rem stays on Free, which §14.4's projections hold once P4 ships | 01f §4.2 |
| Vercel | $0 (Hobby) | $0 if the team's Active CPU stays under ~2 of Hobby's 4 hours; otherwise Pro, $20 including $20 of usage | 01f §2.2-2.3 |
| cron-job.org (the second pinger) | $0 | $0 | free tier |
| the Zenbook | $0 | $0 | runs anyway for the recorder, telemetry, backups and DiveLoop |
| Spotify | $0; Rem's Premium is required for the app to work at all | $0 | friends cannot be charged: the app controls playback, which makes it a Streaming SDA, and those may not be used commercially (01f §1.5) |
| **total** | **$0** | **$5-26 with Developer; $0-20 on Free** | |

Isolation itself adds $0: the databases are free (100 on Free, unlimited on paid plans, idle ones cost
only storage), encryption is Node's built-in `crypto`, and the tests run in the existing harness.

What the Developer plan buys besides capacity, which is why it is recommended although five users fit
Free after P4: a month's reads past the allowance become a bill ($1 per billion) instead of a block on
every query for every user until the 1st, which is what August's regressions did (READ_QUOTA "Where
August actually went"); ten days of point-in-time recovery for Rem's own data instead of one; and a
five-day undelete for a destroyed database, which is the grace §12.3 relies on.

The work is in §13.1's sizes: P2 M, P3 L, Phase 1 L, Phase 2 M, Phase 3 M-L, Phase 4 M, P4 and the
brake M, each friend after that S.

## 16. Unknowns and risks

### 16.1 Unknowns, and what answers each

| unknown | where it matters | answered by |
|---|---|---|
| whether Spotify's development-mode quota is one pool or one per user | §7.5, F2 | the passive check (§7.9): a ban in Phase 5, or never; the plan is safe under both readings |
| the team's Vercel Active CPU | Phase 4's gate, §15 | Rem, on the dashboard, in Phase 0 |
| how many accounts the allowlist holds, whether any are grandfathered, whether Rem counts toward five | U | the dashboard's User Management list, in Phase 0 |
| whether `/v1/me` returns `account_id` to this app, and under which scopes | §5.1, §11.4, §12.1 | Phase 0's dev sign-in; Phase 2 step 2 before anything depends on it |
| R1 on Turso, and the payload build time from iad1 | every latency in §14 | lanes 1902-1903's bench route |
| whether recently-played lists a play after the player has moved on, and how often | F2's worst case | Phase 3's soak: the retry count |
| whether `/me/player` alone ever misses playback that currently-playing sees | §7.3 | Phase 3's soak: no play first stored by a backstop while Rem was listening |
| whether the identity-first predicate is equal on today's data | §8.2 | lane 1910's check on a current copy (verified so far on the Aug 11 copy only) |
| the player bucket's limit and the rate limit's number | §14.3 | a player-endpoint 429, with its `reason`, in `api_log` |
| keystroke-to-paint on a real phone | S3 | Phase 0's `lb-perf` read on Rem's phone |
| how friends listen and how often they open Home | §14.2, §14.4 | Phase 4's week; Turso's per-database usage |
| whether a destroyed Turso database's point-in-time history goes with it | §12.3 | A and C quote Turso's docs saying it does; B could not find the statement (B §14). Re-read the page before a friend's data is on a paid plan |
| the incident's exact window | §11.2 | not needed: the recorder diff finds the rows |
| whether Preview and Production share the Data Cache; whether `cache()` is active in route handlers | §6.2 | not needed: the owner stamp and the keyed boxes make the design correct either way |
| the Data Cache's size and hit rate under the team's other projects | §9.3 | not observable on Hobby; an eviction costs one month's rebuild |
| what "Turso is joining Supabase" means for plans and prices | §10.1 | Turso's announcements; each user's data stays portable |

### 16.2 Risks the plan carries

- **A wrong uid compiles.** The branded type stops a uid made from request input; it cannot stop a
  real uid used in the wrong place, such as the cron handing user A's uid to user B's step. The step
  receives its arguments and touches nothing else, T4 checks that each user's play lands in that
  user's file, and the token-owner assertion and owner stamps catch a mismatch at runtime (C §16.2).
- **One token reads everything.** The group token reaches every user's data and cannot be revoked
  alone (B §19). It must be a Secret-type variable (write-only after saving), which nobody has checked
  for today's `TURSO_AUTH_TOKEN` (C §16.2).
- **The open app trusts the cron.** While ticks run, an open tab harvests only its catch-ups, even if
  the cron's step for that one user keeps failing; the user's capture health shows the stall, and for a
  quota ban not harvesting is the right behaviour (C §16.2).
- **The mechanical edit's volume.** Threading `forUser` touches ~535 call lines (upper bound, C §2.2),
  and a semantics change can hide in that much noise. `tsc --noEmit` is the oracle, the adversarial
  review reads the non-mechanical hunks, and the isolation suite runs every per-user method as two
  users.
- **A missed segment bump** serves one user a stale month until its next bump; each bump site has a
  known-answer test, the manifest's play counts catch a missed insert, and moving the shape token
  re-fetches everything (§9.1).
- **P3's deadline.** If segments slip past mid-December, the catalog split (01d O2) buys ~10 months.
- **Spotify can lower the budget.** The brake plans to 60% of a limit Spotify says "may change"; the
  429 `reason` with per-user attribution shows the first sign.
- **Rollbacks assume Spotify keeps not rotating this app's refresh tokens** (01e F2); if it starts, a
  rollback costs Rem one sign-in (§11.4).
- **Cross-site scripting** acts as its victim only (the session cookie is httpOnly and server actions
  run as the victim), and the text the app renders comes from Spotify, where anyone can name a
  playlist; React's escaping stays the main defence. A nonce-based CSP stays on `docs/SECURITY.md`'s
  checklist, not a multi-user blocker (01e §5.10).
- **Policy.** Storing friends' history and showing derived listening stats sit against the Developer
  Terms' storage rule and the Policy's "derived listenership metrics" line (01f §1.5). The plan
  narrows the exposure (each user sees only their own stats; retention; deletion inside five days);
  accepting the rest is Rem's call. This is an engineer's reading, not legal advice.

## 17. What I ran

Nothing ran against the production store, the Zenbook, Turso, Vercel or Spotify, and nothing was
written except this file. On Oct 14, about 11:03 PM to 11:45 PM, on the Mac:

- Read in full: the six overviews (`01a`-`01f`), the three designs, `docs/STORE_MIGRATION.md`,
  `docs/GOTCHAS.md` and the project's `CLAUDE.md`.
- `git rev-parse --short HEAD` (`7e0c5b1` at the start) and `git diff --stat ac6f7fe HEAD -- src scripts
  ops tests vercel.json next.config.ts package.json` (empty, so the overviews' line numbers hold).
- Code read with `sed -n` to check what this plan cites beyond the overviews: `src/lib/db.ts:570-590`
  (the all-time gate) and `690-760` (the orphan predicate and `recomputeOrphanFlags`);
  `src/lib/skip-rule.ts:28-75`; `src/app/(app)/home/den-home.tsx:370-386` and `655-680`;
  `src/app/api/cron/sync/route.ts:20-60` and `92-186`; `src/lib/harvest-gate.ts`;
  `tests/stubs/next-cache.ts`.
- B's two scripts, re-run unchanged from `~/.claude/broke/scratch/lazyboy_mu/0222_design_b/`:
  `sqlite3 -readonly 'file:data/replica.db?immutable=1' < orphan_equal.sql` (1.3 s) and
  `< orphan_plans.sql`, against the Mac's Aug 11 local copy (7,572 plays; nothing written, no WAL
  opened). The output is quoted in §8.2 and matched B §10.1's figures exactly.

## 18. Decisions that are Rem's

Each with a recommendation and its reason, grouped by what it blocks.

**Now, before Oct 15, 8 PM**

1. **Phase 0's production changes**: rotate `AUTH_SECRET` in Production with a separate value for
   Preview, set `SPOTIFY_OWNER_ID` in Production and `.env.local`, and gate `logout`. *Recommend yes,
   before the cutover's window.* A browser that signed in before the guard can act as you until about
   Nov 13, and its log-out can stop your capture (01b E1-E3, 01e F1). It costs one sign-in.
2. **STORE_MIGRATION's edits 1-5** (§10.2: the dominant read and R4's growth term; Production-only
   flip; phase E's user key; backups as a list with token rows stripped; deleting the cutover's
   plaintext copies). *Recommend yes, before lane 1901.* None touches the cutover's logic, and each
   saves doing the work twice.
3. **Edit 6: lanes 1910-1911 also ship the identity-first orphan predicate.** *Recommend yes, after the
   equality check on a current backup copy.* It gave the same verdict on every play of the Aug 11 copy
   and reads ~2.7 rows a play where today's walks ~411 (§8.2); scoping alone leaves busy playlists
   expensive, in a way the meter hides.
4. **Where the three log tables live** (STORE_MIGRATION §4's open question). *Recommend keeping them
   on the Zenbook, as you said.* Multi-user adds one reason: on Turso, five users' `api_log` would push
   the month's writes past R4's 10% bar (§10.2).
5. **Two one-minute dashboard reads**: Spotify's User Management list (how many accounts, any
   grandfathered above five, whether you count toward the five) and Vercel's Active CPU per project
   over 30 days. *Recommend now*: they settle target U and the Vercel plan (01f §6.2).

**The design, before Phase 1**

6. **Five accounts, you included; past five, people run their own copies.** *Recommend yes.* It is
   Spotify's cap, and no money changes it (01f §1.2-1.3).
7. **A database per user.** *Recommend yes.* A forgotten filter becomes impossible rather than
   unlikely, your data does not move, and deletion reaches every copy inside Spotify's five days
   (§4.1, §12.3). Revisit only if friend features that join across users become the priority.
8. **The single-user performance track before the multi-user phases** (P2, then P3 before
   mid-December). *Recommend yes.* With the predicate of decision 3 it cuts your own store reads on a
   heavy day from ~19M to ~1.45M rows (§8.6), and it removes the late-December cache cliff, whether or
   not anyone else ever signs in.
9. **The search target's device and network**: a mid-tier phone (4× CPU) at 10 Mbit/s, with slow 4G a
   stated miss. *Recommend yes.* Meeting slow 4G on a first visit takes newest-first loading, an M-sized
   change nothing else needs (§14.1).
10. **Delete the incident's foreign plays from your history**, after reading the list. *Recommend yes.*
    They are someone else's listening inside your stats, and once the store has owners they would be
    filed as yours for good (§11.2).

**Before the first friend**

11. **Turso's Developer plan with overages**, $4.99 a month billed yearly. *Recommend yes, as
    insurance*: five users fit Free after P4, but on Free one regression blocks every query for every
    user until the 1st, as August showed, and Developer turns that into a bill. It also gives your data
    ten days of point-in-time recovery and makes a deletion undoable for five days (§15).
12. **Vercel Hobby or Pro.** *Recommend reading Active CPU first, and staying on Hobby only if the team
    uses under ~2 of its 4 CPU-hours a month*; an overrun stops every project on the team for up to 30
    days, and Pro ($20) turns it into a bill (01f §6.3).
13. **What "log out" means.** *Recommend three actions*: sign out (this browser; capture continues),
    sign out everywhere, and disconnect and delete. Today one button stops capture and signs out every
    device (§5.4).
14. **An `invalid_grant` within six months of consent.** *Recommend treating it as a disconnect*:
    destroy the friend's database at once; if they come back and ask within four days, restore from
    the backup or Turso's undelete. You are exempt. Waiting before deleting is gentler but either
    stretches past Spotify's five days or needs bookkeeping; this keeps every copy inside five days
    under any reading of the Terms (§12.3).
15. **Retention for friends.** *Recommend*: kept while connected; deleted at a disconnect; deleted
    twelve months after the last sign-in. The twelve is the number to choose; Spotify says not to keep
    content indefinitely (01f §1.5).
16. **Friends' backups kept four days and taken only while a friend is active; the telemetry store's
    backups kept four days from the first friend on; the token key rotated within five days of a
    friend's deletion.** *Recommend yes*: deletion then reaches every copy, the vendor's point-in-time
    history included, with no file-by-file bookkeeping; your own backups stay at 60 days (§12.3-12.4).
    The alternative to the key rotation is naming the ten-day vendor copy in the privacy policy and
    accepting it.
17. **`TURSO_PLATFORM_TOKEN` stays in the runtime**, Production only, used by the deletion job's destroy
    and the daily usage read. *Recommend yes.* 01e §6 recommends removing it; the price of that is a
    deletion that waits on a script you have to remember within five days (§12.3).
18. **The privacy policy and end-user agreement**, and whether friends ever see derived stats. *The text
    is yours to write or approve* (§12.2 lists what it must say). *Recommend each person sees only their
    own listened time and skip stats* until you decide about comparisons, given the Developer Policy's
    line on derived listenership metrics (01f §1.5).
19. **A session whose Spotify grant has died.** *Recommend keeping today's behaviour*, a redirect to
    sign in again: one sign-in restores reading and capture, and with decision 14 a friend's read-only
    view would mostly show data being deleted. 01b §2.4 recommends a read-only mode instead (§5.4).
20. **The recorder stays yours alone and runs hourly.** *Recommend yes* (01c §5.7, 01e §5.9). Separately:
    its grant may age out by Feb 6, 2027; a fresh local sign-in copied into its `tokens.json` restarts
    the clock (01e F3).
21. **A canary account in Phase 4.** *Optional*: only if you have a spare Spotify account, since it holds
    one of the five places while it exists (§6.5).

**Before the second friend**

22. **Closed-app freshness if the quota is shared.** *Recommend the fair-share brake for everyone, you
    included* (§7.5): two minutes until the day's budget runs low, then 15-30 minutes for whoever is
    above their share, with anything you open always current. Exempting you moves your ~150 calls a
    day onto everyone else's share. The alternative that keeps two minutes for all is server-side
    provisional plays (01c §5.3 ii), medium-to-large work.
23. **Finding out whether the quota is pooled.** *Recommend the passive way* (§7.9) plus a question on
    Spotify's developer forum. The active test bans your own capture for up to ~12 hours if the quota
    is shared (01c §7 decision 3).
24. **Friends' Extended Streaming History imports.** *Recommend not until segments exist*: a five-year
    import is a ~4.2 MB history body today (01d §7 decision 2).

**Only if it happens**

25. **If Spotify does not return `account_id`** to this app (Phase 0's dev sign-in shows it first).
    *Recommend deciding then.* Keying on the mutable Spotify `id` works for a handful of friends but can
    split one person into two users if Spotify ever lets ids change (01e §5.5, C §15 decision 5).
