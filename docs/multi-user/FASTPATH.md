# Multi-user lazyboy: the fast path to the first friend

Lane 2008_lb_mu_fastpath wrote this on Oct 15, 2026, in answer to Rem's 12:26 PM and 12:44 PM questions:
why the plan puts the first friend in mid to late December, and what a three-day path would take. Sources:
PLAN.md (read in full), RULINGS.md through the 1:33 PM rulings, PHASE1.md on `mu/phase1`,
STORE_MIGRATION.md, the eleven 19xx lane briefs in `~/.claude/broke/wavequeue/rem/` and their gate
(`~/.claude/broke/scratch/lazyboy_store/gate.py`). Nothing ran against production, the Zenbook, Turso,
Vercel or Spotify. A duration is [measured] where a lane has already run and [estimate] otherwise. Every
date below comes from the steps in §4 below, so a date moves when its step does. "PLAN §n" is a section
of PLAN.md; a bare "§n" is a section of this file.

## 0. For Rem

**Recommendation: the fastest-safe schedule (§4.1), with the first friend on Tuesday Oct 20 in the
evening, or Wednesday Oct 21 if the cutover takes the second night [estimate].**

- **Why the plan says December.** Most of the time is waiting. Of the plan's 45-66 days to the first
  friend, 24 are soaks and the canary week, 10-17 are P2 and P3 placed in front of Phase 1, and about 5
  are margin on the store move. The building takes days: one lane built Phase 1's decision-free half in
  22 minutes. The plan's own durations add up to Nov 29-Dec 20, so its "mid to late December at the
  earliest" is the late end of its own range.
- **The move to Turso is one night and one day.** The cutover runbook fits in two hours, and its slot
  tonight is 3:30-4 AM. Its follow-up lanes run on Friday. The rest of the plan's week is margin it does
  not itemize; the visible reasons are STAT 139 having the seats first and one cutover slot a night.
  Lane 1908's 3-day check only measures. Lane 1909 keeps the frozen pre-cutover copy for 7 days, which
  protects your data. No multi-user step waits for either lane, in the plan or here.
- **What fastest-safe keeps and cuts.** It keeps everything that protects other people's data:
  - the isolation suite with its planted bugs;
  - an adversarial review of each phase and of the whole diff;
  - the canary with every exit check;
  - deletion through the job, with friends' backups kept four days;
  - the second pinger and the e-mailed health check, live before the friend.

  It cuts the soaks that only cover your account to a day each, runs Phase 3's capture soak alongside a
  48-hour canary, and moves P2-P4 to after the first friend. A new friend starts with 50 plays, and every
  read cost P2-P4 cut grows with stored history.
- **Three days (Sunday Oct 18) is possible on paper.** It needs no soak at all on your account (Phases 1,
  2 and 3 within about 18 hours, the token move at night), a 24-hour canary, and nothing slipping. It saves
  about two days. The price is the two things that protect a friend most: a capture policy proven on your
  listening before theirs depends on it, and phases that can be rolled back one at a time (§3).
- **Before 8 PM tonight:**
  - Let lanes 1901-1906 and 1910-1911 run ahead of STAT through Friday, or accept a one-night slip.
  - Rule on decisions 2-3, 11, 14 and 16 (a 48-hour canary), plus 15, 23, 24, 26 and 27.
  - Give a standing go-ahead for phase deploys whose tests and reviews are green.

  The plan's eight STORE_MIGRATION edits are not in the lane briefs that start tonight (§5).

## 1. Why the plan lands in December

PLAN §13.3 gives the durations. This table splits each one into the work it contains and the waiting it
contains.

| step | the plan's time | work | waiting |
|---|---|---|---|
| STORE_MIGRATION through lane 1911 | about a week | the cutover's runbook (at most 2 hours, in a night slot) plus eight more lanes with timeouts of 1.5-3 hours, three of them (1904, 1905, 1910) in parallel after the cutover: about a night and a day | STAT 139 goes first on the seats (`--stat-first`, which defers a lane 45 minutes at a time); only one cutover slot a night; the rest is margin the plan does not itemize. Lanes 1908 (72 h) and 1909 (168 h) run afterwards and hold nothing up |
| P2 | a few days | one M lane, its review, and the fill on Rem's data | the exit check's week of capture matching the recorder (PLAN §13.1) |
| P3 | one to two weeks | one L lane, its review, and the throttled-browser harness | review rounds the plan does not itemize |
| P2 and P3 before Phase 1 (decision 12) | moves the first friend 1.5-2.5 weeks later (PLAN §13.3) | – | all of it: only one lane may work in `db.ts` at a time, so Phase 1 waits behind P3 |
| Phase 1 | L, then a soak | half was built in 22 minutes on Oct 15 (spawned 1:06 AM, marker 1:28 AM [measured]); what remains is the `db.ts` edit and its review, about a day [estimate] | 7-day soak |
| Phase 2 | M, then a soak | about a day, plus Rem's token move at a quiet hour [estimate] | 3-day soak |
| Phase 3 | L, then a soak | one to two days [estimate] | 7-day soak |
| Phase 4a | M-L, then the canary | one to two days, mostly buildable now in new files [estimate] | 7-day canary |
| Phase 4b | – | an invite | – |

The plan's durations, added from Oct 15:

| step | duration | ends |
|---|---|---|
| store move | a week | Oct 22 |
| P2 | a few days | about Oct 25 |
| P3 | one to two weeks | Nov 1-8 |
| Phases 1-3 | three to five weeks | Nov 22-Dec 13 |
| canary | a week | **Nov 29-Dec 20** |

If P3 also waits for P2's week of capture, the range becomes Dec 6-27. "Mid to late December at the
earliest" in PLAN §0 is the late end of this range.

Where the 45-66 days go:

| share | days |
|---|---|
| soaks and the canary (7 + 3 + 7 + 7) | 24 |
| P2 and P3 in front of Phase 1 (decision 12) | 10-17 |
| margin on the store move | about 5 |
| building and review, at the pace the plan assumed | 6-20 |

The lanes in this program ran faster than that pace. On Oct 14-15 each lane took 22-58 minutes,
including seat drains [measured: `mu_dispatch.log` and the marker times]. That covers the three
designs, the synthesis, four reviews, the revision and Phase 1's half. At that pace the building
left before the first friend is about 15-25 lane-hours [estimate], which is a few days of calendar time
across two seats.

## 2. Every wait and ordering rule

"Five people" means Rem plus four friends, on the free plans Rem chose (decisions 17-18). Each likelihood
is a judgment from the cited evidence, not a measured rate.

### 2.1 The store move (STORE_MIGRATION §7)

| wait | what it buys | how likely for five people | fast path | risk of the change |
|---|---|---|---|---|
| nothing before Oct 15, 8 PM | Rem's own hold (Oct 13: "do it in 2 days") | – | keep | – |
| `--stat-first` on every lane except 1903 and 1907 | STAT 139 gets the seats first (Rem, Oct 13). It protects no data | – | Rem's call: exempt 1901-1906 and 1910-1911 through Friday | STAT lanes wait behind them for about a day. Without the exemption, one busy STAT evening can push 1901 past tonight's cutover slot, which costs a day |
| the night window, with no one using the app (1903, 1907) | The cutover stops capture for up to 45 minutes and copies a live database file. At night nobody is listening, and the window keeps the run clear of the Zenbook's 3 AM reboot and the 07:00 UTC Vercel cron | The reboot happens every day (`uptime -s` read 03:01 on Oct 12 and Oct 13, STORE_MIGRATION §3). A run that crossed it would lose the store partway through the freeze. This wait protects data | keep | Only one slot a night: a two-hour run can start at 12:30-12:45 AM or 3:30-4 AM (from gate.py's `night_next`, run for these dates). Lane 1907 uses the 12:30 slot tonight, so the cutover either starts at 3:30-4 AM Friday or waits until Saturday 12:30 AM |
| lane 1908, 72 hours after lane 1906 | R1, R3 and R4 measured after three days of real use; the move's outcome record | It only measures and protects nothing. No multi-user step waits for it, in the plan or here | keep it; it runs alongside | none. Its numbers arrive around Monday noon, before the first friend in each of §4's schedules; the three-day path of §3 would bring its friend in a day before them |
| lane 1909, 7 days after the cutover | The frozen pre-cutover copy stays on the Zenbook for a week. It is the move's rollback source and a second full copy of Rem's store. R5 checks counts, 40 sampled rows, the `meta` key set and verify-derived, so a defect in rows that were not sampled would only show up in use | Low, but the cost would be Rem's history. This wait protects data | keep the 7 days; nothing waits for it | With multi-user code deployed inside that week, rolling the move back also means reverting Phases 1-4a and freezing friends with `SIGNUPS=owner`. That is still possible |
| the interim second pinger, after lane 1904 (decision 8, ruled yes) | capture continues while the Zenbook is down | High. The Zenbook went about ten days without capturing in four weeks of August and September (PLAN §7.9). A friend has no recorder, so an outage loses every play beyond their last 50 | keep it, and have it live before the first friend. It is S work after the cutover, then Rem sets up the cron-job.org job | – |

### 2.2 The single-user track (decision 12)

**P2 and P3 before Phase 1.**

- **What it buys.** Lower reads for Rem: a heavy day drops from ~3.85M rows after P1 to ~1.53M after P3
  (PLAN §8.6). It also removes the late-December cache cliff on his history payload (PLAN §9).
- **How likely it matters for five people.** For friends, not for months. A new friend starts with their
  last 50 plays, and every read cost P2-P4 cut grows with stored history. In their first month a new
  friend reads about 0.3-0.8M rows a day [estimate: PLAN §8.1's per-run costs applied to about 1,500 stored
  plays and an 8,000-song library]. Rem's heavy day after P1 is ~3.85M. Even counting every one of Rem's
  days as heavy, Rem plus four new friends stays under about 0.21B rows a month, inside R4's 250M.
- **Fast path.** Reverse the order: Phase 1 first, then P2 and P3 after the first friend, written against
  `forUser` with Rem's uid. PLAN §13.3 already allows this, and nothing gets written twice. P3 keeps its
  mid-December deadline. If it is not merged by Dec 1, the catalog split (01d O2) is the stopgap.
- **Risk of the change.** In November P3 competes with multi-user work for the single `db.ts` slot.
  Friends' reads grow with their histories, so P2 and P4 are due within a few months [estimate], and
  sooner for a friend who keeps the app open a lot.

**P2's week of capture matching the recorder.** It shows that the accumulator does not drift. Only Rem's
data is involved, and the daily heal records any drift within a day (PLAN §7.11). It drops off the friend's path
together with the change above.

### 2.3 Soaks on Rem alone

**Phase 1, 7 days.**

- **What it buys.** It catches regressions the identity layer causes in Rem's own app: a cookie refused
  in a loop, a route answering 401, cached entries stranded by the new keys. With one user, isolation
  itself cannot be exercised (PLAN §6.5).
- **How likely for five people.** Moderate for an edit of about 535 call lines. Most of these regressions
  show within hours of use. The daily cycles show within a day: 24 token refreshes, the 24-hour cache
  lifetime, the 7 AM push, the Zenbook's reboot. Rem's plays have the recorder behind them.
- **Fast path.** 24 hours.
- **Risk of the change.** A rarer regression shows up during the canary instead. Reverting is one push.

**Phase 2, 3 days.**

- **What it buys.** The encrypted token path runs through its hourly refreshes, and the identity read's
  failure branch gets exercised.
- **How likely for five people.** Low. The plaintext token rows stay for a week as the way back (PLAN §11.4).
- **Fast path.** 24 hours, which is 24 refreshes.
- **Risk of the change.** A token fault stops Rem's capture until it is fixed. The recorder covers him
  and the health check sends an e-mail.

**Phase 3, 7 days.** This is the soak that protects friends' plays.

- **What it buys.** The new harvest policy runs on Rem's real listening before anyone without a recorder
  depends on it. It checks four things:
  - about 150 harvests a day;
  - no play stored first by a backstop while he was listening;
  - ticks finishing within 20 s;
  - the second pinger working.
- **How likely for five people.** Low to moderate. Losing a play takes more than 50 plays between
  harvests. While a pinger runs, the 25-change completeness rule and the session-tail harvest prevent
  that.
- **Fast path.** 48 hours, run alongside the canary (the canary's plays are Rem's test data).
- **Risk of the change.** A listening pattern the 48 hours did not include, such as a device the probe
  cannot see, reaches the friend first. Rem's recorder diff over those 48 hours is the check.

### 2.4 The canary

**The canary week: 7 days on one account Rem controls.**

- **What it buys.** The first production run with two real users (PLAN §6.5, completeness H4). It covers:
  - `cache()` in route handlers;
  - the Data Cache across environments;
  - Fluid compute serving two users from one instance;
  - two real token refreshes in one tick;
  - the shared-device case;
  - the planted probe's e-mail;
  - deletion done for real.
- **How likely for five people.** Low for each kind of mistake, because each has one layer that prevents
  it and another that detects it. The impact, though, is another person's data and Spotify's 24-hour
  breach notice. Two active users exercise these paths thousands of times a day: a tick every minute, 24
  refreshes each, every page view. Each daily process (backup, chores, cache lifetime) needs one day.
- **Fast path.** 48 hours, which covers each daily cycle twice. Make the canary active: run every
  user-facing feature once as the canary, including:
  - the request form;
  - the first library scan and Liked;
  - cleaning a playlist (an owned task);
  - search and the day view;
  - now-playing;
  - log out and sign in again;
  - disconnect, last.

  Prove that deletion reaches backups within the 48 hours: put a backup file for the canary's database,
  dated past the four-day retention, in the backup folder, and check that the next nightly run prunes it
  before it dumps. That replaces waiting until day five after the canary's deletion.
- **Risk of the change.** A cross-user fault that needs more than two days of traffic to appear reaches
  the friend. The owner stamps and the token-owner assertion turn most such faults into a refused request
  and an e-mailed isolation event. `SIGNUPS=owner` then freezes everyone but Rem with one redeploy
  (PLAN §13.6).

### 2.5 Approvals, gates and ordering

| wait or rule | what it buys | fast path |
|---|---|---|
| Rem's go-ahead before each phase deploys (PLAN §18) | Rem's control of production | A standing go-ahead for any phase whose tests, build and adversarial review are green. Without it, each go-ahead can cost hours. Phase 2's token move still happens at an hour Rem picks |
| pre-rotation deployments deleted "a day later" | caution only: Instant Rollback is already barred across a rotation (PLAN §13.5) | delete them before the canary; keep the deletion |
| PLAN §13.2's gates | One-time checks that take minutes to an hour each: Active CPU (a hard gate now that Pro is ruled out, since a Hobby overrun stops every project on the team for up to 30 days), the User Management list, the restore drill, Preview without store variables, the platform token out of `.env.local`, the Zenbook's Funnel-facing services under their own account, a deliberate health-check failure, the whole-diff adversarial review | keep all of them; none is a wait |
| one lane in `db.ts` at a time | merges that can be reviewed | keep it; it costs hours per lane once soaks no longer sit between lanes |
| Phase 1 after lane 1911, P3 after lane 1906, Phase 2 after lanes 1903-1904 | no conflicts in `storePlaylists` or Home's load path; the cutover's token compare comes first | keep; all three lanes finish the day after the cutover |
| one phase per deploy, a day apart | a regression can be traced to one phase and reverted on its own; reverting Phase 2 needs the token flag (PLAN §11.4) | keep, at one day each |
| P4 before the second friend; friends a week apart (Phase 5) | reads at five users; each friend's quota and player-call volume | after the first friend, gate each new friend on measured quota spend and Turso usage instead; two or three days per friend covers a full quota day |

Every schedule below keeps these, because they protect other people's data:

- the isolation suite with its planted-bug self-test and static checks, run for each phase and again
  before the canary;
- an adversarial review of each phase and of the whole multi-user diff;
- the canary with every exit check in PLAN §13.1;
- deletion through the job, with friends' backups kept four days and pruned first;
- the e-mailed health check and the second pinger, live before the first friend;
- the Zenbook's Funnel-facing services under their own account before any friend's data is backed up
  there;
- production deployments built before Phase 1 put out of reach;
- `SIGNUPS=owner` as the freeze switch.

Also kept: the night slot for the cutover, lane 1909's week, and the plaintext token rows kept for a week.

## 3. Three days: what it takes and what it gives up

Sunday Oct 18 holds only if every step lands on the first try:

- **Tonight.** Lane 1901 starts at 8 PM (STAT idle or exempted, and room on a seat). Lane 1902 passes its
  review, deploys, and takes its three baseline runs at least 20 minutes apart. Lane 1907 renews the
  certificate at 12:30 AM. The cutover runs 3:30-5:30 AM Friday.
- **Friday.** Lanes 1904-1906 and 1910-1911 finish by about noon. Phase 1's remainder is built and
  reviewed by about 6 PM and deployed (Rem signs in once). Phase 2 is reviewed and deployed that night,
  with its token move.
- **Saturday.** Phase 3 and 4a deploy by about noon, after the whole-diff review. The canary signs in.
- **Sunday, about 3 PM.** After 24 hours of canary come the exit checks, then the canary's deletion
  through the job, then the friend connects.

What it gives up, and the risks it takes:

1. **Any slip costs a full day.** Tonight has one cutover slot, and its last start is 4 AM. Lanes 1901
   and 1902 may each take up to their three-hour timeouts, so 1901 has to start by about 10 PM, and
   `--stat-first` pushes it back 45 minutes at a time. 1902's review also has to pass on the first try.
   An open Lazy Boy tab making requests around 3:30 AM makes `--quiet-app` defer the cutover 30 minutes,
   to the edge of the slot. Missing the slot moves the cutover to Saturday 12:30 AM and the friend to
   Monday. This risk applies to §4's schedules too.
2. **Three phases land on Rem's account within about 18 hours, including the token move at night.** If
   capture or sign-in breaks on Saturday, the cause could be in any of the three. Reverting past Phase 2
   needs the rollback flag that writes Rem's plaintext token back (PLAN §11.4). The plan names doing such steps
   out of order as the likeliest remaining way to hurt data (PLAN §16.2).
3. **The friend's plays depend on a capture policy with about a day of evidence from Rem's listening.**
   Friends have no recorder, so a capture fault costs them every play beyond their last 50.
4. **A 24-hour canary sees only one nightly backup and one run of the daily chores.**
5. **Rem has to give five or six go-aheads between Friday evening and Sunday, one at night.** There is no
   spare day if a review finds something that needs a redesign.

It saves about two days over §4.1. It pays for them with the two protections that matter most for a
friend: a capture policy proven on Rem's listening first, and phases reverted one at a time.

## 4. Schedules

The dates assume the cutover takes tonight's slot (Friday 3:30-5:30 AM). If it takes Saturday's 12:30 AM
slot instead, each date moves by a day. Each lane time is at most that lane's timeout and usually less
[estimate].

The estimate ledger's record before these dates (`estimates.py report`, Oct 15): 53 on time, 16 late, 4
superseded, 4 unchecked, 3 overdue. The fastest-safe date is entry #81.

"The first friend" means a person other than Rem who connects under `SIGNUPS=invite` after the canary's
exit checks have passed. The scope is PLAN.md Phases 1-4a, minus §2's deferrals, under Rem's rulings
through 1:33 PM Oct 15. If a new ruling adds work before the friend, that is a change of scope, and it
moves the date as a separate event.

| schedule | first friend | what it skips or shortens | P2-P4 |
|---|---|---|---|
| fastest-safe (recommended) | **Tue Oct 20**, evening (Wed Oct 21 if the cutover slips a night) | Phase 1 and Phase 2 soaks cut to 24 h; Phase 3 soak cut to 48 h, run beside the canary; canary cut from 7 days to 48 h, made active | after the first friend |
| balanced | Wed Oct 28 (Thu Oct 29) | Phase 1 and Phase 2 soaks cut to 24 h; Phase 3 soak cut to 72 h on Rem alone; the canary stays 7 days | after the first friend |
| the plan's | Nov 29-Dec 20 by its own durations; "mid to late December" in PLAN §0 | nothing | before Phase 1 |

### 4.1 Fastest-safe, day by day

| when | step | waits for |
|---|---|---|
| Thu Oct 15, afternoon | Rem's rulings (§5). Lanes start building Phase 2, Phase 3 and 4a in new files, with their tests (PLAN §13.4 allows this now) | – |
| Thu 8 PM to Fri 5:30 AM | lanes 1901, then 1902; lane 1907 at 12:30 AM on its own; the cutover (1903) at 3:30 AM once both are done | STAT idle or exempted; the night slot |
| Fri, by about noon | lanes 1904, 1905 and 1910 in parallel, then 1906 and 1911. The interim second pinger, then Rem's cron-job.org job | the cutover |
| Fri, about noon to 6 PM | Phase 1's remainder: `forUser` through `db.ts`, `userCache` on the seven cached reads, the uid in ETags, bodies, the layout and storage names, `requireUser` on the remaining entry points, `/api/metrics`, the versioned open, and tests T1, T2, T7, T8 and T10. Then its adversarial review. Then the deploy with the second `AUTH_SECRET` rotation; Rem signs in once; Rem sets up the health-check job | lanes 1906 and 1911 |
| Sat Oct 17, evening | Phase 2: `lazyboy-app`, encrypted tokens, the identity read, tests T5, T6 and T9, with T12 and PLAN §11.2's re-check run first. Then PLAN §11.4's token move, at an hour Rem picks | 24 h of Phase 1; lane 1904; the dev sign-in showing `account_id` |
| Sun Oct 18, by evening | Phase 3 and 4a deploy under `SIGNUPS=owner`, after the whole-diff review and PLAN §13.2's gates. Then `SIGNUPS=invite`, and the canary signs in | 24 h of Phase 2 |
| Sun to Tue | the canary and Phase 3's soak, 48 h together. Lane 1908's outcome lands on Monday | – |
| Tue Oct 20, evening | the canary's exit checks; the canary deleted through the job and its planted backup file pruned; the first friend's request, Rem's dashboard entry, the friend connects | 48 h of canary |

If a fix touches an isolation layer, the canary's 48 hours start over. A fix anywhere else does not
restart them.

### 4.2 Balanced

The order and the soaks on Rem alone are the same as in §4.1:

| when | step |
|---|---|
| Fri Oct 16, evening | Phase 1 deploys |
| Sat Oct 17, evening | Phase 2 deploys |
| Sun Oct 18, evening | Phase 3 deploys |
| Wed Oct 21, evening | after 72 h of Phase 3 on Rem alone, 4a deploys and the canary starts |
| Wed Oct 28 | after the full 7-day canary week, the first friend |

Balanced keeps every protection for other people at the plan's full strength. What it adds over
fastest-safe is a third day of the capture policy before any second account exists, and five more days of
passive two-user running.

### 4.3 Recommendation

Fastest-safe. Everything in it that protects another person's data comes from the plan at full strength,
except the canary's length. What it shortens is evidence about Rem's own app, which his recorder and a
one-push revert cover. The canary's paths run on every request, every tick or once a day, so 48 hours with
every feature used runs each of them at least twice. What a longer canary adds is rarer timing, and the
runtime owner checks stand behind the tests for that.

Balanced spends a week to buy passive two-user time.

Three days saves about two more days, and pays with the friend's capture evidence and with being able to
roll back one phase at a time.

## 5. What it needs, and what moves after

**Rem, before 8 PM tonight**

- **STAT-first.** Exempt lanes 1901-1906 and 1910-1911 from STAT-first through Friday, or accept that a
  busy STAT evening moves everything back a day.
- **No Lazy Boy tab left open overnight**, so the cutover's quiet-app check passes at 3:30 AM.
- **Decisions 2-3.** The plan's eight STORE_MIGRATION edits are in neither the contract nor the lane
  briefs. The contract last changed on Oct 13, and none of the 19xx briefs contains any of the edits, yet
  lane 1901 starts at 8 PM. As written, the cutover gives Preview deployments the new production store
  (STORE_MIGRATION §8 step 9 sets the store variables for both Production and Preview). The edits that matter for the
  first friend:
  - **edit 2** (Preview off the production store): a gate before the canary;
  - **edit 3** (IndexedDB keyed by an opaque user key): saves Phase 1 re-keying lane 1905's store;
  - **edit 4** (the backup as a list of databases with retention, pruned first, token rows stripped):
    what friends' backups are built on;
  - **edit 6** (the identity-first orphan predicate in lanes 1910-1911): what PLAN §8.6's ~3.85M heavy-day
    figure assumes;
  - **edit 7**: backs up the only copy of 122 of Rem's plays.

  None of them blocks the cutover. If they are ruled on later, the multi-user lanes add edits 3 and 4
  themselves.
- **Decision 11** (a database per person). Phase 1's remainder is built on it.
- **Decisions 14 (the e-mailed health check), 15, 23, 24, 26 and 27** as the plan recommends, and
  **decision 16** as a 48-hour canary.
- **A standing go-ahead** for phase deploys whose tests, build and adversarial review are green.

**Rem, by Saturday**

- **The dev sign-in.** It takes minutes and shows whether `/v1/me` returns `account_id`; Phase 2 stops
  without it (decision 31). Also set `SPOTIFY_OWNER_ID` in Production if it is not already set.
- **The three dashboard reads.** Active CPU decides whether the friend has to wait for decision 18's move
  of recurring work to the Zenbook. If the team uses less than about 2 of Hobby's 4 hours a month,
  today's Vercel tick can carry two users.
- **The cron-job.org jobs:** the second pinger once its lane deploys, and the health check with Phase 1.
- **Sign in once** after Phase 1's rotation.

**Rem, by Sunday:** a second Spotify account for the canary (a free one is enough), added in User
Management. Listen on it during the 48 hours, and sign in once as the canary on your own browser after
signing yourself out.

**Tuesday:** add the friend's e-mail in User Management when their request arrives. Development mode
returns no e-mail from `/v1/me` (01e §1.1), so the request form leaves a signed request cookie for the
friend's sign-in to claim. If they sign in from a different browser, Rem sends them a join link instead.

**What moves after the first friend:**

- P2 and P3, in late October and November, with P3 before mid-December;
- P4;
- the 122-play replay and the skip-rule migration, both on Rem's data;
- decision 18's move of recurring work to the Zenbook, unless Active CPU says it has to come first;
- friends' history imports (decision 30);
- `npm run setup` for an empty install (T18);
- friends two to four, one at a time, each after two or three days of measured quota spend and Turso
  usage, and the fourth only once P4 or a measured read projection under half the free plan says so.

## 6. What this lane ran

On the Mac on Oct 15, from 2:36 PM to about 3:45 PM. Everything was read-only except this file, its
commit, and one estimate-ledger row.

- **Read in full.** PLAN.md, RULINGS.md, PHASE1.md (`git show mu/phase1:docs/multi-user/PHASE1.md`),
  STORE_MIGRATION.md, the project's CLAUDE.md, the eleven 19xx lane briefs, gate.py and the store lanes'
  RULES.md, lane 2011's brief, and `.claude/QUEUE.md`.
- **Lane durations.** `git log` of `mu/phase1` (commits from 1:09 to 1:28 AM), plus
  `~/.claude/broke/scratch/lazyboy_mu/mu_dispatch.log` with the marker times.
- **The missing edits.** `git log -- docs/STORE_MIGRATION.md`: last changed Oct 13 at 8:17 PM. A grep of
  the 19xx briefs for each of PLAN §10.2's edits found none.
- **Night slots.** Imported gate.py's `night_next` and called it for 45- and 120-minute runs at four
  times on Oct 15-16, from a scratch script that was then deleted.
- **Seats and STAT.**
  - `claude-limits rem` and `vic`: rem at 99% until its 3:10 PM reset; vic at 37%.
  - `broke --list`: a STAT 139 sweep lane running.
  - `ps`: no STAT controller running.
  - The STAT lanes queued in `wavequeue/rem` and `wavequeue/any`.
- **Estimates.** `estimates.py report`, then `estimates.py add` for §4's recommended date.
