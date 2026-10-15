# Review of PLAN.md: uptime, the store, and moving Rem's data

Lane 0224_lb_mu_review_migration, Oct 15, 2026 (started Oct 14, 11:39 PM). An adversarial read of
`docs/multi-user/PLAN.md` at `0ca7ab5` through one lens: single points of failure, behaviour when the
Zenbook or the new store is down, and whether moving Rem's existing data could lose or mis-assign
anything. Isolation, security, scale and completeness have their own reviewers; where a point here is
already in `review-completeness.md` it is cited, not repeated. Planning only: nothing here changed
code, data, the Zenbook, Turso or Vercel. Every production read was read-only and is listed in §4.

Severity: **S1** loses or mis-assigns Rem's data, or takes every user down, with no plan step that
catches it; **S2** a plan claim that is wrong or unproven in a way that changes a decision or a
runbook step, or a gap whose failure loses plays or takes every user down; **S3** a gap a lane would
trip over; **S4** wording or a number to correct.

## 0. Summary

(written last)

## 1. Findings

Nothing reaches S1: every S2 below needs a second event the plan expects to happen (a store blip, a
restore, a rollback, a Zenbook outage, a key rotation) before it costs data or uptime.

### S2-1. Restores have no runbook, and four parts of the design make a plain restore misroute data

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
  `session_epoch`, and re-apply disables from a log kept outside the app database (the deletion job and
  any disable already write to the telemetry store; make that a one-line record per action).
- Rehearse it in §13.2's throwaway-invite gate: restore that database under a new name, see the app
  serve from it, then destroy it.

### S2-2. Until Phase 3 the Zenbook is the only frequent capture trigger, and its outage rate is understated

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
  lease replaces the guard. Cost: ~1,440 rows written a day on Turso, 0.4% of the free plan.
  Re-enabling the cron-job.org job with a fresh secret is Rem's step (STORE_MIGRATION's lanes read R6
  as forbidding it).
- Give the Zenbook a resolver that does not depend on tailscaled. Rem's call: an ops change outside
  this program's lanes.
- Restate §14.5's first row with the measured history, and add the interim as a stated exposure.

### S2-3. P2's accumulator and P3/P4's patched values are read-modify-write, and the plan dropped what made them safe

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

(more S2 findings follow)

## 2. STORE_MIGRATION, from this lens

(in progress)

## 3. What holds up

(in progress)

## 4. What I ran

(in progress)
