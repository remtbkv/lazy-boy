# Review of PLAN.md: uptime, the store, and moving Rem's data

Lane 0224_lb_mu_review_migration, Oct 15, 2026 (started Oct 14, 11:39 PM). An adversarial read of
`docs/multi-user/PLAN.md` at `0ca7ab5` through one lens: single points of failure, behaviour when the
Zenbook or the new store is down, and whether moving Rem's existing data could lose or mis-assign
anything. Isolation, security, scale and completeness have their own reviewers; where a point here is
already in `review-completeness.md` it is cited, not repeated. Planning only: nothing here changed
code, data, the Zenbook, Turso or Vercel. Every production read was read-only and is listed in §4.

Severity (named so as not to clash with the plan's search targets S1-S3): **Critical** loses or
mis-assigns Rem's data, or takes every user down, with no plan step that catches it; **High** a plan
claim that is wrong or unproven in a way that changes a decision or a runbook step, or a gap whose
failure loses plays or takes every user down; **Medium** a gap a lane would trip over; **Low** wording
or a number to correct.

## 0. Summary

(written last)

## 1. Findings

Nothing is Critical: each High finding needs a second event the plan expects to happen (a store
blip, a restore, a rollback, a Zenbook outage, a key rotation) before it costs data or uptime, or
concerns data the plan does not touch yet.

### 1. (High) Restores have no runbook, and four parts of the design make a plain restore misroute data

**Evidence.** The plan names restores as its recovery path (§4.5 step 4 and §11.3 "take a restore
point"; §12.4 "Turso's point-in-time recovery covers the last day"; §12.4 "a restore keeps everyone
signed in") and argues for random uids from the restore case (§4.4), but never says how a restored
database becomes the live one. Turso's docs, fetched tonight: "Restoring from a PITR creates a new
database"; "You cannot restore from a PITR to a database that already exists"; "You will need to create
a new token (or use a group token)" (https://docs.turso.tech/features/point-in-time-recovery). A dump
restore is also a `turso db create` (STORE_MIGRATION §8 step 6). So every restore produces a database
with a new name, and four parts of the plan assume names and counters never change:

1. **Roles keyed by the literal name.** The backup list starts `("lazyboy", 60 days)` (§12.4,
   PLAN.md:1555), the deletion job refuses "the database `lazyboy`" (PLAN.md:1501), dev holds a
   `lazyboy` database token (§5.5), and the usage read uses `TURSO_DATABASE_NAME=lazyboy`
   (STORE_MIGRATION §5). After a restore under a new name the nightly job keeps dumping the old,
   abandoned database and nothing reports it.
2. **Warm instances keep the old client.** `forUser` takes its client "from a per-process map filled
   from `users.db_name`" (§6.2 layer 3, PLAN.md:651). Moving `users.db_name` reaches only new
   processes. A warm instance (the now-playing poll keeps them warm) keeps writing that user's plays
   into the old database, whose `owner_uid` still matches, so the owner check passes. Writes split
   between two databases for as long as the instance lives.
3. **Version counters are re-issued.** `write_seq`, `library_seq`, `slow_seq_pub` and P3's
   `seg_seq:<YYYY-MM>` are counters in the user's `meta`. A restore winds them back and the next writes
   hand out the same numbers for different content. P3 serves segments at `?v=<version>` with
   `private, max-age=31536000, immutable` (§9.1, PLAN.md:1182-1183), ETags carry the version (§6.2
   layer 6), and `userCache` entries are keyed by it for up to 24 hours. A browser holding a month at
   v7 from before the restore shows it for good once the restored database reaches v7 again. This is
   the reuse §4.4 rejects for uids, left in place for the cache's own keys.
4. **Restoring `lazyboy-app` resurrects state.** Users deleted since the backup come back `active` with
   their token blobs, decryptable unless the key has rotated since; `session_epoch` returns to values
   from before any "sign out everywhere"; `disabled` users are enabled again. The tick refreshes a due
   user's token and probes Spotify before it opens their database (§7.2 step 2), so a deleted friend's
   grant is used again on the first tick.

The drill does not cover it either: lane 1904's restore test loads a snapshot into a scratch file and
compares counts (`~/.claude/broke/wavequeue/rem/1904_lb_store_aftercare.txt`, item 1) and runs weeks
before `lazyboy-app` exists, while §12.4 says "a restore test of each kind of database in lane 1904's
restore drill".

**Fix.**
- Key the per-process client map by `db_name`, and compare it with the `db_name` that §5.1's identity
  statement and §7.2's claim already return; a mismatch rebuilds the client. No extra round trip.
- Read every per-database role from `users` (the admin's database keeps 60 days, a friend's 4, the
  deletion job refuses `is_admin`), never from the string `lazyboy`.
- Give each database a random `store_epoch` in `meta`, written at provisioning and by every restore,
  and put it in every ETag, segment URL and `userCache` key, so no cached version can be re-issued.
- Write a restore runbook per kind of database: create from PITR or dump; check `owner_uid`; write a new
  `store_epoch`; set the user `paused`; move `users.db_name`; delete the old database's `owner_uid` so
  any other opener refuses; resume. For `lazyboy-app`, before the pingers resume: delete every row
  whose `lb-u-<uid>` no longer appears in `turso db list` and re-run its telemetry deletion, bump every
  `session_epoch`, and re-apply disables from a log kept outside the app database (have the deletion job
  and every disable append a one-line record to the telemetry store, which an app-database restore
  does not touch).
- Rehearse it in §13.2's throwaway-invite gate: restore that database under a new name, see the app
  serve from it, then destroy it.

### 2. (High) Until Phase 3 the Zenbook is the only frequent capture trigger, and its outage rate is understated

**Evidence.** §14.5's first row sizes Zenbook downtime by the nightly reboot: "6-8 minutes daily,
0.47% of the meter's 48.5 hours" (PLAN.md:1807). That window starts Oct 13 (01f §3.3). The Oct 3
review measured what the same box did in late summer (`~/.claude/burn/20261003/lazyboy-review.md:186-205`,
item D2, which 01c §5.7 cites): down Aug 30 14:12Z to Sep 2 06:13Z; down Sep 3 01:22Z to Sep 5 21:51Z,
then up but unable to resolve names until Sep 9 03:15Z; 16 hours on Sep 9; 19.5 hours on Sep 25. That
is about nine and a half days without capture in four weeks, with the pinger and the recorder failing
together, because "The Zenbook's resolv.conf is MagicDNS-only": any tailscaled trouble is a total DNS
loss. Read tonight, `/etc/resolv.conf` on the Zenbook still lists only `100.100.100.100` and
`fd7a:115c:a1e0::53`, both Tailscale's resolver (§4).

After the cutover the store leaves the box but the pinger, the recorder and the backups stay
(STORE_MIGRATION §5). The second pinger waits for Phase 3 (§7.9, PLAN.md:985-986), which §13.3 places
after P2, P3, Phase 1 and Phase 2 with their soaks: roughly late November to early December
[estimate, from §13.3's own durations]. A2 holds only from then (PLAN.md:1819).

**Failure.** A repeat of any August-September outage in those six to seven weeks stops Rem's
closed-app capture and the recorder at once. Plays past the newest 50, about 2.5-3.5 hours of
listening (01c §5.7), come back only through Spotify's Extended Streaming History export, which takes
days to weeks to arrive (D2).

**Fix.**
- Bring the second pinger forward to just after lane 1904, guarded in today's route by a
  compare-and-set that skips a tick within 90 s of the last one (01f §3.5's design):
  `UPDATE meta SET value = :now WHERE key = 'tick_at' AND CAST(value AS INTEGER) < :now - 90000`,
  inserted if absent, skip when no row changed. With pingers on alternate minutes every second tick
  runs, so Spotify sees today's calls; either pinger alone keeps today's two-minute cadence. Phase 3's
  lease replaces the guard. Cost: one row written per tick that runs, ~720 a day on Turso, about 0.2%
  of the free plan's writes.
  Re-enabling the cron-job.org job with a fresh secret is Rem's step (STORE_MIGRATION's lanes read R6
  as forbidding it).
- Give the Zenbook a resolver that does not depend on tailscaled. Rem's call: an ops change outside
  this program's lanes.
- Restate §14.5's first row with the measured history, and add the interim as a stated exposure.

### 3. (High) P2's accumulator and P3/P4's patched values are read-modify-write, and the plan dropped what made them safe

**Evidence.** P2 computes `listened_ms` "in JS and written with the insert" and keeps the all-time
totals as an accumulator "applied one play at a time: for a counted play, `plays + 1`, `durationMs +
listened_ms` … `uniqueTracks + 1`" (§8.3, PLAN.md:1060-1069). P4 patches the Home payload in JS
(§8.4); P3 keeps each month's play count beside its version in `seg_seq` (§9.1, PLAN.md:1196-1200).
Each is read, changed in JS and written back. §7.8 says everything a step writes "is safe to repeat"
and "Writes on this path are idempotent" (PLAN.md:965, 974), listing claims, leases and natural-key
inserts; these three are not on the list and are not idempotent.

Writers that reach one user's database at the same time under the plan:
- until Phase 3, the cron tick, `/api/sync` (a check-then-act on `last_sync`,
  `src/app/api/sync/route.ts:28-31`) and `refreshHistoryAction`, which harvests on every call with no
  server debounce (`src/app/(app)/history-actions.ts:131-133`), "twice per track change". P2 ships
  weeks before the lease (§13.3);
- after Phase 3, a step abandoned at its 25 s deadline that "can still write later" (§7.8), while the
  next tick holds a fresh lease 50 s on;
- the store fetch re-sending a batch whose attempt timed out: it retries any rejection, the
  per-attempt timeout included (`src/lib/store-fetch.ts:80-83`), and 01c §2.8 measured 25-30% of
  `api_log` rows as duplicates from that path;
- the import scripts and a dev server, which hold a `lazyboy` token (§5.5).

Two harvests that read the same totals and each add a play lose one increment; a re-sent absolute
write that lands after a newer one rolls it back. Today none of this can drift, because the totals are
a from-scratch recompute (`maybeRecomputeAllTimeStats`, `src/lib/db.ts:577-583`). Design B made the
patched writes safe with a compare-and-set on a version, and "a payload write that loses its
compare-and-set anyway marks the row dirty" (design-b.md:715-716, 777-778), and its nightly backups
"recompute every derived value from the dump and flag drift" (design-b.md:178-179). The plan drops both
as machinery five users do not need (PLAN.md:161-162), and §8.6's all-time budget after P2, about
5,000 rows a day, has no periodic recompute in it, so a drifted total never heals.

**Failure.** Rem's all-time play count and listened time drift silently after P2, and a month's count
or the Home strip after P3 and P4. `scripts/verify-derived.mjs` sees it only when someone runs it.

**Fix.**
- Make every increment order-free and safe to re-send: keep `through_id`, the highest `plays.id`
  counted, inside `alltime_stats`, and advance totals and `through_id` in SQL in the insert's own batch
  over `id > through_id` (a rowid range, so the cost follows new plays); or write each increment
  relative to the stored value and conditioned on the insert's `changes()` in the same batch. The same
  for each `seg_seq` count. Restore B's version compare-and-set on the Home payload, with a lost race
  marking it dirty.
- Put B's drift check back where it costs Turso nothing: the nightly job already loads each dump into
  SQLite (§12.4). Recompute `alltime_stats`, the segment counts and the Home payload there and log any
  difference to the telemetry store (and through review-completeness H1's alarm, if Rem lifts R6).
- Known answers: two concurrent harvests with overlapping batches, and a re-sent batch, each leave the
  totals equal to `allTimeStats` over the stored rows.

### 4. (High) Writers that do not know P2's and P3's new state leave it wrong: the unfenced fill, rollback windows, the import scripts

**Evidence.**
- **The fill window is not fenced.** P2's fill runs in "a fenced window of ~15 minutes … pause both
  pingers and wait for 5 minutes without writes" (§11.3, PLAN.md:1373-1381). At P2 there is one
  pinger, and pausing it stops none of the other writers: an open or pinned tab's `/api/sync` every two
  minutes, `refreshHistoryAction`, a dev server on `lazyboy`. The cutover proved quiet with the meter's
  statement log and stopped stale builds with the meter's fence (STORE_MIGRATION §8 steps 3 and 10);
  after the cutover the meter sees telemetry only (STORE_MIGRATION §9), and Turso offers neither. A play
  the old build inserts between the fill and the deploy keeps `listened_ms = NULL` for good: nothing in
  §8.3 revisits a NULL, so the accumulator never counts it.
- **Rollback windows.** P2's rollback is "redeploy the previous build; the column is ignored", P3's
  "revert; browsers re-download once" (§13.1, PLAN.md:1582-1583). While the older build runs, it
  inserts plays with no `listened_ms` and moves no `seg_seq`. Rolling forward resumes the accumulator
  from what the old build left and serves months whose versions never moved, immutable in browsers.
  Neither cell says what the roll-forward must repair.
- **The import scripts bypass the path the plan names.** §8.3 counts "the backstop replay, an import"
  among the non-append events that re-open a successor "now rewriting its `listened_ms` too, and set
  `alltime_dirty`", citing `db.ts:547-561` (PLAN.md:1070-1075). The scripts never call that code:
  `scripts/backfill-from-backstop.mjs` and `scripts/import-extended-history.mjs` write raw SQL and
  close with `importTailStmts` (`scripts/import-tail.mjs`), which nulls `skipped` on each run's edges,
  bumps `write_seq` and deletes `home_payload`. Nothing there touches `listened_ms`, `alltime_dirty` or
  `seg_seq`. §9.1 does say the scripts will bump their months for P3; nothing assigns the P2 half, and
  T10 tests the scripts only for `--user` (§6.4). Two imports of Rem's own plays are already queued
  (`.claude/QUEUE.md:16-17`: the 122-play backstop replay, finding 8, and the Extended Streaming
  History import for the Aug 30-Sep 9 gap). Run after P2 as the scripts stand, both leave their plays
  out of the all-time totals.

**Fix.** Treat `listened_ms IS NULL` on a counted play as pending, the way `skipped IS NULL` is today:
a partial index (`WHERE listened_ms IS NULL AND (context_type IS NULL OR context_type <> 'backfill')`),
filled by the pass that rules skips, which sets `alltime_dirty` whenever it fills one. Then the fill
needs no quiet window, a rollback window heals at roll-forward, and a writer that does not know the
column does no lasting harm. P2's lane also adds `alltime_dirty` to `importTailStmts`, and P3's the
`seg_seq` bumps, with known answers in `tests/import-scripts.test.ts`. Rolling P3 forward after a
rollback moves the segment shape token, the escape hatch §9.1 already names. Simplest of all for the
two queued imports: run them before P2's fill (finding 8), so the fill counts them.

### 5. (High) The identity read has no failure branch, and the obvious ones turn a store blip into a sign-out and a wiped browser cache

**Evidence.** From Phase 2 every request's identity, token and capture health come from one
`lazyboy-app` statement (§5.1, PLAN.md:487-501). The plan says when the jwt callback returns null (no
uid, unknown uid, wrong status, stale epoch) and says nothing about the statement failing. Today's
callback keeps the session on a failed read on purpose: "a Turso hiccup must NOT crash the request into
a Configuration error / forced logout" (`src/lib/auth.ts:379-387`). Both natural ways to write the new
callback lose that:
- a read that throws makes Auth.js log `JWTSessionError` and clean the session cookie
  (`@auth/core` 0.41.2, `lib/actions/session.js:58-62`, read from the published package tonight);
- a read caught and treated as "no row" returns null, which cleans it too (same file, `:54-55`).

On the `auth()` path the clean-up `Set-Cookie` is dropped (`next-auth` 5.0.0-beta.31,
`lib/index.js:89-91`), so the cookie survives, but the request has no session: `requireUser()` sends
pages to `/login`, answers routes 401 and actions `{ ok: false }` (§5.1). And "A 401 from any of the
app's own routes clears" the browser's storage (§6.2 layer 6, PLAN.md:703-705). The now-playing poll
hits a route every 6-15 s, so a few seconds of store trouble empty the IndexedDB search copy,
`lb-days` and the rest on every open tab, and the next Home visit on each device pays a first visit's
download (target S2's 2 s) instead of a repeat visit's (S1's 300 ms).

`lazyboy-app` is also a new single point on every request, not only on ticks: one database blocked,
refused or broken by a migration takes every user down while every user database is healthy. §7.8 has
it for the tick (PLAN.md:971); §14.5 does not have it at all.

**Fix.** Give the identity read three outcomes: allowed; refused (null, for the four cases §5.1
lists); unavailable (the statement failed). On unavailable the callback returns the token unchanged,
as today, and `requireUser()` answers 503, an error page or `{ ok: false, retry: true }` without
redirecting to `/login`. The browser clears its storage only on a 401 that carries an explicit
signed-out marker, never on a 5xx or a network error. Known answers in T5: the identity read throws,
and there is no redirect, no 401 and no cleared storage. Add "`lazyboy-app` unavailable" to §14.5, with
finding 1's restore path as its recovery.

### 6. (High) The rollbacks do not say how, and on this project the obvious ways misfire

**Evidence.** The rollback cells say "redeploy the previous build" (P2, Phase 1, P4; §11.4 "redeploy
Phase 1") or "revert" (P3, Phase 3), never by which mechanism (§13.1, PLAN.md:1579-1589). Here the
mechanisms behave differently:
- **Instant Rollback**: "Hobby users can roll back to the immediately previous deployment"; "After a
  rollback, Vercel turns off auto-assignment of production domains. This means new pushes to your
  production branch won't replace the rolled-back deployment"; the rolled-back build keeps the
  environment variables it was built with (https://vercel.com/docs/instant-rollback, updated
  2026-07-07, fetched tonight). Every push to `main` deploys production (STORE_MIGRATION §3) and this
  program pushes docs all day, so "the immediately previous deployment" is usually a docs-only rebuild
  of the very phase being rolled back.
- **`vercel redeploy <url>`** "will rebuild and deploys an existing deployment"
  (https://vercel.com/docs/cli/redeploy), and "Any change you make to environment variables are not
  applied to previous deployments, they only apply to new deployments"
  (https://vercel.com/docs/environment-variables, updated 2026-09-17). So a redeploy runs old code on
  today's variables [inference: a rebuild is a new deployment]. Phase 2 changes what
  `TURSO_AUTH_TOKEN` holds and adds `TOKEN_KEYS` and the app database's URL (§11.4 step 5).
- **The morning push**: "something pushes `main` at about 7 AM" (STORE_MIGRATION §3); the local reflog
  of `origin/main` shows pushes at 07:05 on Oct 13 and Oct 14 and 07:08 on Oct 3. A redeployed older
  build with the phase still on `main` is replaced at the next push. Tonight local `main` is 202
  commits ahead of `origin/main`, and the owner guard production has run since 8:41 PM (`044c9b6`) is
  on no remote branch: production already runs code that only the next push will put on `main`.

Design C wrote the whole recipe: "Promote the previous production deployment in Vercel, restore the
previous environment values, and revert the Phase 1 merge on `main`, so the next push cannot redeploy
it" (design-c.md:978-981). The plan took C's gates and soak checks and left this out. Whether a rolled
back build opens databases one schema step ahead at all is review-completeness H3, which this finding
does not repeat.

**Fix.** Write one rollback recipe in §13 and point every cell at it: revert the phase's merge on
`main` and push, an ordinary production deploy of the old code that survives the morning push and
keeps auto-assignment on; use Instant Rollback only as a minutes-long stopgap when the previous
deployment is the pre-phase build, and Undo Rollback once the revert is live. Make environment changes
additive: a phase adds variables and never changes what an older build reads, or its cell says why the
older build still works with the new value (Phase 2: a group token reaches `lazyboy`, so Phase 1 runs
on it). Add a boot check that names a missing store variable: today a missing `TURSO_DATABASE_URL`
falls back to `file:data/listens.db` (`src/lib/db.ts:127-128`) and fails every query at `mkdirSync`
(`:154-156`) with a bare EROFS [inference: Vercel functions can write only under `/tmp`]. Rehearse each
phase's rollback on Rem alone inside its soak; it costs minutes and is the only test the cell gets.

(more High findings follow)

## 2. STORE_MIGRATION, from this lens

(in progress)

## 3. What holds up

(in progress)

## 4. What I ran

(in progress)
