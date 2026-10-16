# The read-cost ledger, and the Turso rows-read quota it was built for

**Status, 2026-10-16: the quota is live again.** The app's data moved to Turso `lazyboy` that
morning (docs/STORE_MIGRATION.md); only `api_log`, `client_metrics` and `usage_ledger` stay on
the Zenbook. So the meter (below) now sees telemetry traffic only, and Turso's usage comes from
two places: the guard, `/api/cron/usage-check`, which `/api/cron/daily` runs every day at 09:00
UTC against `TURSO_DATABASE_NAME=lazyboy` (Production), and `turso plan show` /
`turso db show lazyboy` by hand. The guard's pace check reports the org's month-to-date usage,
which is `lazyboy`'s (the old `lazy-boy` reads 0); its first call on 2026-10-16 09:08 UTC read
5,209,457 rows read (1.0% of 500M), 24 written. Its per-day reconciliation does **not** work
yet: see "The reconciliation" below. The August status that follows is history.

**Status, 2026-08-11.** Two halves, and they have different lifespans. **The ledger lives on**:
`usage_ledger` + `src/lib/read-costs.ts` still charge every named read path its modeled cost on
every call, and `/usage` still renders it — it is the only instrument that says which path a
cost regression came from, and it is what a fallback to Turso would need on day one. **The
quota it guarded is gone**: the store moved to self-hosted `sqld` on 2026-08-08
(`docs/quota-forensic/BRIDGE.md`) and meters nothing, so the pace check in
`/api/cron/usage-check` now watches a database production neither reads nor writes. Everything
below the next heading is the record of the August incident — accurate as history, and the
reason the fallback is not a one-env-var flip. The per-path cost model in it is still the model
the ledger uses.

Measurement record started 2026-08-06; resolved 2026-08-08 (see "Where August
actually went" at the bottom). Live pre-registrations and the full evidence chain:
docs/quota-forensic/PREREG.md.

## What "rows read" means

Turso bills rows **scanned**, not returned (docs.turso.tech/help/usage-and-billing). A
full-table scan charges one read per row considered; a `count(*)` charges every row; an
indexed probe charges what it examines. Free plan: 500M rows read / 10M rows written /
3 GB syncs per calendar month, and exceeding **any one** metric blocks **every** query on
the database until the month resets.

## State when this was written

- Production had run **replica-less** since the first deploy after 2026-08-03 (the embedded
  replica was switched off in Vercel that day to stop its bootstrap traffic from blowing the
  3 GB syncs quota, and deleted from the code on 2026-08-11 — see GOTCHAS "RETIRED: the
  embedded replica"). With the replica off, **every scanning read was a primary scan and every
  scanned row was billed.**
- Counter readings (Turso dashboard, Rem's screenshots): Aug 3 12:20 PM 167.99M → Aug 5
  4:35 PM 391.89M → Aug 6 1:52 PM 428.51M / 500M (86%). The last 21.3 h = +36.6M ≈
  **41.3M/day**, with ~71.5M of headroom left — under two days at that pace.
- Store size: 7,194 plays (6,951 with a context), 15,019 tracks, 15,327 playlist_tracks,
  180 playlists, 74 contexts (71 distinct in plays).

## Attribution (bottom-up model, plans verified locally)

Every per-query figure below was verified with `EXPLAIN QUERY PLAN` against a copy of
`data/replica.db` (same schema, same data, same engine family as the primary), 2026-08-06.
Traffic was measured by tailing production logs for 58 minutes (`vercel logs --json`,
2026-08-06 19:16–20:14 UTC): **41 hits on `/api/cron/sync`, nothing else** — a strict
120 s pinger interleaved with a ~5-min second scheduler. **11 of the 41 returned 401**
(artifact-check pass, same log file): the ~5-min pinger sends a stale secret, is rejected
before any Spotify or DB work, and has been syncing nothing — so it costs ~0 rows and the
effective paying cadence is the 2-min pinger's **30 ticks/hour ≈ 720/day**. (The route
comment used to say the 5-min source was GitHub Actions; the workflows are deleted, so the
401-ing survivor is an external leftover — find and delete it in the cron-job.org
dashboard, or wherever it lives.)

Per sync call (`syncRecentPlays` — the cron tick AND every open-tab refresh both pay this):

| read | plan | rows billed |
|---|---|---|
| `unresolvedContextUris()` | `SCAN plays` + probe `contexts` per row | **~14.1K** (7,194 + 6,951) |
| `recordPlays` cached-tracks + existing-plays | indexed probes | ~120 |
| meta reads (cooldown, tokens, seq) | indexed | ~10 |

Per tick that lands new plays, add: `recomputeOrphanFlags({newOnly})` `SCAN plays` ~7.2K
(no index on `ctx_orphan`), `recomputeAllTimeStats` → `playsWithListened` full scan +
tracks probes ~14.4K.

The model, per day, at today's store size:

- cron ticks, steady: 720 authenticated × 14.25K ≈ **10.3M/day** (the 401-ing 5-min
  pinger's ~288 hits/day cost ~0)
- ticks landing plays (~50–80/day): × ~21.6K ≈ **1.4M/day**
- an open Home tab: `refreshHistoryAction` every 120 s + twice per track change + on
  visibility (`den-home.tsx`), and `SyncOnLoad`'s `POST /api/sync` (server-debounced to
  ~1/min) — each is a full sync call: ≈ **0.9–1.7M per hour the tab is open**
- cache-miss re-reads after each write-marker bump (daily strip, all-time list, today):
  ~5K × ~15 bumps/day ≈ 0.1M/day
- hourly library sync steady state + daily cron: ~20K/day — noise

Closed-app model ≈ **12M/day**; with a 6 h listening session ≈ 18–22M; the Aug 5→6 window
also contained dev + benchmarking (bench-reads ≈ 1M measured; the dev remainder is not
reconstructable). The model accounts for ~half to two-thirds of the measured 41.3M/day;
the residual is attributed to dev-day traffic **[UNVERIFIED]** and to possible
undercounting of index-entry scans in the model (if Turso bills index entries and table
rows separately, several terms roughly double — still uncalibrated). The residual this
model could not account for was later measured to be the hourly library-sync burst
("Where August actually went", below); within the paths this model does cover,
`unresolvedContextUris` was the dominant term at any plausible calibration.

**The defect class** (this is the second instance, not the first): *a read path whose
resource cost is invisible until a dashboard shows a percentage, so optimizing one metered
dimension silently loads another.* Instance one: the eager replica warm burned syncs; the
Aug 3 fix (replica off) moved the whole scan load onto billed primary reads. Instance two:
`unresolvedContextUris` re-derived "which contexts need resolving" from a full plays scan
on every sync call — correct, tiny on a local file, and ~14K billed rows per call against
the primary, ~1,000+ calls/day.

## The fixes (shipped together with this doc)

1. **Context resolution is bounded by the batch, not the table.** A new unresolved
   context can only enter via a play in the incoming sync batch, so the per-call check
   is now an indexed `IN` over ≤50 URIs (~50 rows) instead of a 14.1K-row scan. The
   30-day negative-cache re-check (self-healing for 403'd names) survives as a
   once-a-day full pass gated by `meta.contexts_full_check_at`.
2. **`recomputeOrphanFlags({newOnly})` uses a partial index** (`idx_plays_orphan_null`,
   `WHERE ctx_orphan IS NULL`) — scans only unverdicted rows (≈ the new plays), not all
   of `plays`. Verified: `SCAN p USING INDEX idx_plays_orphan_null`.
3. **`recomputeAllTimeStats` is throttled to once per 10 min** (`meta.alltime_at`).
   Its full plays scan ran on every tick that landed plays; the all-time card can lag a
   listen by ≤10 min, and the next gated tick heals it. The scan itself still grows
   linearly with history — the incremental-accumulator version is the queued next lever,
   to take when the guard shows this term mattering again.

5. **(Added Aug 7)** The expensive derived reads — the history search payload (~22K
   billed rows per rebuild) and the all-time list (~25K) — key on a **slow marker**
   (`meta.slow_seq_pub`: write_seq, published at most every 10 min) instead of live
   write_seq. Measured live (Aug 7 morning): keyed live, a listening session with the
   app open cost ~60K rows per landed play ≈ 2M/hour — the last unbounded-in-practice
   path. The day strip and day views stay live.
6. **(Added Aug 7)** Search stays INSTANT despite 5: a landed play is an append, so the
   client patches its in-memory index with the delta instead of waiting for a rebuild —
   `refreshHistoryAction` takes the index's newest play minute and returns the plays it
   is missing (`searchHistory("", n)` head check ~3 billed rows steady-state, delta rows
   only when there is one; includes cron-synced plays, which `added` alone would miss),
   and `patchHistoryPayload` (`src/lib/history-patch.ts`, known-answer tested) merges
   them newest-first, idempotently. The 10-min lag now applies only to a cold page load
   and to the all-time list.

What deliberately did NOT change: the pinger cadence (42 ticks/h is Rem's freshness
choice; post-fix a tick costs ~160 rows so cadence stopped mattering), the render-path
caching (already keyed on the write marker), and the replica (stayed off, and was deleted on
2026-08-11 — see ARCHITECTURE for the read architecture).

## The guard (a mechanism, not a convention) — DORMANT 2026-08-08 to 2026-10-16, live again

Since 2026-10-16 production runs on Turso `lazyboy` and this guard watches it, run daily by
`/api/cron/daily` (which records the result and notifies nobody, STORE_MIGRATION R6). The
cron-job.org job described below has not called it since 2026-08-10 (the last `usage_check`
ledger row before Oct 16); its `CRONJOB_API_KEY` is a sensitive Vercel variable and does not
pull, so whether the job still exists is unknown (Rem's, burn review Z2). A breach therefore
shows on `/usage` and in the ledger, and e-mails nobody. Until Oct 16 the paragraph below held:
the pace check ran against Turso, which production no longer used; it was kept armed
because it is the guard the fallback would need immediately, and because its second half (the
reconciliation, below) is what writes the platform total and the residual into the ledger that
`/usage` renders. Read the rest of this section as the design, not as a live alarm.

Two dashboard-at-86% surprises in one week establish that a doc rule is not a guard. The
standing mechanism is `/api/cron/usage-check`: reads the org's usage from Turso's
platform API (`TURSO_PLATFORM_TOKEN`), compares **every** metered dimension (rows read,
rows written, syncs, storage) against a pro-rated month line with a 1.5× allowance, and
returns HTTP 500 on breach. A daily cron-job.org job calls it; cron-job.org emails on
failing jobs, so a breach lands in Rem's inbox while there is still headroom, instead of
in a dashboard nobody re-visits. Tripping it deliberately (allowance temporarily set
below current usage) is part of its acceptance test — a guard that has never fired is a
guard that does not work.

## Measured reads (the meter) — LIVE since 2026-10-12

**Since 2026-10-16 07:52 UTC the meter sees telemetry only**: the core tables are on Turso, and
the meter's core fence answers 503 to any core statement that still reaches it. The figures
below for Oct 12-15 are the whole app's reads on the Zenbook; for Turso's reads use the guard
and `turso db show lazyboy`, not this meter.

The ledger below MODELS reads; this measures them. sqld returns `rows_read`, `rows_written` and
`query_duration_ms` on every statement result (the counters Turso bills on), and the meter in
front of it on the Zenbook (quota-forensic/BRIDGE.md) logs them per statement, with the SQL, to
`~/lazyboy-sqld/querylog/<UTC day>.jsonl`. `python3 ~/lazyboy-sqld/meter-report.py [day]`
prints per-day totals, a day's top readers and writers, and a 30-day projection against Turso's
free plan. `lazyboy-readmeter.timer` separately samples sqld's own cumulative counter
(`data/dbs/default/stats.json`) every 15 minutes into `readmeter.jsonl`, which cross-checks the
meter: a gap between the two means something reached sqld without passing through 8090.

libSQL's count is not "rows scanned" as the model assumes: `SELECT count(*) FROM tracks` over
15,852 rows reported 158 (it walks pages, not rows), while a `plays JOIN tracks` over 21,870
plays reported 65,608 (about three per play: the scan plus each join probe). So per-path model
numbers can be off in either direction; the meter is the authority.

Calibration on 2026-10-12, before the meter existed: sqld's cumulative counter read
**246.8M rows** and 0.81M rows written. The store moved to the Zenbook on 2026-08-08; IF the
counter dates from then (unverified, but it survived the 2026-10-12 reboot, so it persists), that
is ~3.8M rows read/day, ~115M/month. The ledger modeled 286.7M over the same span, so the model
ran ~15% HIGH in aggregate. The "real is ~2× the model" residual in "Where August actually
went" was Turso-era (syncs and paths the model didn't cover), not a property of the model now.

This half survived the move off Turso unchanged, and is the part of this document that still
describes running code. What it measures is modeled rows SCANNED per named read path, which is
a cost whether or not anyone bills it.

The guard above answers *am I burning too fast*. It cannot answer *on what* — and a month of
this database's burn went unattributed for exactly that reason: Turso publishes one counter
per organization, and the per-path model lived in this document, recomputed by hand after the
fact. The ledger makes the attribution continuous instead.

**How it works.** Every named read path records what it MODELS itself to cost as it runs.
`src/lib/read-costs.ts` owns the model — one named constant or formula per path, each with a
comment saying what it was calibrated against and when, and with the linear terms taking the
current plays count as a parameter rather than baking in an August store size.
`usage_ledger (day, reader, calls, modeled_rows)` in `src/lib/db.ts` stores it, one row per
(UTC day, reader). Writes are `void ledgerAdd(...)` — fire-and-forget, error-swallowing, off
the awaited path, and deliberately not batched into any real write. Attribution that can slow
a render or fail a batch is worse than no attribution. It is meta-class data, so it does
**not** bump `write_seq` (the marker rule in `db.ts`; api_log is excluded for the same
reason).

Instrumentation sits at the choke points, and inside the read rather than at its call site,
so a cache HIT costs nothing and is counted as nothing. The readers:

| reader | what it counts |
|---|---|
| `sync_tick_steady` / `sync_tick_landed` | `/api/cron/sync`, split on whether the tick landed a play |
| `sync_onload` | `POST /api/sync`, the open tab's on-load sync |
| `history_refresh` | `refreshHistoryAction` — the sync plus its own head/delta check only |
| `history_payload` / `library_payload` | the two search payloads, on actual rebuild |
| `alltime_list` | `readAllTimePlays`, on actual rebuild |
| `day_strip` / `day_plays` | `readDailyStats` / `readPlaysByDay`, on actual execution |
| `search_fallback` | `searchHistory`'s LIKE path (not the bounded empty-query branch) |
| `contexts_full_pass` | the once-a-day `unresolvedContextUris` scan |
| `unique_song_count` | `recomputeUniqueSongCount` |
| `orphan_full_pass` | the UNSCOPED `recomputeOrphanFlags()` — the ~2.5M term; the two bounded scopes are not ledgered |
| `playlist_rewrite` | `storePlaylists`' delete-all + reinsert branch (its read side: the probe and the purge) |
| `usage_check` | the daily guard's own reads |

Two readers are reserved and written by the reconciliation, not by a read path:
`_platform_total` and `_residual` (plus `_platform_error` for a day the platform API could
not be reached). A real reader never starts with an underscore.

**The reconciliation.** `/api/cron/usage-check`, after its pace check, fetches yesterday's
(the last CLOSED UTC day) real `rows_read` for this database from Turso's windowed usage
endpoint, sums the day's ledger, and writes both the meter and the residual back into the
ledger. It returns **500 — the same email path as a pace breach** — when the day is
unexplained: `|residual| > max(1,000,000, 0.5 × platform_day_total)` **and**
`platform_day_total > 200,000`. A platform API that times out records `_platform_error` and
does **not** alarm; it hung for 20+ minutes on Aug 7, and paging on an unreachable meter
trains you to ignore the one email that matters. `fetchPlatformDayUsage` is isolated and
marked swappable for the same reason: if the windowed endpoint proves unreliable, the
replacement strategy behind the same signature is differencing daily snapshots of the
month-to-date total.

**Broken as of 2026-10-16: the parser does not match the endpoint's shape.**
`fetchPlatformDayUsage` (`src/lib/usage-check.ts`) reads `database.total.rows_read`, else sums
`database.instances` as a map of counters. The endpoint (checked 2026-10-16 for `lazyboy`, HTTP
200) returns the sum at the top level, `total.rows_read`, plus `database.usage.rows_read`, and
`database.instances` is an array of `{uuid, usage}`. Neither branch finds a number, so every
day records `_platform_error` and no `_platform_total`/`_residual` (the Oct 16 call did exactly
that for Oct 15). The pace check is unaffected.

**The thresholds are provisional.** They are sized to catch a burn of the shape that actually
happened — millions of unattributed rows — not calibrated against a measured distribution of
the residual, because nobody has one. P2/P4 (the posting-lag experiments) are what calibrates
them: usage attributed to a day can still be arriving when the next day's cron reads it,
which shows as a spurious positive residual followed by a matching negative one. Until then,
treat a single day's alarm as a reason to look, not as proof.

**Known model biases**, stated rather than discovered later. The landed-tick cost includes
the all-time recompute, which is gated to once per 10 minutes; the sync route cannot see
whether the gate opened, so consecutive landed ticks in one window are over-charged. That
inflates the ledger and therefore *shrinks* the residual — the bias runs toward
under-alarming, never toward a false alarm. And the ledger's own writes (~2 rows each, ~3K a
day) are not ledgered: an instrument that measures itself does not terminate.

**Where to look:** `/usage` — authed, no nav link. The last 14 days, ONE day at a time (← / →
or the chevrons; the whole window is fetched once and paged in the browser, so reading the
ledger cannot move the counter it reports). Every reader draws on every day, zero-filled, in
`LEDGER_READERS` order, with calls, modeled rows, rows per call and the change against the
previous day — a fixed row order is what makes two days comparable. The platform total and the
residual sit below the rule, with the alarm bar (`residualVerdict`) restated where it applies. Known-answer tests:
`node scripts/test-ledger.mjs` (throwaway file DB; the reconciliation math is imported from
the shipped source, the storage SQL is a copy that must match `db.ts`).

## Sibling sweep — every read path, its shape, its verdict

Verdicts: **bounded** = cost independent of history size, or indexed to the rows it
returns; **linear-rare** = full scan but only on real change, cost named; **fixed**.

| path | shape | verdict |
|---|---|---|
| `unresolvedContextUris` (per-sync) | was `SCAN plays`+probes every call | **fixed** → bounded (≤50 indexed rows) |
| `recomputeOrphanFlags({newOnly})` | was `SCAN plays` per landing tick | **fixed** → bounded (partial index) |
| `recomputeAllTimeStats` | full plays scan + tracks probes (~14.4K) | **fixed** → throttled 10 min; linear growth remains, queued lever: incremental accumulator |
| `recomputeOrphanFlags({})` full pass | predicate over every play × its playlist's members. Estimated here at ≈1.3M rows; **measured at 2,544,558** (Aug 7 12:15–12:20 PM ET, windowed usage endpoint — the estimate was ~2× low, see `orphanFullPassRows`) | ~~linear-rare (`library_seq` = 5 lifetime)~~ **FALSIFIED.** It was not rare and it was not cold: it ran on the hourly cron sync for weeks, and it is the single largest term of the whole crisis (~60M/day). The change-probe was never keeping it cold, because a rotating artwork URL counted as a list change. **Now:** the rewrite branch runs it only when membership can actually have moved — the playlist ID SET changed, or the `playlist_tracks` purge reported `rowsAffected > 0` (`needsFullOrphanPass`). A rename, a reorder or a count drift rewrites the list and skips it. Ledgered as `orphan_full_pass`, so a return to hourly is now visible on `/usage` instead of only in the platform counter |
| `recomputeOrphanFlags({playlistId})` | indexed by `idx_plays_context` + predicate over that playlist's plays | bounded per changed playlist |
| `readHistoryIndex` (search payload) | full plays scan ×3 probes ≈ 21.6K, once per `write_seq` change | linear-rare: ~15/day ≈ 0.3M/day; grows with history — same queued lever class |
| `readLibraryIndex` | playlist_tracks scan + probes ≈ 30K, once per `library_seq` change | linear-rare: `library_seq` moved 5× ever |
| `readDailyStats` | indexed 16-day window (~1.7K + probes) per bump | bounded by window |
| `readPlaysByDay` | indexed day range ~90 rows + frozen-day cache | bounded |
| `readAllTimePlays` | full scan + per-track subquery ≈ 25K, once per bump when the view is open | linear-rare, cached on `write_seq` |
| `searchHistory` LIKE | scans tracks; **fallback only** since `13515d8` | linear-rare, user-triggered |
| `playsWithListened` | full plays scan + probes | only called by `recomputeAllTimeStats`/`getDailyStats`-adjacent paths above |
| `recordPlays` reads | indexed probes ~120 | bounded |
| `storePlaylistTracks` cached-positions read | indexed per playlist | bounded |
| `storePlaylists` change-probe | 180-row scan hourly | bounded, and always was — its READ cost was never the issue. Its **verdict** was: two-way (exact match → stamp, anything else → delete-all + reinsert + full orphan pass), so the rotating `mosaic.scdn.co` art on 156 of 180 rows failed the match nearly every hour and took the expensive branch with it. ~~"the change-probe is what keeps the full pass cold"~~ **FALSIFIED** by the same measurements. **Now three-way** (`diffPlaylistList`, src/lib/store-diff.ts): identical → stamp meta, no marker; **images only → per-row `UPDATE playlists SET image`**, `write_seq` bumped (a cached read serves the table), no `library_seq` (the search payload reads only `id, name` from `playlists`), no purge, no orphan pass; anything else → the rewrite, ledgered as `playlist_rewrite`. When it does differ it logs one `storePlaylists-diff` line naming the first differing field, so the claim "it's the artwork" stays checkable in production. Known answers: `node scripts/test-playlist-sync.mjs` |
| `recomputeUniqueSongCount` | DISTINCT over playlist_tracks + probes ≈ 30K | linear-rare: only when the library actually changed |
| meta reads (tokens, locks, seq, stamps) | single-key indexed | bounded |
| `api_log` writes/reads | indexed, 1 h TTL | bounded |

## Where August actually went (resolved 2026-08-08)

The forensic (docs/quota-forensic/ — PREREG.md holds every measurement with
provenance) closed the attribution with Turso's windowed usage API, which passed
known-answer validation to the row (a quiet 3.6 h window returned exactly its
endpoint-diffed 1,168; month splits sum exactly; 400 controlled inserts billed
exactly +1,200 written / +800 read, posting within 30 s even mid-connection).

**The dominant burner was the hourly cron library sync's full-rewrite path**: the
storePlaylists change-probe failed nearly every hour on a volatile field (156/180
stored playlists carry rotating mosaic.scdn.co art), so every hour ran the playlist
delete-all+reinsert (~640 billed writes) plus recomputeOrphanFlags()'s unscoped
~2.5M-row pass — one ~5-min burst per hour, ~60M/day at August's store size,
measured identically on Aug 5 (pre-fix era) and Aug 7 (post-fix), because the path
is server-side and every "fix era" shipped around it. July's 336M was the same
mechanism at July's store size. The per-query fixes below were all real and all
correct — they just never touched the burst path. Fixed 2026-08-08 by the
three-tier probe + gated orphan pass (see the sweep table); the forecast
pre-registration for the post-unblock validation window is
docs/quota-forensic/PREREG.md §P5.

The meter itself: billing data exact at every check; the real Turso-side defects
are reporting-layer (the "pulse" aggregation outage of Aug 8 1:37–2:23 AM,
org storage_bytes=0, a transient bytes_synced dip during instance migration) plus
quota enforcement lagging ~14M past the 500M line. Ticket draft:
docs/quota-forensic/SUPPORT_TICKET_DRAFT.md (optional, Rem's call).
