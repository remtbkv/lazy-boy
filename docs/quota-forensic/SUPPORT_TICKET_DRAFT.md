# Turso support ticket — DRAFT (Rem sends; never send from a session)

Status: DRAFT v1, Aug 8 2026 ~1:55 AM ET. Placeholders `[P1]`/`[P2]`/`[P3]` get filled
from the pre-registered experiments in PREREG.md before sending. If the experiments
instead vindicate the meter, this ticket is withdrawn — do not send accusations the data
no longer supports.

---

**Subject:** Usage-metering anomalies on org `remtbkv` (starter plan, DB `lazy-boy`):
counter inconsistencies across an instance migration + usage API outage

**Body:**

Hi — I'm trying to reconcile my app's measured per-query costs against the org usage
counter and I'm seeing several things on Turso's side I can't explain. Org `remtbkv`,
single database `lazy-boy` (aws-us-east-1), August 2026 billing period.

1. **A cumulative counter decreased.** `bytes_synced` from
   `GET /v1/organizations/remtbkv/usage` read 2.42 GB repeatedly on Aug 6–7 (ET), then
   2.28 GB on Aug 8 ~1:06 AM ET. A monthly cumulative usage counter went down ~140 MB
   mid-month.
2. **Instance accounting across a migration looks wrong.** The usage response showed
   two instances for the one database: `3d5671ac…` frozen at exactly 428,393,023
   rows_read since at least Aug 6 10:48 PM ET, with `55ae7a03…` carrying all growth
   since. On Aug 8 ~1:45 AM ET, `GET .../databases/lazy-boy/instances` returned a
   single instance `fa59eb0e…` — a third uuid. I have timestamped API reads suggesting
   the per-instance rows_read values did not sum to the org total during this period
   (to be confirmed: [P-instances]).
3. **rows_read kept growing well past the quota block.** Reads were blocked at 500M
   (as designed), but the counter continued to 513.98M by Aug 8 1:06 AM ET — a 14M
   overshoot recorded while every SQL read on the database was being rejected with
   `BLOCKED: SQL read operations are forbidden`. What accrues rows_read after the
   read block engages? [P1 result: whether the counter kept moving during a fully
   blocked, client-quiet window: …]
4. **The usage endpoint went unresponsive.** From Aug 8 ~1:37 AM ET,
   `GET /v1/organizations/remtbkv/usage` and the per-database usage endpoint hung
   (>90 s, repeated attempts over 15+ min) while all other org endpoints answered in
   <0.5 s. This coincided with the instance change in (2).
5. **Posting latency.** [P2 result: measured latency between executed writes and the
   usage counter reflecting them, short-lived vs long-lived connections: …]

Context I've already gathered: `libsql-server`'s stats are monotonic-since-creation
per-instance atomics flushed every 5 s (`src/stats.rs`), so the billing-cycle figure
must be derived by differencing — and counter rollback after a crash was filed by your
own team as tursodatabase/libsql#863. My observations look like that class of artifact
surfacing at instance-migration boundaries.

Questions:
- Is org-level usage the sum of per-instance counters, and how is usage carried across
  an instance migration? Can a migration double-count or drop usage?
- What is the intended posting cadence for rows_read/rows_written into the usage API —
  real-time, or batched (and at what interval / on what trigger, e.g. connection
  close)?
- What can legitimately accrue rows_read while `blocked_reads` is true?
- Why would `bytes_synced` decrease mid-month?

My app-side accounting (EXPLAIN-verified per-query costs × logged request counts) is
several-fold below what the counter recorded for Aug 7 1:26 PM → Aug 8 1:06 AM ET
(+31.0M rows_read in ~11.7 h against a measured steady state of <1M/day after shipping
scan fixes), so I'd like to understand the meter's semantics before assuming the
remainder is mine.

Happy to share timestamped API responses for all of the above.
