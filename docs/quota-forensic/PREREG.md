# Quota forensic — pre-registered windows + live evidence log (Aug 8, 2026)

Mission: explain or impeach the Turso rows-read meter (research-coord fable mission
`lazyboy-quota-forensic`). Every counter experiment is pre-registered HERE before its
window opens; readings append below as they land. All times ET.

## Tonight's observed state (evidence, with provenance)

- **1:06 AM** (prep, platform API): rows_read **513,980,496** (102.8% of 500M, reads
  blocked), rows_written 240,871, bytes_synced 2.28 GB (**down** from 2.42 GB measured
  repeatedly Aug 6–7). Two instances in the usage response: `3d5671ac` frozen at
  428,393,023; `55ae7a03` carrying all growth.
- **1:37–1:47 AM**: `GET /v1/organizations/remtbkv/usage` **hangs** — four attempts, 90s
  timeouts ×3, 20s ×1; per-database usage endpoint also times out (20s). Meanwhile the
  cheap org endpoints answer in <0.5s: `blocked_reads: true`, `blocked_writes: false`,
  plan `starter` (no upgrade yet). Database object says `block_reads: false` (the block
  is org-level).
- **1:45 AM**: `GET .../databases/lazy-boy/instances` → exactly ONE instance,
  `fa59eb0e…`, type primary — a uuid matching **neither** instance seen at 1:06 AM.
  Another instance change happened between 1:06 and 1:45 AM, coinciding with the usage
  endpoint going unresponsive.
- **1:44 AM**: direct SQL probe (libsql client, prod credentials): SELECT →
  `BLOCKED: SQL read operations are forbidden`; a 1-row meta upsert (key
  `forensic_probe`) → OK. Reads blocked, writes work.
- **1:43 AM**: `POST .../databases` (scratch calibration DB) → refused:
  "organization remtbkv is blocked from creating databases". The scratch-DB
  calibration instrument requires the plan upgrade first.

## P1 — blocked-state counter watch (window opens at API recovery)

While reads are org-blocked, nothing client-side can scan rows: app read attempts are
rejected pre-execution, our write probes use plain INSERTs on fresh tables, platform-API
polls touch no SQL. **Null trace (meter honest, posting real-time): rows_read is
CONSTANT for the whole window (≥6 h), tolerance +10 rows.**

Divergences and their readings:
- rows_read **climbs** while blocked → usage is being posted with delay (server-side
  back-posting) or billed by something that isn't a client read. Quantify rate + decay;
  this is the 14M-overshoot mechanism caught in the act.
- bytes_synced moves (either direction) with no replica and no reads → accounting
  anomaly, same class as the observed 2.42→2.28 GB decrease.
- Per-instance set changes again, or instance values don't sum to the org total →
  migration-accounting evidence.

## P2 — write-posting-latency probe (needs API recovered + ≥15 min quiet baseline)

Discriminates "delayed/batched posting" (mission lean 1) using rows_written, the one
counter we can legally move while blocked. Fresh table `_forensic_cal` (DDL measured
0 billed reads, Aug 7).

1. Short-lived client: one batch INSERT of 200 rows, connection closed. Poll usage
   every ≤30s. Measure Δt(execute → counter shows +200).
2. Long-lived client: ONE connection held open 20 min, 10 rows/min. Record whether
   increments post during the connection or only at/after close.

**Null (real-time metering): both visible within ≤60 s of execution.** Lean-1-support:
long-lived usage posts as a lump at close. Also watch rows_read in lockstep (plain
INSERT should bill 0 reads — any movement is a billing-semantics discovery).
Contamination control: the app's write path currently fails before writing (sync route
reads meta first → BLOCKED), so we are the only writer; every probe statement is logged
with its timestamp below. Cleanup at mission close: DROP TABLE `_forensic_cal`.

## P3 — recovery-jump check (fires once, at first successful usage read)

Reads have been blocked since before 1:06 AM and remain blocked. **Expected under an
honest, real-time meter: first recovered reading = 513,980,496 exactly (± our logged
probe writes' read-side cost, expected 0).** A jump of ≥100K with reads blocked
throughout is meter-side back-posting, demonstrated with no client activity at all —
support-ticket-grade evidence.

## P4 — windowed per-database usage sweep (fires at API recovery, before P2)

Research finding (Aug 8): `GET .../databases/lazy-boy/usage?from=&to=` accepts ISO-8601
windows (offset mandatory) — potentially retroactive sub-month resolution the org
endpoint lacks. Pre-registration:
1. **Validation first** (the endpoint could ignore the params): a July window
   (2026-07-01→07-31) must return ≈0 (DB predates August? if the DB is older, expect
   July's actual usage, distinctly ≠ August's); two half-month August windows must
   ≈sum to the month total; a 1-hour quiet window (Aug 7 5:15–8:51 AM ET ≈ the
   +1,168-rows cooldown stretch) must return ≈0.001M — this stretch is the known-answer
   test. Only if validation passes do the sweep results count.
2. **The sweep**: hourly windows across Aug 7 12:00 PM ET → Aug 8 2:00 AM ET (the
   +31M mystery + the block crossing), then daily windows Aug 1–8. Deliverable: when
   did the burn actually execute (per the meter), when did the block engage, was the
   evening burn uniform or lumped.
3. **Instance-boundary bracket**: windows straddling Aug 6 ~2 PM (3d5671ac freeze) and
   Aug 8 ~1:00–1:45 AM (fa59eb0e appearance): does windowed usage double-count or
   drop across instance replacement? Compare sum-of-instances vs total per window.
Interpretation guard: if validation (1) fails, the endpoint is current-cycle-only and
P4 aborts with that fact recorded (itself worth knowing for the ticket).

## Readings log (append-only)

| ts (ET) | source | rows_read | rows_written | bytes_synced | note |
|---|---|---|---|---|---|
| Aug 8 1:06 AM | platform API (prep) | 513,980,496 | 240,871 | 2.28 GB | 2 instances: 3d5671ac frozen, 55ae7a03 |
| Aug 8 1:37–1:47 AM | platform API | — | — | — | usage endpoint unresponsive (4 timeouts); org endpoint fine; instance set now = {fa59eb0e} only |
| Aug 8 2:22 AM | platform API | — | — | — | endpoint now returns an ERROR body: `error getting pulse usage for organization 51721ab6-…: received response with status code 502` — the internal usage backend is named "pulse" and is 502ing; outage ongoing since ≥1:37 AM |
| Aug 8 2:23 AM | platform API | 513,980,496 | 240,871 | 2.4467 GB | RECOVERED after ~46 min. **P3 verdict: rows_read EXACTLY equal to the 1:06 AM value — no back-posting during the blocked window.** Instances sum exactly: 3d5671ac 428,393,023 (syncs 2.4209 GB — the source of the old "2.42" org readings) + 55ae7a03 85,587,473 (syncs 25.9 MB ≈ the migration's own transfer, billed to the customer quota). org storage_bytes = 0 while instances carry ~9.7 MB each — live aggregation artifact. The 1:06 AM "2.28 GB" dip = transient partial aggregation, now self-corrected ABOVE the old value. |

## P4 outcome (Aug 8 ~2:30 AM) — validation PASSED, mystery decomposed

Known-answer checks: quiet-cooldown window returns **exactly 1,168**; Aug 1–4 + Aug 5–8
= 513,980,496 exactly; per-instance July+Aug splits internally exact (267,372,781 +
161,020,242 = 428,393,023). The windowed endpoint is real retroactive truth.

Hourly sweep, Aug 7 → Aug 8 (ET): burn is a FLAT ~2.52–2.76M/h from 10:00 AM Aug 7
through 12:59 AM Aug 8 (one 2× hour at 2 PM: 5.12M), then **0 from 1 AM on** — the
block engaged at ~514M (≈14M of enforcement lag at that rate ≈ 5 h) and the meter
recorded nothing after. July total: 335,952,305 (same pattern era, under the cap).
rows_written in burn hours ~700–970/h ≈ one write per ~4–6 s = the 6 s now-playing
poll fingerprint of an OPEN TAB whose old build still logged successful now-playing
calls. Verdict shift: the burn was REAL, steady, and time-driven (not play-driven,
not meter fiction) — an always-open tab pinned to a pre-fix deployment by Vercel skew
protection, refreshing ~2×/min at ~21–42K rows/cycle, unchanged through the 3:41 PM
deploy (deploys never reach open tabs), silenced only by Spotify cooldowns and the
quota block. The live-counter timelines missed it because the org counter posts this
component in lumps the 6-min windows dodged — pulse's retroactive time-bucketing is
what finally showed it.

**Model-vs-meter residuals (honest, open):** the git-archaeology reconstruction
(OLD_BUILD_COST.md) models the idle stale tab at 27.6K rows/min worst-case vs the
observed 42.5K/min — a ~1.5× gap whose leading candidate is index-entry billing on
reads (the calibration unknown READ_QUOTA.md flagged and never measured; "as few as
one row read" for indexed lookups per Turso's pricing FAQ, but multi-entry range
probes are uncharacterized). And the burn hours carry ~700–970 rows_written/h vs
~120/h modeled — the extra ~600–850/h writer is UNIDENTIFIED (the 6 s now-playing
api_log theory fails: the skip for successful polls shipped Aug 1, before any
plausible tab age... unless the tab predates Aug 1 entirely, which the replica-era
code makes cost-inconsistent). Both residuals are calibratable post-unblock (P2
measures the api_log write multiplier directly; a controlled open-tab hour measures
the true per-cycle read cost) and neither threatens the primary attribution — the
burn's flatness, its on/off edges (cooldown, block), and its indifference to the
3:41 PM deploy are the signature of one long-lived stale-build tab regardless of the
exact per-cycle constant.
