# Multi-user lazyboy: the plan

Lane 0223_lb_mu_synthesis wrote this plan on Oct 14, 2026. Lane 0225_lb_mu_revise revised it on Oct 15
to answer the four reviews (`review-security.md`, `review-scale.md`, `review-migration.md`,
`review-completeness.md`, cited as security R1, scale 1, migration 1, completeness H1 and so on); §19
lists every finding and what changed. Planning only: nothing here changed code, data, the Zenbook
store, Turso or Vercel. It synthesizes the six overviews (`01a-data.md` to `01f-platform.md`, cited as
01a §n and so on) and the three designs (`design-a.md`, `design-b.md`, `design-c.md`, cited as A §n,
B §n, C §n). Code line numbers are against `ac6f7fe`, which the overviews cite; `git diff --stat
ac6f7fe HEAD -- src scripts ops tests vercel.json next.config.ts package.json` is still empty at `c6c9c07`.
Every number is **[measured]** with its source or **[estimate]** with its arithmetic. §17 lists what
the first lane ran, §20 what the revision ran.

Status: complete, Oct 15, 2026, 1:05 AM. Every section is revised; §19 accounts for every finding.

## 0. For Rem: the plan on one screen

**What it takes.** Each person gets their own Turso database (yours is the `lazyboy` database the store
migration creates, unchanged), plus one small app database for identity, encrypted Spotify tokens and
scheduling. Every request carries a random user id, checked against the app database before any read;
the sync tick leases each due user and works on them in parallel inside Spotify's shared budget; and a
single-user performance track ships first, so five people's reads fit Turso's free plan and search
stays fast. No friend gets in until a canary account has run beside you for a week.

**Order of work** [time is an estimate at the lane program's pace; sizes S < M < L, §13.1]:

| step | what | starts | work | money a month |
|---|---|---|---|---|
| Phase 0 | rotate `AUTH_SECRET`, set `SPOTIFY_OWNER_ID`, gate log-out; three dashboard reads; copy `backstop.db` off the Zenbook | today | S: ~30 minutes of yours, one lane | $0 |
| STORE_MIGRATION | lanes 1901-1911 with eight edits (§10.2); P1, the "From" predicate, inside 1910-1911 | Oct 15, 8 PM; ~1 week | as planned | $0 |
| after lane 1904 | an interim second pinger with a 90-second guard; replay the 122 plays only the recorder holds | late October | S | $0 |
| P2, P3 | stored listened time and the all-time accumulator; monthly history segments, lazy days | after lane 1911; P3 before mid-December | M, L | $0 |
| Phases 1-3 | the user id everywhere and the e-mailed health alarm; the app database and encrypted tokens; the per-user sync queue and the Liked fix; all on you alone | after P3; 3-5 weeks with soaks | L, M, L | $0 |
| Phase 4a | a canary account for a week; sign-up, deletion, per-user backups, the quota brake | after Phase 3 and §13.2's gates | M-L | Turso Developer $4.99 (recommended); Vercel Pro $20 only if Active CPU says so |
| Phase 4b | the first friend | a week after 4a; mid to late December at the earliest | S | the same |
| P4, Phase 5 | the Home payload patched in place and the open-tab fix; then friends two to four, a week apart | before the second friend | M, then S each | $5-26 at five users |

**Targets** (§1; budgets in §14):

| target | met? |
|---|---|
| five accounts, you included (U) | yes. The 25 asked for is out of reach: Spotify allows five per app in development mode |
| no path shows or caches another user's data (I) | by design: per class of mistake a layer that prevents it and a test or runtime check that detects it, a canary week, an e-mailed alarm |
| search ready ≤ 300 ms on a repeat visit, ≤ 2 s on a first at 10 Mbit/s, a keystroke ≤ 50 ms, on a phone (S1-S3) | yes for you (~80 ms, ~1.1-1.4 s, ~25-35 ms) and a typical friend; no for a heavy three-year history (~2.2-2.6 s), a five-year import (~3 s) and slow 4G |
| screens current; closed-app plays stored p50 ~1 min, p95 ~5 min; none lost while a pinger runs (F1-F3) | yes; on a heavy shared day a user past their share waits up to 15 minutes, everyone up to 30 once the day's budget is spent |
| reads ≤ 1.5M rows a heavy day with nothing per visit growing with history; writes ≤ ~5,000 rows a day (D1-D3) | after P4: you go from ~4.5-19M a day today to ~0.4M; writes ~4,500-5,000 |
| no request on the Zenbook; capture survives its outages; one user's failure stays theirs (A1-A3) | after STORE_MIGRATION, the interim pinger, and Phase 3 respectively |
| $0 until the first friend, ≤ $26 a month at five | yes |

**Risks that remain.** Spotify sets the ceiling: five accounts, your Premium as everyone's dependency,
and a recently-played budget whose size is inferred from August's bans and whose pooling is unknown
(the brake plans to 60% of it). Turso, Vercel and cron-job.org are shared fate; a Hobby Active CPU
overrun stops every project on the team for up to 30 days, so it is read before the first friend.
Restores, rollbacks and deletions are runbooks a person follows, rehearsed once each. The Zenbook keeps
telemetry, backups and your recorder. Storing friends' history under Spotify's terms is an engineer's
reading, not legal advice.

**Your decisions** (§18 has each reason):

| # | decide | recommend |
|---|---|---|
| 1 | Phase 0; the 7:05 AM push publishes these docs on the public repo before it unless held | yes, today; holding the push is optional |
| 2-5 | STORE_MIGRATION's edits; P1 in lanes 1910-1911; the log tables stay on the Zenbook; the dashboard reads | yes to all, before lane 1901 |
| 6-9 | copy `backstop.db` now; replay its 122 plays after lane 1904; the interim second pinger; a Zenbook resolver outside Tailscale | yes to all |
| 10-13 | five accounts; a database per person; the single-user track first (it costs the first friend ~1.5-2.5 weeks); the phone and 10 Mbit/s search target | yes to all |
| 14-15 | an e-mailed health alarm, lifting STORE_MIGRATION's R6 for these phases; the forced refresh stops calling Spotify in Phase 3 | yes; yes |
| 16-20 | a canary week; Turso Developer; the Vercel plan; three log-out actions; a dead grant sends you to sign in | yes; yes; read Active CPU first; yes; yes |
| 21 | a friend's `invalid_grant` | stop and keep the data, alert you, delete on day 4 unless they reconnect; never automatic when two or more are hit |
| 22-24 | friends' retention; four-day backups without a key rotation per deletion; the platform token in the runtime and your Keychain, never `.env.local` | while connected, paused after 60 idle days, deleted at 12 months (the number is yours); yes; yes |
| 25-27 | the privacy policy; the recorder stays yours, hourly; sqld under its own account on the Zenbook | yours to write; yes; yes |
| 28-31 | the brake for everyone, you included; learning the quota's pooling passively; imports after newest-first loading; if Spotify sends no `account_id` | yes; yes; yes; decide then |

## 1. Targets

The brief asked for multi-user support that is secure, keeps performance and uptime, scales with the
store's usage, and keeps search fast. The three designs turned that into checkable numbers in
slightly different ways (A §0.1, B §1, C §1); this plan takes the strictest version of each that the
evidence supports and states how it is measured. §14 walks every target step by step with its budget.

"Rem-like" means Rem's measured profile: ~115 real plays a day over 30 days (01a §6), 129 on Oct 14
(01c §2), 204 on his busiest day in 61 (01a §6). A **heavy day** is Oct 14's activity as the store
meter measured it (716 ticks, 129 landed plays, 44 all-time recomputes, ~30 rescans, 01c §2.1-2.3),
with three unscoped orphan passes (as that day had) and eight Home visits (an app-heavy user, 01d
§4.2's assumption). Oct 14 was the incident day: the second account's library replaced Rem's and was
replaced back, and each swap moved the playlist id set that triggers an unscoped pass, so at least two
of the three passes were most likely the incident's; the ordinary rate is about three a week
(migration 15, STORE_MIGRATION §3). That inflates only the "today" column of §8.6; from P1 on an
orphan pass is cheap. "A phone" is Chrome with the CPU throttled 4×, the stand-in 01d §2.3 measured
with; no real phone has been measured.

| id | target | today | measured by |
|---|---|---|---|
| **U** | **5 accounts, Rem included**, on the one Spotify app. Past five, each person runs their own copy, which is the one-user case of the same code | 1 (the owner guard, `src/lib/owner.ts:10-14`) | the dashboard's User Management list; `users` rows |
| **I** | No request, cache entry, browser store, background job or script returns, changes or caches another user's data. Every class of mistake that could do it meets one layer that prevents it and one that detects it (a test in `npm test`, or a runtime check that refuses, records the event in `lazyboy-app` and alerts Rem) | not applicable: one global token row, every read unscoped (01b §1) | the isolation suite (§6.4) on every `npm test`; the canary week's exit checks (§13.1); runtime `isolation` events, expected count 0, alarmed by the health check (§7.10) |
| **I$** | Isolation costs at most one extra store round trip on Home (~15 ms at STORE_MIGRATION R1's target) on a warm process, plus one TLS handshake to the app database on a cold one, and microseconds elsewhere | – | §14.6 |
| **S1** | Repeat visit: search usable ≤ 300 ms after Home's first paint, on a phone | no browser copy yet (STORE_MIGRATION phase E) | `lb:index-idb` (R3) |
| **S2** | First visit on a device: search usable ≤ 2 s after first paint, on a phone at 10 Mbit/s, for Rem today and for a typical one-year friend (18,250 plays, 8,000 library songs, 01d §3.3) | real users, mostly August: median 4.0 s, p90 8.7 s between rows painted and search ready [measured, 01d §2.3] | `lb:history-ready`; 01d's throttled-browser harness re-run on the new bodies |
| **S3** | Keystroke to painted rows ≤ 50 ms on a phone, for search sets up to ~30,000 entries (about twice Rem's) | matching 10.5-13.2 ms at 4× for one-letter queries; keystroke-to-paint 43.8 ms median on a desktop dev build [measured, 01d §2.3] | `lb-perf` `paint=` (GOTCHAS "Measuring a search") |
| **F1** | Observed freshness: any Home view shows every play that ended more than 2 minutes before it opened, and every play that ends while it is open | met for Rem through the on-load sync and the browser's provisional plays (01c §5.3) | the on-load harvest's outcome; the handoff beacon |
| **F2** | Stored freshness with the app closed: a finished play is in the store at p50 ~1 minute and p95 ~5 minutes. The tail is Spotify's: it lists ~13% of plays only after the first harvest that follows them [measured, scale 5]. On a quota day the brake (§7.5) slows a user who has spent their share to 15-minute batches, and everyone to 30 once the app's daily budget is spent | p50 72 s, p95 300 s for Rem, Oct 12-14 [measured, scale 5] | each harvest records `now − played_at` for the plays it lands; `/usage` shows p50/p95 per user |
| **F3** | Completeness: no play lost while either pinger runs and no quota ban is in force | one pinger, on the Zenbook (01c §1) | the recorder diff for Rem (STORE_MIGRATION §8 step 13); a harvest before 25 track changes pile up |
| **D1** | Store reads ≤ 1.5M rows (Turso's terms) per Rem-like user on a heavy day, so five such users stay inside R4 (≤ 250M of the free plan's 500M a month) | ~4.5-5.6M on a typical day, ~19M on the incident day with three unscoped orphan passes [estimate from the meter, 01c §2.7-2.8, §5.9] | Turso's per-database usage, recorded by the daily chores |
| **D2** | No read on a per-play, per-tick or per-visit path grows with the user's total stored history | the all-time recompute scans every play up to 144 times a day and grows ~12,000 rows a day, every day (01c §5.9); an open Home tab re-reads the strip at any width the client asks (scale 2) | the §8 table, reviewed per change |
| **D3** | ≤ 5,000 rows written per Rem-like user a day, counting the index entries libSQL bills, and ≤ 50 KB of growth (five users ≤ 10% of the free plan's 10M writes a month) | ~3,000 core rows and ~35 KB a day (01c §2.7, 01a §6) | the meter's per-statement `rw` before the move (scale 8); Turso's per-database usage after |
| **A1** | No user-visible request depends on the Zenbook | every authenticated page does (01f §3.2) | STORE_MIGRATION R2's fault injection, re-run as an exit check of Phases 1, 3 and 4a |
| **A2** | Closed-app capture survives a Zenbook outage of any length | the only frequent pinger is on the Zenbook (01c §1), which lost about ten days of capture in late August and September (migration 2) | stop the Zenbook timer for 10 minutes; plays land from the other pinger |
| **A3** | One user's failure (a revoked grant, removal from the allowlist, a refused database, a hung Spotify call) costs that user's slot and nothing else | one token's failure stops all capture; one user's 403 fails the tick (01c S2) | the cron fan-out test (§6.4); per-user outcomes in every tick's reply to the Zenbook |
| **$** | $0 a month until the first friend; ≤ $26 a month at five users | $0 | §15 |

What changed from the brief, and why:

- **25 users became 5.** Spotify's quota-modes page: "Up to 5 authenticated Spotify users can use an
  app that is in development mode", applied to existing apps from Mar 9, 2026; extended quota mode
  "only accepts applications from organizations (not individuals)" with "at least 250k MAUs"; several
  Client IDs break the one-Security-Code rule and share one quota anyway (all quoted in 01f §1.2-1.3,
  fetched Oct 14). The 25 on today's pages is Client IDs per developer. All three designs and four
  overviews reached the same number. §14.7 shows what would bind first at 25 and 250 if the cap moved.
- **Freshness split into F1-F3**, as B §1 did. Under the documented reading of Spotify's quota (one
  pool per developer account, 01c §4), 2-minute closed-app freshness for five heavy listeners costs
  more recently-played calls a day than the budget August's bans measured (01c §5.1). Nobody sees
  stored freshness while the app is closed, so the plan protects F1 and F3 always and lets F2 degrade
  on the days the budget runs low. F2's tail was "~2 minutes" on Oct 14; the review measured Spotify's
  listing lag, and the target now states it.
- **D1 is set by need, not ambition.** B set 100,000 rows a day; that is reachable (B §10.2) but asks
  for more write-path machinery than five users need. 1.5M is what keeps five heavy users inside R4 on
  the free plan; D2 is the structural rule that keeps D1 true as histories grow.
- **I and I$ are added**, from "keep it all secure" (A §0.1, C T0).

Three numbers the targets rest on are not measured, and the rollout gates on them (§13): whether
Spotify's development-mode quota is one pool or one per user (01c §4, 01f §1.4), how much of Vercel
Hobby's 4 Active-CPU-hours a month the team already uses (01f §2.3), and how many player calls a day
Spotify allows (the most the app has made is 1,336, on Oct 13, with no 429, scale 6).

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
| owner stamp | `meta.owner_uid` checked on first open | – | – | **A's**, cached per `(uid, db_name)` | a wrong mapping (a restore, a provisioning slip) becomes a refused open at one statement per process per pair, and a second uid pointed at a checked database is checked again (security R15) |
| schema changes | `init()` replaced by declared versions and an explicit migrate script | versions, a template database, per-user pause | `init()` per database, as today | a versioned open: one statement reads the owner, the version, a reader floor (`min_reader`) and the store epoch; production alone applies pending additive steps as `init()` does today; a database ahead of the code opens while `min_reader` allows; a pending rebuild refuses that user until the migrate script runs, with that user paused | keeps today's workflow for the additive changes that are nearly all of them (C), one round trip per cold open instead of eight (A), and the unsafe case becomes a refusal (A, B) |
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
| cache keys | one `userCache` helper: uid in key parts and arguments, an owner stamp checked on return, a tag | uid argument, a tag | uid argument, no tag | **A's helper with the stamp, no tag**, the store epoch in every key | the stamp turns a key mistake into a slow request in production, and the epoch keeps a restore from re-issuing a cached version (migration 1); a tag adds nothing a ≤ 24 h TTL and a never-reused uid do not (C §5.2) |
| tokens carry their owner | asserted on every Spotify call | – | – | **A's** | 01e A2, the shared in-flight refresh, is the one silent token leak in the census; the assertion catches its whole class |
| runtime `isolation` events | yes | – | – | **A's** | the first sign of a bug the tests missed |
| tests | T1-T12, static checks S1-S6, file hashes, a faithful cache stub, Spotify scripted per bearer | ten tests, each proven against a planted bug | similar; structural test via the TS compiler API | **A's suite, B's planted-bug rule**, the planted bugs kept as a permanent self-test | the most complete, and a test that never failed proves nothing (completeness M2) |

**Sync**

| point | A | B | C | this plan | why |
|---|---|---|---|---|---|
| tick | per-user claims (`UPDATE … RETURNING`), one tick a minute | global tick lock plus a per-user harvest lock, one a minute | global 90 s lease, ~2 minutes | **A's per-user claims**, with B's two pingers on alternate minutes | one lease serves the cron and the open tab; an overrunning step holds only its own user |
| owner alarm | non-200 when the owner's capture stops | only the Zenbook's caller, by its own secret | `?alarm=owner`, checked before the lease | the Zenbook's own secret (B), the verdict read from the owner's sync state (C's reason), and an hourly health check that e-mails Rem (§7.10) | with two pingers, the other one may have done the owner's work this minute; and a failed unit nobody looks at is no alarm (completeness H1) |
| probe | `/me/player` alone | the same, now-playing too | `/me/player` alone in the cron | cron only (A, C) | now-playing's two-step read is the UI's freshness path (GOTCHAS "Player simulation") |
| harvest | on a track change; completeness at 40 changes | on a track change; 25 | on a track change, plus one retry after a lagging change | track change, **B's 25**, one retry ~5 minutes after a session ends | Spotify's lag is now measured (13% of plays listed late, scale 5); mid-session the next change's harvest catches it, so the retry goes to the session tail; 25 leaves half the 50-play window spare |
| quota brake | fair share: at ¾ of 450, users above their share go to 15 minutes; at 450, everyone to 30 | a daily projection picks one interval for all | at 450, everyone to 30 minutes, before the third user | **A's fair share with a per-user cap at the share**, C's counter (awaited before the call), on from the first friend | light listeners never slow down, a heavy one cannot spend anyone else's share, and the first week the bucket is shared is covered (scale 1) |
| open-app harvest | the same step under the same claim | on load or focus, if a track change was seen | only when no tick ran in 5 minutes, or on load after 15 minutes | **all three**: A's step under the claim, B's load trigger, C's fallback | each covers a different case: overlap, catch-up, dead pingers |
| now-playing poll | 15 s mid-track | 15 s | only if logs show crowding | 15 s from the first friend, with a per-user server memo | the daily player volume is the reason, not the 30-second window, which has taken 56 calls without a 429 (scale 6, 7); Rem's app does not change before a friend needs it (completeness L6) |

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
| deletion | destroy the database the same day; tombstone after 5 days | drop the tables at once; destroy within 5 days, off the runtime | destroy at the request; refuses uid 1 | destroy at the person's request (A, C); after a confirmed revocation, on day 4 unless they return; a `deleted` row kept five days, then removed | a destroyed database leaves point-in-time recovery, where dropped tables stay 1-10 days (A §2.1, C §8.1); a day-0 destroy on an ambiguous signal turns a false positive into a lost history (security R4, completeness H2) |
| backups | one file per database, removed with the account | non-owner copies kept 5 days | friends' kept 4 days, taken only while active | **C's**, for every friend not pending deletion, with the prune run first | deletion reaches the backups by retention, and a prune that runs first cannot be skipped by a failed dump (migration 11, completeness M5) |
| platform token | in the runtime, two uses | Mac only | in the runtime | runtime, Production only (A, C), and the Mac's Keychain for the scripts | a deletion cannot wait for a laptop; `.env.local` holds none (security R8) |
| sign-up | `/join`: terms accepted before OAuth; compare-and-set claim | separate invites table | `invited` users row; `SIGNUPS` flag; consent after sign-in | **A's `/join` and claim, C's flag**, a canary week first | terms before anything is stored; a one-variable way back; the first two-user run is a test account's (completeness H4) |
| dev | local files only | copies of production | uid of Rem → `lazyboy` on its own token; friends local | **C's**, with no schema step applied to production from dev | Rem keeps his workflow; dev cannot reach a friend or migrate Rem's database ahead of review (completeness H3) |
| Rem's migration | the token and three `meta` keys; plaintext kept a week; `account_id` read first | adds columns and payloads in fenced windows | the token only; `account_id` bound at first sign-in | **A's** | learns whether `account_id` exists before deploying code that needs it |
| phases | 0-5, phases 1-3 single-user | performance first, then multi-user | one large owner-only phase | **A's split, B's performance track first, C's gates and soak checks**, a canary week before the first friend | small reversible deploys with one rollback recipe (§13.5); the December deadline protected |

## 3. The plan on one page

```
browser ──► Vercel functions (iad1)
             ├─ app client ─────────► Turso lazyboy-app   users · user_tokens (AES-256-GCM) ·
             │                                            sync_state · app_meta · events
             ├─ forUser(uid) client ► Turso lazyboy       Rem's data: today's schema + plays.listened_ms
             │                        Turso lb-u-<uid>    one per friend (at most four), same schema
             └─ telemetry client ───► Zenbook sqld via the Funnel; one attempt, 4 s, never awaited
                                      api_log (+uid, +reason) · client_metrics (+uid) · usage_ledger
pingers:  Zenbook timer, even minutes, its own secret ─┐
          cron-job.org, odd minutes, CRON_SECRET_EXT ──┴► /api/cron/sync: one tick a minute;
          each due user claimed by lease, probed every 2 min while active, harvested on track changes
          (from lane 1904 to Phase 3: today's route with a 90-second guard, so a tick every 2 minutes)
alarm:    cron-job.org, hourly ────────────────────────► /api/cron/health: 500 → an e-mail to Rem
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
4. **Nothing reaches a friend until it has run on Rem alone, and then beside a canary account for a
   week.** Phases 1-3 change how the app is built, never who can reach it; each soaks on Rem's account
   before the next; Phase 4a's canary is the first two-user run, with exit checks that can fail, and
   the first friend arrives only after it and after every isolation test has failed against a planted
   bug and then passed (§13).
5. **Rem's data does not move.** `lazyboy` becomes his user database. Beyond what the app's own code
   writes, the only changes to it are a new derived column (`plays.listened_ms`, filled and verified
   once), four `meta` keys (`owner_uid`, `schema_version`, `min_reader`, `store_epoch`), his own 122
   plays replayed from the recorder (with his yes), and the token rows leaving for the app database a
   week after they are copied (§11).
6. **Every alarm reaches Rem.** A condition that needs a person (an isolation event, his capture
   stopping, a deletion clock, a friend's dead capture) turns the hourly health check red, which
   e-mails him (§7.10). A page nobody opens is not an alarm.

The order of work, detailed in §13:

| when | what | for whom |
|---|---|---|
| now, today if Rem approves | **Phase 0**: rotate `AUTH_SECRET`, set `SPOTIFY_OWNER_ID`, gate `logout`; the dashboard reads; copy `backstop.db` off the Zenbook; a dev sign-in that shows whether Spotify returns `account_id`; the refresh-token probe | today's exposures |
| Oct 15, 8 PM on | **STORE_MIGRATION lanes 1901-1911**, with §10.2's edits; 1910-1911 also ship the identity-first orphan predicate (P1) | Rem |
| after lane 1904 | the **interim second pinger** with a 90-second guard; the **122-play replay** | Rem |
| after lane 1911 | **P2**: `listened_ms` and the all-time accumulator. **P3**: monthly history segments, lazy days, fetch at mount; **must ship before mid-December** | Rem, single-user |
| after P3 | **Phase 1**: identity and isolation structure, the health check. **Phase 2**: the app database and encrypted tokens. **Phase 3**: the sync queue, the Liked fix, the full second pinger | Rem, single-user |
| after Phase 3 | **Phase 4a**: a canary account Rem controls, for a week; **Phase 4b**: the first friend | Rem + canary, then Rem + 1 |
| a week apart each | **P4** (Home payload patch, the open-tab fix, strip from segments) before the second friend; then **Phase 5**: friends two to four | up to 5 |

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
  status            TEXT NOT NULL,         -- the lifecycle, kept here and nowhere else (§12.3):
                                           -- provisioning | invited | active | needs_reconnect
                                           -- | removed | dormant | revoked | disabled | deleting | deleted
  status_at         INTEGER NOT NULL,      -- when status last changed: the 4-, 7- and 14-day clocks
  is_admin          INTEGER NOT NULL DEFAULT 0,
  session_epoch     INTEGER NOT NULL DEFAULT 0,
  terms_version     TEXT,                  -- privacy policy and end-user agreement accepted (§12.1)
  terms_accepted_at INTEGER,
  invited_at        INTEGER NOT NULL,
  claimed_at        INTEGER,
  last_sign_in      INTEGER                -- drives the 60-day dormant and twelve-month rules (§12.3)
);
-- one open invite per Spotify id, so a claim can never match two rows (A §3.1)
CREATE UNIQUE INDEX idx_users_open_invite ON users (spotify_id) WHERE status = 'invited';

CREATE TABLE user_tokens (
  uid        TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,      -- 'v1.' || base64url(iv ‖ ciphertext ‖ tag), §5.3
  expires_at INTEGER NOT NULL,   -- plaintext, so the cron sees who needs a refresh
  granted_at INTEGER NOT NULL    -- when the stored refresh token first appeared: Spotify's six-month
                                 -- clock (01e §2.1); moves only when a write carries a new one (§5.2)
);

CREATE TABLE sync_state (        -- 01c §5.2's due queue: scheduling only
  uid             TEXT PRIMARY KEY,
  state           TEXT NOT NULL, -- active | idle | backoff | paused
  next_probe_at   INTEGER NOT NULL,  -- unindexed at N ≤ 5: scanning five rows costs less than the
                                     -- index entry every release would write (scale 8)
  next_rescan_at  INTEGER,
  lease_owner     TEXT,
  lease_until     INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,          -- a code, never a message body
  last_ok_at      INTEGER,       -- capture health for the banner and the health check, from Phase 3
  last_harvest_at INTEGER,
  quota_day       TEXT,          -- the recently-played quota day rp_calls counts (§7.5)
  rp_calls        INTEGER NOT NULL DEFAULT 0,
  lag_p50_s       INTEGER,       -- F2's instrument, rolled up daily (§7.8)
  lag_p95_s       INTEGER
);

CREATE TABLE events (            -- what the server detected and a person must see (§6.5, §7.10)
  id    INTEGER PRIMARY KEY,
  at    INTEGER NOT NULL,
  uid   TEXT,                    -- the user the request or step ran as, if any
  code  TEXT NOT NULL,           -- owner-mismatch | cache-stamp | token-owner | decrypt | drift | ...
  alarmed INTEGER NOT NULL DEFAULT 0  -- set by the health check once it has turned red for it
);

CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
-- keys: schema_version, min_reader; cooldown:<bucket>; played_at_convention;
--       lock:spotify_refresh:<uid>; tick_at (the tick's compare-and-set stamp, §7.2);
--       daily_at and lock:daily (the daily chores, §7.11)
```

Choices in it: there is no `env` column on tokens, because dev runs its own app database (§5.5) and
production's never holds a dev grant (A, C). Invites are `users` rows in status `invited`, with the
database already provisioned, so one claim statement binds a sign-in to a row (A §10.2). A user's
lifecycle lives in `users.status` alone, written by one function with `status_at`, always as a
compare-and-set from the status it read, so a returning sign-in and the deletion job cannot both win
(whichever moves the row first makes the other's write land nothing). The cron's claim joins `users`
and leases only `active` users, so disabling, removing or deleting someone stops their sync at the
next tick (security R2). What the probe last saw (track, progress, when playback stopped)
stays in the user's own `meta` beside today's `player_last_active` and `rp_last_harvest`
(`db.ts:2364-2374`); `sync_state` holds times, counters and leases only. `events` is expected to stay
empty; a row is a bug report the health check e-mails (§7.10).

**Every client comes from one factory.** The app client, each user client and the telemetry client
are built by one function that passes `makeStoreFetch` (`src/lib/store-fetch.ts`): the gzip pin, the
retry ladder and the Request rebuilt per attempt are what two production incidents bought (GOTCHAS
"Never let the store compress with brotli", "The store fetch must rebuild its Request per attempt"),
and a per-user client built with a bare `createClient` would lose all three silently. URLs use the
`https://` form, since `@libsql/client` maps `libsql://` to WebSockets, where the fetch override does
not apply (STORE_MIGRATION §3). None of the designs names this; it is cheap to get right once and
easy to get wrong N times.

**Names and roles come from `users`, every time** (migration 1). The per-process map of user clients
is keyed by `db_name`, and every identity read (§5.1) and every claim (§7.2) already returns the
user's current `db_name`; an entry under a different name is rebuilt before use, so a restore that
moves a user to a new database reaches warm instances at their next request, at no extra round trip.
Nothing keys a role on the string `lazyboy`: the backup's retention, the deletion job's refusal and the
usage read follow `is_admin` and `db_name` on the row.

### 4.3 Every table and `meta` key

01a §2-3's census, with where each item goes:

| today | where it goes | how it is tied to one user |
|---|---|---|
| `tracks`, `plays`, `contexts`, `playlists`, `playlist_tracks`, `saved_tracks` | the user's database | by being in it. Per-user `contexts` also ends the shared negative cache: one user's 403 no longer hides a name from another for 30 days (01a D25) |
| `meta`: `last_sync`, `write_seq`, `library_seq`, `slow_seq_pub`, `home_payload`, `alltime_stats`, `alltime_at`, `unique_song_count`, `contexts_full_check_at`, `playlists_synced_at`, `library_synced_at`, `library_scan_attempt_at`, `saved_synced_at`, `liked_total`, `liked_top_added_at`, `plsnap:*`, `player_last_active`, `rp_last_harvest`, `clean_backup_pref`, `lock:clean:*` | the user's database, unchanged | by being in it. The version markers become per user without a line of code, which stops one user's plays from invalidating every other user's caches (01a D21) |
| `meta.me_id` | the user's database | written only by that user's own library sync with that user's own token; used by the owned-playlist filter (`db.ts:2297, 2310`) and the page's `isMine`; never read for sign-in again |
| `meta.user_tz_offset`, `HOME_TZ` (`db.ts:1270`) | `user_tz` (an IANA zone) in the user's database | written by `/api/sync` only when it changes; the Home payload buckets days in the user's zone, with the DST check against that zone (C §3.3) |
| `meta.spotify_tokens` | `user_tokens`, encrypted | the uid key and the associated data (§5.3); Phase 2's runtime copies it on its first tick, so the key never leaves Vercel; the plaintext row stays in `lazyboy` for a week, then goes (§11.4) |
| `meta.spotify_tokens_dev` | dev's own app database | not in production at all |
| `meta.lock:spotify_refresh` | `app_meta`, `lock:spotify_refresh:<uid>` | the uid in the name |
| `meta.spotify_cooldown_until` | `app_meta`, `cooldown:<bucket>` | global by meaning: Spotify's rate limit is per app and its quota per developer account (01f §1.4); split by bucket so a recently-played ban does not stop the player probe (01c S4) |
| `meta.played_at_convention` | `app_meta` | global by meaning; computed from the admin's plays by the daily route |
| new: `owner_uid`, `schema_version`, `min_reader`, `store_epoch` | the user's database | written at provisioning, by the migrate script and by a restore, never by request code except production's additive steps (§4.5, §12.5) |
| new: `probe`, `seg_seq:<YYYY-MM>` | the user's database | the probe's last track and progress (§7.3); each month's segment version (§9.1) |
| `meta.last_sync_added`, `meta.pltracks_at:*` | dropped by the Phase 2 migration | dead: no reader (01a §3) |
| `api_log`, `client_metrics` | telemetry, `+ user_id`; `api_log` `+ reason` | the column; deletion deletes by it (§12.3) |
| `usage_ledger` | telemetry, unchanged | global; per-user store usage comes from Turso's per-database numbers |

### 4.4 The user key

A random opaque uid, 12 base32 characters (60 bits), names the user everywhere the app can see it:
the session claim, `forUser`, cache keys, ETags, browser storage, telemetry rows and a friend's
database name. It stays out of URL paths: the server takes the user from the session (§9.1). Spotify's `account_id` is only the link used at sign-in (01e §5.1); Spotify's
mutable `id` is only what an invite matches once (§12.1).

The design question was integer or random (§2.3). The case for random is the failure it removes: if
the app database is ever restored from a backup, an `AUTOINCREMENT` integer can be issued again to a
newcomer, who would then match a departed user's cache entries for up to a day and, under C's
derived names, their database. A random uid cannot collide, so the owner stamps of §6 compare against
a value that is unique for good. It carries no personal data, so it can sit raw in an ETag, on the
session or in a storage key where page scripts can read it, which removes A's need for an HMAC secret
(`HK_SECRET`) to make an opaque browser key. Version counters inside a database are not unique for
good, since a restore winds them back; `store_epoch` (§4.5) covers them. 01a §8.4's case for an integer (bytes per play) does not apply: no
per-play row carries the key in this model.

### 4.5 Schema versions in place of `init()`

Today `init()` runs one `executeMultiple`, four `PRAGMA table_info` reads and three `CREATE INDEX`
statements on every cold process, eight serial round trips, with no notion of a version
(`db.ts:153-297`; 28 cold starts on Oct 14, 01c §2.1). Against N databases that would be eight round
trips per database a process touches. The plan:

1. **Code declares `USER_SCHEMA` and `APP_SCHEMA`**, each a list of steps marked additive or
   rebuild, and its own version.
2. **Every database's `meta` holds four keys**: `owner_uid`; `schema_version`; `min_reader`, the
   oldest code version that can read it (an additive step leaves it, a rebuild raises it,
   completeness H3); and `store_epoch`, a random value written at provisioning and by every restore,
   which goes into every version token so a restored database cannot re-issue a cached version
   (§9.1, §12.5).
3. **The first open of a database for a uid in a process** reads those four keys in one statement,
   sent in the same batch as the request's first read, whose result is used only if the owner matches
   (scale 10). The verdict is cached per `(uid, db_name)`, so a second uid mapped to an already-checked
   database is checked again (security R15). Then:
   - a wrong `owner_uid` refuses the database and records an `isolation` event (§6.5);
   - code older than `min_reader` refuses that user ("updating"); a database ahead of the code by
     additive steps opens, so a rolled-back build keeps working;
   - a database behind by additive steps only (a nullable column, an index) is brought up to date the
     way `init()` does today, **by production code alone** (`VERCEL_ENV === "production"`) and by
     `scripts/migrate.mjs`. A dev server, a test pointed at a remote URL or any other script refuses
     and says the database is waiting for the production deploy, so a branch's schema never reaches
     Rem's database before review (completeness H3; dev's own databases are local files it may
     migrate);
   - a database behind by a rebuild refuses that user until the migrate script runs; nobody else
     notices (A §3.5, B §4.6).
4. **Provisioning** creates a new user database at the current version in one `executeMultiple`, with
   the four keys, at invite time (§12.1), so sign-in never waits on it.
5. **`scripts/migrate.mjs`**, run from the Mac, applies rebuild steps one database at a time: set that
   user's `sync_state` to `paused`, take a restore point (Turso point-in-time, plus a dump), apply,
   verify, bump `schema_version` and `min_reader`, resume (B §4.6). At six databases this takes
   minutes.
6. **Deploy order** stays what it is: an additive step first (older code opens the database because
   `min_reader` did not move), then the code that needs it, then any destructive step. A rebuild
   raises `min_reader`, so the previous build refuses that database instead of misreading it, and the
   phase's rollback cell says so (§13.1).

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
  that `account_id` signs in if `active`, `needs_reconnect`, `dormant` or `revoked` (the last three
  return to `active`: a fresh consent is what they were waiting for), refreshing `spotify_id` if it
  changed; `disabled` is refused with "ask Rem"; `deleting` and `deleted` are refused with the date
  the account was deleted and "ask Rem for a new invite" (completeness H2). Otherwise the sign-in must
  claim an invite, which needs the terms cookie of §12.1:
  ```sql
  UPDATE users SET account_id = :aid, status = 'active', status_at = :now, claimed_at = :now,
         last_sign_in = :now, terms_version = :tv, terms_accepted_at = :now
  WHERE status = 'invited' AND spotify_id = :sid AND account_id IS NULL
  RETURNING uid
  ```
  One row back signs in as that uid; none is AccessDenied, worded "this app is invite-only".
  `SIGNUPS=owner` refuses everyone but the admin row whatever the rows say: Phases 1-3 run with it,
  and it is Phase 4's one-variable way back (C §4.1). `userinfo.ts` today maps every non-2xx from
  `/v1/me` to "not registered" (`src/lib/spotify/userinfo.ts:33-36`), so a passing 429 would tell an
  invited friend they are not allowed; it narrows to a 403 (C §10.1).
- **The jwt callback's sign-in branch** writes the encrypted token row for that uid (§5.2) and puts
  `uid`, `ep` (the session epoch) and `auth_time` (now) on the cookie from the `users` row, never from
  the incoming cookie or the profile alone, which is what keeps session fixation out (01e §5.6).
  `auth_time` is written here and nowhere else (security R5). The two paths that park Spotify tokens
  inside the cookie when the store write fails (`auth.ts:367-374`, `388-405`) go: a token in a cookie is
  bound to no user row and invisible to the cron, so a sign-in that cannot write its row fails visibly
  and is retried (01e A18).
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
  Primary-key probes only, ~4 rows read [estimate]. It has three outcomes (security R6, migration 5):
  - **allowed**: the session gets its uid;
  - **refused**: the callback returns `null`, which signs the request out, when the cookie has no
    `uid` (every cookie minted before Phase 1, which closes 01e F1 for good), the uid is unknown, the
    status is not `active` or `needs_reconnect`, `ep` is not `session_epoch`, `auth_time` is more than
    30 days old, or `SIGNUPS=owner` is set and the row is not the admin's (from Phase 2, so one
    variable and a redeploy freeze every friend already signed in, completeness M3);
  - **unavailable**: the statement threw or timed out. The callback returns the cookie unchanged, as
    today's does on purpose (`auth.ts:379-387`: "a Turso hiccup must NOT crash the request into a
    Configuration error / forced logout"), but no uid is set on the session. `requireUser()` then
    answers a retryable error (503 for a route, an error page with a retry for a page, `{ ok: false,
    retry: true }` for an action), never a redirect to `/login` and never a 401, so the browser keeps
    its stores (§6.2 layer 6). A cookie that an epoch bump revoked therefore stays refused while the
    app database is down, because nothing reads user data without a uid.

  One round trip, as today's token read is (01e §5.1), and it also carries what Home's chrome reads
  separately today (B §5). Until Phase 3 writes `sync_state`, the banner keeps reading capture health
  from `lazyboy.meta` as it does today (migration 16).
- **`requireUser()`** (server-only) wraps `auth()` and returns the branded uid with `{ admin,
  canCallSpotify }`, or refuses: a redirect for a page, a 401 for a route, `{ ok: false }` for an
  action (01b S2), or the retryable answer above. It is the only source of a uid for an entry point,
  and it merges the three gate strengths 01b §2.4 found into one rule.
- **The uid goes on the session** (security R15). `auth()` returns what the session callback returns
  (`next-auth` beta.31 `lib/index.js:22-31`), and handing the uid over through a `cache()` box may be a
  pass-through in route handlers (01b §3.3, unverified), which would refuse every route. The uid is not
  a credential, the `(app)` layout renders it into the page for the browser's storage keys anyway (§6.2
  layer 6), and `GET /api/auth/session` serves it only to its own holder. Tokens stay off the session,
  as docs/SECURITY.md "Tokens never reach the browser" requires.
- **Home's gate runs before its reads**: the payload read needs the uid, so Home pays one sequential
  round trip it does not pay today (~15 ms at R1's target, I$), plus, in a cold process, a TLS
  handshake to the app database's host; the owner check rides the payload read's batch (§4.5).
  Decoding the cookie separately to start the read in parallel (B §5, 01b S2) is held in reserve for a
  badly missed R1; it is a second way to mint a user handle.

### 5.2 Tokens per user

The token core (`refreshAccessToken`, `coordinatedRefresh`, `waitForFreshToken`, `clearTokensIfStale`,
`getValidAccessToken`, the in-flight map) leaves `auth.ts` for a module with no `next-auth` import,
so the simulated environment can run it; today no test can load `auth.ts` (01e §2.7, A21).

| today | plan | why |
|---|---|---|
| `inflightRefresh`, one promise per instance (`auth.ts:188-196`) | `Map<Uid, Promise<Tokens>>` | shared, user B's concurrent refresh joins user A's and receives A's tokens: the one change in the census that leaks silently (01e A2) |
| `acquireLock("spotify_refresh")` (`auth.ts:212`) | `lock:spotify_refresh:<uid>` in `app_meta` | a shared lease makes B wait up to ~32 s for a token nobody is refreshing (01e A4) |
| `get/set/clearSpotifyTokens()` on `meta` (`db.ts:2514-2531`) | `getTokens(uid)`, `setTokens(uid, t)`, `clearTokens(uid)` on `user_tokens` | 01e A1, A5 |
| a sign-in's write takes no lock and any write is unconditional (`auth.ts:352-362`) | a sign-in writes `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM users WHERE uid = :uid AND status IN ('active', 'needs_reconnect', 'dormant', 'revoked'))`; a refresh writes `UPDATE … WHERE uid = :uid AND blob = :blob_it_read` and, on zero rows, re-reads | a write landing after the deletion job's first step stores nothing (security R3); a refresh that read the old grant before a sign-in cannot overwrite the new one (security R4) |
| – | `granted_at` moves only when the refresh token being written differs from the stored one | Spotify's six-month clock runs from the refresh token's grant (01e §2.1), so the expiry test of §5.4 needs the token's age, not the last sign-in's; it holds whether or not a re-consent mints a new refresh token (Phase 0 probes which, §13.1) |
| `getValidAccessToken()`, `refreshingToken()`, the library task's getter (`auth.ts:278-289`, `actions.ts:46-57`, `playlists-sync.ts:61-65`) | each takes the uid; a background task binds it at creation | 01e A16 |
| `clearTokensIfStale` (`auth.ts:170-181`) | the same rule within one user's row | the fresh-token veto carries over unchanged (01e §2.5) |
| a decrypted token is a bare object | `{ uid, accessToken, refreshToken, expiresAt }`; `setTokens` asserts `t.uid === uid`; the Spotify client asserts the token's uid is the caller's and tags every call with it in `api_log` | a future refactor that shares a promise or cache across users fails an assertion on the first mixed call instead of acting on someone else's account (A §2.5); one compare per call |

Known answers come first (01e §5.2, plus the reviews): two users refreshing concurrently in one
process each end with their own token, one token-endpoint call each; A holding the lock does not
delay B; `invalid_grant` for A touches A's row only; A's ciphertext in B's row fails to decrypt; a
cookie with no uid, an unknown uid, a disabled user, a stale epoch or a 31-day-old `auth_time` yields
no session; the identity read throwing yields no uid, no redirect and the cookie unchanged; no row
means no Spotify call; a refresh finishing after a sign-in leaves the sign-in's grant; a refresh
finishing after the deletion job's first step stores nothing. Write load: about 24 refreshes per
active user a day, each a lock acquire, a row write and a release, ~72 rows per user a day [estimate,
01e §5.2].

### 5.3 Encryption at rest

01e §5.3's scheme, adopted as written by all three designs:

- AES-256-GCM from `node:crypto`, a random 12-byte IV per write, stored as
  `v1.<base64url(iv ‖ ciphertext ‖ tag)>` where `v1` names the key; both tokens in one blob.
- Associated data `lazyboy:tokens:v1:<uid>`: a ciphertext copied into another user's row fails to
  authenticate, so write access to the app database without the key cannot graft a victim's grant
  onto the attacker's account. A checked this with the scheme itself (A §17).
- Plaintext columns: `uid`, `expires_at`, `granted_at`.
- Keys in `TOKEN_KEYS="v2:<base64 32 bytes>,v1:<…>"`, a Vercel Secret ("write-only after saving"),
  Production only; the first key writes, reads pick by prefix. A new key is generated in a pipe
  straight into `vercel env add`, never written to a file, and a copy goes to Rem's password manager
  as the backup. Dev has its own key and its own app database, so the production key never sits in
  `.env.local`.
- **Everything that needs the production key runs in the runtime** (security R9). Phase 2's first
  tick encrypts Rem's plaintext row into `user_tokens` (§11.4); the daily chores re-encrypt any blob
  not under the first key; a rollback flag has the runtime write the plaintext row back. No script on
  the Mac ever holds the key.
- **Rotation only on a suspected compromise** (decision 23): put a new key first and redeploy; the
  daily chore re-encrypts every row; take an app-database backup right after, so no backup needs the
  old key (completeness L2); then drop the old key from Vercel and from the password manager, and
  delete the production deployments built with it (security R1, R9).
- **A blob that fails to decrypt is the deployment's fault, not the user's** (migration 9). It is
  logged as a `decrypt` event with the uid, never the blob; that user's step is skipped or that request
  fails with the retryable answer of §5.1; no user state is written, so the user stays `active`. Two or
  more users, or the admin, failing to decrypt in one tick answers the Zenbook caller 503 and touches
  no rows. At cold start the runtime decrypts one sentinel blob per configured key (kept in `app_meta`)
  and refuses to serve if any fails, so a wrong, truncated or missing key breaks the deploy loudly
  instead of stranding users. Known answer: a deploy with a wrong key leaves every user `active`, and
  capture resumes on the next correct deploy with no sign-in.
- **Losing the key** costs every user one sign-in, and closed-app capture stops for everyone until
  they sign in; for a friend who does not open the app that day, that is every play past their last
  50 (completeness L2).
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
  browser's stores and cookie, and capture continues; *sign out everywhere* bumps `session_epoch`;
  *disconnect and delete* offers a download of the user's history first (the segments the browser
  already holds, §12.3), asks for the account name typed out and a sign-in within the last 10 minutes
  by `auth_time` (otherwise a fresh Spotify sign-in first, security R11), runs the deletion job
  (§12.3), and tells the user to remove Lazy Boy at spotify.com/account/apps, since the app cannot
  revoke a grant. Today's `logout` deletes the only token row, which stops capture and signs out every
  device (`actions.ts:63-69`).
- **A session lasts 30 days from its sign-in, enforced by `auth_time`** (security R5). The cookie's
  own expiry is no bound: Auth.js re-encodes the JWT with a fresh expiry on every session read
  (`@auth/core` 0.41.2 `lib/actions/session.js:33-50`, `jwt.js:58`), and `GET /api/auth/session`
  delivers that cookie through this app's route (`src/app/api/auth/[...nextauth]/route.ts:16-18`).
  The app never calls that route (01e §1.4), so an ordinary user signs in about monthly either way;
  `auth_time` stops anyone holding a copied cookie from renewing it for good. Every sign-in passes
  Spotify's consent screen (`show_dialog`, `auth.ts:322`). The epoch is the server-side kill switch for
  one user; `AUTH_SECRET` rotation is the everyone-out switch, used in Phase 0 and again in Phase 1's
  deploy, each followed a day later by deleting the production deployments built before it, so no
  rollback can bring the old secret back (security R1, §13.5).
- **`invalid_grant`** for a friend (security R4, completeness H2; decision 21). Spotify answers it for
  refresh tokens that are "expired, revoked, or otherwise invalid" (01e §5.7), and what else
  invalidates a grant is undocumented (01e §8), so the app treats it as a question, not a verdict:
  1. Stop at once: no Spotify call for that user, status `needs_reconnect`, data and blob kept.
  2. Confirm: one more refresh at least 10 minutes later. The claim never leases a `needs_reconnect`
     user (T6), so the tick makes this call itself after its steps: one token-endpoint call for at most
     one such user whose confirmation is due, and no data calls. If it succeeds, back to `active`.
  3. If two or more users, or the admin, got `invalid_grant` within 24 hours, it is an app-wide
     event: everyone stays `needs_reconnect` with their data, nothing is scheduled for deletion, and
     the health check reports it (§7.10).
  4. Otherwise, a refresh token at least ~170 days old (`granted_at`) has expired: the user stays
     `needs_reconnect`, the data stays, and their next visit asks them to reconnect.
  5. A younger one most likely means the person removed the app at Spotify, which the Developer Terms
     treat as a disconnect with five days to delete (01e §5.7, 01f §1.5). Status `revoked`: no calls,
     no backups (§12.4), an alarm to Rem, and the deletion job destroys the database on day 4 after
     the first failure unless the person signs in first, which re-consents and returns them to
     `active` with nothing lost but the gap.
  The admin is never `revoked` or deleted automatically: his `invalid_grant` is `needs_reconnect` and
  an alarm. Why day 4 and not day 0, as the Oct 14 plan had: a false positive on day 0 destroys a
  friend's history, which Turso's Free plan cannot undelete, while day 4 still deletes inside the five
  days. The cost: under the strictest reading of "in your possession or control", Turso's paid-plan
  undelete keeps a destroyed database restorable for five more days (§12.3).
- A 401 on a token the store believes fresh zeroes that user's `expires_at`, so the next call
  refreshes and finds a revocation within seconds rather than within the hour (01e §5.7).
- **A dead grant and the pages**: a `needs_reconnect` session keeps today's behaviour, the page gates
  send it to `/login` (`auth.ts:406-409`), and the six history actions and two search routes that
  check only for a session today move onto `requireUser()`, which applies the same rule (C §15
  decision 20). 01b §2.4 recommends a read-only mode instead; one sign-in restores both reading and
  capture, so the plan keeps the redirect. Rem's call (§18).

### 5.5 Secrets, by environment

| secret | Production | Preview | dev (`.env.local`) | what it unlocks once friends exist |
|---|---|---|---|---|
| `AUTH_SECRET` | rotated in Phase 0 and again in Phase 1; production deployments built before each rotation deleted a day later | its own value (C M0a) | its own | minting a cookie that names any uid |
| `TOKEN_KEYS` | Secret, generated in a pipe straight into Vercel; a backup copy in Rem's password manager | none | a dev key | decrypting every grant |
| Turso group token, read-write | Secret, minted in Phase 2 after the old `lazyboy` token is invalidated | none | none | every user's data (group tokens "cannot be revoked individually", B §19) |
| Turso group token, read-only | – | – | – (the Zenbook's backup job, under an account the Funnel-facing services cannot read, §13.2) | reading every user's data |
| `lazyboy` database token | the cutover's (STORE_MIGRATION §8 step 8), invalidated in Phase 2 | – | a fresh one minted after that, checked once to get a 401 from a throwaway database in the same group (security R8) | Rem's data. Invalidation is group-wide (C §8.2), so any rotation retires every Turso token at once and they are re-minted together |
| `TURSO_PLATFORM_TOKEN` | runtime, used by two functions only: the deletion job's destroy and the daily usage read (§12.3) | none | none: it lives in the macOS Keychain, read by `invite.mjs`, `user.mjs`, `migrate.mjs` and `setup` only (security R8) | creating and destroying databases, minting tokens |
| `CRON_SECRET` (Zenbook) and `CRON_SECRET_EXT` (cron-job.org) | both | none | the Zenbook's | `CRON_SECRET` opens every cron route; `CRON_SECRET_EXT` opens `/api/cron/sync` and `/api/cron/health` only, never the daily route that runs deletions, and its replies carry no per-user data (security R14) |
| `SPOTIFY_CLIENT_SECRET` | unchanged | unchanged | unchanged | refreshing any refresh token it finds |

Every Production secret is already Vercel's `sensitive` type, so `vercel env pull` returns none of
them (read by security §2 on Oct 15; that answers the open check on `TURSO_AUTH_TOKEN`). Deployment
Protection covers every deployment URL today (`all_except_custom_domains`) and stays at Standard or
stricter; on Pro, Skew Protection would route requests to older deployments for a day or more after
each deploy (Vercel's skew-protection page, quoted in security R1), so it stays off or gets a
threshold at every phase deploy and rotation.

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
   telemetry client. `forUser` gets its client from a per-process map keyed by `db_name` and checked
   against the `db_name` each identity read or claim returns (§4.2), through one URL template; an
   unknown uid throws and nothing ever falls back to a default URL (C §2.2). The first open for each
   `(uid, db_name)` pair checks the database's `owner_uid` and refuses a mismatch (§4.5). *Stops M9
   and the residue of M1: no module-level function is left that could run against "the" database.*
4. **Caches, process state and background work** (A §2.4):
   - `userCache` in `src/lib/user-cache.ts` is the only caller of `unstable_cache`. It builds
     `unstable_cache(fn, ["u", uid, storeEpoch, ...keyParts], { revalidate })` and calls it as
     `fn(uid, ...args)`, so the uid separates entries twice over and a closure-captured id has no way
     in; the store epoch (§4.5) keeps a restored database from meeting entries cached under versions it
     re-issues. It stores `{ o: uid, v: value }` and checks `o` on every return; a mismatch records an
     `isolation` event and returns the right user's data uncached. That check is what turns a key
     mistake into a slow request in production, including the case no unit test sees: a Preview build
     writing entries under keys production reads, which 01b §8 could not rule out. The seven wrappers
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
     | new: the now-playing memo and the player-action bucket | `/api/now-playing`, the player actions | `Map<Uid, …>`: the last answer for ~5 s, and a token bucket per user (security R13, §6.6) |

   - Background work receives everything it may touch as arguments: the cron's per-user step gets the
     `Uid`, its `UserStore`, a token getter bound to that uid and its deadline (§7.2). *Stops M4, M5,
     M8.*
5. **Spotify credentials that carry their owner** (§5.2-5.3): the associated data binds a ciphertext
   to its row, the owner field binds a token object to its user, locks and in-flight maps are keyed
   by uid, writes are conditional on a live owner, and the profile fetch at sign-in is never cached.
   *Stops M6, and M12 with §12.1.*
6. **The browser** (A §2.6, with the random uid of §4.4 in place of A's HMAC):
   - ETags become `"lib-<shape>-<uid>-<epoch>-<version>-<day>"` and
     `"hist-<shape>-<uid>-<epoch>-<version>-<day>"` (today `src/app/api/search/library/route.ts:39`,
     `history/route.ts:26`). Per-user counters are small integers that collide across users (01a §5),
     so without the uid a shared browser profile could get a 304 for the previous user's body.
   - Search bodies are served `private, no-store` and their URLs carry no uid (§9.1): nothing of a
     user's history sits in the HTTP cache, where no page script can evict it, after they sign out
     of a shared computer (security R12). The server builds every body from the session's database.
   - Every payload carries `u: uid`, and the client drops any body, from the network or IndexedDB,
     whose `u` is not the page's.
   - Storage keys are prefixed with the uid: `lb-days`, `lb-nowplaying`, `clean:active`, phase E's
     IndexedDB store, and the `lb-nowplaying-leader` Web Lock and BroadcastChannel names, so two
     users' tabs in one browser neither read nor relay each other's state (01b §3.6).
   - Sign-out clears that storage in the browser before the sign-out form submits (sign-out is a
     server action, 01b §7 item 1, so its response cannot carry a `Clear-Site-Data` header; the
     client-side clear is the mechanism). A 401 from the app's own routes that carries the
     signed-out marker clears it too (B §6), so a device whose session died elsewhere (sign out
     everywhere, a deletion) forgets on its next request. A 5xx, a retryable refusal or a network
     error never clears anything, so a store blip does not cost a repeat visit its cache (migration 5).
     *Stops M7.*
7. **The shared remainder.** `app-db.ts` holds every statement on the app database; the handful that
   take no uid (sign-in's lookup and claim, the cron's claim, the admin list, the global keys) are
   cross-user by design and each has a test (T6). `/usage` and any admin page require `is_admin`,
   set by the migration for Rem and never derived from `me_id` (01b E2); for any user but the admin,
   `/usage` shows telemetry aggregated by endpoint template, never raw paths with playlist ids or the
   `handoff` beacon's track ids (security R15). Telemetry rows gain the uid; `handoff` beacons send a
   track id instead of "artist — title" (01a §10); `/api/metrics` takes the uid from the session, never
   the body, and refuses reserved event names such as `isolation` (security R7). Scripts take a
   required `--user`, and the backstop replay refuses anyone but the admin, since the recorder
   captures only Rem (01c §5.7). Preview gets no store variables; dev reaches only Rem's database and
   local files, cannot apply a schema step to Rem's database (§4.5), and holds no platform token
   (§5.5). *Stops M10 and M11.*

### 6.3 Every class against the layers

| class | prevents | detects |
|---|---|---|
| M1 a statement forgets the user | a database per user | T1: an ordered logical dump of user B's database unchanged by every call made as A |
| M2 an id from request input | the branded `Uid` | static S2 (no casts); T3: A's identifiers in B's request return B's data or a 404 |
| M3 a read before the gate | a read needs a `Uid` | T3: every entry point with no session refuses before any user database opens; S8: no nested async server component reads user data or calls Spotify |
| M4 a cache key without the user | `userCache` | T2 with equal counters; the owner stamp at runtime |
| M5 shared process state | keyed maps; the deleted cache | static S4 (compiler API); T4 (two users in one invocation) |
| M6 the wrong token | per-user rows, locks and maps; conditional writes | the token-owner assertion at runtime; T5 (Spotify scripted per bearer) |
| M7 browser state across users | uid in keys, ETags and bodies; no-store bodies | T7 |
| M8 background work mixing users | a per-user step with explicit arguments | T4 |
| M9 a wrong user-to-database mapping | random uids; names from `users`, checked per request | the owner check per `(uid, db_name)`; T8 |
| M10 shared tables and operator views | `app-db.ts`'s fixed list; the admin flag; aggregated views | T6; T3 for `/usage` as a non-admin |
| M11 scripts and dev on production | required `--user`; dev's credentials and its refusal to apply schema steps; Preview without store variables | T10; T8's schema cases |
| M12 a sign-in bound to the wrong account | `account_id` link, compare-and-set claim, uncached profile read | T9 |
| M13 a shared quota | server-held limits (§6.6), the fair-share brake (§7.5), plan choices (§15) | per-database usage and per-user `api_log` on `/usage`; the health check's pace alarm (§7.10) |

### 6.4 The tests

They run in the existing simulated environment (`npm test`: vitest against throwaway SQLite files and
a scripted `fetch`, `tests/setup.ts`), touching no store, no Spotify and no Vercel. Each is written
red first, and each is shown failing against a planted bug before it is trusted (B §6): a test that
has never failed proves nothing. The planted bugs stay in the harness as a permanent self-test (an
unkeyed `unstable_cache`, a shared in-flight map, a URL template that ignores the uid, the cache stub
reverted to a pass-through): each run asserts the suite still reports every one, so the suite cannot
quietly lose its teeth (completeness M2).

**What the harness gains** (A §5.1): three database files per test file (`app.db`, `u1.db`, `u2.db`),
created by the production provisioning code so provisioning is under test too, with the journal mode
pinned; a two-user seed with deliberate collisions (the same track at the same `played_at`, D17; the
same playlist id with different members, D14; the same context URI named for one user and
negative-cached for the other, D25; interleaved timelines, D18; equal `write_seq`, `library_seq` and
`slow_seq_pub`), with a marker string (`A-only-…`, `B-only-…`) in every text column; a faithful
`unstable_cache` stub keyed the way Next 16.2.6 keys (`fn.toString()`, the key parts,
`JSON.stringify(args)`) in place of today's pass-through (`tests/stubs/next-cache.ts:4-10`), which can
see no collision at all; a scripted Spotify that answers per bearer token and logs which bearer each
call carried; a session switch (the `vi.mock("@/lib/auth")` pattern of
`tests/now-playing-route.test.ts:13-16`); an open counter per uid; and an ordered logical dump of every
table of the other user's database before and after, in place of a file hash, which WAL would fool
(completeness M2).

| id | runs | must hold |
|---|---|---|
| T1 | every method of `UserStore`, from a fixture registry with one entry per method (a method with no fixture fails the suite), as A then as B | each write method changes A's content and each read returns an A marker (the positive control); the other user's dump unchanged; no other-user marker in any return value |
| T2 | the seven cached reads as A then B with equal counters; then a forged entry under B's key stamped with A | B never sees an A marker; the forged entry is refused, B's data served uncached, an `isolation` event recorded |
| T3 | every page, layout, `"use server"` export and route handler, found by globbing `src/app`, each with an entry in a fixture registry that names its identifier inputs (one without fails the suite): with no session; as B; as B with A's identifiers in the input (playlist id, task id); `/usage` as non-admin B | refused with zero user-database opens; no A marker anywhere and A's dump unchanged, every Spotify call on B's bearer; B's data or a 404, never A's; refused or aggregated. Exempt by a named list: `/`, `/login`, `/join`, `/api/build`, `/api/auth/*`, `/api/cron/*` (T13 covers those). `/playlists/[id]`'s Spotify fetch and `storePlaylistTracks` write move from the nested `Tracks` component into the gated page body (`src/app/(app)/playlists/[id]/page.tsx:141-143, 152-200`) so T3 reaches them (completeness M1) |
| T4 | one cron tick with A and B due, both tokens expired; then A failing three ways (403 "not registered", `invalid_grant`, a hang past the deadline); then library syncs for A and B within 60 s on one instance | each database gets only its own plays; one refresh per user; A's lock does not delay B; B's outcome `ok` whatever A does; the reply is 200 with both outcomes, within 20 s; each user's own playlist list stored (the `playlistsCache` trap) |
| T5 | the token core and the identity read | §5.2's known answers, including: the identity read throwing (no uid, no redirect, no 401, cookie unchanged, storage kept); a 31-day-old `auth_time` refused (which also pins the twelve-month rule's reliance on monthly sign-ins, completeness L3); `SIGNUPS=owner` refusing a friend's live cookie; a decrypt failure writing no user state; a sentinel failure refusing to serve |
| T6 | the app-database functions that take no uid | a claim never returns a leased user, the same user to two concurrent claims, or a user whose status is not `active` (`disabled`, `deleting`, `needs_reconnect`, `revoked`, `dormant`, a non-admin under `SIGNUPS=owner`); an invite is claimed once; only listed global keys are accepted |
| T7 | the search routes and the client storage module (behind a storage interface, as STORE_MIGRATION §10 plans) | equal versions give A and B different ETags; B with A's ETag gets 200 and B's body; bodies are `private, no-store`; a stored body whose `u` is not the page's is discarded; sign-out empties the store; a 503 or a network error leaves it |
| T8 | a users row pointing B at A's database file, after A was opened in the same process; a database at each schema state | B's open refuses before any read or write, recorded, A's dump unchanged; one additive step ahead opens; one rebuild ahead (`min_reader` above the code) refuses; behind by an additive step, a non-production process refuses to apply it |
| T9 | sign-in | an invite claimed once; a profile without `account_id` refused; a returning user found by `account_id` after their `id` changed; Y cannot claim X's invite; a `deleted` user gets the deletion message |
| T10 | every script | exits non-zero without `--user`; with `--user B` touches only B's file; the backstop replay refuses anyone but the admin; the import scripts set the dirty mark and bump the months they wrote (§8.3, §9.1) |
| T11 | the deletion job for B, including a token refresh for B finishing while it runs, then the daily sweep | B's next request has no session; B's token, queue, lock and telemetry rows are gone and stay gone; B's database destroyed (the Platform API mocked); A's dump unchanged; a second run is a no-op; the job refuses the admin and any name that is not `lb-u-<uid>` with a matching `owner_uid` |
| T12 | the Phase 2 migration on a local copy of a nightly backup, by hand (it needs Rem's data), with a synthetic token row planted first, since backups carry none (completeness L1) | §11.4 step 5's checks |
| T13 | every cron route with no secret, a wrong one, and the other caller's | refused where the caller has no business; `CRON_SECRET_EXT` opens `/api/cron/sync` and `/api/cron/health` only; its replies carry no per-user data; a burst of ticks inside the guard window does one tick's work (security R14) |
| T14 | `invalid_grant` for two users inside an hour; one user's, confirmed 10 minutes later; a refresh racing a sign-in | no deletion and an app-wide event; `revoked` with day 4 scheduled; the sign-in's tokens and `granted_at` survive (security R4) |
| T15 | `/api/metrics` posting an `isolation` event; an owner mismatch while telemetry is down | the client's event refused; the server's event stored in `lazyboy-app` and seen by the health check (security R7) |
| T16 | P2's counters: two concurrent harvests with overlapping batches; a re-sent batch; a play inserted by a writer that leaves `listened_ms` NULL | the totals equal `allTimeStats` over the stored rows after each; the NULL is filled and counted at the next pass (migration 3, 4) |
| T17 | P4's patch over a scripted day with every non-append event: an out-of-order insert, a context name resolving inside the 16 days, an orphan flip, a time-zone change, a duration change; and a lost compare-and-set | patched payload = rebuilt payload after each; the lost race marks the payload dirty (completeness M6, migration 3) |
| T18 | a freshly provisioned user with no plays; an empty install from `npm run setup` | Home renders; the app boots and signs its owner in (completeness M4, M7) |

Static checks, also in `npm test` (A §5.3): S1 `unstable_cache(` appears only in `user-cache.ts`; S2
no `as Uid` outside `identity.ts`, whose minting helper only the gate, the claim and the script
helper import; S3 no per-user function exported from `db.ts` at module level, and `app-db.ts`'s
exports match a snapshot a reviewer sees change; S4 every module-scope binding under `src/` that is
ever mutated (found with the TypeScript compiler API, so a `Set`, an array or a static field counts as
much as a `let` or a `Map`) is on a reviewed allowlist saying how it is keyed (security R15); S5 every
`fetch` to Spotify sets `cache: "no-store"` or goes through `src/lib/spotify/client.ts`; S6 every
`localStorage`, `sessionStorage`, IndexedDB, `BroadcastChannel` and Web Lock name is built by the
uid-prefixing helper; S7 no `await` on a telemetry-client call outside the daily chores and `/usage`,
so the Zenbook stays off every user path (migration 13); S8 no async server component nested inside a
page reads user data or calls Spotify (completeness M1).

### 6.5 In production

- **Isolation events.** The owner check on open, the cache stamp, the token-owner assertion and a
  decrypt failure each record an event with the uid and a code, no data: awaited, in `lazyboy-app`'s
  `events` table (from Phase 2; it costs nothing while the count is zero), plus a `console.error`
  with a fixed prefix and a telemetry row. The client cannot write one (§6.2 layer 7). The health
  check turns red on any new row (§7.10), so the first sign of a bug the tests missed reaches Rem the
  same hour, and each one is a candidate for Spotify's 24-hour breach notice (01f §1.5) under the
  runbook of §13.6. In Phase 1, before the app database exists and with one user, events go to
  telemetry and the log alone, and the health check reads them there.
- **An adversarial review** of each multi-user phase's diff in a fresh context, told to find a
  cross-user path, before it deploys (the pattern of lanes 1902 and 1906).
- **A canary week (Phase 4a)**: a second Spotify account Rem controls, the only invitee for a week
  before any friend, with exit checks that can fail (§13.1). Phases 1-3 cannot exercise isolation
  with one user, so this is the first time the runtime layers meet two real users: `cache()` in route
  handlers, the Data Cache across environments, Fluid compute serving two users from one instance,
  two real tokens refreshing in one tick (completeness H4).
- **The fault injection** that proves A1 (STORE_MIGRATION §8 step 14, the Zenbook stopped with
  SIGSTOP while pages load) re-runs as an exit check of Phases 1, 3 and 4a, which add telemetry
  writes from new places (migration 13).

### 6.6 Budgets one user could spend for everyone

Separate databases isolate data, not budgets (C §5.5). Four are shared: Turso's rows read (per
organization), Spotify's quota (per developer account), Spotify's 30-second rate limit (per app) and
Vercel Hobby's Active CPU (per team, and an overrun stops every project for up to 30 days, 01f §2.2).

- **Spotify's scarce bucket is spent only by the server**: the claim (§7.2), the open-app rules
  (§7.6), the library scan's server gate (`src/lib/playlists-sync.ts:45-48`) and the brake (§7.5). No
  client call can make the app harvest more often than they allow.
- **The player bucket and the rate window**: `/api/now-playing` answers each user from an in-process
  memo of their last answer for ~5 s, so a user's tabs and devices share one call per window; the
  player actions (`src/app/(app)/actions.ts:310-356, 526-541`) pass a per-user token bucket (security
  R13). With Fluid compute on (`resourceConfig.fluid: true`), few instances serve everyone, so an
  in-process memo catches a stuck tab cheaply.
- **Client-chosen scans are bounded**: `dailyStatsAction` accepts any width up to 100,000 days and
  every distinct width is a fresh scan and a new cache entry (`history-actions.ts:68-72`); it accepts
  only the one value the client sends (`den-home.tsx:379`). `refreshHistoryAction` takes the same
  width (`history-actions.ts:139-146`) and stops reading it in P4 (§8.4). `searchPlaysAction` runs an
  unindexable `LIKE` per call (`db.ts:884-904`); ten a minute per user per instance, the rest refused.
  `/api/playlists/[id]/tracks` gets the same per-user limit (01b S13).
- **Background pages are paced**: a library scan's pages, today sent back to back (`client.ts:243-266`),
  sleep between requests, so a friend's first scan or a full Liked refetch does not put 100 calls
  into one 30-second window (scale 3, 7).
- These stop a bug or a stuck tab from running away; they do not stop a determined invited user, who
  can spread calls across instances. The answer to that is `scripts/user.mjs --disable`, which ends
  their sessions at their next request and their sync at the next claim (§4.2).

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
- **The player endpoints** have never returned a 429. Rem's cron alone spends 1,035-1,303 calls a day
  on them [measured, deduplicated `api_log`, 01c §2.7]; the busiest player day the app has had is
  1,336 calls, on Oct 13 [measured, deduplicated `api_log`, Aug 17-Oct 14, scale 6]. Their limit is
  unmeasured, and the probe that triggers every harvest lives in this bucket (§7.8).
- **The 30-second rate limit** is per app and unpublished. The busiest 30-second windows in the
  retained `api_log` held 56 calls (Aug 18, a cron library scan) and 54 (Sep 27), with no 429 within a
  minute of either [measured, 84,260 calls after removing exact re-sends, scale 7]; the only 429s ever
  logged are recently-played's and `/me`'s, during the August quota bans. The 18 calls quoted before
  (`db.ts:2652-2658`) were the peak inside those ban windows, not a ceiling.

### 7.2 The tick

From Phase 3, two pingers call `GET /api/cron/sync`: the Zenbook's timer on even minutes
(`OnCalendar=*:0/2`, in place of today's drifting `OnUnitActiveSec=2min`) with `CRON_SECRET`, and
cron-job.org on odd minutes with `CRON_SECRET_EXT` (B §7.2). With both alive the app ticks every
minute; with either alone, every two minutes, today's cadence. From lane 1904 to Phase 3, today's
route runs with an interim guard instead (§7.9). The tick:

0. **The caller and the owner alarm.** The secret names the caller, compared in constant time as
   today (`route.ts:45-66`). Only the Zenbook's caller can get a non-200: the route answers it 503 when
   the admin has no token row or is `needs_reconnect`, or when two or more users, or the admin, failed
   to decrypt in the last tick (§5.3), read from the app database before anything else, so the verdict
   does not depend on which pinger's tick did the owner's work this minute (C §6.2's reason).
   cron-job.org always gets a bare `{"ok":true}`: it disables a job after a run of failures
   (`route.ts:174-178`), and it keeps response bodies in its execution history, where per-user
   outcomes would be a minute-by-minute record of when each friend listens (security R14).
1. **The stamp.** `UPDATE app_meta SET value = :now WHERE key = 'tick_at' AND CAST(value AS INTEGER)
   < :now - 45000` (inserted if absent). No row changed means another tick ran within 45 s: the
   route replies 200 at once and does nothing. Pingers 60 s apart both pass; a leaked secret called in
   a loop gets one tick per 45 s, where without the guard 100 calls a second would write ~8.6M rows a
   day against the free plan's 10M a month and block every write until the 1st (security R14). The open
   app's fallback reads the same stamp (§7.6).
2. **Claim.** One statement leases every due user whose `users.status` is `active` (and, under
   `SIGNUPS=owner`, only the admin): `UPDATE sync_state SET lease_owner = :tick, lease_until = :now +
   50s WHERE uid IN (SELECT s.uid FROM sync_state s JOIN users u ON u.uid = s.uid WHERE u.status =
   'active' AND (:signups = 'invite' OR u.is_admin = 1) AND s.state <> 'paused' AND s.next_probe_at <=
   :now + 30s AND (s.lease_until IS NULL OR s.lease_until < :now)) RETURNING uid`, joined to the
   users' tokens and database names in the same round trip (security R2, completeness M3). A leased
   user is not due, so two ticks, or a tick and an open tab, never work on one user at once. This is
   also the tick's store health check, with one attempt and a 5-second timeout: if it fails, the tick
   ends instead of waiting out the store fetch's three 15-second attempts (`src/lib/store-fetch.ts:28-29`).
3. **Steps, concurrently**, under `Promise.allSettled` and a 15-second deadline each. A step receives
   its `Uid`, `UserStore`, a token getter bound to the uid and its deadline, and nothing else: refresh
   the token if under 60 s remain, probe (§7.3), harvest if the policy says so (§7.4-7.5), record into
   the user's database, then write the next due times and release the lease with a compare-and-set
   on `lease_owner`, so a step that outlived its lease writes nothing to the queue.
4. **At most one library rescan**, for one user, under its own deadline, after the harvests, and only
   if at least 10 s of the tick's 20 s remain (§7.7).
5. **Reply within 20 s.** cron-job.org times out at 30 s and disables a job that "subsequently fails
   more than 25 times" (its FAQ, quoted in scale 4), and today's ticks already reach 29.1-34.2 s at
   their maximum through the Funnel (01c §2.1). Whatever has not finished by 20 s is handed to
   `after()`, which Vercel keeps alive to `maxDuration`. The Zenbook's caller gets one outcome per user
   (codes and counts, no data, as today, 01b §2.3); cron-job.org gets the bare body.
6. **The daily chores, when overdue.** If `app_meta.daily_at` is over 26 hours old, the tick takes
   `lock:daily` and runs them in `after()` (§7.11).

Cadence by state: `active` (a play in the last 30 minutes) is probed every 2 minutes; `idle` every 2
minutes while there are at most two users, then every 5 minutes after 30 idle minutes once there are
three or more (B §7.3: that keeps five users' probes near 2,250 a day); `backoff` 2, 4, 8 … 60
minutes; `paused` users, and users whose status is not `active`, make no Spotify calls. Due times are
offset by a hash of the uid so users spread across the minute, and counted due 30 s early so a late
tick does not stretch two minutes to four.

Each pinger hit is one invocation: 1,440 a day whatever N is. The tick lasts as long as its slowest
user's step: ~1-3 s at R1's target, 15 s at most when a Spotify call hangs (01c §5.8). The route sets
`maxDuration = 60`; nothing under `src/app` sets one today, so the project's 300 s default applies
(01f §2.1).

### 7.3 The probe

The cron asks `/me/player` alone. It reports the active device's track, including in the window where
`/me/player/currently-playing` answers 204 mid-playback, and answers 204 only when no device is active
(GOTCHAS "Player simulation"), which is all the harvest decision needs. Today's idle tick spends two
calls, currently-playing and then `/me/player` on its 204 (413 of Rem's 436 idle ticks on Oct 14,
01c §2.1). Now-playing keeps its two-step read: it is the UI's path, and its cost is bounded
separately (§7.6).

The probe keeps the last track id, progress, the time and when playback stopped in the user's own
`meta` (`probe`), written only when the track or the play state changes: a repeat shows as progress
lower than the time since the last probe allows, so a probe that changes nothing writes nothing
(scale 8). A **track change** is a different track id, the same track with progress gone backwards (a
repeat), or playback stopped since the last probe (the session tail).

### 7.4 When a harvest happens

A harvest is one recently-played call, which returns the last 50 plays. A user is harvested when:

| trigger | when | Rem-like calls a day [estimate] |
|---|---|---|
| track change | the probe saw one since the last harvest, subject to the brake (§7.5) | ~117-130, one per play at most. The ceiling is one per probe, up to 30 an hour: a listener with music on 10-12 hours a day reaches ~200-240, a skip-heavy one ~300-360 (scale 1) |
| session tail | the first probe that finds playback stopped (today's `>=` rule, `src/lib/harvest-gate.ts:20-24`) | ~5 |
| tail retry | once, ~5 minutes after a session tail | ~5 |
| completeness | 25 track changes since the last harvest, whatever the brake says (B §7.4: half of the 50-play window) | 0 unless the brake holds a user above 25 changes |
| backstop | 2 hours idle since the last harvest, for devices the probe cannot see (50 plays is ~2.5-3 hours of nonstop listening, 01c §5.1); hourly, as today, until the first friend (completeness L6) | ~7 (14 while hourly) |
| open app | §7.6 | ~5 for Rem; more for an app-heavy friend |

**Late listings.** Spotify lists some plays only after the player has moved on: from Oct 12 to 14, 30
of 225 of Rem's plays (13.3%) were not in the first harvest after they ended, with misses commonest in
the first 30 seconds after a play's end (20%); end to stored was p50 72 s, p90 240 s, p95 300 s
[measured from the Zenbook's `ping.log` matched to `api_log`, scale 5]. A retry one tick later landed
only 7 of the 30, and mid-session it is not needed: the next track change's harvest lists the late
play at no extra cost while it is among the last 50. So the plan drops the mid-session retry the Oct 14
version had and spends one retry on the session tail, where nothing else would fire for two hours.
F2's tail is Spotify's, and §1 states it.

That is ~150 a day for a Rem-like user, against 139-319 cron harvests plus the recorder's 96 today
(01c §2.7). On Rem's day the tick harvested 280 times for 129 plays (01c §5.3); the rule predicts
~150, a number Phase 3's soak checks on his own traffic before anyone shares the bucket. Each harvest
tags its trigger in `api_log.source` (`harvest:change`, `:tail`, `:tail-retry`, `:completeness`,
`:backstop`, `:open-app`), which is what that soak reads (completeness L4). The decision is a pure
function next to `shouldHarvest`, with known answers in `tests/harvest-gate.test.ts`.

### 7.5 The fair-share brake

Under the shared reading, one person's heavy day can get every user's capture banned until ~10:50 AM
(01f §1.4). No code makes the bucket private, so the plan decides who slows down first (A §6.4, with
C's counting and scale 1's per-user cap):

1. Every recently-played and `/me` call increments the caller's `sync_state.rp_calls` for the quota
   day, **awaited before the call**, so a lost write cannot undercount; a re-sent increment overcounts,
   the safe side (01c §2.8 shows re-sends happen on this path). The quota day starts at 14:51 UTC, the
   boundary `getRecentlyPlayedQuotaWindows` already uses. The app's total is the sum over at most five
   rows.
2. Every user starts the day on track-change harvests.
3. A user whose count reaches their share, 426 ÷ N (N = the users the claim can lease), moves to one
   harvest per 15 minutes of playback for the rest of the quota day. Light listeners never reach it,
   and a heavy listener cannot spend anyone else's share.
4. When the app's total reaches 426, every user moves to one per 30 minutes of playback.
5. In every mode, completeness (25 changes), the session tail and its retry, and the 2-hour backstop
   still fire, so no play leaves the 50-play window unseen (F3), and opening the app still harvests
   (§7.6), so what a person sees on opening is current (F1).

It is a counter, a comparison and a branch, with known answers at each boundary. It counts from
Phase 3 and **switches on with the first friend** (Phase 4, N = 2): Rem and one heavy friend can reach
~365-525 calls on a day, past the 450 budget, so the first week anyone shares the bucket is the week
it is needed (scale 1). At N = 2 the share is 213, which Rem passes only on his heaviest days (his
busiest in 61 had 204 plays, ~230-250 harvests with the recorder). Five Rem-like users each reach
their ~85 about 60% into their listening day, about when the total reaches 426, so on a heavy day
everyone gets 2 minutes for ~60% of it and 30 after (A §13.3); mixed profiles slow the heaviest first
(§14.2). If the passive check (§7.9) shows the quota is per user, 426 becomes a per-user number and
everyone stays on track-change harvests. The owner is not exempt (decision 28): exempting him moves
his ~150 calls a day out of everyone else's share, so the brake trips earlier for friends.

### 7.6 The open-app paths

- **`/api/sync`** (on load, every 2 minutes while visible, on focus; `src/components/sync-on-load.tsx:12-27`)
  runs the same per-user step under the same claim, so an open tab and the cron never harvest one
  user twice in a minute. On a load or a return to the tab it also harvests once if the probe saw a
  track change since the last harvest, at least 60 s apart (B's H4), which is the catch-up for
  listening the probe could not see. When no tick has stamped `app_meta.tick_at` in 5 minutes (both
  pingers down, or every tick failing at its claim), the tab's own 2-minute timer makes the user due,
  so an open app keeps capturing on its own (C §6.3). Today the route harvests whenever the last
  harvest is over a minute old, playing or not (`src/app/api/sync/route.ts:28-31`); a friend with Home
  visible through an 8-hour workday would spend ~240 scarce calls a day that way (C §6.3). The
  browser's zone is written only when it changes (today on every call, `:24-27`).
- **`refreshHistoryAction`** stops calling Spotify in Phase 3 and only re-reads the user's store;
  today it harvests on every call with no debounce (`history-actions.ts:133`, 01c S6), which also makes
  it one more concurrent writer of the derived state (migration 3). The browser's provisional plays
  (`src/lib/optimistic-play.ts`, `handoff.ts`) already cover the moment a track ends. The one change
  Rem sees: the forced refresh at a track change finds the stored row only after the next tick, up to
  ~2 minutes later, with the provisional row standing in (decision 15). Its re-read is the open-tab
  term of §8.6: it runs every 120 s while Home is visible, on every return to the tab and on each
  track change (`den-home.tsx:748, 990-996`), and reads the strip at whatever width the client holds
  (`history-actions.ts:139-146`; "See all" sends every day of history, `den-home.tsx:386-412, 760`)
  plus today's rows, both live entries keyed on `write_seq`, so each marker move makes the next
  refresh a real read: ~7,500 rows at the default width, ~46,000 with "See all" open [estimate, scale
  2]. P4 answers it from the patched Home payload instead (§8.4).
- **Now-playing** polls every 6 s from one leader tab per browser today (`now-playing-context.tsx:76`).
  From the first friend (Phase 4, not Phase 3, so Rem's own app does not change weeks early,
  completeness L6) it polls every 15 s mid-track, keeping the end-of-track and focus polls (01c §5.5),
  and the server answers each user from a ~5-second memo, so a user's tabs and devices share one call
  (§6.6). The chip already interpolates progress between polls; `tests/handoff.test.ts` re-runs at the
  15-s cadence, since the instant handoff reads the chip's last poll. The 30-second window is not the
  reason: five visible tabs at 6 s make 25-50 calls per 30 s, under the 56 measured. The daily player
  volume is (§7.8): at 15 s an app-heavy friend's three visible hours add ~720-1,440 player calls to
  their ~450-720 probes, so five such users would ask ~6,000-11,000 a day of a bucket that has never
  been seen above 1,336 [estimate, scale 6]. Phase 5 adds a friend only while the measured player
  volume stays inside what the app has already run without a 429 (§13.1).

### 7.7 Library rescans

- One user per tick, outside the harvest deadlines and only with ≥ 10 s left in the tick's budget,
  resumable (rescans commit per playlist and the snapshot gate skips finished ones,
  `src/lib/sync/library.ts:64-71`); every 30 minutes while active, every 2-3 hours idle (01c §5.6).
- No `/me` call: the user's Spotify id is on the users row, refreshed at sign-in. That is one
  scarce-bucket call per rescan, 32 a day for Rem (01c §5.1).
- Every playlist's stored snapshot read in one statement over the user's `plsnap:` keys instead of
  ~110 serial `getMeta` reads (`library.ts:65-66`; about half of the day's `meta` reads, 01c §2.3).
- **Liked Songs, sized for a friend with thousands** (scale 3). Rem has 48, so nothing measured so far
  exercised this path. Today `storeSavedTracks` diffs on `(addedAt, position)` (`src/lib/store-diff.ts:216-219`)
  and Spotify lists Liked newest first, so one new like moves every row's position and rewrites all N
  rows, though nothing reads `position` (`db.ts:1636-1638, 2296-2303`); and any change in the count or
  the newest `added_at`, or a day passing (`sync/library.ts:79-84`), refetches the whole list,
  unpaced, through `getAll`, which throws at its 501st page (`client.ts:255`), so a list over 25,000
  songs would fail every scan. For a friend with 5,000 likes that is ~5,000 rows written and 100 calls
  per like [estimate, scale 3]. Phase 3 changes it before anyone else signs in: `position` leaves the
  diff, so a like writes one row; the list is read from the newest page until a stored `(track,
  added_at)` appears, with a full refetch only when the count still disagrees afterwards; the daily
  check stays daily and now costs one or two calls when nothing changed, which also stops the daily
  ~39,000-row unique-song recount it triggers today (B §3 row 6); background pages are paced (§6.6);
  and `getAll` takes a resumable cursor in place of the throw. `playlist_tracks` has the same
  position-keyed shape (`db.ts:2069-2093`) at a lower rate, since Spotify appends at the bottom; it is
  left as is.
- The image-only tier stops bumping `write_seq` (`db.ts:1841`) in P4, and the playlist grid keys on a
  marker of its own, so artwork rotation (198 updates on Oct 14, 01c §2.3) stops invalidating every
  strip and day entry (scale 2).
- A new user's first scan (~150 calls for a Rem-sized library, 1-2 minutes at 150 ms pacing, 01c §5.6)
  starts from their first Home visit or the cron, whichever comes first; the client kick also stamps
  `library_scan_attempt_at`, so the two never scan one user at once (C §6.6).

### 7.8 Failure isolation

| failure | effect | who |
|---|---|---|
| a Spotify call hangs | the step is abandoned at 15 s and may still write later: claims, leases and natural-key inserts are safe to repeat, and the derived totals move only by what an insert actually inserted (§8.3) | that user |
| `invalid_grant` | §5.4's steps: stop and keep, confirm, then expiry, `revoked` or an app-wide event | that user, or nobody's data when two are hit |
| 403 "not registered" (removed from the dashboard's list) | `removed`, no further calls; after 7 days the health check asks Rem to run the deletion, since the person can no longer sign in to ask (completeness M5). Never applied to the admin, and never when every user failed the same way in one tick, which is what the owner's Premium lapsing looks like (01c §5.4 item 4): then the whole tick backs off | that user |
| Spotify 5xx or a timeout | `backoff` | that user |
| 429, rate limit | the app-wide cooldown, seconds long (`client.ts:150-183`) | everyone, correctly: the limit is per app |
| 429, `QUOTA_EXCEEDED` (the body's `reason`, which nothing reads today, 01c S4) | `cooldown:<bucket>` until `Retry-After` or the observed reset; probes and rescans in other buckets continue. While only one user has been refused this quota day, one other user's next harvest goes through first: refused too, the cooldown goes app-wide; accepted, the quota is per user, the cooldown stays that user's, and §7.9 has its answer (security R15) | everyone's harvests, or that user's |
| a player-endpoint refusal | no track change can be seen, so every user active in the last 3 hours is harvested every ~30 minutes, now-playing polls at 30-60 s, and the health check reports it (scale 6) | everyone's freshness, not their completeness |
| a token that will not decrypt | §5.3: that user's step skipped, no state written; two or more in one tick, or the admin's, answers the Zenbook caller 503 | nobody's state |
| the app database unreachable | the tick ends at the claim; requests answer the retryable error (§5.1) | everyone; plays within each user's last 50 come back at the next tick |
| a user database refused (wrong owner, behind on schema) | that user's step skips, recorded | that user |

The Oct 14 version called every write on this path idempotent. Claims and leases are compare-and-sets
with an owner token, and inserts have natural keys (`plays` by `(track_id, played_at)` inside the
user's own table); the derived totals and month counts were not, which §8.3 fixes by advancing them
only with what an insert actually inserted (migration 3). Writes that must outlive a response go
through `after()`, not a bare `void` (01c §5.4 item 8). Each harvest records the lag of the plays it
lands (`now − played_at`); the daily chores roll them into `lag_p50_s` and `lag_p95_s`, F2's
instrument on `/usage`.

### 7.9 Pingers, the recorder, and finding out how the quota is counted

- **An interim second pinger, right after lane 1904** (migration 2; decision 8). Until Phase 3 the
  Zenbook is the only frequent capture trigger, and from late August to late September it lost about
  ten days of capture in four weeks: down Aug 30 to Sep 2 and Sep 3 to 5, then unable to resolve names
  until Sep 9, 16 more hours on Sep 9 and 19.5 on Sep 25 (the Oct 3 review's item D2, quoted in
  migration 2), with the pinger and the recorder failing together because its only resolver is
  Tailscale's (`/etc/resolv.conf` lists `100.100.100.100` and `fd7a:115c:a1e0::53`, read Oct 15).
  Phase 3 is six to seven weeks after the cutover [estimate, §13.3]. So right after lane 1904,
  today's route gains three small things: it accepts `CRON_SECRET_EXT` beside `CRON_SECRET`; it
  answers the owner alarm to the Zenbook's secret only; and it takes §7.2's stamp with a 90-second
  window, so with the two pingers on alternate minutes every second tick runs and Spotify sees today's
  two-minute cadence, while either pinger alone keeps it. Cost: one row written per tick that runs,
  ~720 a day. Re-enabling the cron-job.org job that `CRONJOB_JOB_ID` already names in Production, with
  the new secret, is Rem's step; `ensureCronJobEnabled` (`src/lib/cronjob.ts:14-48`) keeps it enabled
  once it is, a chore that moves to the daily route (C §6.5).
- **A resolver on the Zenbook that does not depend on tailscaled** (decision 9): an ops change outside
  the lanes, which removes the failure that took the pinger and the recorder down together.
- **The full second pinger** comes with Phase 3's claim: the 90-second window becomes 45 s and both
  pingers' ticks run, one a minute (§7.2).
- **The recorder** stays Rem's alone and runs hourly from Phase 3 instead of every 15 minutes: 24
  scarce calls a day instead of 96, and an hour is well inside 50 plays of any listening (01c §5.7 a).
  Extending it to friends would put their refresh tokens in a plain file on the Zenbook (01e §5.9). Its
  grant was adopted on Aug 6 and may age out by Feb 6, 2027 under Spotify's six-month rule, silently
  (01e F3); a fresh local sign-in copied into `~/lazyboy-recorder/tokens.json` restarts the clock. Its
  file holds the only copy of 122 of Rem's plays until lane 1904 backs it up (§10.2 edit 7, §11.3).
- **How the quota is counted** is found passively (01c §7.3): `api_log` records the caller's uid and
  each 429's `reason` from Phase 3 on, friends join one at a time, and the first ban answers it:
  §7.8's quota row lets one other user's harvest through after the first refusal, so "one user
  refused" can actually be observed. With the brake holding the total near 426, a ban may never come,
  and the plan is safe under both readings. A question on Spotify's developer forum costs nothing.
  Driving a test account into a ban would risk Rem's own capture for up to ~12 hours (01c §7
  decision 3).

### 7.10 Alarms

Today nothing that goes wrong notifies anyone. The Zenbook unit that is meant to "fail visibly" has an
empty `OnFailure=` (read by completeness H1), `ping.sh` only appends each reply to `ping.log` (01c §1),
and everything else ends on `/usage`, a page. STORE_MIGRATION's R6, "No new alerting mechanism", is
the reason, and it is right for the cutover; it stops being right once friends' data, a breach-notice
clock and a deletion clock depend on someone noticing (decision 14).

The channel is the one the dormant usage-check route was built around (`docs/ARCHITECTURE.md:190-198`):
a cron-job.org job with failure e-mail, here calling `GET /api/cron/health` hourly with
`CRON_SECRET_EXT`. It answers 500, with a one-word reason and nothing about anyone's listening, when:

- the `events` table has a row not yet reported (an isolation event, a decrypt failure, a drift);
- the admin is `active` and his last successful tick is over 30 minutes old (before Phase 3, the
  stamp in `lazyboy.meta`);
- a user has been `revoked` or `deleting` for over a day, or a deletion's five-day check fails (§12.3);
- a friend has been `needs_reconnect` or in `backoff` for over six hours, or `removed` for over seven
  days;
- the daily chores' `daily_at` is over 26 hours old;
- Turso's month-to-date reads run ahead of the month's pace (the usage-check's own rule).

A reported `events` row is marked so it e-mails once; standing conditions stay red while they hold.
cron-job.org disables a job after a run of failures, so the daily chores re-enable the health job the
way they re-enable the pinger. Each condition has a known answer. It is live from Phase 1, when
isolation events begin, and costs $0.

### 7.11 The daily chores

STORE_MIGRATION's `/api/cron/daily` becomes the home of every once-a-day job: deletion retries and the
automatic triggers (day 4 of `revoked`, 14-day invite expiry, the 60-day `dormant` move, twelve months
without a sign-in, §12.3); Turso's usage read; re-enabling the two cron-job.org jobs; the lag
roll-ups; the contexts pass; the telemetry prunes; re-encrypting blobs under an old key (§5.3); the
sweep of `user_tokens` and `sync_state` rows whose uid has no `users` row (security R3); and the
**drift heal**: per user, recompute the all-time totals and each month's play count from the stored
columns, overwrite them, mark the Home payload for one rebuild, and record a `drift` event if anything
differed (migration 3). The heal is one indexed pass over the user's plays, ~22,000 rows for Rem
today [estimate], about 1% of the free plan at five users; a daily chore is one of the places rule 2
of §3 allows a whole-history read.

One Vercel cron a day is a thin hook for that much: Hobby fires it anywhere in its hour (01f §2.2),
STORE_MIGRATION places it at `0 7 * * *`, an hour that contains the Zenbook's ~07:00-07:08 UTC reboot,
and the block it replaces never ran for two months without anyone noticing (STORE_MIGRATION §3). So
(migration 10): the cron moves to `0 9 * * *`; the chores stamp `app_meta.daily_at` when they finish;
a tick that finds the stamp over 26 hours old runs them under `lock:daily` in `after()`, so either
pinger covers a missed cron; a deletion's telemetry step retries on every tick until it succeeds,
instead of once a day; each chore's outcome shows on `/usage`, and a stale stamp turns the health check
red. Each chore is idempotent and resumable, so a run cut off at `maxDuration` finishes on the next.

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
| an open Home tab's re-read of the strip and today's rows (`refreshHistoryAction`, `history-actions.ts:139-146`; §7.6) | each write-marker move while Home is visible: two or three per landed play (`db.ts:522, 749, 819`) and every image-only rescan (`db.ts:1841`) | ~7,500 at the default width; ~46,000 with "See all" open [estimate, scale 2] | small on Oct 14 (7 refreshes); 826,090 modeled rows on Aug 12 [measured, `usage_ledger`, scale 2] |
| ticks and harvests that land nothing | 591 a day | ~3 and ~215 | ~0.06M |

Oct 14 was the incident day, and its orphan row carries it: at least two of its three unscoped passes
were most likely the second account's library replacing Rem's and being replaced back (§1, migration
15). On an ordinary day the row is about three passes a week.

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
- **A NULL is pending, never zero** (migration 4). `listened_ms IS NULL` on a counted play means "not
  yet ruled", as `skipped IS NULL` does today: a partial index (`WHERE listened_ms IS NULL AND
  (context_type IS NULL OR context_type <> 'backfill')`) finds them, and the pass that rules skips
  fills them and sets `alltime_dirty` whenever it fills one. A writer that does not know the column
  (an older build during a rollback, an import script, a dev server) leaves a play the next pass
  fills, not one the totals miss for good, so the fill needs no quiet window (§11.3).
- **The accumulator** is `allTimeStats` (`skip-rule.ts:58-74`) applied one play at a time: for a
  counted play (real, not skipped), `plays + 1`, `durationMs + listened_ms`, `since` kept, and
  `uniqueTracks + 1` when no earlier counted play of that track id exists (an `EXISTS` on
  `idx_plays_track`). It equals the chain walk because `listened_ms` is the value the walk computes.
  **It advances in SQL, in the insert's own batch, by what the insert inserted** (migration 3): each
  `INSERT OR IGNORE` is followed by an update of the stored totals conditioned on `changes()`. Two
  harvests landing overlapping batches, a re-sent batch (the store fetch retries any rejection, its own
  timeout included, `src/lib/store-fetch.ts:80-83`; 01c §2.8 measured 25-30% of `api_log` rows as
  re-sends) and a step abandoned at its deadline that writes later each add only the rows that were
  new, in any order. A read-modify-write in JS, as the Oct 14 version described, would lose an
  increment to a concurrent harvest or roll a total back with a late re-send. The lane first checks
  that `changes()` behaves this way inside a Turso batch; the fallback is a `through_id` kept with the
  totals and advanced over the rowid range of new plays (migration 3). T16 has the known answers.
- **Non-append events keep today's path.** An out-of-order insert (the backstop replay, an import, a
  late play inside the 50-play window) re-opens its successor and rules it from its predecessor
  (`db.ts:547-561`), now rewriting its `listened_ms` too, and sets `alltime_dirty`; a duration change
  on a played track (`sync/library.ts:94-101`) re-rules that track's plays and their successors
  through `idx_plays_track`. A dirty flag makes the next tick recompute the totals from the stored
  columns: one scan of that user's plays, without the `tracks` probes, only on those events. The import
  scripts write raw SQL and close with `importTailStmts` (`scripts/import-tail.mjs`), so they never
  reach that code: P2's lane adds `alltime_dirty` to `importTailStmts`, with known answers in
  `tests/import-scripts.test.ts` (migration 4).
- **The daily heal** (§7.11) recomputes the totals from the stored columns once a day and records a
  `drift` event if they differed, so a drift the rules above miss lasts a day at most and is reported.
  This is the check design B kept and the Oct 14 version dropped (design-b.md:178-179), moved to where
  it is cheap.
- **One-time fill on Rem's database** (§11.3): one chain walk in JS with the same pure function
  (~45,000 rows read, ~14,500 written [estimate, B §8.1]), verified by `SUM(listened_ms)` over counted
  plays equal to `alltime_stats.durationMs` on the same snapshot, and by `scripts/verify-derived.mjs`
  extended with a `listened_ms` check.
- **Effect**: 2.24M rows on Oct 14 become a few thousand a day, and the only read that grew every day
  stops growing (D2). The all-time card also stops lagging a listening session by up to 10 minutes.

P2 comes before the history segments (P3) so the segment tuple can carry each play's listened
seconds from its first version (§9.1), which is what lets P4 move the whole-history strip into the
browser without a second shape change.

### 8.4 P4: the Home payload patched in place, the open tab, and three smaller terms

Before the second friend (§13), or earlier if Turso's per-database usage at the first friend's month
says so:

- **The Home payload** is patched from the harvest in hand instead of rebuilt (B §8.2). The harvest's
  read batch includes the `home_payload` row; JS applies the new plays to that day's entry in the
  strip (plays, `durationMs` from `listened_ms`, the unique count from the opening day's rows), to the
  opening day's song rows, and to the all-time totals from the accumulator; a new local day starts a
  fresh opening day. The write is a compare-and-set on a version kept in the payload, and a patch that
  loses the race marks the payload dirty instead of overwriting a newer one (B §8.2, migration 3).
  Everything else falls back to today's rebuild: a play landing on a day other than the opening day,
  an out-of-order insert, a time-zone or shape change, and any derived-column event that touches a
  play in the payload's 16 days (a context name resolving, an orphan flip), which marks the payload
  dirty. Today the rebuild after every landed play is what heals those two derived columns; a patched
  payload needs the explicit mark or a stale "From" could sit in it for days, and the daily heal
  rebuilds it once a day regardless (§7.11). ~7,500 rows read per landed play become ~1, and a landed
  tick's ~30 round trips become ~3. The exit check runs a scripted day that includes every
  non-append event, not a day of appends (T17, completeness M6).
- **The open tab** (scale 2). `refreshHistoryAction` returns the 14-day strip, the all-time totals
  and today's rows from the patched `home_payload` (one `meta` read) plus the delta it already
  computes, and ignores widths above 14; the expanded strip comes from the segments in the browser.
  An open Home tab then costs ~1 row per landed play instead of ~7,500 per marker move at the default
  width and ~46,000 with "See all" open (§7.6). The image-only playlist tier stops bumping `write_seq`
  (`db.ts:1841`) and the grid keys on a marker of its own, so artwork rotation stops moving the marker.
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
[estimate] built from the measured per-run costs above. The "today" column carries Oct 14's three
unscoped orphan passes, at least two of them the incident's (§1); an ordinary day has about three a
week, so an ordinary "today" is ~4.5-9M. From P1 on an orphan pass costs little either way.

| term | today | P1 | P2 | P3 | P4 |
|---|---|---|---|---|---|
| all-time recompute | 2.24M | 2.24M | ~0.005M | ~0.005M | ~0.005M |
| Home payload | 0.95M | 0.95M | 0.95M | 0.95M | ~0.03M |
| orphan verdicts: new plays + library changes | 0.017M + 15.3M | ~0.001M + ≤ 0.05M | same | same | same |
| unique-song count | 0.16M | 0.16M | 0.16M | 0.16M | ~0.12M |
| ticks, harvests, rescans, identity, claims | ~0.08M | ~0.08M | ~0.08M | ~0.08M | ~0.08M |
| daily contexts pass | 0.04M | 0.04M | 0.04M | 0.04M | ~0 |
| nightly backup dump (source counts kept, §10.2 edit 4) | 0.05M | 0.05M | 0.05M | 0.05M | 0.05M |
| the daily heal (§7.11) | – | – | ~0.02M | ~0.02M | ~0.02M |
| search, 2 visits (Rem) / 8 visits (an app-heavy user) | 0.14M / 0.58M | same | same | 0.03M / 0.10M | same |
| whole-history strip, 2 / 8 mounts | 0.09M / 0.35M | same | same | same | 0 |
| open Home tab re-reads (§7.6), Rem / app-heavy at the default width | ~0.05M / ~0.36M | same | same | same | ~0 |
| **total, Rem (2 visits)** | **~19.1M** | **~3.85M** | **~1.64M** | **~1.53M** | **~0.39M** |
| **total, an app-heavy Rem-like user (8 visits)** | **~20.1M** | **~4.9M** | **~2.65M** | **~2.17M** | **~0.46M** |

The open-tab row is scale 2's: an app-heavy user with Home visible three hours of a day re-reads the
strip and today's rows at least ~48 times (~45 landed plays and ~3 artwork rescans while visible), and
with "See all" open each re-read covers the whole history, ~2.2M a day instead of ~0.36M. The August
days with the most refreshes show the shape: Aug 12 had 169 strip reads (826,090 modeled rows) for 47
landed ticks [measured, `usage_ledger` in the Oct 14 backup, a lower bound, scale 2].

Against D1 (≤ 1.5M a heavy day): Rem is at the bar after P3 and well under it after P4; an
app-heavy Rem-like user needs P4. Against R4 at five users (≤ 250M a month), after P3: Rem plus four
light friends is ~101M (20% of the free plan), and Rem plus four app-heavy Rem-like friends at Rem's
history size is ~306M (61%, over the bar), or past the free plan's 500M if they leave "See all" open
while listening. After P4 it is ~67-74M (13-15%), because nothing left on a per-visit path grows with
history. With one friend (Phase 4), after P3, it is ~110M (22%), or ~165M (33%) with "See all" open,
which is why P4 can wait for the second friend and no longer. §14.4 has the arithmetic.

Writes (scale 8's recount; libSQL bills each index entry an insert adds: `INSERT INTO api_log` wrote
4 rows and `INSERT OR IGNORE INTO plays` 8 on every call of Oct 14 [measured, the meter's
per-statement `rw`]): ~3,000 core rows a day for Rem (01c §2.7), plus ~72 for tokens, ~900-1,440 for
claims and releases (two rows per probe, 450-720 probes a day, with `next_probe_at` unindexed), ~130
for the `probe` key written only on a change, ~205 for the derived counters (one month-count upsert
and one totals update per landed batch) and ~165 counter increments: **~4,500-5,000 a day**, at D3's
5,000 [estimate]. Writing `probe` on every probe and indexing `next_probe_at` would make it
~5,100-5,900. Five users, with the tick stamp (1,440 a day): ~0.72-0.8M a month, 7-8% of the free
plan's 10M, inside R4's 10%. A friend with a large Liked list stays inside it only with Phase 3's
Liked change: without it, three likes a day at 5,000 songs is ~15,000 rows written (§7.7). `api_log`,
~1,000 Spotify calls a user a day after Phase 3, stays on the Zenbook.

## 9. Search: per-user payloads, caching and the phone budget

Search keeps today's model: the browser holds the user's library and history and filters them on
every keystroke with no request (`den-home.tsx:497-524`, 01d §1). Two things change. Every key, ETag
and stored copy carries the uid (§6.2 layer 6). And the history stops being one body, for a reason
that applies to Rem alone: it is 1.79 MB raw, 86.6% of the Data Cache's 2 MiB item limit, and crosses
it around late December 2026, after which every Home open rebuilds it with a full plays scan and
nothing reports it (01d §3.2: Next 16.2.6 skips caching an item over the limit and only warns, in
runtime logs that age out within the hour). The step-by-step phone budget is §14.1.

### 9.1 What the browser fetches (P3)

- **The manifest rides the page.** Home's server render already reads the user's database for the
  Home payload; the same batch reads the manifest (each segment's key, version and play count, and
  the database's `store_epoch`, a few hundred bytes; B §9.1), so the browser knows at first paint
  which segments it lacks. No extra request.
- **History in monthly segments** (01d O3): one body per (user, UTC month), plus the 7,529 catalog rows
  as a segment of their own, since they never change and are 58% of today's body (01d §2.1). Each is
  self-contained in today's tuple format with one field added: a play becomes `[trackIdx, minute,
  sourceIdx, listenedS]`, so the browser can build any day's totals (B §8.3), at ~4 bytes a play.
  The URL is `/api/search/h/<segment>?v=<epoch>.<version>&s=<shape>`, served **`private, no-store`**
  (security R12): the uid is not in the path, because the server takes the user from the session and
  builds from the session's database through `userCache`, keyed by uid, epoch, segment, version and
  shape. A miss reads one month through `idx_plays_played_at`, ~3 rows a play, at most ~10,000 rows
  for Rem's busiest month (01d O3). If the month's version has moved past the URL's (the current month
  after a new play), the route answers the current body with its version in a header (B §9.1).
- **Why no-store.** An immutable response stays in a browser's HTTP cache for its lifetime, where no
  page script can evict it, so a year of a person's listening would outlive their sign-out on a shared
  computer. IndexedDB (phase E) is the repeat-visit store and S1's budget reads it (§14.1), and it is
  cleared at sign-out. The cost: a device without the IndexedDB copy fetches every segment again, from
  the Data Cache, at first-visit cost. Safari deletes a site's script-writable storage, IndexedDB
  included, after seven days of use without visiting it (WebKit, quoted in scale §3; a web app added
  to the home screen keeps its own count), so a friend who opens Lazy Boy in Safari less than weekly
  gets S2's numbers, not S1's, each time.
- **The library**, one body per user as today, `/api/search/l?v=<epoch>.<library_seq>&s=<shape>`, also
  `private, no-store`; split per playlist when a library passes ~12,000 songs (01d O7, §8.5).
- **A delta at visit start** (01d O4): the plays newer than the newest minute the browser holds, ~50
  rows, today's `refreshHistoryAction` read made a scoped GET.
- **Phase E's IndexedDB copy** stores bodies under `(uid, epoch, kind, segment, version, shape)`, so a
  repeat visit paints search from disk before the network (STORE_MIGRATION §10, 01d O5), and a restored
  database, whose versions start over, can never match a body stored before the restore (migration 1).

**Segment versions** are per-month entries in the user's `meta` (`seg_seq:<YYYY-MM>`, holding the
version and the month's play count), bumped by every write that can change a closed month (A §7.1,
B §8.3). Keeping the count beside the version is what lets the manifest be one `meta` range read of a
dozen rows; counting plays per month at render time would be a scan of the whole history on every
Home open, the thing D2 forbids. The count advances in SQL with the insert's `changes()`, as the
all-time totals do, and the daily heal recomputes it (§8.3, §7.11).

| event | how its months are found |
|---|---|
| a play inserted, in order or not, and the successor it re-opens | their `played_at` |
| `ctx_orphan` flips after a playlist's membership moved | `UPDATE … RETURNING played_at` on the scoped pass |
| a context name resolves or changes | `SELECT DISTINCT substr(played_at, 1, 7) … WHERE context_uri = ?` on `idx_plays_context` |
| a played track's name, artist, art, album or duration changes | the same on `idx_plays_track` |
| the backstop replay, a history import, the catalog backfill | the scripts bump the months they wrote, and `catalog`, through `importTailStmts` (T10) |

Each bump site gets a known-answer test: write to an old month, and that month's version moves and no
other does. The manifest's play count per month lets the client catch a missed insert bump (its
stored copy's count differs) and refetch. A missed bump on a derived column leaves a stale "From"
label or name in that month until its next bump, the same failure class as a missed `write_seq` bump
today (`db.ts:337-340`), and for one user only. Moving the shape token re-fetches every segment, the
escape hatch for a bug in this list, and the step that rolling P3 forward after a rollback takes,
since an older build in between wrote plays without moving any month's version (migration 4).

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
rebuild, ~4,500-10,000 rows, never correctness. Closed months mostly live in the browser's IndexedDB,
so the server rebuilds one only for a device that lacks it; with the bodies `no-store`, the HTTP cache
no longer stands in for a device whose IndexedDB copy is gone.

### 9.4 Order and the December deadline

P3 must ship before mid-December. If it cannot, the catalog split alone (01d O2) is the stopgap: the
history entry drops from 86.6% to 37.1% of the limit and the next crossing moves ~10.7 months out
[measured, 01d §5.1]. P3's client edits touch the load path phase E rewrites (lane 1905), so P3
starts after lane 1906 merges, never in a parallel branch (C §7.2).

Friends' history imports need more than segments (scale 9). A five-year import is ~91,000 plays, 60
monthly segments plus the catalog: ~61 requests on a cold visit, each its own invocation with its own
identity read, and per-segment dictionaries repeat the art and album strings of every song heard that
month (+24.8% raw, +29.8% gzipped over Rem's five months, 01d O3). At ~4.2 MB raw before that overhead
(01d §3.3) it is ~2 MB gzipped, ~1.6 s at 10 Mbit/s plus ~1.1 s of parse and build at 4×: ~3 s
[estimate]. Segments fix the 2 MiB cliff for an import, not S2. So an import waits for **newest-first
loading** (the library and the newest months first, the box usable in ~1.2 s while older months
follow, B §17) and **yearly segments for closed years**, one request per year instead of twelve
(decision 30).

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
reversible move into a migration (01a §10). Every overview, all three designs and all four reviews say
the same. What the plan takes from the move: the user paths off the Zenbook (A1 rests on R2); R1's
round trip, which every latency in §14 assumes; phase A's telemetry client, where `user_id` is added;
the daily route, home of the per-user chores, the usage read and the deletion job's retries; lanes
1910-1911's scoped orphan pass; phase E's browser copy.

**Eight edits before Oct 15, 8 PM**, each small and none touching the cutover's logic; each is the
director's and Rem's call (decisions 2 and 3):

| # | where | edit | why | from |
|---|---|---|---|---|
| 1 | §3 and R4 (doc) | name the all-time recompute, not the history payload, as the ~50,500-row scan that dominates reads; give R4 a growth term (~12,000 rows a day more for every day of history at today's 44 runs, 01c §5.9) and note that R4 holds for one user and the multi-user plan re-checks it at N | it decides which lever comes next (P2, §8.3) and what lane 1908's outcome check should watch | 01a §11.2, 01c §6 items 1-2, 01d §6 item 4; A, B, C |
| 2 | §8 step 9 (lane 1903) | flip Production only and delete Preview's `TURSO_*` variables; then `vercel env ls production` must show both store variables before any redeploy | as written it carries today's preview exposure to the new store: a preview's `init()` would run a branch's schema against production, and any preview could read every row (01b §3.7, E4). STORE_MIGRATION §3 records the variables as one Production + Preview pair, and Vercel's CLI page does not say what removing one environment from a shared variable does; a production build without them falls back to `file:data/listens.db` (`db.ts:127-128`) and fails every query (migration §2) | 01b §7 item 2, 01e §6 item 4; A, B, C; migration §2 |
| 3 | §10 (lane 1905) | key IndexedDB by an opaque user key the `(app)` layout renders, a constant until Phase 1's uid replaces it; stamp each stored body with it; make the store's key `(userKey, epoch, kind, segment, version, shape)`; clear the store in the browser when the sign-out form submits | no user id reaches the browser today (01b §1.1), and the lane would otherwise reach for the email, the random `sub` or `me_id`, each wrong in its own way; the segment and epoch dimensions save a second migration of browser data when P3 lands | 01b §7 item 1, 01d §6 item 3, 01e §6 item 3; A, B, C; migration 1 |
| 4 | §9 (lane 1904) and lane 1909's archive | write the backup as a list of `(database, retention)` pairs, starting with `("lazyboy", 60 days)`; run each database's retention prune first and unconditionally, and log it; strip the `spotify_tokens%` and `lock:%` rows from every copy before it is compressed; keep the source counts (`count(*)` per table on the store, against the loaded dump), and require the CLI's exit status and, for a `.dump`, the closing `COMMIT;` | a list costs nothing now and saves a rewrite; today's `backup.py` prunes only at the end of a successful run, so a failed night skips every prune (migration 11); every copy today holds live 13-scope grants valid up to six months (01e F2); the source comparison is what catches a dump that ended early, which counting the dump against itself cannot (migration 12). Its cost is ≤ ~45,800 rows a night if Turso charges a `count(*)` for every row, as READ_QUOTA's definitions say, and a few hundred if it counts pages as the Zenbook's sqld did (158 for 15,852 rows, READ_QUOTA "Measured reads", scale 11); one read of Turso's usage before and after settles which. The cutover's own snapshot keeps the token rows (R5) | 01a §10 item 3, 01e §6 item 1, B §11.3 item 3, C §8.3; migration 11-12 |
| 5 | lane 1903's last step | delete the plaintext scratch copies on the Mac: the core snapshot (both token rows) and the mode-600 copy of `.env.local` (every secret) | the same exposure as edit 4 | 01e §6 item 2, C §8.3 |
| 6 | lanes 1910-1911 | ship the identity-first orphan predicate with the scoping, pinned by a known-answer test | the scoped pass with today's predicate still costs plays × members on a busy playlist; the rewrite makes it ~5-10 rows a play (§8.2). The equality check now has current data: on the Oct 14 backup copy (22,040 plays) both forms give the same verdict on every play, 1,162 orphans each, and walk 379.9 rows a play against 2.6 (scale §3) | B §10.1, §11.3 item 4; reproduced twice |
| 7 | §9 (lane 1904) | the nightly job also copies `~/lazyboy-recorder/backstop.db` (31 MB, one file), kept 60 days like Rem's store | it holds the only copy of 122 of Rem's plays (§11.3) and is the loss-repair path for every recorder window; `backup.py` copies the store's file alone, and nothing else names the recorder's file (migration 8) | migration 8 |
| 8 | §6 item 7 (`vercel.json`) | add `/api/cron/daily` at `0 9 * * *`, beside `/api/cron/sync`'s existing daily entry, not in place of it | 07:00 UTC holds the Zenbook's nightly reboot (01f §3.3), which fails the chores' telemetry steps; the sync entry is the last-resort capture when both pingers are down (§14.5) | migration 10, 14 |

**Notes for the lanes**, changing no lane's work:

- STORE_MIGRATION's R6, "No new alerting mechanism", binds lanes 1901-1911 and not the multi-user
  phases, whose alarm is §7.10 (completeness §2, decision 14).
- Step 8's full-access, no-expiry `lazyboy` token is the credential Phase 2 invalidates before it
  mints the group token (§11.4); dev gets a token of its own after that (security §3).
- Lane 1903's step 11 expects fence 503s from "old deployments" that reload "through build-skew". Skew
  Protection is a Pro feature, the team is on Hobby (01f §2.1), and production shows no pinning today
  (no `dpl=` marker in `/login`, no `__vdpl` cookie, security §5): after the flip, old tabs reach the
  new deployment, and old deployments answer only on protected URLs. Fence hits should come from dev
  servers and scripts; an old deployment in the meter's log means someone reached a protected
  deployment URL, which is worth a look rather than a wait (security §3). GOTCHAS "Deployment skew +
  stale tabs" makes the same assumption and needs the same note.
- From lane 1904 on, a backup carries no token rows, so restoring `lazyboy` from one brings back no
  token: capture stops until Rem signs in, with the recorder covering him meanwhile (01e §6 item 1).
  Lane 1904's restore drill should expect that sign-in (completeness §2).
- Phase 0 lands before lane 1903's flip, so the deployment a one-click rollback could reach during
  the cutover was built after the `AUTH_SECRET` rotation (security §3).

**Optional for lane 1904, free**: copy the meter's per-statement logs (`~/lazyboy-sqld/querylog/*.jsonl`)
with 1909's archive, the only exact per-path record of the single-user workload (01a §10 item 1);
compare `api_log`'s row count with its distinct count for a day, a free test of 01c §2.8's re-send
hypothesis; and copy the Zenbook's `~/lazyboy-cron/ping.log` daily. It keeps only its last 2,000 lines
(about 2.75 days), and its per-tick `added` counts matched to `api_log` are the only record of
Spotify's listing lag (§7.4), which Phase 3's soak re-measures (scale §3).

**Considered and not recommended before the move**: deriving the Zenbook fence's table list from
`init()` (01b §7 item 3), because the multi-user tables live in new databases that no pre-multi-user
deployment knows, so the hand-written list stays complete (C §8.3); writing `/api/cron/daily` as a
loop over users now (01c §6 item 3), because Phase 1 threads the uid through every caller anyway, so
the lane should just write each chore as a function of one user's store; an accumulator lane inside
the migration (01c §6 item 2), which is P2 here, queued after lane 1911; and shipping the uid claim
before lane 1905 (01e §6 item 3), since edit 3's constant gives 1905 the same interface without
moving auth work in front of the cutover.

**Ordering after the move.** Right after lane 1904, and before P2: the interim second pinger (§7.9)
and the 122-play replay (§11.3), both Rem's go-ahead. Phase 2's token table lands after lanes 1903
and 1904, because the cutover compares one plaintext token row on both stores (STORE_MIGRATION §8
steps 10 and 16; 01b §7), and R5's "Rem stays signed in" rests on it. Phase 1's branch is cut after
lane 1911 merges: the orphan scoping and the mechanical edit both rewrite `storePlaylists` and
`recomputeOrphanFlags`, and both at once would make a merge nobody can review (C §11.2). If R1 fails
and the move stops (STORE_MIGRATION §2), multi-user waits: on the Zenbook it fails A1 by construction.

**STORE_MIGRATION §4's open question**, whether the three log tables move to Turso too: from the
multi-user side, keep them on the Zenbook (decision 4). Telemetry becomes personal data with a
deletion duty wherever it lives, which the user column handles in both places (01a §10). On Turso,
five users' `api_log` would be ~0.6M rows written a month even after Phase 3's call cuts (~1,000 calls
a user a day, ~4 rows written per insert counting index entries, scale 8) [estimate], which with the
~0.72-0.8M core writes of §8.6 passes R4's 10% write bar. On the Zenbook the cost is `/usage`'s log
sections during an outage and a dependency on the Funnel certificate that lane 1907 renews.

## 11. Migrating Rem's data with nothing lost

### 11.1 What changes in Rem's database

Almost nothing. After the cutover Rem's data is the Turso database `lazyboy`, which becomes his user
database as it stands: the seven tables are not copied, rebuilt or re-keyed (A §9.1, C §9.1).

| what | when | change | why nothing can be lost |
|---|---|---|---|
| 122 of his own plays that only the recorder holds | after lane 1904, before P2 | inserted by the backstop replay (§11.3), with his yes | a snapshot first; the script inserts only what is missing (`1ac38fa`) and was run on a snapshot copy before ("166 inserted … re-run 0", `.claude/QUEUE.md:16`, uncommitted on Oct 15) |
| `plays.listened_ms` | P2 | a nullable column added and filled (§11.3); a NULL means pending | additive, so `min_reader` does not move and old code ignores it; verified by a sum that must match exactly |
| `meta.owner_uid`, `schema_version`, `min_reader`, `store_epoch` | Phase 1 | written once | four new keys; no reader before Phase 1 |
| `meta.user_tz`, `probe`, `seg_seq:*` | Phase 3 and P3 | written by the app's ordinary code | new keys |
| the token rows | Phase 2 | encrypted into `user_tokens` by the runtime; the plaintext rows stay a week as the way back (§11.4) | both copies hold the same grant (Spotify does not rotate this app's refresh token, 01e F2); the later `expiresAt` wins any compare |
| dead and moved `meta` keys | a week into Phase 2 | `spotify_tokens`, `spotify_tokens_dev`, `lock:spotify_refresh`, `spotify_cooldown_until`, `last_sync_added`, `pltracks_at:*` deleted | moved or never read (01a §3); `scripts/` reads no token row (C §16.3) |

### 11.2 No foreign plays: measured

The Oct 14 plan scheduled deleting the second account's plays from Rem's history, on the strength of
commit `044c9b6`'s line that "the cron recorded its plays into the owner's history". No lane had
measured it. The migration review did, read-only on the Zenbook's SQLite files on Oct 15 (migration
7 and its §4):

- **Store against recorder.** From Oct 13 00:00Z to Oct 15 03:45Z the store and the recorder hold the
  same 264 plays, none on one side only, and all 96 recorder runs on Oct 14 finished without an error
  line. Over the recorder's life (Aug 6 to Oct 15) the store-only plays are 54 on Aug 6, older than
  the recorder's first capture, and 2 on Sep 9 and 4 on Sep 25, during recorder outages; none since.
- **Insertion order.** `plays.id` orders inserts. Of the 1,500 rows inserted since the first Oct 1
  play, none carries an earlier `played_at`; of the 267 since the first Oct 13 play, one does, an Oct
  12 play the recorder also holds.
- **The library.** Against the 08:40Z Oct 14 snapshot, taken before the second sign-in, the
  playlists, the playlists owned by `me_id` and `playlist_tracks` match exactly; Liked went 48 → 49 and
  `contexts` 114 → 117 by ordinary activity; `me_id` is unchanged.

There is nothing to delete, so the plan's one irreversible step on Rem's history is gone, with the Oct
14 version's decision 10, its rollout row and its Phase 2 precondition. What stays is the method, for any future
cross-account write: the recorder diff over the whole range and the insertion-order query, both
read-only, re-run once on the latest backup before Phase 2 (the review's scripts are in
`~/.claude/broke/scratch/lazyboy_mu/0224_review/`). The Oct 14 method, a `played_at` window, would have
missed such plays: a harvest on another account's token stores that account's last 50 plays with
their own `played_at` (`src/lib/spotify/resources.ts:410`), which can predate the incident by days. If
Rem knows whose account it was, asking them to remove Lazy Boy at spotify.com/account/apps ends that
grant, which stays valid at Spotify until they do (01e §1.6, completeness L5).

### 11.3 The 122-play replay, then P2's fill

**The replay, first** (migration 8; decision 7). 122 of Rem's plays, 56 on Aug 9 and 60 on Aug 10 (the
quick-tunnel outage, 01f §3.3) and 6 on Sep 8, exist only in `~/lazyboy-recorder/backstop.db` on the
Zenbook, which nothing backs up today. Decision 6 copies the file off the Zenbook now; edit 7 backs it
up nightly from lane 1904. After lane 1904, with a snapshot first, `scripts/backfill-from-backstop.mjs`
inserts what is missing (the Oct 3 review's item D1, unblocked since `afb21d1` landed on Oct 14), and
`importTailStmts` re-rules the edges. The Extended Streaming History import for the Aug 30-Sep 9 gap
(`.claude/QUEUE.md:17`) goes in the same slot if its export has arrived, or after P2 once
`importTailStmts` sets `alltime_dirty` (§8.3). Run before the fill, both are counted by it.

**P2's fill.** With `listened_ms IS NULL` meaning pending (§8.3), the fill needs no quiet window, which
P2 could not have had anyway: at P2 there is one pinger to pause, and pausing it freezes none of the
other writers (an open tab's `/api/sync` every two minutes, `refreshHistoryAction`, a dev server),
while after the cutover neither the meter's statement log nor its fence sees Turso (migration 4, 16).
The steps:

1. Take a restore point: Turso's point-in-time, plus a dump by the backup script.
2. Add the column. It is additive, so `min_reader` does not move and the running build ignores it;
   plays it inserts from here on are NULL, which is pending.
3. Fill it with one chain walk in JS through the same pure function the skip verdicts use.
4. Deploy the code that writes the column on insert, advances the totals with each insert (§8.3) and
   fills pending NULLs in the pass that rules skips; it starts with `alltime_dirty` set, so its first
   pass fills whatever step 2's window left and recomputes the totals from the stored columns.
5. Verify: `SUM(listened_ms)` over counted plays equals `alltime_stats.durationMs` on one snapshot,
   and `verify-derived.mjs` is green with its new check.

Rollback: §13.5's recipe; the older build ignores the column, its plays stay NULL, and the first pass
after rolling forward fills them. Cost on Turso, once: ~45,000 rows read and ~14,500 written
[estimate, B §8.1], 0.01% and 0.15% of a free month.

### 11.4 Phase 1 and Phase 2: the owner tag and the tokens

**Phase 1** (no app database yet) generates Rem's uid once and keeps it as a Production constant
(`OWNER_UID`, not a secret). The jwt callback puts that uid, epoch 0 and `auth_time` on the cookie
when the signing-in profile passes today's owner guard; the identity check compares against the
constants; cookies with no uid are refused, so Rem signs in once and the pre-guard sessions end for
good. Phase 1's deploy also rotates `AUTH_SECRET` again: it costs nothing, since Rem signs in once
anyway, and no pre-Phase-1 build can then read a post-Phase-1 cookie, so a rollback across the
boundary signs people out instead of letting single-user code serve them (security R1). Before the
deploy, one step writes `owner_uid`, `schema_version`, `min_reader` and `store_epoch` into
`lazyboy.meta`, which the first open of `forUser(OWNER_UID)` then checks. Those four keys are the only
writes Phase 1 makes to Rem's data. The health check of §7.10 goes live with Phase 1.

**Phase 2** (A §9.3, with C's and B's checks). Preconditions: Phase 1 has soaked; lanes 1903 and 1904
are done; §11.2's re-check on the latest backup is empty; a fresh verified backup exists. T12 rehearses
every step first on a local backup copy with a synthetic token row planted (§6.4).

1. On the Mac, with the platform token from the Keychain: create `lazyboy-app` in group `default`,
   apply the app schema, and insert Rem's `users` row: `uid = OWNER_UID`, `account_id` NULL until his
   next sign-in binds it (Phase 0's dev sign-in has shown whether Spotify sends `account_id`; if it does
   not, stop here, decision 31), `spotify_id = SPOTIFY_OWNER_ID`, `db_name = 'lazyboy'`, `status =
   'active'`, `is_admin = 1`, `session_epoch = 0`. Phase 1's cookies name the same uid and epoch, so
   Rem stays signed in. Write the sentinel blob for the new key (§5.3) from the runtime's first boot,
   not from the Mac.
2. At a quiet hour: invalidate the `lazyboy` database's tokens. Invalidation is group-wide (C §8.2),
   so this retires every token in the group, the cutover's production token and dev's included, and it
   has to come before the new tokens, or it would retire them too (security R1). Then mint the
   runtime's read-write group token and the backup job's read-only one straight into mode-600 files,
   and set Production's environment: the group token in place of `lazyboy`'s own, `TOKEN_KEYS`
   generated in a pipe, the app database's URL (values on stdin, as STORE_MIGRATION §8 step 9 does).
   From the invalidation until the deploy lands, production has no store credential: a few minutes in
   which Rem's pages fail and ticks fail at their claim, and plays inside his last 50 come back at the
   next tick.
3. Deploy Phase 2, still `SIGNUPS=owner`. Its first tick finds no `user_tokens` row for the admin and
   encrypts `lazyboy.meta.spotify_tokens` into one, in the runtime, so the key never leaves Vercel
   (security R9). Three ticks answer 200 with Rem's outcome `ok`.
4. Mint dev a fresh `lazyboy`-only token, and check once that it gets a 401 from a throwaway
   `lb-u-test` database created in the same group for the check and destroyed after (security R8).
5. Verify, each a known answer: the seven tables' counts at or above the pre-migration counts and
   `max(played_at)` moving; `verify-derived.mjs` green; the named `meta` keys (Phase 1's four present,
   the moved keys still present until step 6, nothing else removed; ordinary activity adds and removes
   `plsnap:` and `lock:clean:*` keys, so the whole key set is no check, migration 16); the runtime's log
   line that the blob it wrote decrypts to the plaintext row; Rem still signed in; the recorder diff
   over the window empty.
6. A week later, delete the keys in §11.1's last row, from the Mac with dev's `lazyboy` token; no key
   is needed.

Until Phase 3 writes `sync_state`, Rem's capture banner keeps reading `lazyboy.meta` as today
(migration 16).

**Rollback** follows §13.5: revert the merge and push, never Instant Rollback, because every
pre-Phase-2 deployment holds the invalidated token. Before step 6: Phase 1's code runs on the group
token, which reaches `lazyboy`, and reads the plaintext row; if a refresh happened in between, the
access token has expired and the unchanged refresh token renews it. If Spotify has started rotating
refresh tokens by then, the old code's refresh fails, `clearTokensIfStale` deletes the row and Rem
signs in once (C §9.4). After step 6: set the rollback flag, so Phase 2's runtime writes Rem's
plaintext row back from his blob (§5.3), then revert. A rollback to a build from before the interim
pinger's guard pauses the cron-job.org job first: that route has no guard, and two pingers would
double Rem's Spotify calls (C §9.4). Nothing else in Rem's database changed, so nothing else needs
undoing.

## 12. Sign-up gating, privacy, deletion and backups

### 12.1 Sign-up gating

Two gates, both required (01e §5.4). **Spotify's allowlist** (the dashboard's User Management, five
accounts at most) is what lets an account's token work at all; an account not on it completes OAuth
and then gets a 403 from `/v1/me`, which `userinfo.ts` already routes to
`/login?error=SpotifyNotRegistered`. Adding someone there takes "the name and Spotify email address of
the user" (Spotify's quota-modes page, quoted in completeness M4), so Rem holds each friend's address.
**The app's invite row** is what the app can see, carries the cap, and lets Rem cut someone off without
the dashboard. Every user's calls count against Rem's developer account (01c §4), so the gate is also
the cost control.

- **Invites** are made on the Mac: `scripts/invite.mjs --spotify-id <id>` (Spotify's `id` is in the
  person's profile URL, so Rem can see it before they ever sign in). It refuses if active plus invited
  users already number five (`--force` for a grandfathered list, if the dashboard shows one); inserts
  the `users` row as `provisioning`, which reserves the uid; creates `lb-u-<uid>` in group `default`
  with the platform token from the Keychain, applies the user schema and writes the four keys of §4.5;
  sets the row to `invited`; prints the join link, the reminder to add the person on the dashboard, and
  §12.6's text to send them. A crash leaves a `provisioning` row the script resumes or removes.
  `invite.mjs --revoke <uid>` withdraws an unclaimed invite and destroys its empty database, and the
  daily chores do the same for an invite unclaimed after 14 days (completeness M5). Provisioning stays a
  script because it happens four times, ever, at five users, and it keeps database creation out of the
  sign-in path (A §10.1, B §14).
- **`scripts/user.mjs --disable | --enable | --remove <uid>`** is the only way to change another user's
  status (security R11, completeness M3). The runtime holds no admin mutation, so a stolen admin
  cookie, or a script injected into the admin's page, cannot destroy a friend's data. `--remove` runs
  the deletion job of §12.3 from the Mac. Every change it makes also appends a line to the telemetry
  store's lifecycle log, which §12.5 re-applies after an app-database restore (migration 1).
- **`/join`** needs no session. It shows the privacy policy and the end-user agreement, which the
  Developer Terms require before sign-up (§V, 01f §1.5), and asks whether the person agrees to account
  notices by e-mail at the address Rem already holds; "I agree" sets a short-lived signed cookie naming
  the terms version; then "Connect Spotify". The claim of §5.1 succeeds only with that cookie, so
  nothing is stored for a person who has not agreed (A §10.2).
- **`SIGNUPS=owner|invite`**: `owner` refuses everyone but the admin whatever the rows say, at sign-in
  and, from Phase 2, at the identity read and the cron's claim, so one variable and a redeploy freeze
  every friend already signed in, with a test (completeness M3). Phases 1-3 run with it, and it is
  Phase 4's one-variable way back (C §4.1).
- **`status = 'disabled'`**, set by `user.mjs`, ends the user's sessions at their next request (the
  identity read) and their sync at the next claim, which leases only `active` users (§7.2).
- **Scopes** drop `user-read-email` and `user-read-private` (`src/lib/auth.ts:32-46`): development mode
  returns no email, nothing reads `product`, and no request uses `market=from_token` (C §10.2). It
  waits until a dev sign-in shows `/v1/me` still returns `account_id` with the smaller set, since no
  fetched page says which scope the field needs, and takes effect at each user's next consent.
- `src/lib/owner.ts` goes in Phase 4a, when the canary needs to get past it, after everything it guards
  against is gone (01c S18). Rem's Premium subscription becomes a dependency of every user: "If the
  owner's Premium subscription lapses, the app will stop working" (migration guide, quoted in 01f §1.2).
- **An empty install** (completeness M7). Past five, people run their own copy, and every new checkout
  starts empty, but after Phase 2 the app needs an app database, the owner's `users` row and database,
  `OWNER_UID` and `TOKEN_KEYS`, which §11.4 creates for Rem by hand. `npm run setup`, which today
  promises a new user "only has to paste their Spotify Client ID + Secret" (`scripts/setup.mjs:1-3`),
  creates them, with a harness test that boots the app from nothing (T18). Phase 2's lane updates
  `README.md`'s deploy and local-start steps (`README.md:26-45`). An own copy costs its owner their own
  Premium, developer app, Turso database and pinger, and about an hour of setup (01f option E;
  decision 10).

### 12.2 Privacy

- **Who sees what.** Each user sees only their own data; the plan has no cross-user feature. If the
  roadmap's friends features come, the one sanctioned way to read another user's data would be a
  single function, `forFriend(viewer, owner)`, that checks a consent table and opens the owner's
  database read-only, so a cross-user read is one call a reviewer can find (A §11). A sketch, not part
  of this build. Compare-a-friend and the static `/friends` page do nothing in development mode for
  anyone (`GET /users/{id}/playlists` is gone with "No replacement", 01f §1.2), so they are hidden for
  friends or labelled (completeness M4).
- **The operator.** Rem holds the credentials and can technically read any user's database; the
  privacy policy says so. The admin views show operational state per user (status, last success,
  failures, quota spend, store usage per database) and, for everyone but Rem, telemetry aggregated by
  endpoint template, without the playlist ids in raw paths or the track ids `handoff` beacons carry
  (security R15). There is no admin view of anyone's listening.
- **Telemetry** holds a uid, endpoint paths, timings and 429 reasons, no song names, for 30 days once
  the daily chores' prunes run (01a D32), and is deleted with the account. `server-error` rows
  (`src/instrumentation.ts:17-24`) carry a request path and no user; with no uid in any path (§9.1)
  they hold nothing that names a user, and they age out with the rest.
- **Derived metrics.** Listened time, skip verdicts and the all-time stats are "derived listenership
  metrics" on a plain reading of the Developer Policy (01f §1.5). They are shown only to the person they
  describe; comparisons between friends wait for Rem's decision (§18).
- **Retention.** Rem's own history: kept indefinitely; it is his record, and the importers exist to
  complete it. A friend's: kept while connected; capture pauses after 60 days without a sign-in
  (`dormant`, resumed at the next one); deleted at a disconnect (§12.3) and twelve months after the
  last sign-in (`users.last_sign_in`, which `auth_time` keeps at most 30 days stale for anyone who uses
  the app), so nobody's history is stored "indefinitely" (Developer Terms §IV, 01f §1.5). The twelve
  months is Rem's number to choose.
- **E-mail.** The Oct 14 version said there would be none; the allowlist needs each friend's Spotify
  e-mail, so Rem holds it (completeness M4). The policy names it, and notices (a dead grant, a pending
  deletion, a dormant account) go by e-mail only to those who agreed at `/join`, as Spotify's policy
  requires ("Don't email users unless they have provided you with their explicit consent", 01e §5.7),
  and in the app for everyone.
- **Deletion outside the app.** A friend removed from the allowlist can no longer sign in to press
  "Disconnect and delete", so the policy names a way to ask Rem directly (completeness M5).
- **Breach duty.** A suspected breach goes to `security@spotify.com` within 24 hours (Data Protection
  Appendix §9, 01f §1.5); the isolation events of §6.5, now e-mailed by the health check (§7.10), are
  the tripwire most likely to surface one, and §13.6 is the runbook.
- **The policy text** is Rem's to write or approve. It needs at least: what is collected (Spotify account
  and profile ids, the Spotify e-mail address Rem enters on the dashboard, display name, encrypted
  tokens, listening history, library, the stats derived from them), where it is stored and by whom
  (Turso in AWS us-east-1; Vercel's iad1 functions; request telemetry and backup staging on a laptop in
  Rem's apartment, through Tailscale; backups on OneDrive; cron-job.org, which sees the cron secret and
  a bare status), that an encrypted copy of a deleted friend's token can stay in the database vendor's
  point-in-time history for up to ten days (§12.3), retention, how to disconnect and delete, including
  by asking Rem, the operator's access, and the Developer Terms' minimum end-user terms (disclaimers,
  Spotify as third-party beneficiary).

### 12.3 Account deletion

**Triggers** (security R4, completeness H2, M5): the user's "Disconnect and delete" (the mechanism
the Developer Policy requires, 01e §5.8), behind a typed confirmation and a sign-in within the last 10
minutes (§5.4); Rem's `user.mjs --remove`, after a friend asks or after the health check reports a
friend `removed` from the allowlist for seven days; day 4 of `revoked`, unless the person signs in
first (§5.4); and twelve months without a sign-in. The friend's own request and Rem's removal run at
once; the rest run from the daily chores, which also retry. No trigger fires automatically while an
app-wide `invalid_grant` event stands (§5.4). Before it touches anything, the job refuses the admin
(`is_admin`), any database the `users` row does not name, and any database that is not `lb-u-<uid>`
for the departing uid with a matching `owner_uid`; test T11 pins the refusals. The job is one module,
run in the runtime for a disconnect and the daily triggers and from `user.mjs` for a removal.

0. Offer the export: "Disconnect and delete" first offers a download of the user's own history, built
   in the browser from the segments it already holds (§9.1). Before an automatic deletion, the notice
   (§12.2) says how long is left to sign in and download it.
1. `status = 'deleting'` and `session_epoch + 1`, so every session dies; delete the `sync_state` row,
   so the cron stops; delete the token row, so every Spotify call stops. Token writes are conditional
   on a live owner (§5.2), so a refresh in flight lands nothing after this step.
2. Destroy `lb-u-<uid>` through Turso's Platform API.
3. Delete the user's `api_log` and `client_metrics` rows on the telemetry store, and append a one-line
   record of the deletion there (§12.5 reads it after an app-database restore); if the Zenbook is
   down, every tick retries until it succeeds (§7.11).
4. Backups: the nightly job stopped copying this user when they entered `revoked` or `deleting` and
   keeps a friend's copies four days (§12.4), so the last one ages out by day four. The job reads the
   backup log's oldest file for this database on day five, and the health check reports a copy still
   there (migration 11).
5. After the lease window (50 s), delete the uid's `user_tokens`, `sync_state` and lock rows again and
   assert none remain (security R3); then set the `users` row to `deleted`, keeping only the uid,
   `account_id`, `status` and `status_at`, so a returning sign-in in the next five days is told the
   account was deleted and when (§5.1) and Rem can restore from Turso's undelete or a backup if the
   person asks. The daily chores delete the row after those five days.
6. The page tells the person to remove Lazy Boy at spotify.com/account/apps, since the app cannot
   revoke a grant, and the browser clears its stores (§6.2 layer 6).

**Why destroy, not empty.** Rows deleted inside a living database stay restorable through Turso's
point-in-time recovery for 1 day on Free and 10 on Developer, which on Developer outlasts Spotify's
five-day deletion term. A destroyed database leaves point-in-time recovery, and on paid plans "deleted
databases can be restored for up to five days" (Turso's docs, quoted in A §2.1 and C §8.1). Destroyed
at the request, with friends' backups aging out by day 4, every copy of a friend who asks is gone
within five days under any reading of "in your possession or control".

**Day 4 for a revocation, not day 0.** The Oct 14 version destroyed at once on an `invalid_grant`
under six months, so the copies would be gone inside five days under the strictest reading. The
reviews showed the price: a Spotify-side event that invalidates many grants would destroy every
friend's history in one run, an expiry could be filed as a revocation, and on Free nothing can be
undeleted (security R4, completeness H2). §5.4 now confirms the signal, refuses to act on an
app-wide one, and waits until day 4, when the person may have signed in again. The cost, stated: on a
paid plan the destroyed database stays restorable through Turso's undelete until about day 9, which the strictest
reading of the Terms would count; on Free there is no undelete. Rem's call (decision 21).

**Two copies outside the friend's database**, which none of the designs closed:

- **The telemetry store's backups.** STORE_MIGRATION phase D backs up the Zenbook file nightly and keeps
  60 days on OneDrive (its §9), so the friend's `api_log` and `client_metrics` rows deleted in step 3
  would survive there for two months. From Phase 4 the telemetry backup takes the friends' four-day
  retention (§12.4); it is diagnostics, and four days of restore points is enough.
- **The app database's point-in-time history** (1 day on Free, 10 on Developer) keeps the friend's
  `users` row and token blob after steps 1 and 5 change them. The identifiers in it (`account_id`,
  Spotify id, timestamps) are what the privacy policy names as held by the database vendor for up to
  ten days. The token blob is ciphertext under a key only production holds; the Oct 14 version rotated
  `TOKEN_KEYS` within five days of each deletion to make that copy unreadable, and the reviews showed
  what it costs: the key handled outside Vercel (security R9), every user stranded by one bad rotation
  (migration 9), and backups unreadable across it (completeness L2). The plan now names the encrypted
  copy in the policy instead, and rotates only on a suspected compromise (§5.3; decision 23). The
  person's own removal of the app at Spotify ends the grant whatever copy exists.

The destroy needs `TURSO_PLATFORM_TOKEN` in the runtime (§5.5). 01e §6 recommends taking it out once a
second user exists. The runtime already holds a group token that can read and drop every table, so the
platform token adds the power to create and destroy databases, and a deletion then cannot wait on a
laptop that is not always on. Keeping it, Production only and used by two functions, is the
recommendation (A, C; decision 24).

### 12.4 Backups

STORE_MIGRATION phase D's nightly job (lane 1904) with edits 4 and 7 of §10.2, extended (C §10.3):

- One `(database, retention)` entry per database: `("lazyboy", 60 days)` as today (the admin's
  database, read from `users`, not from the name), `("lazyboy-app", 4 days)`, `backstop.db` at 60 days
  (edit 7), and `("lb-u-<uid>", 4 days)` for each friend whose status is not `revoked`, `deleting` or
  `deleted`, read each night from the app database through the read-only group token, so a friend in
  `needs_reconnect`, `disabled`, `removed` or `dormant` still has a backup (completeness M5); from
  Phase 4, the Zenbook's telemetry file at 4 days too (§12.3). Retention applies on the Zenbook and on
  OneDrive alike.
- **The prune runs first**, per database and unconditionally, before any dump, and logs the oldest
  file it kept per database to the telemetry store, where `/usage` and the deletion job's day-five
  check read it. Today's `backup.py` prunes only at the end of a successful run, so one failed dump
  would skip every prune (migration 11). If the Zenbook is down across a deletion, the runbook prunes
  OneDrive from the Mac with the same `rclone delete` rule.
- Plaintext token and lock rows stripped from every copy before compression (until Phase 2's week is
  over, `lazyboy` still holds them). `user_tokens` rows are ciphertext whose key never leaves Vercel,
  so the app database's copies keep them and a restore keeps everyone signed in, provided the key that
  wrote them is still configured: after a rotation (§5.3), an app-database backup is taken at once, so
  no restore needs the dropped key (completeness L2). A restore of `lazyboy` from a nightly backup
  brings back no plaintext token, so Rem signs in once after it (§10.2 notes).
- Integrity check, source counts and one file per database; a restore test of each kind of database,
  run under §12.5's runbook before the canary (§13.2), not only in lane 1904's drill, which runs before
  `lazyboy-app` exists (migration 1).
- The backup job and its read-only group token stay on the Zenbook, but sqld and the meter, the
  services the Funnel exposes, move to a Unix account of their own with no read access to
  `~/lazyboy-backup`, the rclone config or `~/lazyboy-recorder` before a friend's data is backed up
  there (security R10; decision 27). Today all of them run as one account, and the meter parses every
  query POST it forwards, unauthenticated ones included (`ops/zenbook-meter/meter-proxy.mjs:110-145`).
- The cost: a friend's data lost more than four days back cannot be restored from a backup; Turso's
  point-in-time recovery covers the last day (ten on Developer). Rem's backups are unchanged.

### 12.5 Restores

Every Turso restore makes a database with a new name: "Restoring from a PITR creates a new database",
"You cannot restore from a PITR to a database that already exists", and the restored database needs a
new token or a group token (Turso's point-in-time-recovery page, quoted in migration 1); a dump
restore is a `turso db create` too (STORE_MIGRATION §8 step 6). The plan is built so a new name is safe:
names come from `users` and are compared on every request (§4.2), roles come from the row, and a
restored database gets a new `store_epoch`, so no cached version can be served under a counter the
restore re-issues (§4.5). The runbook, per kind of database (migration 1):

- **A user's database** (Rem's or a friend's): create it from point-in-time or a dump; check its
  `owner_uid`; write a new `store_epoch`; set the user's `sync_state` to `paused`; move `users.db_name`;
  delete the old database's `owner_uid`, so any process still holding it refuses it at the next open;
  resume. Warm instances pick up the new name at their next identity read or claim. Rem's restored from
  a nightly backup holds no plaintext token, so he signs in once (§12.4).
- **`lazyboy-app`**: restored state revives what changed since the copy, so before the pingers resume:
  delete every `users` row whose `lb-u-<uid>` no longer appears in `turso db list`, re-run their
  telemetry deletion, and re-apply every deletion and disable recorded since the copy in the telemetry
  store's lifecycle log (§12.3 step 3), which an app-database restore does not touch; bump every
  `session_epoch`, so sessions ended since the copy stay ended; then resume. Without this, a deleted
  friend's row and token would come back `active`, and the tick would refresh their grant before
  anything noticed their database was gone.
- **Rehearsed** before the canary (§13.2): restore the throwaway invite's database under a new name,
  see the app serve from it, then destroy it.

### 12.6 What a friend gets

Written once, sent with each invite, and kept on `/join` (completeness M4):

- **What works**: their own listening history and day view, search over their library and history,
  playlist cleaning and merging, the all-time card, Liked Songs mirrored. **What needs their own
  Spotify Premium**: starting playback, queueing, resuming and playing from a playlist ("This API only
  works for users who have Spotify Premium", Spotify's start-playback page); development mode no longer
  returns `product` from `/me` (01e §1.1), so the app cannot check first, and a 403 from a player
  endpoint says "needs Spotify Premium" instead of today's generic error (`src/lib/spotify/client.ts:196-201`).
  Comparing with friends does not exist (§12.2).
- **Where their history starts**: the first harvest stores their last 50 plays; earlier listening
  arrives only through Spotify's Extended Streaming History export, which waits for decision 30. The
  first library scan takes one to two minutes (§7.7); the day strip and the all-time card start nearly
  empty. A freshly provisioned user's Home renders with no plays (T18).
- **What can be lost**: capture runs on Rem's servers while the app is closed, with no recorder behind
  it (§7.9), so if their capture stops (a dead grant, a long outage), plays beyond their newest 50, about
  2.5-3.5 hours of listening (01c §5.7), are gone unless they export them from Spotify.
- **Retention and deletion**: kept while connected; capture pauses after 60 days without a sign-in;
  deleted on request within five days, or twelve months after the last sign-in; how to ask Rem
  directly; that Rem can technically read their data.
- **The cap**: five people in all, Rem included; removing someone from Spotify's list may be permanent
  if the dashboard's list is grandfathered above five (01f §1.2, decision 5).

## 13. Rollout in reversible phases

Every phase is its own deploy, and each has an exit check and a rollback measured in minutes, by the
recipe of §13.5. Until Phase 4a, `SIGNUPS=owner` keeps everyone but Rem out, so Phases 1-3 change how
the app is built and never who can reach it. Sizes as in the overviews: **S** one place; **M** a
contract that callers follow; **L** a design change or a mechanical edit across many files.

### 13.1 The phases

| phase | ships | starts after | exit check | rollback | size |
|---|---|---|---|---|---|
| **0**, now | Rem: rotate `AUTH_SECRET` in Production and give Preview its own value, and a day later delete the production deployments built before the rotation; set `SPOTIFY_OWNER_ID` in Production and `.env.local`; read the dashboard's User Management list, Vercel's Active CPU (team → Usage, 30 days) and Deployment Protection; copy `backstop.db` off the Zenbook; approve §10.2's edits. One lane: gate `logout` (01b E3); a dev sign-in at `127.0.0.1:3000`, with `TURSO_DATABASE_URL` unset so nothing reaches production, that logs the key names `/v1/me` returns, with and without the two scopes §12.1 drops; after the Oct 15 backup (08:40 UTC), the hash prefix of Rem's stored refresh token on a local copy against the pre-incident `d30e33fe` (01e §2.1, §8), which shows whether a sign-in mints a new refresh token (completeness H2). Rem: `/home?perf=1` on his phone, reading `paint=` | – | an old cookie refused after the redeploy; Rem signed in; `SPOTIFY_OWNER_ID` listed by `vercel env ls production`; whether `account_id` arrives; whether the refresh token changed | re-set the variables; revert the one-line guard; never Instant Rollback to the pre-rotation build | S |
| STORE_MIGRATION | lanes 1901-1911 with §10.2's edits; **P1** (the orphan predicate) inside 1910-1911 | Oct 15, 8 PM; Phase 0 before lane 1903's flip | its own R1-R6; P1's known-answer test | its own (STORE_MIGRATION §8) | – |
| interim | the second pinger with its 90-second guard (§7.9); the 122-play replay (§11.3) | lane 1904; Rem's go-ahead on each | ticks from both pingers with Spotify seeing one every 2 minutes; the Zenbook timer stopped for ten minutes and capture continuing; the replay's count equal to the recorder diff, `verify-derived` green | disable the cron-job.org job; the replay restored from its snapshot | S |
| **P2** | `plays.listened_ms` with NULL as pending, the accumulator advanced in SQL, the daily heal, `alltime_dirty` in `importTailStmts` (§8.3, §11.3) | lane 1911 and the replay | `SUM(listened_ms)` = `alltime_stats.durationMs`; T16; Turso's per-database reads for the all-time term near zero; a week of capture matching the recorder and no `drift` event | §13.5; the column is ignored, and the first pass after rolling forward fills what the older build left NULL | M |
| **P3** | segments (`no-store`, no uid in the path, the store epoch in every version) with their manifest and version bumps, lazy days, fetch at mount, `history-ready` on the history half, ≤ 50 painted rows, phase E's store keyed per segment | P2 and lane 1906; **before mid-December** (the catalog split, 01d O2, is the stopgap if it slips) | every month's segment equals that month's slice of `readHistoryIndex()` on one snapshot; 01d's throttled harness meets S1-S3 at 4×; `history-ready` on `/usage` | §13.5; rolling forward again moves the shape token, since the older build moved no month's version | L |
| **1**, owner only | `identity.ts` and the branded `Uid`; `requireUser()` on every entry point; `OWNER_UID`, epoch 0 and `auth_time` on the cookie, cookies without a uid refused (Rem signs in once); `AUTH_SECRET` rotated again; `forUser` over `lazyboy` with the versioned open (`min_reader`, schema steps from production only); `userCache` with owner stamps and the store epoch; keyed `cache()` boxes and module state; `playlistsCache` deleted; task owners; uid in ETags, bodies and storage keys; sign-out clearing storage; the token core in its own module with keyed maps and owner-carrying tokens, still reading the plaintext row; the health check (§7.10); §6.4's harness with its planted-bug self-test, T1-T3, T7, T8, T10, S1-S8, each shown failing first | P3 | `npm test` and `npm run build` green; an adversarial review of the diff; the rollback rehearsed; STORE_MIGRATION step 14's fault injection; then a week with zero isolation events, capture matching the recorder, Rem signed in, and one deliberate health-check failure that reached Rem's inbox | §13.5, never Instant Rollback (the secret rotated): the previous build ignores the cookie's extra claims and the four `meta` keys | L |
| **2**, owner only | `lazyboy-app`, `app-db.ts`, the users row, encrypted tokens with every key operation in the runtime, the identity read with its three outcomes and `SIGNUPS=owner` enforced in it, the decrypt rules and sentinels, the `events` table, conditional token writes, T5, T6, T9, T12; §11.4's steps | Phase 1's week, lane 1904, §11.2's re-check | §11.4 step 5, then three days | §11.4's rollback | M |
| **3**, owner only | `sync_state` and the claim joined to `users`; the per-user step, the 20-second reply and `after()`; the `/me/player` probe, written on change; track-change harvests with the tail retry, completeness at 25 and the backstop, still hourly; the owner alarm by caller and bare replies to cron-job.org; per-bucket cooldowns and the 429 `reason`; the uid and the harvest trigger on telemetry, the `handoff` beacon without song names; the open-app rules; the per-user time zone (`user_tz`); `refreshHistoryAction` off Spotify (decision 15); the rescan changes, Liked included (§7.7); paced background pages; the brake's counter, counting but inert; the daily chores run by a tick when overdue; T4, T13; then the second pinger at 45 s and the recorder hourly | Phase 2's soak | a week in which Rem's harvests come to ~150 against 280 on Oct 14 (01c §5.3), read from the trigger tags; every tick answers within 20 s; the open app harvests only catch-ups; no play first stored by a backstop while Rem was listening (the check on `/me/player` alone); the recorder diff empty; the second pinger proven by stopping the Zenbook timer for ten minutes; the fault injection re-run | the 45-second window back to 90, then §13.5 | L |
| **4a**, the canary | `/join`, the terms pages, `invite.mjs` with `--revoke` and expiry, `user.mjs`, the claim (`SIGNUPS=invite`); `/v1/me`'s non-403 failures no longer read as "not registered"; the two scopes dropped; the log-out split with the export; the deletion job with its guards; per-database backups with the prune first, friends' and telemetry's at four days; admin-only `/usage`, aggregated for friends; §6.6's bounds, the now-playing memo and 15-second polling, the 2-hour backstop; the brake switched on (N = 2); the Premium message; §12.6's text; `owner.ts` removed; T11, T14, T15, T17's harness, T18. The only invitee is a second Spotify account Rem controls; a free account is enough, since Spotify requires Premium only of the owner | Phase 3's week and §13.2's gates | after a week, checks that can fail (completeness H4): the canary's Home and search hold none of Rem's plays and Rem's none of the canary's; `api_log` attributes every call to the right uid; a planted probe (a cache entry forged under the canary's key and stamped with Rem's uid) produces exactly one isolation event, and its e-mail reaches Rem; the canary signed in once on Rem's browser after he signs out (the shared-device case) finds nothing of his in its stores; the fault injection re-run; then the canary leaves through the deletion job, which proves deletion for real | `SIGNUPS=owner` (one variable; every non-admin session and sync stops), then §13.5 to Phase 3, never Instant Rollback; a deletion in flight is finished by `user.mjs` | M-L |
| **4b**, the first friend | an invite | 4a's week | after a week: each user's scarce-bucket calls near §14.2's table; Turso's per-database usage near §8.6; no `QUOTA_EXCEEDED`; player calls inside what the app has run without a 429; isolation events at zero; the friend confirms Home shows only their own plays | `user.mjs --disable` or `SIGNUPS=owner`; the deletion job if they leave | S |
| **P4** | the Home payload patch with its compare-and-set and dirty mark, the open-tab fix, the strip from segments, the image-only marker, the `contexts` scan, one marker bump per batch | 4b's week, **before the second friend** | T17's scripted day, every non-append event with patched = rebuilt after each; the usage drop on Turso | §13.5; the patch has a flag | M |
| **5**, friends two to four | one person at a time, a week apart | P4 | each addition: the last week's recently-played spend plus the newcomer's expected share under ~426, or the brake tripping rarely; player calls a day inside what the app has run without a 429, or the poll slowed first; the read projection under 50% of the plan; Active CPU inside the plan | per friend, as in 4b | S each |

The irreversible steps, each named where it happens: invalidating the `lazyboy` token (§11.4 step 2,
answered by minting new ones), deleting the plaintext token rows a week into Phase 2 (§11.4 step 6,
still recoverable by decrypting), and a friend's account deletion once the four-day backups and
Turso's undelete window have passed (§12.3), which is irreversible by design. The replay only adds
rows and is undone from its snapshot. The Oct 14 version's deletion of foreign plays is gone (§11.2).

### 13.2 Gates before the canary, and so before any friend

- Phases 1-3 have each soaked on Rem alone, with their rollbacks rehearsed.
- **Vercel Active CPU** read (team → Usage → Active CPU over 30 days). No API open to Hobby reports
  it, and overrunning a Hobby allowance stops the feature for up to 30 days for every project on the
  team (01f §2.2-2.3). Stay on Hobby only if the team uses under ~2 of its 4 CPU-hours a month.
- **The dashboard's User Management list** read: how many accounts it holds, whether more than five
  survived Mar 9, and whether Rem's own account takes one of the five (01f §1.2). If it is
  grandfathered above five, removing anyone is permanent ("These limits only restrict what you can
  create or add going forward", 01f §1.2), the canary included.
- **The Turso plan** decided, before the canary's first sync (§15, §18).
- **Deletion and restore proven** on a throwaway invite: create the row and its database, restore the
  database under a new name by §12.5's runbook and see the app serve from it, then run the deletion
  job and see the database gone from `turso db list` and the rows gone.
- **Preview without store variables, dev on its own app database, no platform token in `.env.local`**,
  all confirmed.
- **Old builds out of reach**: every production deployment built before Phase 1 deleted; Deployment
  Protection at Standard or stricter; on Pro, Skew Protection off or a threshold set (security R1).
- **The health check live**, and one deliberate failure seen in Rem's inbox (§7.10).
- **The Zenbook's Funnel-facing services** (sqld, the meter) under their own Unix account (security
  R10).
- **Rem's decisions** on the policy text, retention, log-out, and the `invalid_grant` rule (§18).
- **An adversarial review** of the whole multi-user diff in a fresh context, told to find a
  cross-user path.

### 13.3 Order and timing

| step | waits for |
|---|---|
| Phase 0 | nothing; today, before the 7:05 AM push if Rem can, and before lane 1903's flip at the latest |
| STORE_MIGRATION | its own gates (Oct 15, 8 PM; STAT 139 first) |
| the interim pinger, the replay | lane 1904 |
| P2 | lane 1911 (both change `recordPlays`' neighbours and the derived checks) and the replay |
| P3 | P2 (the segment tuple carries listened seconds) and lane 1906 (the same load path) |
| Phase 1 | P3 (one lane in `db.ts` at a time; the mechanical edit should run over the final read paths) |
| Phase 2 | Phase 1's soak, lane 1904, §11.2's re-check |
| Phase 3 | Phase 2's soak |
| Phase 4a | Phase 3's soak and §13.2 |
| Phase 4b | 4a's week |
| P4 | 4b's week |
| Phase 5 | P4 |

[estimate, at the lane program's pace and with STAT 139 work first] STORE_MIGRATION through lane 1911
takes about a week from Oct 15; P2 a few days; P3 one to two weeks with its review; Phases 1-3 three to
five weeks with their soaks; the canary a week. That puts the first friend around mid to late December
at the earliest, a week later than the Oct 14 estimate, with P3 comfortably ahead of its deadline. The
single-user track before Phase 1 (decision 12) is part of that date: by the plan's own durations it
moves the first friend back about 1.5-2.5 weeks, and P3 alongside Phase 1 is ruled out by one lane in
`db.ts` at a time, so it is a real trade between the friend's date and merge risk (completeness L7).
The only hard date in the plan is P3, or the O2 stopgap, before mid-December. If Phase 1 has to start
before P3 for any reason, P3 is written against the uid-keyed interfaces of §6.2 with Rem's constant
uid, as phase E is (§10.2 edit 3), so nothing is written twice.

### 13.4 How it turns into lanes

- The mechanical part of Phase 1, threading `forUser` through `db.ts` (74 async exports, 54
  `getClient()` sites) and its callers (~235 call lines in `src/`, ~300 in `tests/`, upper bounds by
  grep, C §2.2), suits a Sonnet lane at medium effort with `tsc --noEmit` as its oracle.
- The pieces that carry the risk (the gate, the jwt callback and token core, the claim and the tick,
  the open-app rules, the deletion job) are Opus lanes at high effort, each followed by an adversarial
  review lane in a fresh context before deploy, the pattern of lanes 1902, 1906 and 1911.
- One branch per phase, rebased on `origin/main` before it pushes; one lane in `db.ts` at a time.
- **Building ahead of a phase's turn.** A lane may start a later phase's work early on its own branch,
  but only in new files (`identity.ts`, the token core's new module, `user-cache.ts`, the harness
  additions under `tests/`) and in files no queued lane edits. Lanes 1901-1911 edit `db.ts`,
  `store-fetch.ts`, the cron, metrics and search routes, `usage/page.tsx`, `instrumentation.ts`,
  `vercel.json`, the `(app)` layout, Home's load path and the meter (STORE_MIGRATION §6, §10; §10.2
  edit 3); P2 and P3 edit `db.ts`, the import scripts, the search routes and Home. Nothing from such a
  branch merges before its phase's place in §13.3, and it rebases when that comes.
- Each phase's lane updates the docs its change touches in the same branch: the `db.ts` header rule
  ("ONE client" becomes the client factory and `forUser`), `CLAUDE.md`, `docs/ARCHITECTURE.md`,
  `docs/GOTCHAS.md` (including its build-skew note, §10.2), `README.md` from Phase 2 (§12.1), and
  `docs/SECURITY.md`, whose checklist still says development mode allows 25 users (01f §1.2) and which
  takes the runbooks of §12.5, §13.5 and §13.6.
- Rem's own steps: Phase 0's environment changes and dashboard reads, re-enabling the cron-job.org
  job, the Zenbook's resolver and service account, the policy text, the canary and each friend's
  dashboard entry, and the decisions in §18.

### 13.5 Rollbacks

The Oct 14 version's cells said "redeploy the previous build" or "revert" without saying how, and on
this project the obvious ways misfire (security R1, migration 6). Vercel's Instant Rollback restores a
build with the environment it was built with ("won't update environment variables if you change them in
the project settings"); on Hobby it reaches only the immediately previous deployment; after it, Vercel
stops assigning production domains to new pushes; and since every push to `main` deploys production,
docs-only commits included, the immediately previous deployment is often a rebuild of the very phase
being rolled back (Vercel's instant-rollback page, quoted in both reviews). A `vercel redeploy` rebuilds
old code on today's variables. And something pushes `main` at about 7 AM (`origin/main`'s reflog: 7:05
AM on Oct 13 and 14), which would replace a redeployed older build while the phase is still on `main`.
So:

1. **Revert the phase's merge on `main` and push.** It is an ordinary production deploy of the old
   code on today's environment; it survives the morning push and keeps domain assignment on; it takes
   a build's few minutes.
2. **Instant Rollback only as a stopgap** while the revert builds, and only when the previous
   deployment is the pre-phase build and no secret or store credential changed in between. That rules
   it out across Phase 0 and Phase 1 (`AUTH_SECRET` rotated), Phase 2 (the `lazyboy` token
   invalidated) and Phase 4a (friends' cookies would meet pre-friend code). Undo Rollback once the
   revert is live.
3. **Environment changes are additive**, or the phase's cell says why the older build works with the
   new value: Phase 2's group token reaches `lazyboy`, so Phase 1's code runs on it.
4. **Each cell names the schema state it leaves.** Additive steps leave `min_reader`, so the older
   build opens the database (§4.5); a rebuild raises it, and that phase's rollback is the migrate
   script's reverse step, not a deploy.
5. **A boot check names a missing store variable.** Today a missing `TURSO_DATABASE_URL` falls back to
   `file:data/listens.db` (`db.ts:127-128`) and fails every query with a bare file-system error, which
   is what a rollback with the wrong environment would look like.
6. **Each phase rehearses its rollback** on Rem alone inside its soak; it costs minutes and is the only
   test the cell gets.

After each secret rotation (Phase 0, Phase 1), once the new build has run a day, the production
deployments built before it are deleted (`vercel rm <url>`; production keeps 30 days and always the
last 10, security R1), and before the canary every production deployment built before Phase 1 is
deleted. A rollback then cannot bring back an old secret, or put single-user code in front of a
friend's cookie, whose search routes, gated on a session alone (`src/app/api/search/history/route.ts:16`,
`src/app/api/search/library/route.ts:22`), would answer a friend with Rem's history.

### 13.6 A suspected cross-user exposure

The runbook, for an isolation event that is not a test, a friend's report, or anything else that
suggests one person saw or changed another's data (completeness M3):

1. **Freeze**: set `SIGNUPS=owner` and redeploy; every non-admin session ends at its next request and
   every non-admin sync at the next claim (§12.1).
2. **Keep the evidence**: the `events` rows and their codes, `api_log` by uid for the window, the
   deployment id, the request ids in Vercel's logs while they last (about an hour on Hobby).
3. **Work out whose data reached whom**, from the codes and the logs.
4. **Within 24 hours of suspecting it**, write to `security@spotify.com` (Data Protection Appendix §9,
   01f §1.5) and tell the affected friend directly.
5. **Fix**, move the affected shape tokens so every cached body is rebuilt, and run the whole suite
   with its planted-bug self-test.
6. **Unfreeze**, and add the case to the isolation suite.

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
near 30 ms: ~105 ms. S1 needs the IndexedDB copy: with the bodies `no-store` (§9.1), a device that has
lost it pays S2. Safari deletes it after seven days of use without a visit (WebKit, quoted in scale §3;
a web app added to the home screen keeps its own count), so a friend who opens Lazy Boy in Safari less
than weekly gets S2's numbers each time.

**S2, a first visit, 4× CPU, 10 Mbit/s:**

| step | a typical one-year friend | Rem today | basis |
|---|---|---|---|
| first paint → requests start | ~100 ms | ~100 ms | fetch at mount (§9.2); today up to 2 s of idle wait, or 800 ms on Safari |
| the gate and the bodies on the server, in parallel | ~50-300 ms | ~50-300 ms | identity ~15 ms, plus a TLS handshake in a cold process; a Data Cache hit ~50 ms, a miss rebuilds one month from an index range (~4,500-10,000 rows) [estimate]; the current month always rebuilds after listening |
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
| a five-year import, ~91,000 plays | ~2 MB in ~61 requests | ~3 s | **no**: the same newest-first loading, plus yearly segments for closed years; imports wait for both (§9.4, scale 9) |
| Rem on slow 4G (1.6 Mbit/s) | ~1.08 MB | ~5.5 s | **no**: the same newest-first loading, ~2.5 s to a usable box; slow 4G stays a stated miss (decision 13) |

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
| Spotify lists the play | in the first harvest for ~87% of plays; for ~13%, at a later one: the next track change's, or the tail retry ~5 minutes after the session ends | §7.4 [measured, scale 5] |
| **stored after the play ends** | **p50 ~1 minute, p95 ~5 minutes** | F2 |

The same cadence measured today: p50 72 s, p75 106 s, p90 240 s, p95 300 s, max 644 s, 88.4% within
125 s (Rem's 225 plays, Oct 12-14, scale 5). Phase 3's `lag_p50_s` and `lag_p95_s` confirm it per
user, and scale's scripts (`~/.claude/broke/scratch/lazyboy_mu/0224_review_scale/bin/`) re-run on a
fresh backup and `ping.log` give the before and after. **F1**: an open app shows a finished track at
once through its provisional play, and opening the app after listening elsewhere runs the on-load
harvest and the delta patch, so plays that ended before the open appear within ~1-2 s of first paint
[estimate, B §7.8], apart from Spotify's late listings, which the next harvest brings. **F3**: a
harvest fires by 25 track changes, at every session's end and again ~5 minutes later, and after 2
hours idle (hourly until the first friend); at Rem's peak of ~20 plays an hour (01c §5.7), 25 changes
take ~75 minutes, longer than any brake interval, so no play leaves Spotify's 50-play window unseen
while a pinger runs.

**The scarce bucket, a quota day** [estimate, from §7.4; the friend profiles are 01d §3.3's and 01f
§5.1's assumptions, not data]:

| user | track changes | session tails and their retries | idle backstops | open-app catch-ups | recorder | total |
|---|---|---|---|---|---|---|
| Rem, ~117-130 plays | ~125 | ~10 | ~7 | ~5 | 24 | ~170 |
| light friend, 40 plays | ~40 | ~10 | ~10 | ~10 | – | ~70 |
| typical friend, 50 plays | ~50 | ~10 | ~9 | ~10 | – | ~80 |
| Rem-like friend | ~125 | ~10 | ~7 | ~10 | – | ~150 |
| a friend with music on 10-12 hours a day, or a skip-heavy one | ~200-360 | ~10 | ~5 | ~10 | – | ~225-385 |

| users | demand a day | against 450 (426 + the recorder) | what the brake does (share = 426 ÷ N) | closed-app freshness |
|---|---|---|---|---|
| Rem alone | ~170 | 38% | nothing | p50 ~1 min, p95 ~5 min |
| Rem + one light, typical or Rem-like friend, an ordinary day | ~240-320 | 53-71% | nothing: nobody reaches 213 | the same |
| Rem on his heaviest day + a 10-12-hour friend | ~455-635 | 101-141% | each slows to 15-minute batches past 213; at 426 everyone goes to 30 | the same for most of the day, then ≤ 15, and ≤ 30 late |
| Rem + four light | ~450 | ~100% | Rem passes his ~85 a little past halfway through his listening and moves to 15-minute batches; the friends never reach theirs | the friends as Rem alone, all day; Rem ≤ 15 min after his share |
| Rem + four typical | ~490 | ~109% | the same: Rem slows, the friends stay under ~85 | the same |
| Rem + four Rem-like | ~770 | ~171% | everyone reaches ~85 about 60% into their day, when the total nears 426, and moves to 30-minute batches; the day's total is held near ~505-560 (scale §2) | as Rem alone for ~60% of the day, then ≤ 30 min |
| any mix, if the quota is per user | – | – | nothing | as Rem alone, all day |

Today, for comparison: 139-319 cron harvests plus the recorder's 96 for Rem alone (01c §2.7). Five
Rem-like users on today's policy would need ~800-1,700 a day (01c §5.1). The Oct 14 version's row for
five Rem-like users had everyone slowing to 15 minutes at ~320; its own source says the ¾ step it used
could not fire for users of equal weight (A §13.3, scale 1), which is why the per-user cap replaced it.

### 14.3 Users (U)

| resource | per Rem-like user a day | five Rem-like | limit |
|---|---|---|---|
| allowlist places | 1 | 5 | 5 (01f §1.2) |
| Turso databases | 1 | 6, plus the old `lazy-boy` | 100 on Free |
| recently-played and `/me` calls | ~150-170 | held near ~505-560 by the brake | ~725-800 observed; 450 planned |
| player calls | probes ~720 with up to two users, ~450 from three on; now-playing ~240-480 per visible hour per browser at 15 s | ~2,250 from probes, plus ~3,600-7,200 from five app-heavy users' visible tabs [estimate, scale 6] | unknown; 1,336 the busiest day so far, with no 429 |
| Spotify calls per 30 s, at peak | – | ~2-3 from ticks, ~10-15 from five visible tabs at 15 s, background pages paced | 56 measured without a 429; the limit is unpublished |
| Turso rows read | ≤ 1.5M on a heavy day after P4 (§8.6) | 30-306M a month by profile and step (§14.4) | 500M (R4: 250M) |
| Turso rows written | ~4,500-5,000, index entries counted | ~0.72-0.8M a month | 10M (R4: 1M) |
| Vercel invocations | ~200 browsing (Rem's measured profile) to ~1,000 (Home visible three hours, scale 11); the tick is 1,440 a day in total | ~73,000-195,000 a month | 1,000,000 (Hobby) |
| Vercel provisioned memory | – | ~100-110 GB-h a month at five app-heavy users [upper bound, scale §2] | 360 GB-h (Hobby) |
| Vercel Active CPU | unmeasured; Rem's share today estimated at 0.5-2.4 CPU-hours a month (01f §2.3), and an app-heavy user makes up to ~5× his invocations | 2.5-12 if it scaled with Rem's profile, more with app-heavy friends | 4 (Hobby, team-wide) |

Five accounts fit every budget but two unknowns: Active CPU, which Rem reads before the canary
(§13.2), and the player bucket, on which each Phase 5 addition gates (§13.1). §14.7 shows what binds
past five.

### 14.4 Store reads, writes and growth (D1-D3)

Per user on a heavy day, §8.6's table: Rem ~1.53M after P3 and ~0.39M after P4; an app-heavy Rem-like
user ~2.17M after P3 and ~0.46M after P4. D1 (≤ 1.5M) is met by Rem at about P3 and by everyone after
P4; D2 holds after P4, when nothing on a per-play, per-tick or per-visit path grows with history.

Five users, a month, all friends app-heavy (eight Home visits a day, Home visible three hours). The
friend profiles are assumptions [estimate, the same per-run costs applied to each profile's history
and library]:

| five users | per friend a day, after P3 / P4 | after P3 | after P4 |
|---|---|---|---|
| Rem + four light (40 plays a day, 7,200 plays, 2,000 library songs) | ~0.46M / ~0.15M | ~101M (20%) | ~30M (6%) |
| Rem + four typical (50 a day, 18,250 plays, 8,000 songs) | ~0.95M / ~0.29M | ~160M (32%) | ~46M (9%) |
| Rem + four app-heavy Rem-like, at Rem's history size | ~2.17M / ~0.46M | ~306M (61%) | ~67M (13%) |
| the same a year in, ~42,000 plays each | ~2.78M / ~0.52M | ~379M (76%) | ~74M (15%) |
| either of the last two with "See all" left open while listening | + ~1.84M a friend | past 500M: Free blocks every query until the 1st | unchanged |

Each cell is (Rem's day + 4 × the friend's day) × 30 against the free plan's 500M. The open-tab term
(§7.6) is ~0.04-0.05M a day for the light and typical friends, whose strips are smaller. The app-heavy
friends' biggest terms after P3 are the whole-history strip and the open tab, which is why P4 ships
before the second friend: they are the per-visit reads left that grow with each user's history. On the
Developer plan (2.5B included, 01f §4.2) the largest cell is under a quarter of the allowance, and even
today's code at five Rem-like users on an average day (~1B a month [estimate: 5 × ~6.7M × 30, §8.6's
today column with the orphan passes averaged]) fits with no block, which is why §15 recommends it as
insurance rather than as capacity.

**D3**: ~4,500-5,000 rows written per Rem-like user a day, index entries counted (§8.6), ~0.72-0.8M a
month at five, 7-8% of the free plan; a friend with thousands of Liked Songs needs Phase 3's Liked
change to stay inside it. **Growth**: ~35 KB of core data a day for a Rem-like user (01a §6), ~12 KB
for a light one; five heavy users add ~64 MB a year against 5 GB.

### 14.5 Uptime (A1-A3)

| failure | user requests | closed-app capture | plays lost |
|---|---|---|---|
| the Zenbook down: the nightly reboot (~6-8 minutes around 07:00 UTC, 01f §3.3), and outages like late August and September's, about ten days in four weeks (migration 2) | unaffected after STORE_MIGRATION; telemetry dropped; `/usage` shows its log sections empty | from lane 1904, the interim pinger keeps everyone at 2 minutes; before it, capture stops, and Rem's recorder stops with it | none from lane 1904; before it, plays beyond the newest 50, recoverable only through Spotify's export, which takes days to weeks |
| the Zenbook frozen (103 stalls over 100 s in four weeks, STORE_MIGRATION §1) | unaffected: telemetry is never awaited on a user path and gives up at 4 s (R2; static check S7) | as above | none |
| the Funnel certificate (expires Nov 8; lane 1907) | `/usage`'s log sections | unaffected | none |
| cron-job.org down | none; the health check's e-mails stop | the Zenbook's timer | none |
| both pingers down | none | an open app captures for its own user (§7.6); otherwise the daily Vercel cron on `/api/cron/sync` (07:00 UTC ± 59 min), kept beside `/api/cron/daily` (§10.2 edit 8); the health check e-mails Rem within the hour | each user's plays beyond their newest 50, ~2.5-3.5 hours of nonstop listening (01c §5.7), unless they open the app; Rem's recorder covers him unless the Zenbook is the one down |
| one user's grant revoked, allowlist entry removed, database refused, or Spotify calls hanging | that user only | that user only | that user's, beyond 50, until they reconnect |
| `lazyboy-app` unavailable: blocked, refused, or broken by a migration (migration 5) | everyone: the identity read answers the retryable error, nobody is signed out and no browser store is cleared (§5.1) | everyone: ticks end at the claim | the 50-play rule, everyone; a broken database is restored by §12.5 |
| a wrong, truncated or missing token key deployed (migration 9) | everyone: the deploy refuses to serve at its sentinel check (§5.3) | everyone, until the variable is fixed and redeployed; no user's state changes | the 50-play rule; nobody has to sign in again |
| Turso down | everyone | everyone | the 50-play rule, everyone |
| Turso Free's read quota exceeded | everyone, until the 1st (01f §4.2) | everyone | the same; Developer with overages turns it into a bill |
| Vercel down, or a Hobby allowance overrun | everyone; an overrun lasts up to 30 days and takes the team's other projects too (01f §2.2) | everyone | the same |
| Spotify suspends the app, or Rem's Premium lapses | Spotify features, everyone | everyone | the same |
| a recently-played `QUOTA_EXCEEDED` | none beyond history updates | harvests wait for the ~10:50 AM reset; probes and rescans continue | the 50-play rule; the brake makes it unlikely |
| a player-endpoint refusal | the now-playing chip slows | harvests every ~30 minutes for users active in the last 3 hours (§7.8) | none while 30 minutes of listening stays under 50 plays |

A1 holds once STORE_MIGRATION lands and stays held while the fault injection passes at each phase
(§6.5). A2 holds from the interim pinger, after lane 1904; the Zenbook's resolver fix (decision 9)
keeps the recorder alive through the same DNS failures. A3 holds by §7.8 from Phase 3. What remains is
shared fate on managed services and on Spotify's policy, none of which this app can remove at its
scale (C §14 item 5); `lazyboy-app` is new shared fate of the same kind, on every request.

### 14.6 Isolation and its cost (I, I$)

I is met by §6.3: each class has a layer that prevents it and one that detects it, the suite runs on
every `npm test` with its planted bugs, and the canary week exercises the runtime layers with two real
users before any friend. Its cost:

| what | per request | per tick | how known |
|---|---|---|---|
| identity, status, token, capture health and cooldown in one statement | no extra round trip where the gate already ran first; Home +1 sequential round trip (~15 ms), and in a cold process a TLS handshake to the app database's host (~30-45 ms in all [estimate, scale 10]); three fewer reads | one claim; one token row per due user | from the code |
| the owner check on the first open per `(uid, db_name)` | none when warm; in a cold process it rides the first read's batch, so no extra round trip, where `init()` spends eight | the same | §4.5 |
| token decrypt / encrypt | 1.67 µs / 2.67 µs | per due user | measured by A on the Mac (A §17) |
| the owner stamp on cached values; the token-owner assertion | a few bytes and a compare; one compare per Spotify call | – | from the design |
| conditional token writes; the `events` table | a primary-key probe inside each token write; nothing while no event happens | – | §5.2, §4.2 |
| uid in browser keys and ETags | none: a random uid needs no HMAC | – | §4.4 |

I$ holds: one round trip on a warm Home, plus a handshake in a cold process; microseconds elsewhere.

### 14.7 Past five users

Spotify allows five accounts on this app (§1), so 25 and 250 exist only on a grandfathered list or a
changed policy; past five the plan sends people to their own copies, which share nothing and scale
without limit (01f §5.2 option E). The brief asked how things scale, so here is what would bind first
if the cap moved, for app-heavy Rem-like users with the levers through P4 applied [estimate; scale §2
has the full table at 5, 25 and 250]:

1. **Spotify's allowlist at six**, a policy limit no design changes.
2. **Money, in small steps**: Hobby's Active CPU somewhere between 2 and 25 users (unmeasured, read in
   Phase 0); Turso reads at R4's 250M bar around 18 users and at Free's 500M block around 36 (250M ÷
   (0.46M × 30)); Hobby's provisioned memory near 25; Turso Free's 100 databases past 98. Pro is $20
   a month and Developer $4.99, so none of these is a wall.
3. **The scarce bucket, under the shared reading**: at the brake's floor of ~35-40 harvests a user a
   day (30-minute batches over ~9 hours of playback, plus tails, backstops and app opens), the app
   passes the 450 budget at ~12 Rem-like users and the ~725-800 ban line at ~19-21. From there it is
   banned daily however the brake is tuned, and a heavy listener loses plays during each ban: past ~20
   users the brake can no longer protect completeness. Under the per-user reading it never binds.
4. **Library rescans at ~30-45 active users**: one per tick is 1,440 a day, against 32-48 wanted per
   active user; several rescans per tick under one shared deadline lifts it.
5. **The 30-second window** from the ticks alone around 200-250 users, at the measured floor of 56.

At 25, everything but the scarce bucket fits with money; at 250, the bucket, the rescan cadence and
Vercel's plan would all need redesign, which is why the plan's answer past five is a copy per person.

## 15. Costs

Money, a month, at 01f §2.2 and §4.2's prices (fetched Oct 14):

| item | until the first friend | five users | basis |
|---|---|---|---|
| Turso | $0 (Free) | **$4.99 billed yearly ($5.99 month to month)** on Developer with overages, recommended from the canary's first sync (decision 17); $0 if Rem stays on Free, which §14.4's projections hold once P4 ships | 01f §4.2 |
| Vercel | $0 (Hobby) | $0 if the team's Active CPU stays under ~2 of Hobby's 4 hours; otherwise Pro, $20 including $20 of usage | 01f §2.2-2.3 |
| cron-job.org: the second pinger from lane 1904, the hourly health check from Phase 1 | $0 | $0 | its free tier, which the app's earlier jobs used |
| the Zenbook | $0 | $0 | runs anyway for the recorder, telemetry, backups and DiveLoop |
| Spotify | $0; Rem's Premium is required for the app to work at all | $0 | friends cannot be charged: the app controls playback, which makes it a Streaming SDA, and those may not be used commercially (01f §1.5) |
| **total** | **$0** | **$5-26 with Developer; $0-20 on Free** | |

Isolation itself adds $0: the databases are free (100 on Free, unlimited on paid plans, idle ones cost
only storage), encryption is Node's built-in `crypto`, and the tests run in the existing harness. The
reviews' additions cost rows, not money: the interim pinger's stamp ~720 rows written a day, the daily
heal ~0.02M rows read a day for Rem, the health check a handful of primary-key reads an hour (§8.6).

What the Developer plan buys besides capacity, which is why it is recommended although five users fit
Free after P4: a month's reads past the allowance become a bill ($1 per billion) instead of a block on
every query for every user until the 1st, which is what August's regressions did (READ_QUOTA "Where
August actually went"); ten days of point-in-time recovery for Rem's own data instead of one; and a
five-day undelete for a destroyed database. The undelete is extra room after a deletion, not the grace
the plan rests on: a revocation already waits four days before anything is destroyed (§12.3). It also
keeps a deleted friend's database restorable at Turso until about day 9, which decision 21 weighs.

**Work**, in §13.1's sizes (**S** one place, **M** a contract callers follow, **L** a design change or a
mechanical edit across many files), with Rem's own part of each [time is an estimate at the lane
program's pace, §13.3]:

| step | size | Rem's part |
|---|---|---|
| Phase 0 | S | ~30 minutes: two variables, three dashboard reads, deleting the old deployments a day later, a copy of `backstop.db`, `paint=` on his phone |
| STORE_MIGRATION, with P1 | as planned, ~1 week | approving §10.2's edits (decisions 2-4) |
| the interim pinger, the replay | S | re-enabling the cron-job.org job with the new secret; the replay's go-ahead |
| P2, then P3 | M, then L; P2 a few days, P3 one to two weeks | none beyond the deploys |
| Phases 1-3 | L, M, L; three to five weeks with their soaks | one sign-in at Phase 1; Phase 2's Mac steps with a lane (§11.4); creating the health check's cron-job.org job |
| Phase 4a, the canary week | M-L, a week | the policy text, a canary account, the Zenbook's resolver and service account, the Turso plan, the dashboard entry |
| Phase 4b, then each friend in Phase 5 | S each, a week apart | the dashboard entry and the invite |
| P4, before the second friend | M | none beyond the deploy |

## 16. Unknowns and risks

### 16.1 Unknowns, and what answers each

| unknown | where it matters | answered by |
|---|---|---|
| whether Spotify's development-mode quota is one pool or one per user | §7.5, F2 | the passive check (§7.9): after the first refusal §7.8 lets one other user's harvest through, so the first ban answers it; the plan is safe under both readings |
| the player bucket's daily limit, and the 30-second rate limit's real number | §7.6, §14.3; every harvest is triggered by a probe in that bucket | a player-endpoint 429 with its `reason` in `api_log`; until one comes, the envelope the app has already run without a 429 (1,336 player calls in a day, 56 calls in 30 s, scale 6-7) gates each Phase 5 addition |
| the team's Vercel Active CPU | Phase 4a's gate, §15 | Rem, on the dashboard, in Phase 0 |
| how many accounts the allowlist holds, whether any are grandfathered, whether Rem counts toward five | U | the dashboard's User Management list, in Phase 0 |
| whether `/v1/me` returns `account_id` to this app, and under which scopes | §5.1, §11.4, §12.1 | Phase 0's dev sign-in; Phase 2 stops at its first step if it does not (decision 31) |
| whether a sign-in mints a new refresh token, so that a re-consent restarts Spotify's six-month clock | §5.4's expiry rule | Phase 0's hash-prefix probe on the Oct 15 backup (01e §8, completeness H2); `granted_at` moves only with a new token, so the rule holds either way |
| what besides revocation and expiry makes Spotify answer `invalid_grant` (a password change, a client-secret rotation) | §5.4 | undocumented (01e §8); the app-wide rule of §5.4 keeps the plan safe without the answer |
| R1 on Turso, and the payload build time from iad1 | every latency in §14 | lanes 1902-1903's bench route |
| whether `changes()` after an `INSERT OR IGNORE` reports that insert inside a Turso batch | §8.3's accumulator | P2's lane, before relying on it; the fallback is a `through_id` over the rowid range of new plays (migration 3) |
| whether Turso bills an unfiltered `count(*)` per row or per page | §10.2 edit 4's cost: ≤ ~45,800 rows a night or a few hundred | Turso's usage read before and after one backup |
| whether a token minted for `lazyboy` is refused by another database in the group | §5.5, what dev can reach | Phase 2 step 4's check against a throwaway `lb-u-test` (security R8) |
| what removing Preview from a shared Production + Preview variable does | §10.2 edit 2 | `vercel env ls production` after the edit, before any redeploy (migration §2) |
| whether `/me/player` alone ever misses playback that currently-playing sees | §7.3 | Phase 3's soak: no play first stored by a backstop while Rem was listening, read from the trigger tags (§7.4) |
| keystroke-to-paint on a real phone | S3 | Phase 0's `lb-perf` read on Rem's phone |
| how friends listen and how often they open Home | §14.2, §14.4 | the canary week, then Phase 4b's; Turso's per-database usage |
| whether `cache()` is active in route handlers, whether Preview and Production share the Data Cache, and how Fluid compute mixes users in one instance | §6.2 | not needed for correctness: the owner stamps and the keyed boxes hold either way; the canary week is the first production run with two users (completeness H4) |
| the Data Cache's size and hit rate under the team's other projects | §9.3 | not observable on Hobby; an eviction costs one month's rebuild |
| what "Turso is joining Supabase" means for plans and prices | §10.1 | Turso's announcements; each user's data stays portable |

Answered since Oct 14, so out of the table: how often Spotify lists a play late (13% miss the first
harvest after them, scale 5); whether the identity-first predicate matches on current data (all
22,040 plays of the Oct 14 backup, scale §3); the incident's window, since there are no foreign plays
to find (migration 7); whether the production secrets are Vercel's write-only type (all `sensitive`,
security §2); the Zenbook's outage record (about ten days without capture in four weeks of August and
September, migration 2); the busiest 30-second window without a 429 (56 calls, scale 7); and whether
point-in-time recovery outlives a destroyed database ("PITR restores an existing database — it cannot
bring back a database that was deleted", Turso's page, re-read by migration §3; only the paid plans'
five-day undelete can).

### 16.2 Risks the plan carries

- **A wrong uid compiles.** The branded type stops a uid made from request input; it cannot stop a
  real uid used in the wrong place, such as the cron handing user A's uid to user B's step. The step
  receives its arguments and touches nothing else, T4 checks that each user's play lands in that
  user's file, and the token-owner assertion and owner stamps catch a mismatch at runtime (C §16.2).
- **One token reads everything.** The group token reaches every user's data and cannot be revoked
  alone (B §19). It is a `sensitive` Vercel variable, as every production secret already is
  (security §2), and Phase 2 invalidates the cutover's `lazyboy` token before minting it (§11.4).
- **The app database is on every request.** From Phase 2 a blocked, refused or broken `lazyboy-app`
  stops every user while every user database is healthy. The identity read's "unavailable" outcome
  keeps people signed in and their browser stores intact, and §12.5 restores it (migration 5, §14.5).
- **People run the runbooks.** Restores, rollbacks, the incident freeze and Phase 2's token move are
  steps someone follows, each rehearsed once (§12.5, §13.2, §13.5, §13.6). A step out of order, such as
  an Instant Rollback across a secret rotation or moving `users.db_name` before the new `store_epoch`
  is written, is the likeliest way left to hurt data.
- **A false deletion.** A friend who removed the app by mistake and does not sign in within four days
  loses their history: on Free nothing is left, and on Developer Turso's undelete keeps it to about
  day 9 (§12.3, decision 21).
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
- **Spotify can change the terms under the plan.** The brake plans to 60% of a limit Spotify says "may
  change"; the player bucket that triggers every harvest has no known limit; and development mode went
  to five users from Mar 9, 2026 (01f §1.2). The 429 `reason` with per-user attribution shows the first
  sign, and the health check reports a player refusal (§7.8).
- **Rollbacks assume Spotify keeps not rotating this app's refresh tokens** (01e F2); if it starts, a
  rollback costs Rem one sign-in (§11.4).
- **Cross-site scripting** acts as its victim only (the session cookie is httpOnly and server actions
  run as the victim). With every admin mutation moved to scripts on the Mac (security R11), one in
  Rem's session can read what he can read but cannot destroy a friend's data. The text the app renders
  comes from Spotify, where anyone can name a playlist, so React's escaping stays the main defence; a
  nonce-based CSP stays on `docs/SECURITY.md`'s checklist, not a multi-user blocker (01e §5.10).
- **Publication.** The repo is public, and these documents describe today's exposures in detail; the
  next push of `main` publishes them (decision 1).
- **Policy.** Storing friends' history and showing derived listening stats sit against the Developer
  Terms' storage rule and the Policy's "derived listenership metrics" line (01f §1.5). The plan
  narrows the exposure (each user sees only their own stats; retention; deletion inside five days);
  accepting the rest is Rem's call. This is an engineer's reading, not legal advice.

## 17. What the first lane ran (Oct 14)

Nothing ran against the production store, the Zenbook, Turso, Vercel or Spotify, and nothing was
written except this file (and a one-off formatting script in this lane's scratch, deleted at the end).
On Oct 14, about 11:03 PM to 11:45 PM, on the Mac:

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

Each with a recommendation and its reason, numbered as in §0 and grouped by what it blocks. The Oct 14
version numbered them differently; §19 quotes the reviews, which use the Oct 14 numbers, and names the
decision each became. Each phase's production deploy, and each step that writes Rem's data (the replay,
P2's fill, Phase 1's four `meta` keys, Phase 2's token move), also waits for his go-ahead when it comes;
those approve a reviewed step rather than choose a design, so they are not numbered here. The end of
this section says which build work waits on which decision.

**Now: before the 7:05 AM push, and before lane 1901 (Oct 15, 8 PM)**

1. **Phase 0.** Rotate `AUTH_SECRET` in Production with a separate value for Preview, and a day later
   delete the production deployments built before the rotation; set `SPOTIFY_OWNER_ID` in Production
   and `.env.local`; let one lane gate `logout` and run the dev sign-in and the refresh-token probe
   (§13.1). *Recommend yes, today, and before lane 1903's flip at the latest.* The browser that signed
   in as the second account before the guard still acts as Rem, and its log-out can stop his capture
   (01b E1-E3, 01e F1). The Oct 14 version said that session ends about Nov 13. It does not: Auth.js
   re-issues the cookie on every `GET /api/auth/session`, so only a rotation ends it (security R5). It
   costs Rem one sign-in. Separately, the repo is public, local `main` is 238 commits ahead of
   `origin/main` (`git rev-list --count`, 1 AM Oct 15), and something pushes `main` at about 7:05 AM
   (`origin/main`'s reflog: Oct 13 and 14), which publishes these documents and the overviews'
   description of that session and of the ungated `logout`. *Holding that push is optional*: the
   description hands nobody the incident's cookie, and `logout`'s action id is not on the public
   `/login` page (security §5). Phase 0 closes both exposures either way.
2. **STORE_MIGRATION's edits** (§10.2): edits 1-5, 7 and 8, and its notes to the lanes. *Recommend yes,
   before lane 1901.* None touches the cutover's logic. Edits 2, 4 and 5 close live exposures (Preview on
   the production store, 13-scope grants in every backup, plaintext copies in scratch); edit 7 protects
   the only copy of 122 of Rem's plays; edit 8 moves the daily chores off the Zenbook's reboot hour and
   keeps the sync route's daily entry as the last-resort capture. No review found anything in lanes
   1901-1911 that should wait.
3. **P1 inside lanes 1910-1911**: the identity-first "From" predicate shipped with the scoping (edit
   6). *Recommend yes.* On the Oct 14 backup copy it gives the same verdict on all 22,040 plays and walks
   ~2.6 rows a play against ~380 (scale §3; the Aug 11 copy agreed, §8.2). Scoping alone leaves a busy
   playlist's pass at plays × members, which the meter hides (01c §2.8). The lane pins it with a
   known-answer test.
4. **The three log tables stay on the Zenbook** (STORE_MIGRATION §4's open question). *Recommend yes,
   as Rem said on Oct 13.* Multi-user adds a reason: on Turso, five users' `api_log` would be ~0.6M rows
   written a month, which with the core writes passes R4's 10% bar (§10.2). The cost is `/usage`'s log
   sections during a Zenbook outage and the Funnel certificate that lane 1907 renews.
5. **Three one-minute dashboard reads**: Spotify's User Management list (how many accounts, whether more
   than five survived Mar 9, whether Rem's own account takes one of the five), Vercel's Active CPU per
   project over 30 days, and the project's Deployment Protection setting. *Recommend now.* They settle
   target U, the Vercel plan (decision 18) and one of §13.2's gates. If the list is grandfathered above
   five, removing anyone from it is permanent ("These limits only restrict what you can create or add
   going forward", 01f §1.2), the canary included.

**Around the store move (lane 1904)**

6. **Copy `~/lazyboy-recorder/backstop.db` off the Zenbook now**, once, until edit 7's nightly copy
   exists. *Recommend yes*; it is a minute's work. It holds the only copy of 122 of Rem's plays (56 on
   Aug 9, 60 on Aug 10, 6 on Sep 8), and nothing backs it up (migration 8).
7. **Replay those 122 plays** with `scripts/backfill-from-backstop.mjs` after lane 1904 and before P2's
   fill, with a snapshot first. *Recommend yes.* It writes production data, so it is Rem's to approve. It
   inserts only plays that are missing and re-rules their edges (`1ac38fa`); on an older snapshot copy
   it inserted 166 plays, then 0 on a re-run (the D1 entry, `.claude/QUEUE.md:16`). Run before the
   fill, P2 counts them (§11.3). The Extended Streaming History import for Aug 30-Sep 9 takes the same
   slot once Rem's export arrives.
8. **An interim second pinger** right after lane 1904: today's route accepts a second secret and skips a
   tick within 90 s of the last one, and Rem re-enables the cron-job.org job with the new secret.
   *Recommend yes.* Until Phase 3, six to seven weeks later [estimate, §13.3], the Zenbook is the only
   frequent capture trigger, and in late August and September it lost about ten days of capture in four
   weeks (migration 2). Cost: ~720 rows written a day, $0. Re-enabling the job is Rem's step because
   STORE_MIGRATION's lanes read R6 as forbidding it.
9. **A resolver on the Zenbook that does not depend on Tailscale.** *Recommend yes*, as an ops change
   outside the lanes. Its only resolvers today are Tailscale's (`/etc/resolv.conf`, read Oct 15), which
   is how one tailscaled fault took the pinger and the recorder down together for days in September
   (migration 2).

**The design, before Phase 1**

10. **Five accounts, Rem included; past five, each person runs their own copy.** *Recommend yes.* It is
    Spotify's cap for an app in development mode, and extended quota mode takes only organizations with
    at least 250k monthly users, so no money changes it (01f §1.2-1.3). An own copy costs its owner
    their own Premium, developer app, Turso database and pinger and about an hour of setup (01f option
    E), and works only once `npm run setup` provisions an empty install (§12.1, completeness M7).
11. **A database per person.** *Recommend yes.* A forgotten filter becomes impossible instead of
    unlikely, Rem's data does not move, and deleting a person is destroying one database (§4.1, §12.3).
    Revisit only if friend features that join across users become the priority.
12. **The single-user performance track before the multi-user phases** (P2, then P3 before
    mid-December). *Recommend yes.* With P1 it cuts Rem's own heavy-day reads from ~19M rows to ~1.5M
    (§8.6) and removes the late-December cache cliff, whether or not anyone else signs in. The cost: the
    first friend arrives about 1.5-2.5 weeks later [estimate, completeness L7], since one lane in `db.ts`
    at a time rules out running P3 beside Phase 1 (§13.3).
13. **The search target's device and network**: a mid-tier phone (4× CPU) at 10 Mbit/s, with slow 4G a
    stated miss. *Recommend yes.* Meeting slow 4G on a first visit takes newest-first loading, an M-sized
    change nothing else needs yet (§14.1).
14. **An e-mailed health alarm from Phase 1**, which lifts STORE_MIGRATION's R6 ("No new alerting
    mechanism") for the multi-user phases while it keeps binding lanes 1901-1911. *Recommend yes.* Today
    nothing that goes wrong notifies anyone: the Zenbook unit's `OnFailure=` is empty and everything
    else ends on a page (completeness H1). Friends' data, Spotify's 24-hour breach notice and the
    five-day deletion clock all depend on someone noticing. It is an hourly cron-job.org job with failure
    e-mail calling `/api/cron/health` (§7.10), at $0.
15. **The forced refresh stops calling Spotify in Phase 3.** *Recommend yes.* At a track change Home
    shows the provisional row at once and the stored row after the next tick, up to ~2 minutes later,
    instead of after an immediate harvest (§7.6). It removes an undebounced harvest and a concurrent
    writer of the new derived totals (migration 3). The other Phase 3 changes the Oct 14 version made to
    Rem's app, 15-second polling and the 2-hour backstop, now wait for the first friend (completeness L6).

**Before the first friend (Phase 4a)**

16. **A canary week**: Phase 4a invites only a second Spotify account Rem controls, for a week, with exit
    checks that can fail, and the first friend comes after it (Phase 4b). *Recommend yes.* Phases 1-3
    cannot exercise isolation with one user, so without it the first two-user run in production is a
    friend's (completeness H4). A free account is enough; it holds one of the five places while it
    exists.
17. **Turso's Developer plan with overages**, $4.99 a month billed yearly, from the canary's first sync.
    *Recommend yes, as insurance.* Five users fit Free after P4 (§14.4), but on Free one regression
    blocks every query for every user until the 1st, as August showed, and Developer turns that into a
    bill. It also gives ten days of point-in-time recovery instead of one, and a five-day undelete for a
    destroyed database (§15).
18. **Vercel Hobby or Pro.** *Recommend reading Active CPU first (decision 5), and staying on Hobby only
    if the team uses under ~2 of its 4 CPU-hours a month*: an overrun stops every project on the team
    for up to 30 days, and Pro ($20) turns it into a bill (01f §6.3). On Pro, Skew Protection stays off
    or gets a threshold at each phase deploy (§5.5, security R1).
19. **Three log-out actions**: sign out (this browser; capture continues), sign out everywhere, and
    disconnect and delete. *Recommend yes.* Today one button stops capture and signs out every device
    (§5.4).
20. **A session whose Spotify grant has died goes to sign in**, as today. *Recommend yes.* One sign-in
    restores both reading and capture; 01b §2.4's read-only mode would mostly show a friend data that is
    about to be deleted (§5.4).
21. **A friend's `invalid_grant`.** *Recommend*: stop calls and keep the data; confirm with a second
    refresh 10 minutes later; if two or more people, or Rem, are hit within 24 hours, treat it as
    Spotify's event and delete nothing; a refresh token at least ~170 days old has expired and waits for
    its owner to reconnect; a younger one counts as a revocation, which alerts Rem and destroys the
    database on day 4 unless the person signs in first. Rem is never deleted automatically (§5.4, §12.3).
    The Oct 14 version destroyed the database at once; the reviews showed that one Spotify-side event would then
    destroy every friend's history, and that an expiry could be filed as a revocation (security R4,
    completeness H2). Day 4 stays inside Spotify's five days. The cost: on Developer the destroyed
    database stays restorable through Turso's undelete until about day 9, which the strictest reading of
    the Terms would count, so the policy names it. Day 0 is the alternative if Rem reads the Terms that
    strictly, at the price of a false positive destroying a history for good on Free.
22. **Retention for friends.** *Recommend*: kept while connected; capture paused after 60 days without a
    sign-in; deleted at a disconnect and twelve months after the last sign-in. The twelve is the number
    to choose; Spotify says not to keep content indefinitely (01f §1.5).
23. **Friends' backups kept four days and taken for every friend not pending deletion; the telemetry
    store's backups kept four days from Phase 4; no token-key rotation after each deletion.** *Recommend
    yes.* Deletion then reaches every backup through retention, with no file bookkeeping (§12.4). The Oct
    14 version rotated the token key within five days of each deletion so the vendor's ten-day
    point-in-time copy of the encrypted token would be unreadable; that took the key outside Vercel, one
    bad rotation would strand every user, and backups became unreadable across it (security R9, migration
    9, completeness L2). The policy names the encrypted copy instead, and the key rotates only on a
    suspected compromise (§5.3). Rem's own backups stay at 60 days.
24. **`TURSO_PLATFORM_TOKEN` in the runtime, Production only, for the deletion job's destroy and the
    daily usage read; for the scripts, in the Mac's Keychain; never in `.env.local`.** *Recommend yes.*
    A deletion cannot wait for a laptop (§12.3), and in `.env.local` every dev server, its dependencies
    and every lane's copy of the file would carry a credential that reads and destroys every friend's
    data (security R8). 01e §6 recommends taking it out of the runtime; the price is a deletion that waits
    on a script someone must remember to run within five days.
25. **The privacy policy and end-user agreement**, and whether friends ever see derived stats. *The text
    is Rem's to write or approve* (§12.2 lists what it must say, including the Spotify e-mail he enters on
    the dashboard and the vendor's encrypted token copy). *Recommend each person sees only their own
    listened time and skip stats* until Rem decides about comparisons, given the Developer Policy's line
    on derived listenership metrics (01f §1.5). An engineer's reading, not legal advice.
26. **The recorder stays Rem's alone and runs hourly from Phase 3.** *Recommend yes* (01c §5.7, 01e
    §5.9): an hour is well inside 50 plays of any listening, and extending it to friends would put their
    refresh tokens in a plain file on the Zenbook. Its grant may age out by Feb 6, 2027; a fresh local
    sign-in copied into its `tokens.json` restarts the clock (01e F3).
27. **sqld and the meter under their own Unix account on the Zenbook**, with no read access to the
    backups, the rclone config or the recorder, before a friend's data is backed up there. *Recommend
    yes*, an ops change. From Phase 4 the Funnel-facing box holds a read credential for every friend, and
    the meter parses every query it forwards, unauthenticated ones included (security R10).
28. **The fair-share brake applies to Rem too**, from the first friend. *Recommend yes* (§7.5): two
    minutes for everyone until someone spends their share of the day's budget, then 15-minute batches
    for that person alone, and 30 for everyone once the app's total reaches 426, with whatever anyone
    opens always current. Exempting Rem moves his ~150 calls a day onto everyone else's share. The
    alternative that keeps two minutes for all is server-side provisional plays (01c §5.3 ii),
    medium-to-large work.
29. **Finding out whether the quota is pooled.** *Recommend the passive way* (§7.9): per-user
    attribution and each 429's reason from Phase 3, friends added one at a time, and after the first ban
    one other user's harvest let through to see whether it is refused; plus a question on Spotify's
    developer forum. The active test would ban Rem's own capture for up to ~12 hours if the quota is
    shared (01c §7 decision 3).

**When a friend asks for an import**

30. **Friends' Extended Streaming History imports wait for newest-first loading and yearly segments for
    closed years**, not for segments alone. *Recommend yes.* A five-year import is ~91,000 plays; with
    monthly segments alone a cold visit is ~61 requests and ~3 s at 10 Mbit/s, past S2 (scale 9, §9.4).

**Only if it happens**

31. **If Spotify does not return `account_id`** to this app (Phase 0's dev sign-in shows it first).
    *Recommend deciding then.* Keying on the mutable Spotify `id` works for a handful of friends but can
    split one person into two users if Spotify ever lets ids change (01e §5.5, C §15 decision 5).
    Phase 2 stops at its first step until this is settled (§11.4).

**Dropped since Oct 14**: deleting the incident's plays from Rem's history (the Oct 14 version's
decision 10). There are none: the store and the recorder agree play for play from Oct 13 on, and
nothing back-dated was inserted since Oct 1 (§11.2, migration 7).

**What the build waits on.** Most of the code is the same whatever Rem decides; this is where a
decision changes what gets built or when it can run.

| phase | waits on a decision | no decision holds it |
|---|---|---|
| 0 | the environment changes, the deployment deletions and the dashboard reads (1, 5) | the `logout` gate; the dev sign-in that logs `/v1/me`'s keys; the refresh-token probe on a local backup copy |
| interim | the cron-job.org job going live (8); the replay (7); the resolver (9) | the route's second secret and 90-second guard, with tests |
| P2, P3, P4 | P2 and P3's place before Phase 1 (12); P3's device and network target (13) | everything they contain |
| 1 | the per-user database half: `forUser`'s client map and URL template, the owner stamp, the versioned open, `store_epoch`, and the harness's per-user files (11); the health check's cron-job.org job and e-mail (14); the second `AUTH_SECRET` rotation and `OWNER_UID` in Production, which are deploy steps | `identity.ts` and the branded `Uid`; `requireUser()` and its three outcomes; `auth_time`; keyed `cache()` boxes and module state; `playlistsCache` deleted; task owners; `userCache` with owner stamps; uid in ETags, bodies and storage keys; sign-out clearing storage; the token core in its own module with keyed maps and owner-carrying tokens; the `/api/cron/health` route; the harness's cache stub, scripted Spotify and planted-bug self-test |
| 2 | `lazyboy-app` as a database of its own, and §11.4's steps on Rem's data with T12's rehearsal of them (11); the platform token in the Keychain for those steps (24); `account_id` (31, only if absent) | the `users`, `user_tokens`, `sync_state` and `events` tables and the functions on them; encryption with its sentinels and decrypt rules; the identity read's three outcomes; conditional token writes; T5, T6, T9 |
| 3 | the forced refresh (15); the recorder's cadence (26) | the claim, the step, the probe, the harvest policy, the Liked change, paced pages, the brake's counter, T4, T13 |
| 4a, 4b, 5 | 16-25 and 27-29, §13.2's gates, and each invite | – |
| a friend's history import | 30 | – |

Phase order binds whatever is decided. A lane that builds ahead of its phase's turn keeps to new files
and files no queued lane edits, on its own branch, and rebases when the turn comes (§13.4).

## 19. Review disposition

Every finding of the four reviews, what changed in this plan, and where. "Fixed" means the plan now
does what the finding asks, or an equivalent named in the row; "partly" and "not taken" say why.

Overlaps were merged where they ask for the same change (security R4 with completeness H2, security
R6 with migration 5, security R7 with completeness H1, security R1 with migration 6); each row names
its twin. Four recommendations of the Oct 14 plan changed, not only their mechanics: an
`invalid_grant` no longer destroys a friend's database at once (decision 21); a token-key rotation
after each deletion is no longer recommended (decision 23); the canary is no longer optional, and the
first friend waits a week behind it (decision 16); and the deletion of foreign plays is gone, since
there are none (§11.2). The reviews cite the Oct 14 plan's decision numbers, and the first column
quotes them; the other columns use §18's.

### 19.1 Security (`review-security.md`)

| finding | disposition | where |
|---|---|---|
| R1 (High) a rollback brings back old secrets and pre-isolation code | Fixed, with migration 6. `AUTH_SECRET` rotates again in Phase 1's deploy; production deployments built before each rotation are deleted a day after it, and all pre-Phase-1 ones before the canary; one rollback recipe (revert the merge and push; Instant Rollback never across a secret rotation or the Phase 1, 2 and 4 boundaries); Phase 2 invalidates the `lazyboy` database token before minting the group token; Deployment Protection read in Phase 0 and kept as a gate; on Pro, Skew Protection off or a threshold at every phase deploy | §5.4, §5.5, §11.4, §13.1, §13.2, §13.5 |
| R2 disabling a user does not stop their sync | Fixed. The lifecycle status lives on `users` alone (`sync_state` keeps scheduling states only); the claim joins `users` and leases only `active` users; T6 gains the case | §4.2, §7.2, §6.4 |
| R3 a refresh racing deletion writes the token back | Fixed. Token writes are conditional on a live owner; the job re-deletes token, queue and lock rows after the lease window and asserts none remain; the daily chores sweep rows with no `users` row; T11 races a refresh against the job | §5.2, §12.3, §7.11, §6.4 |
| R4 one `invalid_grant` wave destroys every friend; an expiry can read as a revocation | Fixed, with completeness H2, and the recommendation changed: an `invalid_grant` stops calls and keeps the data; a second refresh at least 10 minutes later confirms it; two or more users, or the admin, within 24 hours is an app-wide incident that deletes nothing; a single confirmed case alerts Rem and deletes on day 4 unless the person reconnects. `granted_at` changes only when a write carries a new refresh token, and refresh writes compare-and-set on the blob they read | §5.2, §5.4, §12.3, decision 21 |
| R5 sessions renew through `/api/auth/session` | Fixed. An `auth_time` claim set at sign-in only; the jwt callback refuses a cookie 30 days after it. Decision 1 corrected: the pre-guard browser stays signed in as Rem until `AUTH_SECRET` rotates, not until Nov 13 | §5.1, §5.4, §6.4 T5, decision 1 |
| R6 the identity check's failure mode | Fixed, with migration 5: allowed, refused or unavailable; unavailable keeps the cookie, mints no uid, and `requireUser()` answers a retryable error | §5.1, §6.4 T5 |
| R7 the isolation tripwire is forgeable and lost with the Zenbook | Fixed, with completeness H1. The server writes isolation events, awaited, to an `events` table in `lazyboy-app` (Phase 2 on; in Phase 1, with one user, telemetry and `console.error`); `/api/metrics` refuses reserved event names and takes the uid from the session; the health check reads the table | §4.2, §6.5, §7.10 |
| R8 the platform token in `.env.local` | Fixed. It lives in the macOS Keychain, read by the scripts only; dev gets a fresh `lazyboy`-only token in Phase 2, checked to get a 401 from a throwaway `lb-u-test` | §5.5, §11.4 |
| R9 the production token key leaves Vercel | Fixed. Phase 2's runtime encrypts Rem's row on its first tick; the daily chores re-encrypt blobs under an old key; a rollback flag has the runtime write the plaintext row back. Rotation after each deletion is dropped from the recommendation, so the only copy outside Vercel is the password-manager backup | §5.3, §11.4, decision 23 |
| R10 the Funnel-facing Zenbook holds a read credential for every friend | Fixed as a gate before the canary: sqld and the meter run under their own Unix account with no read access to the backup directory, the rclone config or the recorder. An ops change, Rem's go | §13.2, decision 27 |
| R11 irreversible actions need only a session | Fixed. Removing and disabling a user run only from `scripts/user.mjs` on the Mac; "Disconnect and delete" needs a typed confirmation and a sign-in within the last 10 minutes (`auth_time`) | §5.4, §12.3 |
| R12 immutable segment URLs leave a year of history in a shared browser | Fixed. Segments and the library body are `private, no-store`; IndexedDB is the repeat-visit store; the uid leaves the URL path, since the server takes the user from the session. Cost: a device without the IndexedDB copy (Safari after seven days away) pays a first visit | §6.2, §9.1, §14.1 |
| R13 now-playing and the player actions have no server bound | Fixed. A per-uid memo on `/api/now-playing` (~5 s) and a per-uid token bucket on the player actions, both in-process | §6.2, §6.6, §7.6 |
| R14 cron hardening | Fixed. The tick stamp is a compare-and-set that doubles as the rate limit; `CRON_SECRET_EXT` opens `/api/cron/sync` and `/api/cron/health` only; cron-job.org gets a bare `{"ok":true}`; T13 | §5.5, §7.2, §6.4 |
| R15 smaller gaps | Fixed: the owner check is cached per (uid, `db_name`) with a T8 case; the uid goes on the session; with no uid in any path, `server-error` rows carry none and age out with the 30-day prune; S4 uses the TypeScript compiler API; `/usage` shows friends' rows aggregated by endpoint template; after one user's quota ban, one other user's harvest goes through before the cooldown goes app-wide | §4.5, §5.1, §6.2, §6.4, §7.8 |
| R16 land Phase 0 before the next push | Taken into decision 1. The repo is public, `main` is 238 commits ahead of `origin/main` (1 AM Oct 15), and its reflog shows pushes at 7:05 AM on Oct 13 and 14 | §0, decision 1 |
| §3 STORE_MIGRATION notes | Fixed: Phase 0 before lane 1903's flip; step 8's `lazyboy` token named as the one Phase 2 invalidates; lane 1903 step 11's expectation of fence hits from old deployments corrected (no Skew Protection on Hobby) | §10.2 |
| §4 tests and checks to add | Added: T5, T6, T8 and T11 extended as listed; T13, T14 and T15 new; `private, no-store` asserted in T7; S4 by the TypeScript compiler API; the Phase 2 token check (§11.4 step 4); the deploy checklist as §13.2's old-builds gate and §13.5's rules | §6.4, §11.4, §13.2, §13.5 |

### 19.2 Performance and scale (`review-scale.md`)

| finding | disposition | where |
|---|---|---|
| 1 (High) the scarce bucket's ceiling is probes; the brake is off for the first friend; its ¾ step cannot fire | Fixed. The brake is on from Phase 4 with N = 2; each user is capped at their share (426 ÷ N) per quota day, then slowed to 15-minute batches alone; at 426 everyone moves to 30. The ¾ step is gone. §14.2 recomputed: five Rem-like users get 2 minutes for ~60% of a heavy day, then 30 | §7.5, §14.2, §13.1 |
| 2 (High) an open Home tab re-reads the strip and today's rows on every marker move | Fixed in P4: `refreshHistoryAction` answers from the patched payload and ignores widths over 14; the expanded strip is built from segments; the image-only rescan stops bumping `write_seq`. §8.6 gains the term | §7.6, §8.4, §8.6 |
| 3 (High) a friend's Liked Songs rewrite every row and re-page the list | Fixed in Phase 3: `position` leaves the diff, Liked is fetched from the newest until a stored row appears, background pages are paced, and a resumable cursor replaces the 500-page throw | §7.7, §13.1 |
| 4 cron-job.org's 30-second timeout | Fixed. The tick replies within 20 s and hands any unfinished step to `after()`; the claim gets one short attempt | §7.2 |
| 5 Spotify lists ~13% of plays late | Fixed. The mid-session retry is dropped and one retry runs ~5 minutes after a session ends; F2 restated as p50 ~1 min, p95 ~5 min; lane 1904 may copy `ping.log` daily so the soak can re-measure | §1, §7.4, §14.2, §10.2 |
| 6 the player bucket leaves out now-playing | Partly. Player calls are counted per user from `api_log` (no store write); the now-playing memo shares one call per user per window; polling drops to 15 s mid-track from the first friend; §7.8 gains the refusal row with a 30-minute fallback harvest; Phase 5 gates on player-call volume. Not taken: a per-user cap kept in the store, which would cost a write per call (~1,000 a user a day) before any player limit has been seen | §7.6, §7.8, §13.1 |
| 7 the 30-second reference is 56 calls, not 18 | Fixed | §7.1, §7.6, §14.3 |
| 8 writes undercounted | Fixed. `probe` is written only when the track or play state changes and `idx_sync_due` is dropped at N ≤ 5; D3 recounted: ~4,500-5,000 rows a Rem-like user a day with both, ~5,100-5,900 without | §4.2, §7.3, §8.6, §14.4 |
| 9 segments do not bring an import inside S2 | Fixed. Imports wait for newest-first loading and yearly segments for closed years as well as segments (decision 30) | §9.4, §14.1 |
| 10 a cold Home pays two serial round trips | Fixed. The owner check rides the first read's batch; I$ restated with the cold-process handshake | §4.5, §14.6 |
| 11 an app-heavy user's invocations are ~5× the figure | Fixed in §14.3 | §14.3 |
| the `count(*)` correction | Taken with migration 12: the backup keeps its source counts | §10.2 |
| §2 the arithmetic at 5, 25 and 250 | Added | §14.7 |
| STORE_MIGRATION: copy `ping.log` | Added as optional for lane 1904 | §10.2 |
| §3 two caveats: S3's render half is unmeasured; Safari deletes a site's IndexedDB after seven days without a visit | Taken: Phase 0 reads `paint=` on Rem's phone; S1 now says a friend who opens Lazy Boy in Safari less than weekly gets S2's numbers, a cost the `no-store` bodies of security R12 make certain | §9.1, §14.1 |

### 19.3 Uptime and migration (`review-migration.md`)

| finding | disposition | where |
|---|---|---|
| 1 (High) restores have no runbook | Fixed. The per-process client map is keyed by `db_name` and compared with the `db_name` every identity read and claim returns; roles come from `users`, never the string `lazyboy`; a random `store_epoch` in each database's `meta` goes into every version token; a restore runbook per kind of database; a rehearsal before the canary | §4.2, §4.5, §6.2, §9.1, §12.5, §13.2 |
| 2 (High) the Zenbook stays the only frequent pinger for weeks | Fixed. An interim second pinger after lane 1904, with a 90-second guard in today's route (decision 8); a resolver on the Zenbook outside Tailscale (decision 9); §14.5 restated with the August-September outages | §7.9, §13.1, §14.5 |
| 3 (High) the new derived state is read-modify-write | Fixed. Totals and month counts advance in SQL, conditioned on the insert's `changes()` in the same batch; the Home payload patch compare-and-sets on a version and marks itself dirty on a lost race; the daily chores recompute the totals and month counts from the stored columns, overwrite what drifted and log it. The heal runs on Turso rather than in the backup job the review suggested, because the backup holds a read-only token and a check that cannot write leaves the drift in place; it costs ~0.02M rows a day for Rem (§8.6) | §8.3, §8.4, §9.1, §7.11 |
| 4 (High) the unfenced fill, rollback windows and the import scripts | Fixed. `listened_ms IS NULL` on a counted play is pending and filled by the pass that rules skips; `importTailStmts` sets the dirty mark and bumps the months it wrote; the two queued imports run before P2's fill | §8.3, §11.3 |
| 5 (High) the identity read has no failure branch | Fixed, with security R6. The browser clears its storage only on a 401 that carries a signed-out marker; "`lazyboy-app` unavailable" added to §14.5 | §5.1, §6.2, §14.5 |
| 6 (High) rollbacks name no mechanism | Fixed, with security R1: one recipe, environment changes additive or explained, a boot check that names a missing store variable, each rollback rehearsed in its phase's soak | §13.1, §13.5 |
| 7 (High) there are no foreign plays | Fixed. §11.2 replaced by the measurement and a re-check on the latest backup before Phase 2; the Oct 14 decision 10, the rollout row and the Phase 2 precondition dropped | §11.2, §13.1, §18 |
| 8 (High) 122 of Rem's plays exist only in the recorder's file | Fixed. Edit 7 backs up `backstop.db` nightly; a one-off copy now (decision 6); the replay after lane 1904 and before P2 (decision 7) | §10.2, §11.3, §13.1 |
| 9 (High) one mis-set key strands every user | Fixed. A decrypt failure writes no user state; two or more in a tick, or the admin's, answers the Zenbook caller 503; each key's sentinel blob is decrypted at cold start | §5.3, §7.8 |
| 10 the daily route is one invocation a day | Fixed. `daily_at` stamp; a tick runs overdue chores under a lease; the Vercel cron at 09:00 UTC; the telemetry deletion retried every tick until it succeeds | §7.11, §10.2 |
| 11 "gone by day four" needs the backup job to finish | Fixed. Prune first, per database, logged; the deletion's five-day check reads the log; a Mac fallback | §12.4 |
| 12 edit 4 drops the source check | Fixed. Source counts kept | §10.2 |
| 13 R2's fault injection is never re-run | Fixed. An exit check of Phases 1, 3 and 4a, and static check S7 | §6.4, §13.1 |
| 14 the last-resort daily Vercel entry | Fixed. `/api/cron/sync` keeps its daily entry beside `/api/cron/daily` | §10.2, §14.5 |
| 15 the heavy day is the incident day | Fixed as a note: the "today" column's orphan term is inflated by the incident; the columns from P1 on are unaffected | §1, §8.1, §8.6 |
| 16 three runbook lines | Fixed: no quiet window for the fill; named `meta` keys checked; capture health stays on `lazyboy.meta` until Phase 3 | §11.3, §11.4 |
| §2 check Production's variables after edit 2 | Fixed | §10.2 |

### 19.4 Completeness and product (`review-completeness.md`)

| finding | disposition | where |
|---|---|---|
| H1 the alarms reach nobody | Fixed. `/api/cron/health`, called hourly by a cron-job.org job with failure e-mail, from Phase 1; lifting STORE_MIGRATION's R6 for the multi-user phases is decision 14 | §7.10, §10.2, decision 14 |
| H2 automatic deletion on `invalid_grant` | Fixed, with security R4. A `deleted` state kept for five days answers a returning sign-in and leaves room for a restore script; Phase 0 probes whether a sign-in mints a new refresh token | §5.4, §12.3, §13.1 |
| H3 a database newer than the code; dev migrating production | Fixed. A `min_reader` version; DDL only from production code and `scripts/migrate.mjs`; any other process refuses to apply steps | §4.5 |
| H4 the first two-user run is a friend's | Fixed. Phase 4 splits: a canary week (4a) with exit checks that can fail, then the first friend (4b) | §6.5, §13.1, decision 16 |
| M1 T3 cannot see nested server components | Fixed. A static check plus moving `Tracks`' fetch into the gated page body; a fixture registry per entry point; layouts in the glob | §6.4 |
| M2 T1 lacks a positive control | Fixed. Fixtures with positive controls, a logical dump in place of file hashes, the journal mode pinned, planted bugs kept as a permanent self-test | §6.4 |
| M3 `SIGNUPS=owner` freezes nobody inside; no incident runbook | Fixed. From Phase 2 it refuses non-admin uids at the identity read and the claim; `scripts/user.mjs`; an incident runbook | §5.1, §12.1, §13.6 |
| M4 what a friend gets | Fixed. §12.6, reused as the invite text; Premium's 403 worded; the e-mail address in the policy | §12.2, §12.6 |
| M5 five lifecycle gaps | Fixed: `removed` alarms after 7 days; `dormant` after 60 days without a sign-in; backups for every user not pending deletion; an export on the disconnect page; `invite.mjs --revoke` and a 14-day expiry | §12.1, §12.3, §12.4 |
| M6 P4's exit check skips the dirty-mark events | Fixed | §13.1 |
| M7 no bootstrap for an empty install | Fixed. `npm run setup` provisions the app database, the owner row and the owner's database; a harness test boots from nothing | §12.1, §6.4 |
| L1 T12 cannot rehearse the token step | Fixed. A synthetic token row | §6.4 |
| L2 key rotation and restores | Fixed. Rotation only on suspected compromise, done in the runtime, followed by an app-database backup; both costs of a lost key stated | §5.3, §12.4 |
| L3 the twelve-month clock is a sign-in clock | Fixed. `auth_time` forces a sign-in at least every 30 days; T5 pins the coupling | §5.4, §6.4 |
| L4 two Phase 3 exit checks read data nothing records | Fixed. Each harvest tags its trigger in `api_log.source` | §7.4 |
| L5 the foreign-play cleanup leaves copies | Retired by migration 7, except the advice to ask the second account's owner to remove the app | §11.2 |
| L6 Phase 3 changes Rem's app before any friend | Fixed. The 15-second poll and the 2-hour idle backstop wait for the first friend; Liked stays daily through the incremental fetch; the one change left in Phase 3 is decision 15 | §7.4, §7.6, §7.7, decision 15 |
| L7 decision 8 states no cost | Fixed: decision 12, the same choice, now states that the first friend arrives ~1.5-2.5 weeks later | §13.3, §18 |
| §2 R6 binds the cutover only; a restore brings back no token | Fixed | §10.2, §12.4 |

## 20. What the revision ran

Lane 0225_lb_mu_revise, on the Mac, Oct 15, in two sessions. The first ran from 12:14 AM until its
seat's usage ran out at 12:49 AM (`~/.claude/broke/scratch/lazyboy_mu/mu_dispatch.log`) and revised
§0, §1, §3-§14, §19 and most of §2.3. The second ran from 12:49 AM to 1:05 AM: it committed the
rest of §2.3, rewrote §15, §16 and §18, added §13.4's rule for building ahead of a phase and two
disposition rows, made the corrections listed below, and wrote this section.

Nothing ran against the production store, the Zenbook, Turso, Vercel or Spotify. No number in the
revision is a new measurement: each is quoted from the four reviews with their attribution, or is
arithmetic on numbers already in the plan, marked [estimate]. Nothing was written except this file and
scratch files in `~/.claude/broke/scratch/lazyboy_mu/0225_revise/` (section drafts, text-replacement
helpers and the checker below), deleted at the end.

The second session ran:

- Read in full: the four reviews, this plan, `docs/STORE_MIGRATION.md`, `docs/GOTCHAS.md` and the
  project's `CLAUDE.md`; 01b §6 (E1-E5) for decision 1.
- `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json next.config.ts package.json`:
  empty at `fbe0c30` and at `c6c9c07`, so the code line numbers still hold.
- `git rev-list --count origin/main..main` (238), `git reflog show origin/main` (pushes at 7:05 AM on
  Oct 13 and 14) and `git log origin/main -- docs/multi-user` (empty) for decision 1; `git log -1` of
  `1ac38fa` and `afb21d1`, and `git show HEAD:.claude/QUEUE.md` beside the working copy's lines 16-17,
  for the replay's citations.
- A citation check: a script opened 90 of the plan's code and doc citations at their cited lines and
  looked for the text the plan attributes to each. 74 matched on a keyword. The other 16 were printed
  and read, and all hold: the code names a helper (`writeSeqStmt()`, `bumpWriteSeq()`, `liveKey()`,
  `getMeId()`, `getLikedSignals()`) or a variable where the check looked for a literal.
- §8.6's columns re-summed against scale §3's re-sum of the Oct 14 table plus the two rows the
  revision added (the open tab, the daily heal).

What the check changed: §8.6's totals (today ~19.1M and ~20.1M, not ~19.2M and ~20.2M; Rem after P3
and P4 ~1.53M and ~0.39M, not ~1.52M and ~0.38M) and the cells of §14.3-14.4 that follow from them;
§0's "claims users one at a time", which §7.2's single claim contradicts; the dropped foreign-play
decision named by its Oct 14 number, since today's decision 10 is the five-account cap; "undeletable"
in §12.3, which read as its opposite; the replay's "166 inserted" sourced to an uncommitted queue line
as well as to the commit. Two gaps found on the way, neither in a review, are closed where they live:
a status write is a compare-and-set, so a returning sign-in and the deletion job cannot both win
(§4.2), and §5.4's 10-minute confirmation refresh names who makes it, since the claim never leases a
`needs_reconnect` user (§5.4).
