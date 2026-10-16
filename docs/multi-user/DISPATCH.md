# Multi-user Lazy Boy: the lanes to the first friend

Lane 2015_lb_mu_director wrote this on Oct 15, 2026, at about 9:30 PM, after Rem's 6:21 PM approval of the fast
path ("I approve of all the previous stuff you told me for the recommendations. Just keep things going."). It
turns FASTPATH.md §4.1 into 27 queued lanes, `1945_lb_mu_01` to `1945_lb_mu_27`, in
`~/.claude/broke/wavequeue/any/`, which either enterprise seat may take. The seat keeper starts lanes by their
leading number and then by name, so these run after STAT 139 and the store migration (1901-1911) and ahead of the
CS 2430 lanes (195x). No lane here ran when this was written; every time below is an estimate.

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
takes about its typical time (builds 2-3 hours at xhigh, reviews 1-1.5, deploys 1-2).

| NN | lane | effort | waits on | starts if nothing slips |
|---|---|---|---|---|
| 01 | `probe`: a standalone sign-in probe Rem runs twice, for `account_id` with and without two scopes | high | – | Thu Oct 15, 9:30 PM |
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
| 22 | `p2_deploy`: old builds deleted, platform token to the Keychain, `lazyboy-app`, the token move, deploy, rollback rehearsed | high | 16, store 1904, `rem_dev_signin`, `rem_owner_id`, `rem_token_move_hour`; 24 h after 14; not before the hour Rem picked | Sat 4-5 PM |
| 23 | `p3_deploy`: deploy, the Zenbook's pinger timer and hourly recorder, second-pinger proof, rollback rehearsed | high | 21, 22; 24 h after 22 | Sun Oct 18, 5-6 PM |
| 24 | `p4a_deploy`: §13.2's gates, deploy under `SIGNUPS=owner`, backups, deletion and restore drill, then `SIGNUPS=invite` | high | 23, 10, `rem_dashboard_reads`, `rem_health_job`, `rem_pinger_job`, `rem_canary_account` | Sun 6-7 PM |
| 25 | `canary_start`: two users running, the planted probe, a planted backup file | high | 24, `rem_canary_connected` | Sun 8:30-9:30 PM |
| 26 | `canary_exit`: Phase 3's and the canary's exit checks over 48 hours, the canary deleted through the job | high | 25, `rem_canary_checklist`; 48 h after `rem_canary_connected` | Tue Oct 20, 8:30-9:30 PM |
| 27 | `first_friend`: aggregate-only checks two hours after Rem approves the friend | high | 26, `rem_friend_email`; 2 h after it | Tue about 11 PM |

The first friend connects when Rem approves their request after lane 26, Tuesday at about 9:30-10:30 PM if every
lane above holds, the cutover takes tonight's slot, and Rem picks about 4-5 PM Saturday for the token move. Each
hour later on Saturday moves Tuesday by an hour; a missed cutover slot moves everything a day.

## 2. Rem's steps

Each is a line in `~/.claude/broke/wavequeue/NEEDS_REM.md`, written by the lane before it, that names its marker.
The lane manager touches the marker when Rem has done it. Two markers carry text: `rem_token_move_hour.done` holds
the hour on its first line as `YYYY-MM-DDTHH:MM` (lane 22 waits until then; an empty file means now), and
`rem_dashboard_reads.done` holds the three readings (lane 24 stops if Active CPU is above about 2 of 4 hours).

| marker | Rem's step | when | written by | lane waiting |
|---|---|---|---|---|
| `rem_dev_signin` | run `node scripts/probe-me-keys.mjs` in `lazyboy-wt/1945_01`, then with `--drop-scopes`, signing in each time | after lane 01 (Thu night), by Sat Oct 17 noon | 01 | 22 |
| `rem_owner_id` | set `SPOTIFY_OWNER_ID` in Production and `.env.local` to the `id` the probe wrote | with the above | 01 | 22 |
| `rem_pinger_job` | re-enable or create the cron-job.org job: every 2 minutes, GET `/api/cron/sync`, bearer from lane 11's file | Fri Oct 16, after about 9 AM | 11 | 24 (23 proves it if present) |
| (no marker) | sign in once after Phase 1's deploy (older cookies are refused) | Fri Oct 16, after about 4 PM | 14 | 22 checks for a page view |
| `rem_health_job` | the hourly cron-job.org health check with failure e-mail, saved first with a wrong bearer so one failure e-mail arrives | Fri Oct 16 evening | 14 | 24 |
| `rem_dashboard_reads` | Spotify User Management (how many accounts), Vercel Active CPU over 30 days, Deployment Protection level | by Sat Oct 17 | this doc | 24 |
| `rem_token_move_hour` | pick the hour of Phase 2's token move (a few minutes in which pages fail) | by Sat Oct 17 noon; 4-5 PM Saturday keeps Tuesday | this doc | 22 |
| `rem_canary_account` | a second Spotify account (free is enough) added in User Management | by Sun Oct 18 afternoon | this doc | 24 |
| `rem_canary_connected` | as the canary: request access, approve it with `invite.mjs`, connect | Sun Oct 18, 8:30-9:30 PM | 24 | 25, 26 |
| `rem_canary_checklist` | FASTPATH §2.4's feature run as the canary, the shared-device case included, no Disconnect | by Tue Oct 20, 6 PM | 24 | 26 |
| `rem_friend_email` | the friend's request arrives; add their e-mail in User Management; approve it with `invite.mjs` | Tue Oct 20, after lane 26 | 26 | 27 |

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
  and any backup file of a non-admin database is pruned at any age. The canary's planted backup file (FASTPATH
  §2.4) tests that prune.
- **The canary goes through the request form like a friend**, and leaves through the deletion job run by lane 26
  (`user.mjs --remove`) after the exit checks, not by pressing Disconnect, which would delete its data before the
  checks read it.
- **Two minutes for everyone** (decision 28 as ruled): PLAN §7.2's five-minute idle cadence at three or more users
  is dropped.
- **The platform token moves to the Keychain in lane 22**, before PLAN §11.4 step 1 needs it there; the store
  program's RULES.md is updated in the same step, since lanes 1908 and 1909 read it. `TOKEN_KEYS` gets one backup
  copy in the Keychain (PLAN §5.3's password-manager copy) and no other.
- **Preview loses its telemetry variables too** (lane 24), since telemetry rows carry users' ids from Phase 1 on
  (PLAN §4.5: Preview gets no store variables).
- **The whole-diff review never edits `mu/phase2-turn`**, which may deploy while it runs; a Phase 1 or 2 defect it
  finds ships with Phase 3 on Sunday, while production still serves Rem alone under `SIGNUPS=owner`.

## 4. Risks to Tuesday

- **Tonight's cutover slot.** Lane 1901 started at 9:24 PM. If 1901 and 1902 are not done by 4 AM, the cutover
  takes Saturday's 12:30 AM slot and every date here moves a day, to Wednesday Oct 21 (FASTPATH §3 item 1).
- **Rem's Saturday hour.** Phase 2 cannot deploy before 24 hours of Phase 1, and Phase 3 not before 24 hours of
  Phase 2. A token move after about 5 PM Saturday pushes the friend later hour for hour.
- **Lane 12 is the largest** (74 exports, 54 `getClient()` sites, ~535 call lines at xhigh). If it or its review
  runs long, Phase 1 deploys Friday night and the chain moves with it.
- **A review that finds a design-level defect stops its chain**; the plan has no spare day for a redesign
  (FASTPATH §3 item 5).
- **Seats.** STAT 139 starts first on both seats and 23 of these lanes run at xhigh or high; a heavy STAT weekend
  delays the Friday and Saturday builds, which have about a day of slack before Sunday's deploys.
- **Disk.** 19 GB free on Oct 15; each worktree's `npm ci` takes about a gigabyte, and a lane waits below 12 GB.
- **The canary's 48 hours restart** if a fix touches an isolation layer during them (FASTPATH §4.1).
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
- After the first friend (FASTPATH §5): P2-P4, the 122-play replay, PLAN §11.4 step 6 a week after Phase 2 (lane 22
  adds it to `.claude/QUEUE.md`), friends two to four. None is queued here.
