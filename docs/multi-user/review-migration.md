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

Nine High findings, four Medium, three Low; nothing Critical.

- **Two measurements tonight change the migration section.** The store holds no plays from the second
  account: the recorder and the store agree play for play from Oct 13 on, nothing back-dated was
  inserted since Oct 1, and the library tables match the pre-incident snapshot (finding 7). §11.2's
  deletion, its rollout row, the Phase 2 precondition and decision 10 can go. And 122 of Rem's own
  plays (Aug 9-10, Sep 8) exist only in the recorder's file, which nothing backs up (finding 8).
- **Restores have no runbook** (1): every Turso restore makes a database with a new name, warm
  instances keep writing to the old one, version counters are re-issued under year-long immutable
  caching, and an app-database restore revives deleted users and dead sessions.
- **The Zenbook stays the only frequent pinger for six to seven weeks after the cutover** (2), on a box
  that lost about nine and a half days of capture in late August and September and still resolves
  names only through Tailscale. A 90-second guard makes the second pinger safe now.
- **The new derived state is fragile** (3, 4): P2-P4's totals are read-modify-write without design B's
  compare-and-set and drift check, and the import scripts, rollback windows and the unfenced fill
  bypass it. Pending-NULL semantics and SQL-side increments fix both.
- **Three failure paths the plan leaves unspecified:** a failed identity read becomes a sign-out and a
  wiped browser cache (5); rollbacks name no mechanism, and on Hobby the obvious ones misfire (6); a
  mis-set token key strands every user in `needs_reconnect` (9).
- **STORE_MIGRATION:** no change to the cutover. Keep edit 4's source counts, add a seventh edit that
  backs up the recorder's file, and check Production's variables after edit 2 (§2).
- **For Rem:** run the 122-play replay after lane 1904 (recommend yes); bring the second pinger forward
  and give the Zenbook a resolver outside Tailscale (recommend yes); drop decision 10.

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

### 7. (High) There are no foreign plays to delete, and the plan's method would have missed back-dated ones

**Evidence.** A step, a rollout row, a Phase 2 precondition and decision 10 rest on commit `044c9b6`'s
line that "the cron recorded its plays into the owner's history" (§11.1-11.2, PLAN.md:1339,
1346-1369; §13.1's "foreign plays" row; §11.4's "§11.2 is done"; §18 decision 10). No lane measured
it. Tonight, read-only on the Zenbook (§4):
- **Store against recorder.** The recorder captures with Rem's own grant every 15 minutes (01c §2.6),
  and all 96 of its runs on Oct 14 finished with no error line in its journal. From Oct 13 00:00Z to
  Oct 15 03:45Z the store and the recorder hold the same 264 plays: none in the store only, none in the
  recorder only. Over the recorder's whole life (Aug 6 to Oct 15) the store-only plays are 54 on Aug 6,
  before the recorder's first run, and 2 on Sep 9 and 4 on Sep 25, during recorder outages (Oct 3
  review D2) when an open tab could still write through the Funnel [my reading]; none since Sep 25.
- **Insertion order.** `plays.id` is an AUTOINCREMENT rowid, so it orders inserts. Of the 1,500 rows
  inserted since the first Oct 1 play, none carries an earlier `played_at`; of the 267 since the first
  Oct 13 play, one does, an Oct 12 play the recorder also holds.
- **The library side.** Against the 08:40Z Oct 14 snapshot, taken before the second sign-in:
  playlists 114 and 114, owned by `me_id` 110 and 110, `playlist_tracks` 7,400 and 7,400, Liked 48 and
  49, `contexts` 114 and 117 with one row written during the incident (named, so no negative cache
  left by the other account), `me_id` unchanged by sha256 prefix. The rewrites healed as 01b E6 said.

The method also has a blind spot that would have mattered had those plays existed. §11.2 lists "the
plays from the start of Oct 14 to Rem's first sign-in" (PLAN.md:1353-1354). A harvest on another
account's token stores that account's last 50 plays with their own `played_at`
(`src/lib/spotify/resources.ts:410` passes it through; `recordPlays` inserts out-of-order rows), so
they can predate the incident by days and fall outside any `played_at` window. The insertion-order
check finds them; the window does not.

**Fix.** Replace §11.2's deletion with tonight's numbers and one re-check on the latest backup before
Phase 2: the full-range recorder diff and the insertion-order query, both read-only (§4 has the
scripts). Drop decision 10, the "foreign plays" row of §13.1 and the Phase 2 precondition, which
removes the plan's one irreversible step on Rem's history. Keep the two checks in the plan as the
method for any future cross-account write. This also retires review-completeness L5, whose copies do
not exist.

### 8. (High) 122 of Rem's plays exist only in the recorder's file, which nothing backs up, and the plan never replays them

**Evidence.** The same comparison found 122 plays in the recorder and not in the store: 56 on Aug 9,
60 on Aug 10 (the quick-tunnel outage, 01f §3.3) and 6 on Sep 8. They are the "122-play backfill" the
Oct 3 review queued as D1, whose production run "is Rem's, after C1" (`.claude/QUEUE.md:16`); C1
landed on Oct 14 (`afb21d1`), so nothing blocks it. Their only copy is
`~/lazyboy-recorder/backstop.db` on the Zenbook: `backup.py` copies the store's file alone
(`SRC = ~/lazyboy-sqld/data/dbs/default/data`, read tonight), and no other unit or script names the
recorder's file. The plan says Rem's data "moves nowhere" (§0) and leans on the recorder as the
loss-repair path (§7.9, §11.2) without scheduling the replay or protecting the file, on a box whose
outage history finding 2 gives. Spotify's Extended Streaming History export could recover them too,
days to weeks after Rem asks for it.

**Fix.**
- A seventh STORE_MIGRATION edit, for lane 1904: the nightly job also copies `backstop.db` (31 MB, one
  file, kept 60 days like Rem's store).
- Run D1 (`scripts/backfill-from-backstop.mjs`, which inserts only what is missing) after lane 1904
  and before P2's fill, so the fill and the accumulator count those plays (finding 4). It writes
  production data, so it is Rem's go-ahead; recommend yes: it adds only his own captured plays and was
  run on a snapshot copy first ("166 inserted … re-run 0", QUEUE.md:16).
- The Extended Streaming History import for Aug 30-Sep 9 (QUEUE.md:17) goes in the same slot when the
  export arrives, or after P2 only once `importTailStmts` sets `alltime_dirty` (finding 4).

### 9. (High) A token that fails to decrypt writes `needs_reconnect`, so one mis-set key stops every user's capture until each signs in

**Evidence.** "A blob that fails to decrypt is no token: the user goes to `needs_reconnect`" (§5.3,
PLAN.md:553-554), and the claim skips `needs_reconnect` (§7.2 step 1). A decrypt failure is almost
never about one user: it is a deploy whose `TOKEN_KEYS` is wrong, truncated or missing an old key. The
plan rotates that key by hand ("put a new key first and redeploy … drop the old key", §5.3) within
five days of every friend's deletion, up to four times (§12.3, PLAN.md:1540-1543). One bad rotation
marks every user `needs_reconnect` within a tick. Correcting the variable and redeploying does not
undo the state, so closed-app capture stays off for each user until that user signs in again, and a
friend who does not open the app loses every play past their last 50. §7.8 guards the 403 case ("never
when every user failed the same way in one tick", PLAN.md:967) and no other. review-completeness L2
covers losing the key and restoring across a rotation; this is the misconfiguration and the state it
leaves behind.

**Fix.** Treat a decrypt failure as the deployment's fault, not the user's: log it with the uid, skip
that user's step or fail that request, and write no user state. If two or more users, or the admin,
fail to decrypt in one tick, answer the Zenbook caller 503 and touch no rows. At cold start, decrypt
one sentinel blob per configured key and refuse to serve if any fails, so a bad key breaks the deploy
loudly. Known answer: a deploy with a wrong key leaves every user `active`, and capture resumes on the
next correct deploy with no sign-in.

### 10. (Medium) The daily route is one invocation a day that now owns deletions, the usage read and the second pinger

**Evidence.** `/api/cron/daily` (STORE_MIGRATION phase A item 7, one Vercel cron at `0 7 * * *`)
becomes the home of the deletion job's retries and of every deletion's telemetry step when the Zenbook
is away (§12.3), the twelve-month inactivity deletions, Turso's usage read (§10.2), re-enabling the
cron-job.org pinger (§7.9), the lag roll-ups (§7.8), the contexts pass and the prunes. Hobby fires it
anywhere in 07:00-07:59 UTC (01f §2.2), an hour that contains the Zenbook's 07:00-07:08 UTC reboot
(01f §3.3 notes the overlap), so its telemetry steps fail on some days. The block it replaces never ran
for two months and nobody noticed (STORE_MIGRATION §3). One missed run delays every chore a day, and
the deletion clock has less room than it looks: telemetry backups keep four days (§12.3), so rows
deleted on day N survive in backups to day N+4, and a second missed retry carries them past Spotify's
five days.

**Fix.** Stamp `app_meta.daily_at` when the chores finish, and have a tick run them once, under a
lease, when the stamp is over 26 hours old, so either pinger covers a missed Vercel cron. Move the
Vercel cron to `0 9 * * *`, clear of the reboot. Let the deletion's telemetry step retry on every tick
until it succeeds instead of once a day. Record each chore's outcome where `/usage` shows it.

### 11. (Medium) "Gone by day four with no bookkeeping" depends on every night's backup job reaching its end

**Evidence.** §12.3 step 4 relies on the nightly job's retention: "the last one is gone by day four
with no bookkeeping" (PLAN.md:1510-1511). Today's `backup.py` prunes local snapshots and runs
`rclone delete … --min-age 60d` only at the end of a successful run; an integrity failure, the
row-loss check or a failed upload ends it with `sys.exit(1)` before either prune (read tonight, §4).
A per-database loop written the same way skips every database's prune when any one database fails, and
nothing prunes while the Zenbook is down (finding 2).

**Fix.** Run the retention prune first and unconditionally, per database, or from its own timer, and
log its result so `/usage` shows the oldest backup file per database. The deletion job's five-day check
reads that record. If the Zenbook is down across a deletion, the runbook prunes from the Mac with the
same `rclone delete` rule.

### 12. (Medium) Edit 4 trades the backup's source check for 0.3% of the free plan

**Evidence.** Edit 4 checks "the counts against the dump itself rather than `count(*)` on Turso", to
save ~45,800 rows read a night (PLAN.md:1298), about 1.4M a month, 0.3% of the free plan. Counting the
loaded dump against itself proves the file loads; it cannot see a dump that ended early, which is what
the source comparison is for, and lane 1904 may export table by table over HTTP if Turso refuses
`/dump` (`1904_lb_store_aftercare.txt`, item 1).

**Fix.** Keep the source counts, the cheapest insurance in the plan. If the 0.3% matters, compare
`plays`' `max(id)` (one row: `id` is a real column, so a dump keeps it) and the small tables' counts
(about 500 rows), and require the CLI's exit status and, for a `.dump`, the closing `COMMIT;`.

### 13. (Medium) R2's fault injection is A1's measure, and no phase re-runs it

**Evidence.** A1 is "measured by STORE_MIGRATION R2's fault injection, repeated with two users" (§1,
PLAN.md:91), but no exit check in §13.1 runs it. R2 is proven once, at the cutover (STORE_MIGRATION §8
step 14). Phases 1-3 then add telemetry writes from new places: isolation events from the cache stamp,
the owner check and the token assertion (§6.5), the uid on `api_log` and `client_metrics`, lag samples
(§7.8). One of them awaited by mistake puts the Zenbook back on a user path, and nothing would show it
until a stall. review-completeness H1 asks for each isolation event to be awaited in the app database
as well; the telemetry half has to stay unawaited.

**Fix.** Re-run step 14's SIGSTOP test as an exit check of Phases 1, 3 and 4 (minutes each), and add a
static check next to S1-S6: no `await` on a telemetry-client call outside the daily route and `/usage`.

### 14. (Low) §14.5's last-resort capture assumes `/api/cron/sync` keeps its daily Vercel entry

§14.5 counts on "the daily Vercel cron (07:00 UTC ± 59 min)" when both pingers are down (PLAN.md:1811).
STORE_MIGRATION §6 item 7 puts `/api/cron/daily` in `vercel.json` "at the existing `0 7 * * *`", which
a lane can read as replacing today's only entry (`vercel.json` lists `/api/cron/sync` alone). Say which,
in §10.2's edit list. An Instant Rollback also reverts crons to the rolled-back build's (Vercel's page,
finding 6).

### 15. (Low) The plan's "heavy day" is the incident day

"A heavy day is Oct 14's activity … with three unscoped orphan passes (as that day had)" (PLAN.md:72-74).
On UTC Oct 14 the second account's library replaced Rem's and was replaced back (`me_id` flipped and
returned, 01b E6, and the library tables match the pre-incident snapshot tonight, finding 7). Each swap
moved the playlist id set, which is what triggers an unscoped pass (01c §2.3), so at least two of the
three passes were most likely the incident's; STORE_MIGRATION §3's ordinary rate is about three a week.
The day's 129 landed plays are Rem's (finding 7). D1's ~19M baseline and §8.6's "today" column inherit
the inflated orphan term. For the scale reviewer.

### 16. (Low) Three runbook lines that would fail or mislead as written

- §11.3 "pause both pingers" (PLAN.md:1374): at P2 there is one, and pausing pingers is not a write
  freeze (finding 4).
- §11.4 step 6 "`lazyboy.meta`'s key set unchanged" (PLAN.md:1414): ordinary activity changes it (a
  rescan adds or purges `plsnap:` keys, a clean takes `lock:clean:*`). Check the named keys: the moved
  ones still present, `owner_uid` and `schema_version` present, nothing else removed.
- §11.4 step 4 writes Rem's `sync_state` once, and §5.1's identity statement reads capture health from
  it from Phase 2 on, but nothing updates `sync_state` until Phase 3's claim. Rem's banner reads stale
  times through Phase 2's soak. Keep capture health on `lazyboy.meta.last_sync` until Phase 3, or have
  Phase 2's tick stamp `last_ok_at`.

## 2. STORE_MIGRATION, from this lens

Nothing in the cutover's logic needs to change, and no lane should wait. On the plan's six edits:

- **Edit 2** (Production-only flip, Preview's `TURSO_*` deleted) holds. After it, run
  `vercel env ls production` and see both store variables before any redeploy: STORE_MIGRATION §3
  records them as one Production + Preview pair, and the CLI page does not say what removing one
  environment from a shared variable does (https://vercel.com/docs/cli/env, updated 2026-08-20). A
  production build without them fails every query (finding 6).
- **Edit 4** holds, with the source counts kept (finding 12).
- **A seventh edit, for lane 1904:** the nightly job also copies `~/lazyboy-recorder/backstop.db`, the
  only copy of 122 of Rem's plays (finding 8).
- **§6 item 7** should say whether `/api/cron/sync` keeps its daily Vercel entry (finding 14).

Two things for after the move, not before it: the D1 replay of those 122 plays after lane 1904 and
before P2 (finding 8), and the second pinger with its 90-second guard after lane 1904 (finding 2).
Both are Rem's go-ahead.

## 3. What holds up

- **Rem's data stays where the cutover puts it.** `lazyboy` becomes his user database with nothing
  copied, rebuilt or re-keyed (§11.1), and per-user databases remove the cross-user statement classes a
  shared store's migration would have had to get right (01a D12, D17, D18).
- **The order around the move.** STORE_MIGRATION runs first with its logic untouched, multi-user schema
  stays out of a reversible move (§10.2), and Phase 2's token move waits for the cutover's token
  compare.
- **The token handover.** The plaintext row is kept a week, the later `expiresAt` wins any compare, and
  Phase 1 can read Rem's token again because Spotify has not rotated this app's refresh token in two
  weeks of hourly refreshes (01e §2.1). Finding 6 supplies the rollback mechanics.
- **The tick's failure isolation.** The claim doubles as the store health check, each user runs under
  its own deadline in `allSettled`, and one user's failure costs that user's slot (§7.8), apart from
  findings 3 and 9.
- **Telemetry off the request path.** One attempt, 4 s, never awaited (§3), so A1 holds by design once
  STORE_MIGRATION lands; finding 13 keeps it held.
- **The client factory** through `makeStoreFetch`, with `https://` URLs (§4.2).
- **The owner stamp on first open** (§4.5) turns a wrong mapping into a refusal, which is what makes
  finding 1's restore runbook safe to write.
- **The recorder is a sound reference.** All 96 runs on Oct 14 succeeded, and from Oct 13 on its plays
  match the store's exactly (finding 7). Owner-only and hourly is enough at Rem's peak of ~20 plays an
  hour.
- **Deletion by destroying the database**, with Turso's point-in-time and undelete behaviour quoted
  correctly (re-read tonight: "PITR restores an existing database — it cannot bring back a database
  that was deleted").
- **§14.5's closing line**: Turso, Vercel and Spotify are shared fate at this size, and the plan says
  so instead of pretending to engineer around them.

## 4. What I ran

Nothing was written to the store, the Zenbook, Turso or Vercel. On the Mac, Oct 14 11:39 PM to
Oct 15 about 12:30 AM:

- **Read in full:** `PLAN.md` (at `0ca7ab5`), `docs/STORE_MIGRATION.md`, `docs/GOTCHAS.md`,
  `review-completeness.md`. **In part:** 01f §0 and §2-4; 01c §0-2 and §5.4-6; 01e §1.2-2.1; 01a §7.7-8.8
  and §10-12; 01b's incident passages (E1-E6); design B §2 and §7.9-8.6; design C §8-9 and a grep for
  restore and PITR; the Oct 3 review's D2 and M1 (`~/.claude/burn/20261003/lazyboy-review.md:186-216,
  335-352`); lane files 1901 and 1904 in `~/.claude/broke/wavequeue/rem/`.
- **Code:** `src/lib/db.ts:1-406, 560-604`, `src/lib/auth.ts`, `src/lib/store-fetch.ts`,
  `src/app/api/cron/sync/route.ts`, `src/app/api/sync/route.ts:18-40`,
  `src/app/(app)/history-actions.ts:120-140`, `src/lib/sync/history.ts:1-140`,
  `scripts/backfill-from-backstop.mjs`, `scripts/import-tail.mjs`, `vercel.json`, `.claude/QUEUE.md`.
- **Git:** `git diff --stat ac6f7fe HEAD -- src scripts ops tests vercel.json next.config.ts
  package.json` (empty); `git show --stat 044c9b6`; `git reflog show origin/main`;
  `git branch -r --contains 044c9b6` (no branch); `git status -sb` (202 ahead); `git log` since Oct 14.
- **Package sources:** the published tarballs of `@auth/core` 0.41.2 (the lockfile's version) and
  `next-auth` 5.0.0-beta.31 from registry.npmjs.org into an empty `/tmp` directory, two files extracted
  and read; nothing executed; the directory was deleted.
- **Web:** Vercel's instant-rollback, `cli/redeploy`, environment-variables and `cli/env` pages; Turso's
  point-in-time-recovery page and usage-and-billing page (the latter had nothing on idle databases).
- **Zenbook, read-only over `ssh ubuntu`, about 11:55 PM to 12:15 AM:** `cat /etc/resolv.conf`;
  `uptime -s`; `systemctl --user list-timers --all`; the recorder's journal for Oct 14 reduced to line
  counts (lines naming a token or secret dropped, long strings redacted): 96 starts, 96 finishes, no
  line matching fail, error or traceback; `backup.py` lines 1-140 and its last log lines; directory
  listings of the store, recorder and snapshots; a grep for "backstop" in `~/lazyboy-backup/` and
  `~/.config/systemd/user/`, and the user crontab. Then four scripts piped to `python3 -`, kept in
  `~/.claude/broke/scratch/lazyboy_mu/0224_review/` for the re-check finding 7 asks for:
  `incident_counts.py` and `lifetime_counts.py` (store against recorder, per hour Oct 13-15 and per day
  Aug 6-Oct 15), `late_inserts.py` (insertion order by `plays.id`) and `residue.py` (library tables
  against the 08:40Z Oct 14 snapshot, decompressed in memory only). Every connection was `mode=ro`
  straight on the SQLite files (`~/lazyboy-sqld/data/dbs/default/data`, as `backup.py` opens it, and
  `backstop.db`), not through sqld or the meter, and printed counts and booleans only. Store reads: an
  `idx_plays_played_at` range (`SEARCH plays USING INDEX idx_plays_played_at`), rowid ranges
  (`SEARCH plays USING INTEGER PRIMARY KEY (rowid>?)`), and plain `count(*)` of five library tables, the
  largest `tracks` at ~15,900 rows: about 35,000 rows in all. The `count(*)`s go past "counts on indexed
  columns"; they ran on the file, not the serving process. After the cutover the re-check runs on a
  local copy of the latest backup, with the paths at the top of each script changed.
