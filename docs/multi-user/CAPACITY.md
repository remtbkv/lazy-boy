# Multi-user Lazy Boy: the capacity bound at five accounts

Lane 1946_lb_capacity wrote this on Oct 15, 2026, 9:55-10:45 PM, for Rem's 9:27 PM ruling: "make sure it's
bounded for [V]ercel so we can have up to like five accounts, you know, at maximum ... realistic usage, make sure
that still doesn't flip over and we have [a] way enough room to spare." Five accounts is the ceiling Spotify's
development mode allows (PLAN §1, target U). Every number is **[measured]** with its source or **[estimate]** with
its arithmetic. Nothing here wrote to Vercel, Turso, Spotify or the Zenbook; §8 lists what ran.

"Enough room" in this file means one rule, applied to every limit: **at five app-heavy users, the projected month
stays at or under half of the hard limit.** Half is R4's bar for Turso (STORE_MIGRATION §2), carried over to the
rest. Its basis is the size of the errors in the estimates below: the per-user models have been off by about 2×
before (the orphan pass, READ_QUOTA "Sibling sweep"; August's residual), and a 2× miss from 50% lands at the limit,
not past it. Five app-heavy users means Rem plus four Rem-like friends who listen ~125 plays a day, open Home 8
times a day and keep it visible ~3 hours (PLAN §1 and §14.4's upper profile, scale finding 11's request rate).

## 0. For Rem

| limit | today [measured] | five app-heavy users [estimate] | room at five |
|---|---|---|---|
| Vercel Active CPU (4 h, team) | not readable by API; 0.4-1.8 h for lazy-boy by estimate | 1.6-5.4 h | **unknown: the band crosses 2 h and 4 h.** Measure first (§2.1) |
| Vercel invocations (1M) | team 80,429 in 31 days (8.0%); lazy-boy ~28,700 | ~245,000 team | 75% left |
| Vercel CDN requests (1M) | team 113,831 (11.4%) | ~315,000 | 68% |
| Vercel provisioned memory (360 GB-h) | team 24.5 GB-h (6.8%) | ~105-115 GB-h | 68% |
| Vercel Fast Origin Transfer (10 GB) | not readable by API | ~0.6-2.4 GB | 76-94% (the low end if responses count compressed) |
| Vercel Fast Data Transfer (100 GB) | team 0.63 GB (0.6%) | ~2 GB | 98% |
| Turso rows read (500M) | Rem alone after tonight: 135-270M a month | ~344M in the first month with four app-heavy friends (~204M with typical ones); ~500M by month three without P2-P4; 30-74M after P4 | **room for two app-heavy friends on today's code**; ample after P2 and P4 |
| Turso rows written (10M) | Rem ~0.1-0.5M | ~0.8M | 92% |
| Spotify recently-played (~725-800 a day, inferred) | ~235-415 | held near 505-560 by the brake | ~30% to the inferred ban line |
| Spotify player calls (limit unknown) | 1,035-1,303 a day; max 1,336 | 3,600-7,200 a day | **unknown**: 3-5× anything the app has run |
| Spotify 30-second window (unpublished) | max 56 calls seen, no 429 | ~75 at a bad coincidence | **none** until background pages are paced (§4) |
| Zenbook CPU, disk, network | load ~0.9 of 20 threads; 44 GB free (87% used); <100 MB a day | the same plus a few MB a day | ample; the shared disk is the one watch item |

Three limits do not have the room Rem asked for, and each has a change queued (§6):

1. **Active CPU** is the only Vercel number nobody can read without the dashboard, and the five-user estimate
   spans the limit. This file's lanes 01-02 (§6) meter it in production and give the app an economy mode that backs off before
   it; lane 05 compares the meter with Rem's dashboard reading after 72 hours and, if five users would pass
   2 hours, designs decision 18's move of the tick to the Zenbook. Until that verdict, friends two to four wait.
2. **Turso reads** have room for Rem and two app-heavy friends on the code the first friend meets. A third passes
   half the free plan in the first month, and growing histories reach the block in about three. The Home payload
   rebuilt on every landed play (~0.95M a day per heavy listener) and the all-time recompute (2.3 rows per stored
   play, up to 144 times a day) are the terms; P4 and P2 remove them. FASTPATH §5 holds only the fourth friend for
   P4; this file holds the third for P2 and P4 or a measured projection under half, and lane 03's guard enforces
   it (§3).
3. **Spotify's player bucket and 30-second window** are unmeasured at five users' volume. Lane 03 paces
   background pages app-wide and gives each user a share of the player calls, with idle probes slowing first.

**One Rem step moves up.** The Active CPU reading (`rem_dashboard_reads`, due Sat Oct 17) decides whether the
recurring work has to leave Vercel before friends two to four. Two more readings sit on the same page and cost
seconds: Active CPU per project (lazy-boy against `monitor`, `website`, `cheffing`) and Fast Origin Transfer.
§7 lists them.

## 1. What a user costs, path by path

The recurring paths, per user a day, at the code that will be running when the first friend connects (Phases 1-4a,
FASTPATH §4.1): the tick serves every user in one invocation (PLAN §7.2), now-playing polls every 15 s mid-track with
a 5-second per-user memo (PLAN §7.6), two pingers. CPU per call is an [estimate] for a warm Node 24 instance in iad1
(framework overhead plus JSON for the rows and bodies each path moves); the meter (lane 01) replaces each one with
a measured figure.

| path | calls a day, one app-heavy user | Vercel invocations | Active CPU a call [estimate] | CPU a day | Turso rows (PLAN §8.6, P1 column) | Spotify calls |
|---|---|---|---|---|---|---|
| sync tick, the user's probe | 720 probes (two minutes for everyone, decision 28) | 0: rides the shared tick | 10-30 ms | 7-22 s | ~0.08M with harvests and rescans | 720 player |
| harvest and record (a landed play) | ~150 (PLAN §7.4) | 0 | 50-150 ms: parsing the all-time recompute's ~51,000 rows and the Home payload's ~7,500 until P2 and P4 | 8-22 s | 2.24M + 0.95M on a heavy day; ~0.03M after P4 | ~150 recently-played |
| library rescan | 32-48 (every 30 min while active) | 0 | 100-300 ms | 3-14 s | small; an unscoped orphan pass ~5M before lane 1911, ≤ 0.05M after | 2-4 each; a first scan ~150 |
| page loads (Home and the rest) | 8-15 | 8-15 | 150-400 ms | 1-6 s | the whole-history strip 0.35M at 8 mounts | 0-2 |
| search payloads | ~16, mostly 304 or Data Cache hits | 16 | 50-300 ms on a miss | 1-5 s | 0.58M at 8 visits; 0.10M after P3 | 0 |
| now-playing | ~720 (15 s × 3 visible hours) | 720 | 10-25 ms | 7-18 s | ~0 (token row) | 720 player, fewer with the memo |
| on-load sync, open-tab refresh | ~180 | 180 | 20-80 ms | 4-14 s | 0.36M open-tab re-reads; ~0 after P4 | catch-up harvests only |
| build probe, metrics, tasks | ~100 | 100 | ~10 ms | 1 s | ~0 | 0 |
| **one app-heavy user** | | **~1,000** | | **~30-100 s, 0.25-0.8 h a month** | **~4.9M heavy day after P1; ~0.46M after P4** | **~1,600 player, ~150 scarce** |

App-wide, whatever N is: the tick's own work (1,440 invocations a day with both pingers, the stamp, the claim) at
15-30 ms, 0.18-0.36 h a month; cold starts, 50-150 a day at 0.3-1 s of module load each, 0.13-1.25 h a month
[estimate: nothing on Hobby reports them]. Rem's own profile is lighter than an app-heavy friend's: ~45-280
browsing invocations a day in the last month against ~1,000 [measured: §2.1's invocation rows less the 720 ticks].

## 2. Vercel Hobby

The allowances are per team, shared with `monitor`, `website` and `cheffing`, and an overrun stops the feature for
every project on the team for up to 30 days: "In most cases, if you exceed your usage limits on the Hobby plan, you
will have to wait until 30 days have passed before you can use the feature again" (vercel.com/docs/plans/hobby,
last updated Sep 14, 2026, fetched tonight).

### 2.1 Today

`GET /v2/usage?type=requests|builds|cron_jobs|data_cache` for Sep 15-Oct 15 (31 daily rows; the last is Oct 15 to
7 PM), with the CLI's own token, read-only. lazy-boy's share is each day's total times that day's per-project
percentage, which the API rounds to whole percents, so a lazy-boy figure is ±0.5% of the team's on each day.

| meter | team, 31 days | lazy-boy | Hobby | team share of it |
|---|---|---|---|---|
| function invocations | 80,429 (12 errors, 0 timeouts, 0 throttles) | ~28,660; ~925 a day, ~765 a day Oct 8-14 | 1,000,000 | 8.0% |
| provisioned memory (`function_execution_successful_gb_hours`) | 24.5 GB-h | ~19.7 GB-h; 0.78 a day Oct 8-14 | 360 GB-h | 6.8% |
| CDN requests (hits + misses) | 113,831; ~4,555 a day Oct 8-14 | ~28,950 | 1,000,000 | 11.4% |
| Fast Data Transfer, out | 0.63 GB | ~0.036 GB | 100 GB | 0.6% |
| cron invocations | 31 | 31, one a day | once a day per job; 100 jobs a project | – |
| builds | 721, 144 build-minutes, peak 161 on Sep 16 (`monitor`, `website`) | ~3 in the breakdown; 9 production deployments since Sep 15 | 45 min a build; 100 deployments a day and 100 builds an hour (rate limits that reset, not monthly allowances) | – |
| Data Cache | 6 days with traffic; Oct 15: 25.5 MB sent, 16.1 MB received | all of it on Oct 15 | 2 MB an item; size unpublished, LRU across the team | – |

lazy-boy is 82% of the team's function execution and about 37-47% of its invocations (Oct 15's breakdown), so the
team's compute is mostly this app. About 720 of its daily invocations are the 2-minute tick.

**Not readable without the dashboard:**

- **Active CPU.** The usage API's allowed types are "requests, monitoring, builds, edge, edge_group_by_project,
  artifacts, edge_config, log_drains, storage_postgres, storage_redis, storage_blob, cron_jobs, data_cache" (its
  400 for any other type, tonight); `/v1/usage` answers "This API endpoint is only available to Teams on the Pro or
  Enterprise plan"; `vercel usage` (CLI 54.6.1) answers "Costs not found (404)". The number is on Rem's
  dashboard: team → Usage → Active CPU, last 30 days, with a per-project breakdown.
- **Fast Origin Transfer**, the 10 GB one: "Data sent between the CDN and Vercel Functions", counted on "the
  HTTP Response (Headers & Body)" (vercel.com/docs/manage-cdn-usage). Same page of the dashboard.

What can be bounded from the API: provisioned memory is instance time at 2 GB (`standard` memory, 1 vCPU), so
lazy-boy's 0.78 GB-h a day is ~0.39 instance-hours, ~11.7 a month. Active CPU cannot exceed that, which is no
help against 4 hours. Today's ticks spend most of their 1.3-1.8 s waiting on the Funnel (40-210 ms a round trip,
STORE_MIGRATION §1); after tonight's cutover each round trip is ~15 ms (R1's target), so instance time should fall
and CPU should not. 01f §2.3's 5-25% CPU share of instance time gives 0.6-2.9 h a month for lazy-boy; §1's paths
summed for Rem's profile give 0.4-1.8 h. Either band includes 2 h.

### 2.2 At five users

| limit | per app-heavy user | app-wide | five users + the other projects | Hobby | room |
|---|---|---|---|---|---|
| Active CPU | 0.25-0.8 h a month (§1) | ticks 0.18-0.36 h, cold starts 0.13-1.25 h | **1.6-5.4 h** with the others at ≤ 0.3 h (they are 18% of the team's function time) | 4 h | unknown; the centre (~3 h) is over half |
| invocations | ~1,000 a day | 1,440 ticks a day (two pingers, one invocation per hit whatever N is) | (6,440 + ~1,670 others) × 30 ≈ 245,000 | 1,000,000 | 75% |
| CDN requests | ~1,100 (invocations + static assets) | 1,440 | ~(7,000 + ~3,500 others) × 30 ≈ 315,000 | 1,000,000 | 68% |
| provisioned memory | – | – | ~100-110 GB-h at five app-heavy (scale §2's upper bound, before the cutover shortens waits) + ~5 others | 360 GB-h | 67% |
| Fast Origin Transfer | ~16 MB a day uncompressed: the history body (1.79 MB raw) on ~6 changed fetches, the library body (1.6 MB) once, Home's RSC 8 × ~0.2 MB, 720 now-playing replies | – | ~2.4 GB a month uncompressed; ~0.6 GB if counted compressed; P3's monthly segments cut the history term ~10× | 10 GB | 76-94% |
| Fast Data Transfer | ~10 MB a day compressed | – | ~2 GB | 100 GB | 98% |
| crons | – | `/api/cron/sync` and `/api/cron/daily` (lane 1901) | 2 | 1 a day each | fits |
| builds and deployments | – | 1-3 deploys a day during the program | the team's other projects peaked at 161 builds in a day | 100 deployments a day | rate limits that reset in an hour or a day |
| Data Cache | one entry per user per body | – | Rem's history entry is 86.6% of the 2 MB item limit and crosses it in late December (PLAN §9); a friend's is smaller; P3 caps every entry at a month | 2 MB an item, team LRU | an eviction costs one rebuild, never correctness |
| function duration | – | the tick under 20 s (PLAN §7.2 step 5) | – | 300 s | fits |

**Verdict.** Every Vercel limit but one has room at five. Active CPU may not: the estimate's band runs from 40% to
135% of the allowance, and the cost of being wrong is every project on the team down for a month. It is the
limit to measure before friends two to four, and the one the guard (§6) watches first.

**What restores room on Active CPU,** largest first [estimate, five app-heavy users]:

| change | CPU it removes a month | cost | in which lane |
|---|---|---|---|
| decision 18: the tick (probes, harvests, rescans) runs on the Zenbook; the Vercel route stays as the fallback cron-job.org calls, doing work only when the Zenbook's stamp is over 5 minutes old | ~0.9-3 h, about 55% | the Zenbook holds the store's group token and the token key, so a stolen Zenbook reads every friend's data and tokens; capture leans on the Zenbook again, with cron-job.org → Vercel as the fallback | lane 05 designs it if the measurement says so; the credential placement is Rem's decision |
| P2 and P4: the landed-play path stops parsing ~58,000 rows | ~0.2-0.6 h | already planned (PLAN §8.3-8.4) | the P2-P4 lanes after the first friend |
| economy mode: now-playing at 30 s, on-load sync and open-tab refresh at 5 minutes, rescans every 2 hours | ~0.15-0.5 h | freshness on an open tab and the library only | lane 01 |

## 3. Turso (the store from tonight's cutover)

The free plan blocks every query for every user until the 1st once any monthly limit is passed (01f §4.2: "any
query that exceeds these limits will result in a failure, indicated by the BLOCKED error code"). Turso counts rows
read for the whole organization, so five users share one 500M.

### 3.1 Today, on the Zenbook's meter (the model until the cutover lands)

`meter-report.py` on the Zenbook, read-only tonight [measured]:

| UTC day | rows read | rows written | note |
|---|---|---|---|
| Oct 13 (from 00:51) | 7,564,958 | 12,064 | 5.1M of it STORE_MIGRATION's own measurement query |
| Oct 14 | 4,252,260 | 13,480 | an ordinary production day |
| Oct 15 | 12,227,083 | 29,491 | a library-change day: 10,814 `playlist_tracks` rows rewritten, 2,697 purged, and orphan-verdict `UPDATE`s reading 7.9M (two at 1.71M each, one at 2.98M, at 1:58-2:31 PM ET) |

The meter undercounts an `UPDATE`'s correlated subqueries against what Turso bills (01c §2.8: 131,607 metered
against ~5M billed for the same unscoped pass), so on Turso a day like Oct 15 could read several times its metered
7.9M in orphan passes. That risk lasts until lane 1911 deploys the scoped, identity-first predicate (Friday).

### 3.2 Projection

PLAN §8.1's per-run costs applied to a friend's history H (stored plays) [estimates]. An app-heavy Rem-like friend on
P1's code reads, a day: the all-time recompute 2.3 × H × 44 runs; the Home payload ~0.95M once their 16-day strip is
full, whatever H is; search 8 × (3H + ~15,000 library rows); the whole-history strip 8 × 2H; the open tab ~0.36M;
ticks, harvests and rescans ~0.08M; the unique-song count ~0.16M. At H = 22,000 that gives 4.8M, PLAN §8.6's 4.9M.
A typical friend (50 plays a day) pays about 40% of the history-free terms.

| when | Rem a day (heavy, every day) | each friend a day | five users a month | of 500M |
|---|---|---|---|---|
| tonight to lane 1911, Rem alone | 4.5-9M, up to ~19M on an incident day | – | 135-270M | 27-54% |
| first month, P1 shipped, four typical friends (H ≈ 1,500) | 3.85M | ~0.74M | ~204M | 41% |
| first month, four app-heavy Rem-like friends (H ≈ 1,500) | 3.85M | ~1.9M | ~344M | **69%** |
| the same with one, two or three such friends | 3.85M | ~1.9M | 173M / 230M / 287M | 35% / 46% / **57%** |
| app-heavy friends at H ≈ 11,000 (three months), no P2-P4 | 3.85M | ~3.2M | ~500M | **100%: blocked** |
| after P3, app-heavy friends at Rem's history size | 1.53M | ~2.17M | ~306M | 61% |
| after P4 | 0.39M | 0.15-0.46M | 30-74M | 6-15% |

Writes: ~4,500-5,000 rows per Rem-like user a day with index entries counted (PLAN §8.6), ~0.72-0.8M a month at
five (7-8% of 10M); a library-change day adds ~11,000-14,000 for that user (Oct 15); a friend with thousands of
Liked Songs needs Phase 3's Liked change, which lane 17 carries. The tick's stamp adds ~720-1,440 a day.
Storage: ~12 MB of core data for Rem, ~12.6 MB a year per Rem-like user; five users under ~125 MB of 5 GB (2.5%).
Databases: 7 of 100.

**Verdict.** Writes, storage and databases have room for years. Reads on P1's code have room for Rem and two
app-heavy friends, or Rem and four typical ones; a third app-heavy friend passes half, and their histories push the
total toward the block within about three months. The two terms that do it are the Home payload rebuilt on every
landed play and the all-time recompute, which P4 and P2 remove. So, tighter than FASTPATH §5 ("the fourth only
once P4 or a measured read projection under half the free plan says so"): **the third friend waits for P2 and P4,
or for a measured projection under 250M with the friends' real profiles.** The guard turns that from a judgment
into a reading (§6, lane 03): each database's day usage from Turso's platform API, the month projected against
250M, the heaviest user slowed first.

### 3.3 Re-measure after the cutover

The meter sees telemetry only once the core tables move, so every Turso figure above becomes a model again until
these are read:

- `lazyboy`'s rows read and written per UTC day from Oct 16 (Turso's windowed usage endpoint, which
  `/api/cron/usage-check`'s reconciliation already calls, and `turso db show --usage`);
- one library-change day's orphan passes before and after lane 1911, to settle the meter's undercount;
- the tick's store round trips and wall time (R1, the bench route), since Vercel's provisioned memory should fall
  with them;
- lane 1908 reads R1, R3 and R4 at 72 hours after lane 1906; lane 05 here reads the rest.

## 4. Spotify's Web API

All five users share one app: its 30-second rate limit is per app, and the development-mode quota is, by the
documentation's reading, one budget for the developer account (PLAN §7.1).

| limit | today [measured] | five users [estimate] | room | what holds it |
|---|---|---|---|---|
| recently-played and `/me` (the scarce bucket) | ban line ~725-800 calls a quota day (six bans, Aug 11-16, 01f §1.4); Rem's cron 139-319 harvests plus the recorder's 96 | demand 450-770 a day; the brake holds ~505-560 on the heaviest days (PLAN §14.2) | ~30% to the low end of the inferred ban line; none needed if the quota is per user | the fair-share brake (lanes 04, 17, 19), the safety valve decision 28 kept |
| player endpoints (probes, now-playing) | 1,035-1,303 a day from Rem's cron; 1,336 the busiest day; never a 429 | probes 3,600 (two minutes for everyone) + now-playing up to 3,600 at 15 s: 3,600-7,200 | unknown; 2.7-5.4× the busiest day the app has run | nothing yet: lane 03 |
| the 30-second window | 56 calls the busiest window (Aug 18, a cron library scan), no 429 within a minute | ticks ~3 per 30 s, five visible tabs at 15 s ~10, a friend's first library scan at 150 ms pacing ~40-60: up to ~75 when they coincide | none: a coincidence passes the only measured point | lane 03: background pages paced app-wide |

A 429 on the 30-second window costs seconds of app-wide cooldown and no data. A player-bucket refusal blinds every
probe, so harvests fall back to every ~30 minutes for active users (PLAN §7.8): freshness, not completeness, while
30 minutes of listening stays under 50 plays. A recently-played ban stops harvests until ~10:50 AM and loses plays
only for someone who passes 50 plays inside it.

## 5. The Zenbook (recorder, telemetry store, backups, pinger)

Read-only over `ssh ubuntu` at 9:57 PM:

| resource | today [measured] | five users after the cutover [estimate] | room |
|---|---|---|---|
| CPU | 20 threads; load 0.75-0.93 with DiveLoop running | telemetry inserts (~1,000 `api_log` rows a user a day), the recorder (Rem only, 24-96 calls a day), the pinger (720-1,440 requests), one nightly dump: well under 1% of a thread. Decision 18's tick, if it moves there: 1,440 ticks at ~60-300 ms, under 0.1 core-hour a day | >95% |
| memory | 13 GB to WSL, 11 GB available | sqld and the meter ~0.2 GB | ample |
| disk | 336 GB, 44 GB free (87% used, mostly DiveLoop's footage). Lazy Boy: sqld data 166 MB, meter logs 11 MB for three days and never pruned, backups 99 MB (14 days local), recorder 31 MB | meter logs ~5-15 MB a day while unpruned (1.8-5.5 GB a year); `api_log` at 30 days ~18 MB; backups keep only Rem's rows (RULINGS 6:21 PM) | Lazy Boy's share fits for years; the shared disk is what could fill, and a full disk stops telemetry, backups and the recorder together |
| network | the Funnel carries every store query today | telemetry only, the pinger, ~8 MB of backup upload a night: under 100 MB a day | ample; the Funnel's bandwidth limit is unpublished |

**Verdict.** Room on everything. Two cheap guards close the open ends: a 30-day prune of the meter's daily logs,
and the health check turning red below 10 GB free on the Zenbook (lane 05).

## 6. The changes, the guard, and the lanes

The guard is one module with one rule per dimension. For each limit it projects the month from month-to-date usage
and compares it with half the hard limit (the "room" rule above):

- **normal** while the projection is at or under 50%;
- **economy** past 60%, and for any single user whose own day passes 1.5× their fair share (the share is the
  budget ÷ N, as the brake's is) while the app's total runs ahead of pace;
- **freeze** past 80%: the app keeps capture and pages and drops everything optional;
- back to normal only under 50% (no flapping at a boundary).

What each mode does, all switched by one stored key so no deploy is needed:

| mode | Vercel | Turso | Spotify |
|---|---|---|---|
| economy | now-playing told to poll every 30 s (the reply carries the interval); on-load sync and open-tab refresh every 5 minutes; library rescans every 2 hours | the all-time recompute gated to 30 minutes instead of 10 (until P2); search payloads served from the cached copy up to an hour old | idle probes every 5 minutes; player calls past a user's share answered from the memo for 30 s |
| freeze | now-playing at 60 s; no rescans; on-load sync off (the tick still captures) | payload rebuilds once an hour | probes every 10 minutes, still inside the 50-play window (~2.5 hours of nonstop listening) |

Reporting: a daily `budget` record per dimension on `/usage`, and the hourly health check (PLAN §7.10, lane 12)
answering 500, which e-mails Rem through cron-job.org, whenever a dimension is in economy or freeze or the meter
itself has gone quiet for six hours. The meter records each invocation's process CPU (`process.cpuUsage()`), wall
time and response bytes by route and user; under Fluid compute two requests on one instance both count the CPU they
overlap, so it errs high, the safe side. Lane 05 sets its calibration against the dashboard once.

The lanes, in `~/.claude/broke/wavequeue/any/`, markers in `~/.claude/broke/scratch/lazyboy_mu/markers/`. None
duplicates a lane in DISPATCH.md: the brake (04, 17, 19), the now-playing memo and 15-second polling (06, 19), the
Liked change (17) and the health check (12, 14) are theirs, and these lanes build on them.

| lane | does | waits on | known answers |
|---|---|---|---|
| `1946_lb_capacity_01_meter_build` | the meter, the budget module, the daily report, economy and freeze for the app-wide paths (now-playing interval, on-load sync, open-tab refresh, rescans, the all-time gate) | store 1911, mu 14 (Phase 1 deployed) | projection at day 1, mid-month and month end, 28-31-day months; mode boundaries and the 50% way back; a 50 ms busy loop metered within 20%; a telemetry store that refuses keeps the counts for the next flush; each mode's interval read by the tick, the poller and SyncOnLoad |
| `1946_lb_capacity_02_meter_review_deploy` | adversarial review in a fresh context, then deploy | 01 | the review's own failing tests |
| `1946_lb_capacity_03_shares_build` | per-user shares on the per-user paths: each database's day reads from Turso's platform API, each user's player calls, background Spotify pages paced app-wide to one call a second | 02, mu 24 (Phase 4a deployed) | a user at 1.5× share moves to economy alone while the total is ahead of pace, and nobody moves while it is behind; a first scan of 150 pages never puts more than 30 calls in a 30-second window; Turso's usage reply parsed from a recorded fixture |
| `1946_lb_capacity_04_shares_review_deploy` | review, then deploy | 03 | as 02 |
| `1946_lb_capacity_05_remeasure` | 72 hours after 02's deploy: the meter against Rem's dashboard reading, Turso's real per-day usage, Spotify's busiest windows; this file's tables updated; the meter-log prune and the disk check on the Zenbook; decision 18's design if Active CPU at five projects past 2 hours | 02 + 72 h, store 1903, `rem_dashboard_reads`, mu 10 | the projection recomputed from measured inputs |

**Gates that follow from this file.** The first friend (lane 29, whose header now waits on lane 02's marker) needs lane 02's meter live: it is the only Active
CPU reading the app can take on its own. Friends two to four each need lane 04's shares deployed and lane 05's
verdict that the users so far, projected to five, fit under half of every limit, or the change it names in place.
The third friend also needs P2 and P4 deployed, or a measured Turso projection under 250M with the first two
friends' real usage (§3.2).

## 7. Rem's readings

On the Vercel dashboard, team "remtbkv's projects" → Usage, last 30 days, with the readings already asked for in
`rem_dashboard_reads`:

1. **Active CPU**, the team total and lazy-boy's share of it.
2. **Fast Origin Transfer**, the team total and lazy-boy's share.

Lane 05 reads them from the marker file alongside the three already listed there.

## 8. What this lane ran

All read-only, Oct 15, 9:55-10:45 PM.

- Vercel REST with the CLI's token: `GET /v2/teams/<team>`, `GET /v9/projects/<lazy-boy>`, `GET /v6/deployments`,
  and `GET /v2/usage` for each allowed type, Sep 15-Oct 16; `vercel usage` once. Scripts in the lane's scratch.
- vercel.com/docs pages: plans/hobby, limits, caching/runtime-cache/data-cache, manage-cdn-usage.
- `ssh ubuntu`: `uptime`, `free`, `df`, `du` on the Lazy Boy directories, `meter-report.py 2026-10-15`, the
  timers' list; two meter logs (Oct 14-15) copied to scratch and summed per hour and per orphan `UPDATE`.
- The repo at 51bd235: the cron, sync, now-playing and search routes, the poll constants, the usage-check rule.
- Turso and Spotify: nothing called. Their figures come from PLAN, 01c, 01f, READ_QUOTA and STORE_MIGRATION.
