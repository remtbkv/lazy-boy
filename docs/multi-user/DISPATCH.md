# Multi-user Lazy Boy: the lanes to the first friend

Lane 2015_lb_mu_director wrote this on Oct 15, 2026, at about 9:30 PM, after Rem's 6:21 PM approval of the fast
path ("I approve of all the previous stuff you told me for the recommendations. Just keep things going."). It
turned FASTPATH.md §4.1 into 27 queued lanes, `1945_lb_mu_01` to `1945_lb_mu_27`, in
`~/.claude/broke/wavequeue/any/`, which either enterprise seat may take.

Lane 1949_lb_mu_replan changed it at about 10:15 PM the same night for Rem's 9:27 PM ruling (RULINGS.md): no
canary account and no 48-hour canary. Lanes 25 (`canary_start`), 26 (`canary_exit`) and 27 (`first_friend`) are
in `wavequeue/superseded/`; three lanes replace them: 28, a two-user rehearsal on a production build; 29, which
checks Phase 3's 24 hours on Rem's account and sets `SIGNUPS=invite`; and 30, the canary's exit checks run on
the first friend's first hour. Lanes 06, 13, 21, 23 and 24 were edited to match; none of them had started. The
first friend can connect on **Monday Oct 19 in the evening**. The UI overhaul waits (RULINGS 9:27 PM), so no
design lane is part of this schedule.

The seat keeper starts lanes by their leading number and then by name, so these run after STAT 139 and the store
migration (1901-1911) and ahead of the CS 2430 lanes (195x). Every time below is an estimate.

How a lane starts: its header's `after=` lists marker files that must exist, and `not_before=` the earliest local
time. A soak is held twice: `not_before` at the earliest time the soak could end, and the lane's first step,
`~/.claude/broke/scratch/lazyboy_mu/mu_gate.py --age <marker> <hours>`, which re-queues the lane into `any/` until
the marker is old enough (the store program's `gate.py` re-queues into `rem/`, which these lanes are not in). Every
lane follows `~/.claude/broke/scratch/lazyboy_mu/RULES.md`: its own worktree under
`/Users/remtbkv/projects/lazyboy-wt/`, commits by explicit path as Rem with no AI lines, CLAUDE.md's gates, agents
off friends' rows, a marker in `~/.claude/broke/scratch/lazyboy_mu/markers/` when its pass condition holds, an entry
in `~/.claude/broke/scratch/lazyboy_mu/OUTCOMES.md`.

## 1. The lanes

Store markers are in `~/.claude/broke/scratch/lazyboy_store/markers/`; `NN` is lane `1945_lb_mu_NN_…`; `rem_x` is
`markers/rem_x.done`. All lanes are Opus. "Starts" assumes the cutover takes tonight's 3:30 AM slot and each lane
takes about its typical time (builds 2-3 hours at xhigh, reviews 1-1.5, deploys 1-2). Lanes 01 and 02 had started
when the replan ran (01 finished at 9:43 PM).

| NN | lane | effort | waits on | starts if nothing slips |
|---|---|---|---|---|
| 01 | `probe`: a standalone sign-in probe Rem runs twice, for `account_id` with and without two scopes | high | – | Thu Oct 15, 9:30 PM (done 9:43 PM) |
| 02 | `p2_build`: Phase 2 ahead of its turn, new files only (app database, encrypted tokens, identity read) | xhigh | – | Thu 9:30 PM |
| 03 | `p2_review`: adversarial review of 02 | xhigh | 02 | Thu 11:45 PM |
| 04 | `p3_build`: Phase 3 ahead (claim, tick, probe, harvest policy, brake) | xhigh | 03 | Fri Oct 16, 1:15 AM |
| 05 | `p3_review` | xhigh | 04 | Fri 3:30 AM |
| 06 | `p4a_build`: Phase 4a ahead (request form, invite and user scripts, Log out and Disconnect, deletion job, planted probe, /privacy) | xhigh | 05 | Fri 5 AM |
| 07 | `pinger_build`: the interim second pinger (second secret, 90-second guard) | xhigh | store 1903 | Fri 5:30 AM |
| 08 | `pinger_review` | xhigh | 07 | Fri 6:45 AM |
| 09 | `p4a_review` | xhigh | 06 | Fri 7:30 AM |
| 10 | `zenbook_account`: sqld and the meter under their own Unix account (decision 27) | high | store 1904 | Fri 8 AM |
| 11 | `pinger_deploy`: deploy, mint `CRON_SECRET_EXT`, hand it to Rem | high | 08, store 1904 | Fri 8 AM |
| 12 | `p1_build`: Phase 1's turn (`forUser` through `db.ts`, `userCache`, uid in ETags and storage, `requireUser` everywhere, the versioned open) | xhigh | store 1906, 1911 | Fri 10 AM |
| 13 | `p1_review`: the whole Phase 1 diff, told to find a cross-user path | xhigh | 12 | Fri 1 PM |
| 14 | `p1_deploy`: `OWNER_UID`, four `meta` keys, second `AUTH_SECRET` rotation, deploy, fault injection, rollback rehearsed | high | 13 | Fri 2:30 PM |
| 15 | `p2_turn`: Phase 2 onto production's code; T12 on Rem's real backup | xhigh | 14, 03 | Fri 4 PM |
| 16 | `p2_turn_review` | xhigh | 15 | Fri 6 PM |
| 17 | `p3_turn`: Phase 3 wired into the cron route, `/api/sync`, `db.ts`, `client.ts` | xhigh | 16, 05 | Fri 7:30 PM |
| 18 | `p3_turn_review` | xhigh | 17 | Fri 10 PM |
| 19 | `p4a_turn`: Phase 4a wired in; `backup.py` into the repo with "only Rem's rows" | xhigh | 18, 09 | Fri 11:30 PM |
| 20 | `p4a_turn_review` | xhigh | 19 | Sat Oct 17, 2 AM |
| 21 | `whole_review`: PLAN §13.2's review of Phases 1-4a together | xhigh | 20 | Sat 3:30 AM |
| 28 | `rehearsal`: a production build, two synthetic friends and an admin through the scripted Spotify stand-in; FASTPATH §2.4's list (below) | xhigh | 21 | Sat 7:30 AM |
| 22 | `p2_deploy`: old builds deleted, platform token to the Keychain, `lazyboy-app`, the token move, deploy, rollback rehearsed | high | 16, store 1904, `rem_dev_signin`, `rem_owner_id`, `rem_token_move_hour`; 24 h after 14; not before the hour Rem picked | Sat 4-5 PM |
| 23 | `p3_deploy`: deploy, the Zenbook's pinger timer and hourly recorder, second-pinger proof, rollback rehearsed | high | 28, 22; 24 h after 22 | Sun Oct 18, 5-7 PM |
| 24 | `p4a_deploy`: §13.2's gates, deploy under `SIGNUPS=owner`, backups with a planted file, deletion and restore drill, fault injection, the planted probe | high | 23, 28, 10, `rem_dashboard_reads`, `rem_health_job`, `rem_pinger_job` | Sun 7-9 PM |
| 29 | `open`: Phase 3's 24 hours and 4a's day on Rem's account checked, the probe's alarm and the planted backup file read, `freeze.sh` written, then `SIGNUPS=invite` | high | 24, 28; 24 h after 23; not before Mon 5 PM | Mon Oct 19, 6-8 PM |
| 30 | `first_hour`: the exit checks on the first friend's first hour, aggregates only, `freeze.sh` on a failure | high | 29, `rem_friend_email`; 1 h after it | Mon about 9-11 PM |

The friend can request access once lane 29 opens the door, Monday at about 7-9 PM if every lane above holds, the
cutover takes tonight's slot, and Rem picks about 4-5 PM Saturday for the token move. Each hour later on Saturday
moves Monday by an hour; a missed cutover slot moves everything a day, to Tuesday Oct 20.

Lane 28's checks, RULINGS 9:27 PM's list (FASTPATH §2.4): `cache()` in route handlers; the Data Cache across
environments (two servers, production and preview, on one build and one cache directory); one instance serving
two users (one `next start`, both users' requests interleaved); two token refreshes in one tick, and one of them
failing; the shared-device case in one real browser profile; the planted probe and the health check's red answer
that e-mails Rem; deletion reaching backups (Disconnect, the deletion job, then `backup.py` against fixture
backups). It also proves the `SIGNUPS=owner` freeze locally. Nothing in it touches Spotify, Turso, Vercel, the
Zenbook or real data.

## 2. Rem's steps

Each is a line in `~/.claude/broke/wavequeue/NEEDS_REM.md`, written by the lane before it, that names its marker.
The lane manager touches the marker when Rem has done it. Two markers carry text: `rem_token_move_hour.done` holds
the hour on its first line as `YYYY-MM-DDTHH:MM` (lane 22 waits until then; an empty file means now), and
`rem_dashboard_reads.done` holds the three readings (lane 24 stops if Active CPU is above about 2 of 4 hours).

| marker | Rem's step | when | written by | lane waiting |
|---|---|---|---|---|
| `rem_dev_signin` | run `node scripts/probe-me-keys.mjs` in `lazyboy-wt/1945_01`, then with `--drop-scopes`, signing in each time | now (lane 01 finished), by Sat Oct 17 noon | 01 | 22 |
| `rem_owner_id` | set `SPOTIFY_OWNER_ID` in Production and `.env.local` to the `id` the probe wrote | with the above | 01 | 22 |
| `rem_pinger_job` | re-enable or create the cron-job.org job: every 2 minutes, GET `/api/cron/sync`, bearer from lane 11's file | Fri Oct 16, after about 9 AM | 11 | 24 (23 proves it if present) |
| (no marker) | sign in once after Phase 1's deploy (older cookies are refused) | Fri Oct 16, after about 4 PM | 14 | 22 checks for a page view |
| `rem_health_job` | the hourly cron-job.org health check with failure e-mail, saved first with a wrong bearer so one failure e-mail arrives | Fri Oct 16 evening | 14 | 24 |
| `rem_dashboard_reads` | Spotify User Management (how many accounts), Vercel Active CPU over 30 days, Deployment Protection level | by Sat Oct 17 | this doc | 24 |
| `rem_token_move_hour` | pick the hour of Phase 2's token move (a few minutes in which pages fail) | by Sat Oct 17 noon; 4-5 PM Saturday keeps Monday | this doc | 22 |
| `rem_friend_email` | add the friend's Spotify e-mail in User Management (it can be done before their request); when the request arrives, approve it with `invite.mjs` | Mon Oct 19, after lane 29 | 29 | 30 |

Rem also gets one cron-job.org failure e-mail on Sunday evening: lane 24's planted probe, which proves the alarm
path in production. Removed by the replan: `rem_canary_account`, `rem_canary_connected` and
`rem_canary_checklist`.

## 3. Choices made where FASTPATH or PLAN left one open

- **Build ahead in a stack, one phase at a time.** `mu/phase2` is cut from `mu/phase1`, `mu/phase3` from reviewed
  `mu/phase2`, `mu/phase4a` from reviewed `mu/phase3`, each frozen once reviewed. Each turn cuts a new branch and
  replays only its own commits with `git rebase --onto`, so no lane rewrites another's branch.
- **Every turn is a build, a review and a deploy** (Rem's rule for this program: a review lane after every build,
  in a fresh context, before any deploy). Phase 1's turn follows PLAN §13.1 in full; it has no build-ahead review,
  so lane 13 reviews the whole Phase 1 diff.
- **Phase 1's mechanical edit is one Opus xhigh lane**, not PLAN §13.4's Sonnet medium lane: it is isolation code,
  which this program builds at xhigh, and one lane in `db.ts` at a time keeps it from splitting.
- **The dev sign-in is a standalone probe script** instead of PLAN §13.1's dev server: it writes no store, holds no
  token after it exits, and also prints the `id` that `SPOTIFY_OWNER_ID` needs.
- **The interim pinger** builds after the cutover (FASTPATH §4.1) and deploys after lane 1904 (PLAN §13.3).
- **Backups keep only Rem's rows** (RULINGS Oct 15 6:21 PM), which overrides PLAN §12.4's four-day copies of
  friends: friends' databases are never dumped, the app-database and telemetry copies are filtered to Rem's rows,
  and any backup file of a non-admin database is pruned at any age. Lane 28 tests the prune on fixtures; lane 24
  plants a file for a fictitious non-admin database on the Zenbook and lane 29 checks the nightly run deleted it.
- **The rehearsal runs after the whole-diff review and before either Sunday deploy** (Rem: after Phase 3 and 4a
  are built and reviewed, before `SIGNUPS=invite`). It runs Saturday morning, off the critical path, so a defect it
  finds can be fixed before Sunday. It fixes defects the way lane 21 does, on the turn branches with a test that
  fails first; its marker carries the heads lanes 23 and 24 deploy. A defect needing a design change stops it, and
  nothing after it deploys.
- **4a deploys Sunday evening under `SIGNUPS=owner`, inside Phase 3's 24 hours.** Phase 3's soak stays on Rem's own
  account with no other user, as ruled; it then covers the capture code a friend gets (4a turns the brake on and
  sets the 2-hour backstop), at the cost that a regression that day could come from either phase. Waiting for the
  soak before deploying 4a would put 4a's deploy, its drills and the door in one Monday-evening lane with no time
  between them.
- **The planted probe fires in production under `SIGNUPS=owner`**, stamped on Rem's key with a uid no user holds,
  so no friend's data or experience is involved; lane 29 reads its alarm on Monday.
- **The first-hour checks read no friend's row.** RULES 11 now names no canary. Lane 30 uses counts, verdicts and
  Rem's rows; its one query in the friend's database is a `count(*)` of Rem's play pairs found there. The checks
  that need a second account's rows (Home and search per user, the shared-device case, deletion for real) ran on
  synthetic users in lane 28.
- **The freeze is a script** (`~/.claude/broke/scratch/lazyboy_mu/freeze.sh`, lane 29) that sets `SIGNUPS=owner`
  and redeploys the current production url, with `--dry-run` run before the door opens. Lane 30 and Rem use it.
- **Two minutes for everyone** (decision 28 as ruled): PLAN §7.2's five-minute idle cadence at three or more users
  is dropped.
- **The platform token moves to the Keychain in lane 22**, before PLAN §11.4 step 1 needs it there; the store
  program's RULES.md is updated in the same step, since lanes 1908 and 1909 read it. `TOKEN_KEYS` gets one backup
  copy in the Keychain (PLAN §5.3's password-manager copy) and no other.
- **Preview loses its telemetry variables too** (lane 24), since telemetry rows carry users' ids from Phase 1 on
  (PLAN §4.5: Preview gets no store variables).
- **The whole-diff review never edits `mu/phase2-turn`**, which may deploy while it runs; a Phase 1 or 2 defect it
  finds ships with Phase 3 on Sunday, while production still serves Rem alone under `SIGNUPS=owner`. Lane 28
  follows the same rule.
- **Lanes 1946 (capacity) and 1947 (authz)** were running when the replan ran and had written nothing into these
  lanes. Their own lanes and notes keep their gates; lane 30 reads CAPACITY.md if it exists.

## 4. Risks to Monday

- **Tonight's cutover slot.** Lane 1901 started at 9:24 PM. If 1901 and 1902 are not done by 4 AM, the cutover
  takes Saturday's 12:30 AM slot and every date here moves a day, to Tuesday Oct 20 (FASTPATH §3 item 1).
- **Rem's Saturday hour.** Phase 2 cannot deploy before 24 hours of Phase 1, Phase 3 not before 24 hours of Phase
  2, and the door not before 24 hours of Phase 3. A token move after about 5 PM Saturday pushes the friend later
  hour for hour.
- **Lane 12 is the largest** (74 exports, 54 `getClient()` sites, ~535 call lines at xhigh). If it or its review
  runs long, Phase 1 deploys Friday night and the chain moves with it.
- **A review or the rehearsal that finds a design-level defect stops its chain**; the plan has no spare day for a
  redesign (FASTPATH §3 item 5).
- **The rehearsal is local.** It cannot see Vercel's shared Data Cache or real Fluid instances; the owner stamps,
  the runtime owner checks and the e-mailed isolation events stand behind it in production, and lane 30's first
  hour is the first time two real users meet. `freeze.sh` stops every non-admin session and sync with one redeploy.
- **Seats.** STAT 139 starts first on both seats and most of these lanes run at xhigh or high; a heavy STAT weekend
  delays the Friday and Saturday builds, which have about a day of slack before Sunday's deploys. Lane 28 adds
  about four hours on Saturday morning, inside that slack.
- **Disk.** 19 GB free on Oct 15; each worktree's `npm ci` takes about a gigabyte, and a lane waits below 12 GB.
  Lane 28 also builds for production and keeps a browser profile.
- **Two answers can stop the path:** no `account_id` from Spotify (lane 22 stops; decision 31 is Rem's), and Active
  CPU above about 2 of Hobby's 4 hours (lane 24 stops; the friend waits for recurring work to move to the Zenbook,
  decision 18 as ruled).
- **Adjacent: local `main` is 264 commits ahead of `origin/main`** (Oct 15, 9:30 PM). Lane 1902's push ships them
  with the store split, including code commits such as the privacy pages and the now-playing change. After that,
  docs committed to local `main` (this file included) stay off `origin` until someone merges them; each deploy lane
  here leaves local `main` alone when it cannot fast-forward.

## 5. Files

- `~/.claude/broke/scratch/lazyboy_mu/RULES.md`: the standing rules every lane reads first.
- `~/.claude/broke/scratch/lazyboy_mu/mu_gate.py` and `test_mu_gate.py` (seven known answers).
- `~/.claude/broke/scratch/lazyboy_mu/markers/`: lane and Rem markers. `OUTCOMES.md`: each lane's entry.
- `~/.claude/broke/scratch/lazyboy_mu/secrets/CRON_SECRET_EXT`: lane 11 writes it for Rem's two cron-job.org jobs;
  lane 24 deletes it.
- `~/.claude/broke/scratch/lazyboy_mu/freeze.sh`: lane 29 writes it; `SIGNUPS=owner` and one redeploy.
- `docs/multi-user/REHEARSAL.md` on `mu/phase4a-turn`: lane 28's checks and the command that re-runs them before
  friends two to four.
- After the first friend (FASTPATH §5): P2-P4, the 122-play replay, PLAN §11.4 step 6 a week after Phase 2 (lane 22
  adds it to `.claude/QUEUE.md`), friends two to four, the UI overhaul. None is queued here.
