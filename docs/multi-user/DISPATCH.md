# Multi-user Lazy Boy: the lanes to the first friend

Lane 2015_lb_mu_director wrote this on Oct 15, 2026, at about 9:30 PM, after Rem's 6:21 PM approval of the fast
path; lane 1949_lb_mu_replan changed it at about 10:15 PM for Rem's 9:27 PM ruling (no canary account). Lane
1944_lb_mu_speed replanned it on Oct 16 at about 2 AM for Rem's 1:19 AM instruction:

> "the faster we can put the friends on, the better ... I don't see any reason why you can't speed up this
> migration, speed up everything, and make sure it's still doing everything correctly. We have a proper backup of
> the system before, so we can revert there ... there's no reason why it can't be more parallelized out or at least
> built out so then it can be stitched together properly ... There's no reason why it has to take days."

Two changes do it. The phase turns build in parallel, each on its own branch, and two stitch lanes put them together
in deploy order before the reviews read them (§3). And a phase deploys when the one before it is verified in
production, not 24 hours after it (§4): the checks read Rem's real plays, the recorder, telemetry and the meter, and
the daily jobs run in the two-user rehearsal on a fast-forwarded clock. The rehearsal, the friend's first-hour
checks, the `SIGNUPS=owner` freeze and the capacity meter before sign-ups open all stay.

**The first friend can connect on Saturday Oct 17 in the afternoon** if every lane holds and Rem listens on Friday
evening or Saturday morning; the old plan said Monday Oct 19 in the evening. Every time below is an estimate.

How a lane starts: its header's `after=` lists marker files that must exist, and `not_before=` the earliest local
time. A deploy lane's step 0 is its production check; if the evidence is not in yet, it runs
`~/.claude/broke/scratch/lazyboy_mu/mu_gate.py <lane> --retry 30 --why "…"`, which puts it back in
`wavequeue/any/` for 30 minutes later, and ends (RULES 10). Every lane follows
`~/.claude/broke/scratch/lazyboy_mu/RULES.md`, rewritten at rules 5, 7, 8 and 10 for this plan.

## 1. Where things stand, Oct 16 at 2 AM

- Done: lanes 01 (the sign-in probe, 9:43 PM), 02 and 03 (Phase 2 built ahead and reviewed, 11:05 PM), 04 and 05
  (Phase 3 built ahead and reviewed, 1:55 AM, `mu/phase3` at f754f72), 1946_lb_capacity (CAPACITY.md), 1947_lb_authz
  (AUTHZ.md and the authorization tests, 82b360b on `lane/1947_lb_authz`); store lanes 1901 and 1902 (the store split,
  live at 7aeb438) and 1907 (the Funnel certificate, now valid to Jan 14, 2027).
- Running: 12 (Phase 1's turn, on the store split, no longer waiting for 1906 and 1911) and 07 (the interim pinger),
  both started at 1:43 AM on the rem seat; 06 (Phase 4a built ahead) since 1:55 AM.
- The cutover (1903) is in tonight's slot: its gate re-queued it for 3:33 AM. The seat keeper starts it then; a
  one-shot spawner (pid 81092, logging to `lazyboy_store/store_chain.log`) starts it at 3:34 AM if the keeper has
  not. `store_chain.py` starts 1904-1911 as their markers appear.

## 2. The lanes

`NN` is lane `1945_lb_mu_NN_…`; `cap0N` is `1946_lb_capacity_0N_…`; store lanes keep their numbers; `rem_x` is
`markers/rem_x.done`. All Opus. The times assume measured lane lengths (builds took 65-80 minutes on Oct 15-16,
reviews 30-80) with Phase 1's turn at about two hours, and Rem listening when the checks need his plays. Lane 32 is
unused: lanes 12 and 07 started before the numbering settled and were told the Phase 1 stitch is lane 33.

| lane | does | waits on | starts / ends if nothing slips |
|---|---|---|---|
| 12 | Phase 1's turn on the store split | – | running, 1:43-~3:45 AM |
| 07 → 08 | the interim pinger, its review | 07 | running → ~2:50-3:50 AM |
| 06 → 09 | Phase 4a built ahead, its review | 05 | running → ~3:20-4:30 AM |
| 1903 | the cutover (night slot) | 1902, 1907 | 3:33-~5:30 AM |
| 31 `stack` | Phase 2's and 3's build-ahead commits replayed once onto Phase 1's turn: `mu/p2-base`, `mu/p3-base` | 12 | ~3:50-4:50 AM |
| cap01 | the capacity meter, on Phase 1's turn | 12 | ~3:50-5:15 AM |
| 15 / 17 | Phase 2's / Phase 3's wiring, in parallel | 31 | ~4:55-6:30 AM |
| 11 | the interim pinger deployed; `CRON_SECRET_EXT` for Rem | 08, 1903 | ~5:35-6:30 AM |
| 1904, 1905, 1910 | aftercare, browser search cache, scoped orphan pass | 1903 | ~5:35-7:00 AM |
| 10 | sqld and the meter under their own Zenbook account | 1904 | ~7:05-8:15 AM |
| 19 | 4a's replay and wiring | 31, 09, 1904 (its `backup.py`) | ~7:05-8:30 AM |
| 1906, 1911 | review and deploy of 1905, 1910 | 1905, 1910 | ~7:05-8:30 AM |
| 33 `p1_stitch` | Phase 1 onto `main` after them: 1905's IndexedDB key → the uid, 1910's orphan pass through `forUser`, the two `cron-auth.ts` | 12, 1906, 1911, 11 | ~8:35-9:45 AM |
| 13 | Phase 1 review, on `mu/s-p1` | 33 | ~9:50-11:15 AM |
| 34 `stitch` | the meter, Phase 2, 3 and 4a laid on `mu/s-p1` in deploy order, one slice each | 33, cap01, 15, 17, 19 | ~9:50-11:30 AM |
| 14 | Phase 1 deployed (`OWNER_UID`, four `meta` keys, `AUTH_SECRET` rotation, fault injection, rollback rehearsed) | 13 | ~11:20 AM-12:45 PM |
| cap02, 16, 18, 20, 21 | reviews of the meter, Phase 2, 3, 4a slices and the whole diff, in parallel on the stitched stack | 34 | ~11:35 AM-2 PM |
| 28 | the two-user rehearsal on the stitched stack, plus check 9: the daily cycle on a fast-forwarded clock | 34 | ~11:35 AM-3:30 PM |
| 35 `restitch` | every review's fixes folded into its phase's slice: `mu/f-meter`, `f-p2`, `f-p3`, `f-p4a` | 13, 14, cap02, 16, 18, 20, 21, 28 | ~3:35-4:45 PM |
| 36 `restitch_review` | fresh-context check that `mu/f-*` is what the reviews passed | 35 | ~4:50-5:45 PM |
| 37 `meter_deploy` | V1, then the meter deployed | 36, 14 | ~5:50-6:30 PM |
| 22 | V2, then Phase 2 and the token move | 37, 1904, `rem_dev_signin`, `rem_owner_id`, `rem_token_move_hour` (its hour) | ~6:30-8:30 PM |
| 23 | V3, then Phase 3, the Zenbook timer, the second pinger proven | 22 | ~9:30-11:00 PM |
| 24 | V4 and PLAN §13.2's gates, then 4a under `SIGNUPS=owner`, the backup prune proven by a hand run, the planted probe | 23, 10, `rem_dashboard_reads`, `rem_health_job`, `rem_pinger_job` | Fri ~11 PM-Sat 12:30 AM if Rem listens Friday night; else Sat ~10:30 AM-noon |
| 29 | V5, `freeze.sh`, then `SIGNUPS=invite` | 24, 37 | Sat ~1:30-3 AM, or ~1-2 PM |
| 30 | the first friend's first hour, aggregates only | 29, `rem_friend_email`; 1 h after it | Saturday afternoon |
| cap03 → cap04 | per-user shares, for friends two to four | 37, 24 → cap03, 30 | after the first friend |
| cap05 | the meter against Rem's dashboard reading after 72 hours of measurement | 37 + 72 h, 1903, `rem_dashboard_reads`, 10 | Monday evening; friends two to four only |
| 1908, 1909 | the store move's outcome (72 h after 1906), the frozen copy dropped (168 h after 1903) | – | Mon Oct 19, Fri Oct 23; nothing waits on them |

The critical path runs through the store lanes (1903 → 1905/1910 → 1906/1911 → 33), the parallel reviews and the
rehearsal (34 → 28 → 35 → 36), then five deploys, each waiting on Rem's plays. Each hour Rem's listening or his
token-move hour arrives later moves the rest by about that much; a missed cutover slot moves 33 onward by a day.

## 3. Branches: build in parallel, stitch, review the stitched result

```
origin/main 7aeb438 ─ mu/phase1 rebased ─ mu/phase1-turn (12) ─┬─ mu/p2-base ─ mu/phase2-turn (15)
                                                               │  └ mu/p3-base ─┬ mu/phase3-turn (17)
                                                               │                └ mu/phase4a-turn (19, replays mu/phase4a)
                                                               └─ cap/meter (cap01)
main after 1906, 1911, 11 ─ mu/s-p1 (33) ─ mu/s-meter ─ mu/s-p2 ─ mu/s-p3 ─ mu/s-p4a   (34: one slice per deploy)
reviews: mu/rv-p1 (13), mu/rv-meter (cap02), mu/rv-p2 (16), mu/rv-p3 (18), mu/rv-p4a (20), mu/rv-whole (21),
         mu/rv-rehearsal (28)
P1 as deployed (14) ─ mu/f-meter ─ mu/f-p2 ─ mu/f-p3 ─ mu/f-p4a   (35 folds the fixes, 36 checks; 37, 22, 23, 24 push)
```

- **One writer per branch** (RULES 7). No lane moves a branch it did not create; a stitch makes new branches with
  `git rebase --onto` from the sources' heads, so a source can always be compared with what it became
  (`git range-diff`, recorded by every stitch).
- **Shared bases.** Lane 31 replays Phase 2's and 3's build-ahead commits onto Phase 1's turn once, so lanes 15, 17
  and 19 start from the same commits and the stitch meets one resolution of each replay conflict.
- **Deploy order is stack order: Phase 1, the meter, Phase 2, Phase 3, 4a.** Each slice must build and pass alone,
  because each deploys alone and reverts alone. The meter goes right after Phase 1 so it measures Phase 2-4a's real
  cost on Rem's account before a friend arrives, and its first daily budget record exists before lane 29 reads it.
- **What the stitches reconcile:** lane 33, Phase 1 against lanes 1905 (`den-home.tsx`, the layout, the sign-out
  form), 1910 (`db.ts`'s orphan pass, `store-diff.ts`, `read-costs.ts`) and 11 (`cron-auth.ts`, `/api/cron/sync`);
  lane 34, the meter's hooks against the routes Phase 3 and 4a rewrite, Phase 3's wiring against Phase 2's
  (`db.ts`, the token store, the harness, the health check), Phase 3's tick against the interim pinger and its
  rescan against 1910's scoped pass. Every behaviour-changing resolution is its own commit with a test that fails
  first.
- **Reviews run on the stitched result**, fresh-context and adversarial, each on its slice, plus lane 21 on the
  whole diff and lane 28's rehearsal, all at once. Each commits its fixes on its own `mu/rv-*` branch, the message
  naming the phase it fixes; lane 35 puts each fix in that phase's slice (a Phase 1 fix found after Phase 1 is live
  goes in the meter's slice). Lane 36 checks the fold in a fresh context before anything after Phase 1 deploys.
- **The authorization tests** (lane 1947, `AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-`) gate every
  boundary: no cell or red-team check pinned to a phase at or below it may fail (P1 and L07 at `s-p1`/`s-meter`,
  then P2, P3, P4a). Each review checks that the pins its phase removed were met by code, not by editing the
  expectation.

## 4. Checks that replace the waits

Each is step 0 of the lane after the deploy it checks, over the window since that deploy's marker. Missing evidence
re-queues the lane for 30 minutes (RULES 10); wrong evidence stops it; evidence still missing 12 hours after the
marker writes `.blocked` and a NEEDS_REM line. The recorder diff is PLAN §11.2's method (scripts in
`~/.claude/broke/scratch/lazyboy_mu/0224_review/`), both ways; ticks are read from the Zenbook's
`~/lazyboy-cron/ping.log`.

| check | after | read by | evidence | stands in for |
|---|---|---|---|---|
| V1 | Phase 1 (14) | 37 | every tick 200; ≥3 of Rem's plays stored, recorder diff empty; Rem signed in after the rotation (a page view with his uid); no isolation event, no 5xx or fence 503 from production; telemetry arriving; `verify-derived.mjs` green | Phase 1's 24 h |
| V2 | the meter (37) | 22 | V1's capture items over the new window; meter rows arriving; every dimension normal | – (new deploy) |
| V3 | Phase 2 (22) | 23 | ≥1 hourly refresh of Rem's token through `user_tokens`, decrypting; no `decrypt` or isolation event; ticks ok; ≥3 plays, recorder diff empty; `verify-derived.mjs` green | Phase 2's 24 h |
| V4 | Phase 3 (23) | 24 | ≥20 of Rem's plays under Phase 3, recorder diff empty; ≥1 listening session ended with its tail harvest; every harvest tagged, harvests per play within PLAN §7.4; no play first stored by a backstop while he listened; ticks ≤20 s; `sync_state` moving; only catch-up harvests from the open app; no events; the second pinger's ten-minute proof | Phase 3's 24 h on Rem's account, kept by RULINGS 9:27 PM and superseded by Rem's 1:19 AM instruction |
| V5 | 4a (24) | 29 | the planted probe's one `cache-stamp` event and the hourly health job's red record after it, green since; the planted backup files pruned by lane 24's hand run before its dump, Rem's files untouched; ≥5 plays, recorder diff empty; no other events, no `decrypt`, no `QUOTA_EXCEEDED`; the budget record (or the meter's projection) normal | Phase 3's 24 h (old lane 29's gate) and the wait for a nightly backup |

The daily paths no production window this short exercises run in lane 28's check 9: at least two simulated days
on a shifted server clock with two synthetic friends, covering the hourly token refreshes, the daily chores once a
day, the 14-day invite expiry, day 4 of a revoked friend, the brake's 14:51 UTC quota day, every cached lifetime and
the backup's age prune. What depends on a clock outside the app (the Zenbook's 3 AM reboot, Vercel's 09:00 UTC cron,
Spotify's token lifetime) stays unproven there and is written down in REHEARSAL.md.

## 5. Rem's steps

Each is a line in `~/.claude/broke/wavequeue/NEEDS_REM.md` (item 8 and the lines lanes add); the lane manager touches
the marker when Rem has done it.

| marker | Rem's step | when | lane waiting |
|---|---|---|---|
| `rem_dev_signin`, `rem_owner_id` | `node scripts/probe-me-keys.mjs` in `lazyboy-wt/1945_01`, then `--drop-scopes`, signing in each time; `SPOTIFY_OWNER_ID` in Production and `.env.local` from the probe's `id` | Friday morning, by about 5 PM | 22 |
| `rem_pinger_job` | the cron-job.org job every 2 minutes, GET `/api/cron/sync`, bearer from `secrets/CRON_SECRET_EXT` | Friday after about 6:30 AM (lane 11's line), by about 9 PM | 23 proves it, 24 |
| (no marker) | sign in once at lazy-spotify.vercel.app after Phase 1 (older cookies are refused), then listen as usual | Friday after about 12:45 PM | 37 (V1) |
| `rem_health_job` | the hourly cron-job.org health check on `/api/cron/health`, saved first with a wrong bearer so one failure e-mail arrives | Friday after about 12:45 PM (lane 14's line), by about 10 PM | 24 |
| `rem_token_move_hour` | the hour of Phase 2's token move (a few minutes of failing pages); empty means as soon as ready | Friday by about 5 PM; empty keeps Saturday | 22 |
| `rem_dashboard_reads` | Spotify User Management count; Vercel Active CPU (30 days, team and lazy-boy) and Fast Origin Transfer; Deployment Protection level | Friday, any time before about 10 PM | 24, cap05 |
| (no marker) | listen: about 20 plays after Phase 3's deploy, one session ending | Friday night or Saturday morning | 24 (V4) |
| `rem_friend_email` | add the friend's Spotify e-mail in User Management (any time before), send them the request page, approve with `node scripts/invite.mjs --approve <id>` | Saturday after lane 29 opens the door | 30 |

Rem also gets one cron-job.org failure e-mail from lane 24's planted probe, which proves the alarm path in production.

## 6. Choices made in the replan

- **The interim pinger deploys after the cutover, not after 1904** (PLAN §13.3): nothing in it touches the backups
  or docs 1904 changes, and it puts Rem's cron-job.org step on Friday morning. Lane 33 waits for it so
  `cron-auth.ts` is reconciled once; if 08 or 11 blocks, take 11 out of 33's `after=` and the pinger rebases onto
  Phase 1 later.
- **Lane 19 waits for 1904**, whose `backup.py` it copies into the repo as the deployed bytes.
- **The capacity meter is reviewed on the stitched stack (cap02, now review-only) and deployed by lane 37** between
  Phase 1 and Phase 2. cap03 and cap05 read lane 37's marker. If the meter blocks, lane 35 leaves its slice out,
  Phases 2-4a go on without it, and lane 29 cannot open the door until it is live.
- **Deletion reaching backups is proven by a hand run** of the installed `backup.py` right after lane 24 plants the
  file, instead of waiting for the 4:40 AM nightly run.
- **Waits that stay:** 1903's night slot; lane 30's first hour (the friend's use is what it checks); 1908's 72 hours
  and 1909's 7 days (one measures, the other keeps the frozen pre-cutover copy; nothing waits on either); cap05's 72
  hours (a measurement window for friends two to four).
- **Disk.** `npm ci` costs 657 MB per worktree and 17 GB were free at 2 AM, with up to seven worktrees live at once
  after lane 34. RULES 5 now clones a golden install (`~/.claude/broke/scratch/lazyboy_mu/nm_golden/`, built from
  origin/main's lockfile, the same lockfile every branch here carries) with `cp -cR`: an APFS clone, ~20 MB and 7 s.
  `tsc` and vitest were run from a clone before the rule changed.
- **Kept from the earlier plans:** backups keep only Rem's rows; the planted probe fires under `SIGNUPS=owner`
  stamped with a uid no user holds; the first-hour checks read no friend's row; `freeze.sh` (lane 29) is the
  one-redeploy freeze; two minutes for everyone; the platform token moves to the Keychain in lane 22; Preview loses
  its telemetry variables in lane 24.

**Rollbacks**, each named in its lane: 11, 14, 37, 22, 23 and 24 revert their commits on `main` and push, never
Instant Rollback across Phase 1's secret or Phase 2's tokens; 22 adds `LB_TOKEN_ROLLBACK=1` once the plaintext rows
are gone (a week later); 23 restores its `*.pre-mu23` Zenbook units; 24 restores `backup.py.pre-mu24`; 29's is
`freeze.sh`. Behind them: 1903's own rollback (STORE_MIGRATION §8), the frozen pre-cutover copy lane 1909 keeps for
7 days, and the Oct 15 4:40 AM nightly backup (22,127 plays, copied to OneDrive).

## 7. Risks

- **Phase 3 reaches a friend with hours of Rem's listening behind it, not a day.** V4's 20 plays and one session
  cover the harvest policy's common paths and lane 28's clock covers the daily ones; a listening pattern rarer than
  that (a device the probe cannot see, a very long session, the 3 AM reboot mid-session) can show first on the
  friend, who has no recorder. Lane 30's first hour, the e-mailed health check and `freeze.sh` stand behind it.
- **Stitch conflicts.** Three wirings and the meter were built without seeing each other, on Phase 1 before lanes
  1905, 1910 and the pinger. Lanes 33 and 34 resolve with tests and the reviews read the result, but a conflict that
  needs a design change stops the chain until it is settled.
- **Seats and RAM.** From about 11:30 AM five reviews and the rehearsal run at once at xhigh. A drained 5-hour
  window cuts lanes, which resume after its reset (rem resets at 6:10 AM, vic at 4:40 AM, then every five hours).
  Every gate waits for 12 GB of free RAM and the Mac had 11 GB free at 2 AM, so gates queue behind each other.
- **Rem's listening and hours.** V1-V5 need his plays, V1 his sign-in, lane 22 his token-move hour. Listening that
  starts Saturday morning instead of Friday night moves the door from about 2 AM to about 2 PM Saturday.
- **The cutover slot.** If 1903 misses 3:33 AM (the quiet-app check, a failure), lanes 1904-1911 and 33 move a day
  and the friend moves to Sunday. The builds before 33 do not wait for it.
- **Two answers can still stop the path:** no `account_id` from Spotify (lane 22, decision 31) and Active CPU above
  about 2 of Hobby's 4 hours (lane 24, decision 18).
- **Adjacent:** local `main` holds docs commits that are not on `origin/main` (this file's included) and
  `origin/main` holds the store split that local `main` lacks; deploy lanes leave local `main` alone when it cannot
  fast-forward. Lanes read this file, RULINGS.md and CAPACITY.md from the shared checkout.

## 8. Files

- `~/.claude/broke/scratch/lazyboy_mu/RULES.md`: the standing rules (5: the golden node_modules clone; 7: branches;
  8: parallel builds; 10: deploys and the production checks).
- `~/.claude/broke/scratch/lazyboy_mu/mu_gate.py` and `test_mu_gate.py` (nine known answers; `--retry` added for §4).
- `~/.claude/broke/scratch/lazyboy_mu/nm_golden/`: the golden install and its `LOCK_SHA`.
- `~/.claude/broke/scratch/lazyboy_mu/markers/`: lane and Rem markers. `OUTCOMES.md`: each lane's entry.
- `~/.claude/broke/scratch/lazyboy_mu/secrets/CRON_SECRET_EXT`: lane 11 writes it for Rem's two cron-job.org jobs;
  lane 24 deletes it.
- `~/.claude/broke/scratch/lazyboy_mu/freeze.sh`: lane 29 writes it; `SIGNUPS=owner` and one redeploy.
- `docs/multi-user/REHEARSAL.md` on `mu/f-p4a`: lane 28's checks and the command that re-runs them.
- After the first friend (FASTPATH §5): P2-P4, the 122-play replay, PLAN §11.4 step 6 a week after Phase 2 (lane 22
  adds it to `.claude/QUEUE.md`), the per-user shares and the 72-hour remeasure (cap03-cap05), friends two to four,
  the UI overhaul.
