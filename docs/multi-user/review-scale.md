# Review of PLAN.md: performance and scale

Lane 0224_lb_mu_review_scale, Oct 14-15, 2026. An adversarial review of `docs/multi-user/PLAN.md`
through one lens: performance and scale. Every budget and every piece of arithmetic in the plan was
recomputed from the code and the six overviews' measurements, at 5, 25 and 250 users; where the
existing data could answer a question the plan calls unmeasured, I measured it on a local copy.
Planning only: nothing here changed code, data, the Zenbook store, Turso or Vercel. Security,
isolation and product scope belong to the other three reviewers and stay out of this file.

Line numbers are against `ac6f7fe` (`git diff --stat ac6f7fe HEAD -- src scripts ops tests
vercel.json next.config.ts package.json` is still empty). Plan sections are cited as "§n", the
overviews as "01a §n" and so on. Every number is **[measured]** with its source, or **[estimate]**
with its arithmetic. §4 lists everything I ran.

Status: complete, Oct 15, 2026.

## 0. Verdict

The plan's skeleton holds up under this lens: a database per user costs no extra reads, the
predicate rewrite is right on current data (§3), the December cache cliff is real and correctly
dated, and five users fit Turso and Vercel once the single-user levers ship. The arithmetic around
it is optimistic in four places, each of which a friend would find before Rem does:

1. **The scarce Spotify bucket is budgeted from plays, but the ceiling is probes**, and the brake
   is switched off for the one phase that first shares the bucket with an unknown listener. Its ¾
   step does nothing for users of similar weight (finding 1).
2. **An open Home tab re-reads the day strip and today's rows after every write-marker move**, and
   P4 does not touch that path. §8.6 has no term for it, and with "See all" open it grows with
   history (finding 2).
3. **Every friend-side number is Rem's library**, and Rem has 48 Liked Songs. A friend with
   thousands rewrites every `saved_tracks` row and re-pages the whole list on each like (finding 3).
4. **Two numbers the plan calls unmeasured are in the logs already**: Spotify lists ~13% of plays
   only after the first harvest that follows them, so F2's tail is ~5 minutes at p95, not 2
   (finding 5); and the app's busiest 30-second window without a 429 is 56 calls, not 18
   (finding 7).

None of this changes the structure. Every fix below is small, and most belong in phases the plan
already has (P4, Phase 3, Phase 4's gates).

## 1. Findings, by severity

High: a stated target or budget fails under plausible use, or one user can stop every user's
capture. Moderate: a stated number is wrong in a way that changes a gate, a decision or an outage
path. Low: a number is off and nothing rides on it.

### 1. High: the scarce bucket's per-user ceiling is probes, the brake is off at the first friend, and its ¾ step cannot fire

**(a) The ceiling.** The plan sizes each user's harvests from plays: "~117-130, one per play at
most" (§7.4), and friend profiles of 40 to 125 plays a day (§14.2). The design's ceiling is probes:
one harvest per probe that sees a track change, and a probe every 2 minutes while a user is active
(§7.2), so up to 30 an hour. A friend with music on 10-12 hours a day and ~3-minute tracks is
~200-240 harvests a day; a shuffle-and-skip listener up to ~300-360 [estimate]. Rem (~165, §14.2)
plus one such friend is ~365-525 against the 450 planning budget, up to 117%, before finding 5's
retries. §14.2's row "Rem + one friend, any profile: ~230-310, 51-69%, the brake does nothing" holds
for the three profiles it lists, not for any profile.

**(b) The brake is inert for the first friend.** §13.1 ships "the brake's counter, counting but
inert" in Phase 3, and switches it on in "P4 and the brake", which starts after "Phase 4's week,
before the second friend". So the first week anyone else shares the bucket, nothing limits that
person's harvests. Under the shared reading the plan adopts (§7.1), a ban stops every user's history
capture until ~10:50 AM ET (01f §1.4), with only Rem's recorder behind it.

**(c) The ¾ step does nothing for equal users.** §7.5 step 3: when the total reaches ~320, "any user
above an equal share (426 ÷ N)" slows to 15-minute batches. With five Rem-like users each has spent
~64 when the total reaches 320, under the share of ~85, so nobody slows, and the next event is step
4 at 426: everyone to 30-minute batches. §14.2's row says the opposite ("everyone is above their
share at ~320, about 40% into the listening day, and moves to 15 minutes; 30 near the end"). Its own
source has it right: "nobody is above 90 at 338; the app reaches 450 about 60% into the day and
everyone moves to 30-minute batches" (`design-a.md:1303`, A §13.3). On a heavy day friends get
2-minute capture for ~60% of it and 30 minutes after, never 15.

**Fix.**
- Switch the brake on in Phase 4 with N = 2. It is "a counter, a comparison and a branch" (§7.5) and
  has counted since Phase 3.
- Until the passive check (§7.9) settles whether the quota is pooled, cap each user's change-triggered
  harvests at their share (426 ÷ N) per quota day, then 15-minute batches for that user only. Light
  listeners never reach it; a heavy friend cannot take Rem's capture down with theirs.
- If Rem wants the graded behaviour §14.2 describes, compare each user's spend with a pro-rated share
  (the share times the fraction of the quota day gone) or with the remaining budget over the users
  still active. Correct §14.2's five-Rem-like row either way.

### 2. High: an open Home tab re-reads the strip and today's rows after every write-marker move; §8.6 does not count it and P4 does not remove it

**What the plan says.** Phase 3 makes `refreshHistoryAction` stop calling Spotify and "only re-read
the user's store" (§7.6). P4 patches the Home payload so "~7,500 rows read per landed play become
~1" (§8.4). §8.6 counts the payload, search per visit and the whole-history strip per mount, and
concludes that after P4 "nothing left on a per-visit path grows with history".

**Evidence.**
- After its sync, `refreshHistoryAction` reads `getDailyStats(tz, Math.max(14, Math.min(days,
  100000)))` and, when the view follows today, `getPlaysByDay(day, tz)`
  (`src/app/(app)/history-actions.ts:139-174`).
- `days` is the strip's current width, sent by the client (`den-home.tsx:760` passes
  `daily.length`), and "See all" sets it to every day of history (`extendDays`,
  `den-home.tsx:386-412`). §6.6 bounds `dailyStatsAction`'s width; this action's is unbounded.
- It runs every 120 s while Home is visible (`den-home.tsx:990-992`), on every return to the tab
  (`:993-996`), and on each track change, which the 45-s throttle exempts (`:748`).
- Both reads are LIVE cache entries keyed on `meta.write_seq` (`db.ts:1082-1090`, `1186-1191`), so
  each marker move makes the next refresh a real read. The marker moves two or three times per landed
  play (`db.ts:522, 749, 819`; §8.4) and on every image-only playlist rescan (`db.ts:1841`, which
  bumps `write_seq` so the playlist grid refreshes; 198 artwork updates on Oct 14, 01c §2.3).
- P4's patch writes `home_payload`, which only the server render reads (`home/page.tsx:78-83`).
- [measured, `usage_ledger` in the Oct 14 backup] On the August days with the most refreshes, strip
  reads ran far ahead of landed plays: Aug 12, 169 strip reads (826,090 modeled rows) for 47 landed
  ticks and 285 refreshes; Aug 13, 161 for 76 (283 refreshes); Aug 16, 189 for 77 (397). On days
  with few refreshes the two move together, since then the payload rebuild is the only reader.

**Recomputed** [estimate, from the meter's per-run costs, 01c §2.2]. One re-read at the default width
is the strip (~5,600 rows) plus today's rows (~1,900): ~7,500. With "See all" open the strip read
covers every real play at ~3.06 rows each (5,600 rows over the 1,828 plays of its 16-day window, my
count on the Oct 14 copy): 14,511 plays × 3.06 ≈ 44,400, plus 1,900, ~46,000 a re-read, growing ~350
rows a day at Rem's rate. An app-heavy friend who listens like Rem with Home visible for 3 hours of
it (~45 landed plays, ~3 artwork rescans) pays ≥ 48 re-reads: **~0.36M rows a day at the default
width, ~2.2M with "See all" open**, against §8.6's whole after-P4 day for that user, 0.44M. Rem plus
four such friends after P4: §14.4's ~64M a month becomes ~107M at the default width, or **~330M with
"See all" open (66% of the free plan, over R4's 250M)**. D1 fails for anyone who leaves "See all"
open while listening, and D2 fails on this path.

**Fix (P4).**
- `refreshHistoryAction` returns the 14-day strip, the all-time totals and today's rows from the
  patched `home_payload` (one `meta` read) plus the delta it already computes, and ignores widths
  above 14.
- The expanded strip is built in the browser from the segments, which P4 already plans for the
  mount-time prefetch (§8.4).
- The image-only tier stops bumping `write_seq` (`db.ts:1841`); the playlist grid keys on a marker of
  its own, so artwork rotation stops invalidating every strip and day entry.

With those three, an open tab costs ~1 row per landed play.

### 3. High: a friend's Liked Songs rewrite every row and re-page the whole list on each like; every per-user library figure in the plan is Rem's 48 likes

**What the plan says.** §7.7 keeps the Liked list "re-fetched when its count or newest `added_at`
moves". The per-friend read and write budgets (§8.6, §14.3-14.4) apply Rem's per-run costs.

**Evidence.**
- `storeSavedTracks` diffs on `(addedAt, position)` (`src/lib/store-diff.ts:216-219`) and upserts
  every row that differs (`db.ts:2236-2246`). Spotify returns Liked Songs newest first, so a new like
  takes position 0 and moves every other row down one: each like rewrites all N rows. Nothing reads
  `position`: the two readers select from `saved_tracks` with no ordering on it (`db.ts:1636-1638`,
  `2296-2303`).
- Any change in the count or the newest `added_at` (`src/lib/sync/library.ts:81-83`) refetches the
  whole list: `savedTracks()` pages `/me/tracks?limit=50` serially to the end
  (`src/lib/spotify/resources.ts:231-243`, `client.ts:243-266`). `paceMs` sleeps between playlists
  only (`library.ts:71`), so the pages go back to back.
- `getAll` throws at its 501st page (`client.ts:255`). A Liked list over 25,000 songs fails the whole
  library scan after ~500 calls, every time, and the 10-minute attempt gate retries it
  (`src/app/api/cron/sync/route.ts:37-39`).
- Rem's copy holds 48 `saved_tracks` rows and `meta.liked_total = 48` [measured]. Nothing measured in
  the overviews exercises this path.

**Recomputed, per like event, for a friend with 5,000 Liked Songs** [estimate, from the code above
and finding 8's calibration]: ~5,000 rows written (one per moved row), ~10,000 read (the
`saved_tracks` scan plus `readCachedTracks` over 5,000 ids), 100 Spotify page calls in ~10-25 s,
and a `library_seq` bump that makes the next Home visit rebuild the library body. Three like events
a day is ~15,000 rows written from Liked alone, 3× D3's 5,000. Four such friends: ~1.8M a month, 18%
of the free plan's 10M writes, over R4's 10% bar on this one term. The page burst (up to 100 calls
inside 30 s) is ~2× the busiest window the app has ever logged (finding 7).

`playlist_tracks` has the same shape at lower rates: keyed and diffed by position (`db.ts:2069-2093`),
so inserting or removing one track near the top of an N-track playlist rewrites every later position,
two rows written each (the row and `idx_pltracks_track`). Spotify appends at the bottom, which keeps
this rarer.

**Fix (Phase 3's rescan changes, before the first friend).**
- Drop `position` from the `saved_tracks` diff, or the column: a like writes one row.
- Fetch Liked incrementally: page from the newest until a stored `(track, added_at)` appears; refetch
  the whole list only when the count still disagrees, plus the weekly safety net §7.7 proposes. A like
  costs one or two calls.
- Pace pages in background scans (a sleep inside `getAll` for patient callers).
- Replace the 500-page throw with a resumable cursor, or check the Liked count at invite time.

### 4. Moderate: cron-job.org times out at 30 seconds, and the tick's budget runs past it

cron-job.org's FAQ (fetched Oct 15, https://cron-job.org/en/faq/): "If your URL/script does not finish
after 30 seconds, it will timeout", and a job is disabled when it "subsequently fails more than 25
times". The plan's tick runs per-user steps under a 25-s deadline, then "at most one library rescan
... under its own deadline, after the harvests", then replies (§7.2 steps 2-4); its claim can also
wait out the store fetch's 15-s attempts (`src/lib/store-fetch.ts:28-29`). A tick where one user's
Spotify call hangs to the deadline and a rescan follows passes 30 s, and today's ticks already reach
29.1 s (landed with a rescan) and 34.2 s (landed) at max through the Funnel (01c §2.1). §7.2 step 0
sends cron-job.org a 200 always, on the premise that the status code is what counts as a failure; a
timeout counts as well. A Spotify-side slowdown of ~50 minutes (25 odd-minute ticks) disables the
second pinger until the daily watchdog re-enables it (§7.9), and A2 rests on that pinger.

**Fix.** A response budget for the whole tick of ~20 s: steps under ~15-s deadlines, a rescan only
when ≥ 10 s remain. Or evaluate the owner alarm, reply, and run the steps in `after()`, which Vercel
keeps alive to `maxDuration`.

### 5. Moderate: Spotify lists ~13% of plays after the first harvest; the retry and F2's tail are measurable now

**What the plan says.** The retry is "unmeasured; Phase 3's soak counts it" (§7.4). F2's budget is
"p50 ~1 minute, worst ~2 minutes 5 s" (§14.2); the target says "within ~2 minutes" (§1); §16.1 lists
how often Spotify lists a play late as unknown.

**Measured** (Oct 12 09:22Z to Oct 14 06:36Z, Rem's devices; method in §4): each cron harvest's
`added` count from the Zenbook's `ping.log`, matched one to one to its recently-played call in
`api_log`, replayed against the plays in the Oct 14 backup. 225 plays judged; 41 excluded because an
open-app harvest or an unmatched tick could have stored them.

| | value |
|---|---|
| plays not in the first harvest after they ended | 30 of 225 (13.3%) |
| miss rate by that harvest's delay after the play's end | 0-30 s: 20%; 30-60 s: 17%; 60-90 s: 9%; 90-120 s: 7% |
| of the 30, landed by the next harvest (2 min later) | 7; 18 needed two more harvests, 5 three or more |
| all 225, from end to stored | p50 72 s, p75 106 s, p90 240 s, p95 300 s, max 644 s; 88.4% within 125 s |

Today's cron harvests every 2 minutes during playback, so the first harvest after a play's end comes
0-120 s later, the same spread as the plan's change-triggered harvest at the next probe. Some
sessions lag every play: Oct 13 17:01-17:13Z, each harvest landed the play before the one that had
just ended. (The replay assumes `played_at` marks a play's end. I re-ran `playedAtConvention`,
`src/lib/skip-rule.ts:87-107`, week by week on the copy: end-stamp matches outnumber start-stamp
matches in every week through Oct 14, e.g. 359 to 16 in the week of Oct 5. The daily check that is
meant to watch this has not run since Aug 10, 01c §1.)

**Consequences.**
- The retry fires on ~13% of change-triggered harvests, ~16-17 calls a day for a Rem-like user, and
  one retry a tick later lands only about a quarter of what it is for (7 of 30). §14.2's table has no
  retry column: Rem ~165 → ~182, a Rem-like friend ~145 → ~162, five Rem-like users ~745 → ~830
  before the brake.
- F2's "worst ~2 minutes 5 s" is off ~5× at the tail: the same cadence gives p95 5 minutes and a
  maximum of ~11.
- The session tail is where a miss costs most: its harvest runs 0-120 s after the last play ends, the
  band with the highest miss rate, and after it nothing fires for 2 hours (§7.4's backstop).

**Fix.** Drop the immediate mid-session retry: the next track change's harvest lists the late play at
no extra cost, and it is still among the last 50. Spend one retry on the session tail instead, ~5
minutes after playback stops. State F2 as p50 ~1 minute, p90 ~4, p95 ~5, and let Phase 3's
`lag_p50_s`/`lag_p95_s` confirm it per user.

### 6. Moderate: the player bucket's daily count leaves out now-playing, and the design's harvest trigger lives in that bucket

**What the plan says.** "player calls ~720 with up to two users; ~450 from three on ... five Rem-like
~2,250 ... unmeasured; ≤ ~2,500 planned" (§14.3). Now-playing at 15 s is checked against the 30-s
window only (§7.6).

**Evidence.** Now-playing polls every 6 s from one leader tab per browser
(`src/components/now-playing-context.tsx:76, 358-360`); each poll is one call while something plays
and two when nothing does (a 204 from currently-playing, then `/me/player`; GOTCHAS "Player
simulation"). At the plan's 15 s that is 240-480 player calls per visible hour per browser, doubled
by a second device (01c §5.5). An app-heavy friend with Home visible 3 hours a day adds ~720-1,440
to the ~450-720 probes; five such users ask for ~6,000-11,000 player calls a day [estimate].
[measured, deduplicated `api_log`, Aug 17 to Oct 14] The busiest player day the app has had is
**1,336 calls** (Oct 13), and no player endpoint has ever answered 429. The bucket is known to take
~1,350 a day; five users counting now-playing would ask 4-8× that of a bucket whose limit nobody has
seen.

**Why it matters more in this design.** The probe is what triggers a harvest (§7.3-7.4). If the
player bucket were refused, no track change would be seen, only the 2-hour backstop would harvest,
every user's F2 would become ~2 hours, and anyone above ~25 plays an hour would lose plays. §7.8's
failure table has no row for it.

**Fix.** Count player calls per user per quota day beside `rp_calls`. Serve `/api/now-playing` from a
short per-user server cache (~10 s, in the `probe` row the tick already writes), so one user's tabs
and devices share a call per window. Past a per-user soft cap (say 1,000 a day), poll at 30-60 s. Add
the refusal to §7.8, with a fallback harvest every ~30 minutes for users active in the last few hours.

### 7. Low-moderate: the 30-second reference number is the wrong one; the bursts the plan leaves unbounded are pagination

**What the plan says.** "18 calls in 30 s have passed without a 429 (`db.ts:2655-2658`, 01f §1.4)"
(§7.1); "18 seen safe" (§7.6, §14.3), against which the 15-s poll is justified.

**Evidence.** The comment at `db.ts:2652-2658` describes the August ban windows ("the burst window was
never close (peak 18 calls/30s ...)"): 18 was the peak inside the windows before each quota ban.
[measured, the whole retained `api_log`, Aug 10 to Oct 14: 104,942 rows, 84,260 after removing exact
re-sends] The busiest 30-s windows held **56** calls (Aug 18 20:06Z), 54 (Sep 27 12:52Z) and 53
(Aug 13 15:27Z), all library scans, none followed by a 429 within a minute. The only 429s ever logged
are recently-played (83) and `/me` (38), Aug 12-17, both quota bans. The rate limit's measured floor
is 56 per 30 s.

**Consequences.** The 15-s poll is not needed for the 30-s window at five users (five visible tabs at
6 s make 25-50 calls per 30 s); its case is finding 6's daily volume. The bursts that leave the
measured envelope are unpaced pagination: a friend's first scan or a full Liked refetch (finding 3)
sends 100+ page calls back to back, and a rate-limit 429 is app-wide. **Fix:** pace background pages
(finding 3) and quote 56 as the floor.

### 8. Low-moderate: writes are undercounted; libSQL bills index entries, and three per-probe or per-play writes are missing

**Calibration** [measured, the meter's per-statement `rw`, `~/lazyboy-sqld/querylog/2026-10-14.jsonl`
on the Zenbook]: `INSERT INTO api_log` wrote 4 rows on all 2,118 calls (the row, two index entries,
`sqlite_sequence`); `INSERT OR IGNORE INTO plays` 8 on all 129 (the row, six index entries,
`sqlite_sequence`); a `meta` upsert 1; `UPDATE plays SET skipped` 1 per row; `UPDATE playlists SET
image` 1. LibSQL counts index insertions (and, from the `UPDATE`s, not removals), so an `UPDATE`
that moves an indexed column should cost the row plus the new entry. That last step is inferred: no
statement that day moved an indexed column.

**What §8.6's ~0.67M a month leaves out** [estimate, per Rem-like user a day]: the release moves
`next_probe_at`, which `idx_sync_due` indexes, so a probe is three rows, not two (+450-720); the
`probe` key written to the user's `meta` on each probe while playing, since a repeat is detected from
progress (§7.3; +~270); one `seg_seq:<month>` upsert per landed play (§9.1; +~125); the accumulator's
`alltime_stats` write per landed play where today's gate allows ≤ 44 a day (§8.3; +~80).
Recounted: ~3,000 core + 72 tokens + 1,350-2,160 scheduling + ~270 probe + ~205 derived + ~165
counters ≈ **5,060-5,870 a day, over D3's 5,000**. Five users with the `last_tick_at` stamp: ~0.8-0.93M
a month (8-9% of the free plan) against the plan's ~0.67M, before finding 3's Liked term.

**Fix.** Write `probe` only when the track or the play state changes; a repeat shows as progress
lower than the time since the last probe allows. At N ≤ 5 leave `next_probe_at` unindexed: a
five-row scan is cheaper than the index entries it saves. Recount D3 from the meter's `rw`.

### 9. Low-moderate: segments do not bring an imported or long history inside S2, though decision 24 reads as if they do

**What the plan says.** "Friends' history imports wait for segments" (§9.4); decision 24, "Recommend
not until segments exist"; §14.1 lists "a heavy three-year user's first visit (~2.2-2.6 s)" as not
met.

**Recomputed** [estimate]. A five-year import is ~91,000 plays (01d §3.3): 60 monthly segments plus
the catalog. A cold visit sends ~61 requests, each its own function invocation with its own identity
read (§5.1) and, on a Data Cache miss, its own rebuild. Each segment repeats the art and album strings
of every song heard in it; over Rem's five months that was +24.8% raw and +29.8% gzipped (01d O3),
and it grows with the number of months a song recurs in. At ~4.2 MB raw before that overhead (01d
§3.3): ~1.5 MB gzipped + ~30% ≈ 2 MB, ~1.6 s at 10 Mbit/s, plus ~1.1 s of parse and build at 4×
(01d §3.3), ~3 s. Segments fix the 2 MiB cliff for an import, not S2.

**Fix.** Make newest-first loading (B §17, already sized M in §14.1) a precondition for imports, and
either one dictionary per user or yearly segments for closed years: one request per year instead of
twelve.

### 10. Low: Home's isolation cost on a cold process is two serial round trips, not one

§5.1 and §14.6 put it at "Home +1 sequential round trip (~15 ms)". A process's first open of a user
database must pass §4.5's versioned-open statement before that database's first read is trusted
(§6.2 layer 3), so a cold Home runs the identity read, then the owner check, then the payload: two
more than today's single wave, plus a TLS handshake to a second host, ~30-45 ms at R1 [estimate].
Negligible against S2, but over the stated bound. **Fix:** send the owner check and the first read
as one batch on the user's client, and discard the read on a mismatch.

### 11. Low: an app-heavy user's browsing invocations are ~5× the plan's figure

§14.3 uses ~200 interactive invocations per user a day, Rem's measured profile (01f §2.3). A visible
Home tab after Phase 3 makes ~4 now-playing polls a minute, `SyncOnLoad` every 2 minutes
(`src/components/sync-on-load.tsx:12`), a refresh every 120 s (`den-home.tsx:990-992`), the build
probe at most every 5 minutes, and forced refreshes on track changes: ~320-340 requests per visible
hour [estimate]. Three visible hours is ~1,000 a day; five such users ~0.15M a month plus 43,200 ticks,
inside Hobby's 1M. It matters for the Active CPU estimate, which 01f scaled from Rem's profile, and at
25 users (§2).

**Not a finding, a correction.** §10.2 edit 4 prices a per-table `count(*)` check at "~45,800 rows a
night". On libSQL an unfiltered `count(*)` walks pages (158 reported for 15,852 rows, READ_QUOTA
"Measured reads"), so it costs a few hundred. The edit stands on fidelity, not cost.

## 2. The arithmetic at 5, 25 and 250 users

Spotify allows five accounts on this app (§1, 01f §1.2), so 25 and 250 exist only on a
grandfathered list or a changed policy; past five the plan sends people to their own copies, which
share nothing and scale without limit (01f §5.2 option E, which holds). The columns below answer the
brief anyway, because they show what binds first if the cap ever moves. Every cell is an
[estimate]. Users are Rem-like and app-heavy (~125 plays and ~9 hours of playback a day, Home
visible ~3 hours), the upper bound; the plan's levers through P4 and this review's fixes to findings
2 and 3 are applied unless a row says otherwise; the scarce bucket is read as shared, as the plan
does.

| resource | per user a day (basis) | 5 users | 25 users | 250 users | limit |
|---|---|---|---|---|---|
| allowlist places | 1 | 5 | 25 | 250 | **5** on one app (dev mode) |
| scarce bucket, un-braked | ~145-165 harvests (§14.2), +~16 if the mid-session retry stays (finding 5) | ~745-830 | ~3,700-4,100 | ~37,000-41,000 | ~725-800 observed ban line; 450 planned |
| scarce bucket at the brake's floor | ~35-40: 9 h × 2 batches + ~5 tails + ~7 idle backstops + ~5-10 open-app (§7.4-7.5) | ~505-560 (A §13.3), **holds** | ~875-1,000, **over the ban line: daily bans** | ~8,750-10,000, ~12× the line | the brake has no level below 30 minutes |
| player bucket | 450-720 probes + 0-1,440 now-playing (finding 6) | ~2,250-10,800 | ~11,000-54,000 | ~112,000-540,000 | unknown; 1,336 the measured max day |
| Spotify calls per 30 s | ~0.35 from the tick per active user (probe + harvest), 2-4 per visible tab, scans paced | ≤ ~25 | ~16-50 (5-10 tabs visible) | ~40-65 from ticks alone at a peak hour (100 active, 150 idle) | 56 measured without a 429; true limit unpublished |
| Turso rows read | ~0.37-0.45M on a heavy day (§8.6 P4 column, finding 2 fixed) | ~64-70M a month (13-14%) | ~330M (66% of Free, over R4) | ~3.3B | Free 500M (R4 250M); Developer 2.5B |
| same, finding 2 unfixed, "See all" open | +~2.2M | ~400M (79%) | ~2B | ~20B | as above |
| Turso rows written | ~5,060-5,870 (finding 8), Liked fixed | ~0.8-0.93M a month (8-9%) | ~3.8-4.4M (38-44%) | ~38-44M | Free 10M (R4 1M); Developer 25M |
| of which scheduling (claims and releases) | 1,350-2,160 | ~0.2-0.3M | ~1-1.6M | ~10-16M | – |
| Turso databases | 1 | 7 (with `lazyboy-app` and the old `lazy-boy`) | 27 | 252 | Free 100 |
| Turso storage | ~12 MB now, +12.6 MB a year (01a §9.1) | ~60-125 MB | ~0.3-0.6 GB | ~3-6 GB | Free 5 GB |
| Vercel invocations | ~200 (Rem) to ~1,000 (app-heavy, finding 11); ticks 1,440 for the app | ~73,000-195,000 a month | ~0.19-0.79M | ~1.5-7.5M | Hobby 1M |
| Vercel provisioned memory | ticks ~1,440 × ~2-3 s × 2 GB for the app; polls ~720 × ~0.4 s × 2 GB and other requests ~300 × ~1 s × 2 GB per user [upper bound: fluid compute shares instances] | ~100-110 GB-h a month (~30%) | ~300 GB-h (~85%) | ~2,500 GB-h (Pro, ~$27 on demand) | Hobby 360 GB-h |
| Vercel Active CPU | unmeasured; 01f's top-down band 0.5-2.4 CPU-h per Rem-like user a month | 2.5-12 h | 12-60 h | 125-600 h | Hobby 4 h, team-wide |
| tick concurrency | ~half the users due each minute | 2-3 steps | ~12 | ~125 steps and 125 user-database hosts in one invocation | 25-s deadline per step; 60-s `maxDuration` |
| library rescans | ~32-48 wanted per active user (§7.7) | ~160-240 a day | ~800-1,200 | ~8,000-12,000 | **one per tick: 1,440 a day** |

What binds, in the order the users arrive (my recomputation):

1. **Spotify's allowlist at six.** Policy, not engineering.
2. **Money switches, all small.** Hobby Active CPU somewhere between 2 and 25 users (unmeasured, the
   plan's Phase 0 read); Turso reads at R4's 250M bar at ~19 users (250M ÷ (0.44M × 30)) and at
   Free's 500M block at ~38, or at ~3 and ~6 if finding 2 is not fixed and app-heavy users leave "See
   all" open; Hobby's provisioned memory near 25 app-heavy users, which §14.3 does not list; Turso
   Free's 100 databases past 98 users. Pro is $20 a
   month and Developer $4.99, so none of these is a wall.
3. **The scarce bucket, under the shared reading.** At the brake's floor of ~35-40 harvests a user a
   day, the app exceeds the 450 planning budget at ~12 Rem-like users and the ~725-800 ban line at
   ~19-21, from where it is banned daily however the brake is tuned, and a heavy listener loses plays
   during each ban. §14.3 calls this "closed-app freshness (each share of the scarce bucket is 426 ÷
   N)"; past ~20 users it is completeness. Under the per-user reading it never binds.
4. **Library rescans at ~30-45 active users** (1,440 a day ÷ 32-48 each): the "one user per tick"
   rule (§7.2 step 3, §7.7) leaves libraries ~4 hours stale at 250. Several rescans per tick under
   one shared deadline lifts it.
5. **The 30-second window from the ticks alone around 200-250 users**, at the measured floor of 56
   calls; spreading probes and slowing idle users further moves it.

At five every row fits except the two unknowns the plan already gates on (Active CPU, quota pooling)
and the player bucket (finding 6), which it does not.

## 3. What holds up

(to fill)

## 4. What I ran

(to fill)
