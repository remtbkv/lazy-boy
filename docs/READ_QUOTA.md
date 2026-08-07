# The Turso rows-read quota: attribution, fixes, and the guard

Written 2026-08-06, before the fixes below deployed — the measurement windows are
pre-registered here so the post-fix reading can be judged against a prediction made in
advance, not fitted after the fact.

## What "rows read" means

Turso bills rows **scanned**, not returned (docs.turso.tech/help/usage-and-billing). A
full-table scan charges one read per row considered; a `count(*)` charges every row; an
indexed probe charges what it examines. Free plan: 500M rows read / 10M rows written /
3 GB syncs per calendar month, and exceeding **any one** metric blocks **every** query on
the database until the month resets.

## State when this was written

- Production has run **replica-less** since the first deploy after 2026-08-03
  (`LAZYBOY_NO_REPLICA=1`, set in Vercel that day to stop the embedded replica's
  bootstrap traffic from blowing the 3 GB syncs quota — see GOTCHAS "The replica and the
  syncs quota"). With the replica off, **every scanning read is a primary scan and every
  scanned row is billed.**
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
rows separately, several terms roughly double). The clean baseline window below resolves
the calibration; the ranking of terms does not depend on it — `unresolvedContextUris` is
the dominant term in every path at any plausible calibration.

**The defect class** (this is the second instance, not the first): *a read path whose
resource cost is invisible until a dashboard shows a percentage, so optimizing one metered
dimension silently loads another.* Instance one: the eager replica warm burned syncs; the
Aug 3 fix (replica off) moved the whole scan load onto billed primary reads. Instance two:
`unresolvedContextUris` re-derived "which contexts need resolving" from a full plays scan
on every sync call — correct, tiny on a local file, and ~14K billed rows per call against
the primary, ~1,000+ calls/day.

## Pre-registered measurement windows

Counter readings come from the Turso dashboard (or the platform API once a token exists).
Both windows: no local dev, no benchmarks, app closed except where stated; tick traffic
confirmed by a log tail during the window.

- **W0 — baseline, before the fix deploys, ≥6 h.** Prediction: 10–24M/day pace
  (0.45–1.0M/h; the range is model ± the index-entry calibration unknown). Null (model
  wrong): the pace stays ≥35M/day with no dev running — then something big is
  unattributed and the fixes must NOT be declared the answer.
- **W1 — after the fix deploys, ≥6 h.** Prediction: ≤1M/day pace closed-app (720 ticks
  × ~160 rows ≈ 0.12M + throttled recomputes ≈ 0.3M + margin). Failure bar: >3M/day
  means a sibling path is still scanning — hunt it, don't celebrate.
- A trivial no-op scores: W1/W0 ≈ 1.0. The fix claims W1/W0 ≤ 0.1 at unchanged tick rate.
- Projected month at the W1 bar: ≤ ~30M/month + Rem's interactive use ≈ **≤10% of the
  500M cap**, against 86% burned in the first 6 days of August.

Outcomes are recorded at the bottom of this file as readings land.

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
   path. New plays now appear in search/all-time up to 10 min late mid-session; the day
   strip and day views stay live.

What deliberately did NOT change: the pinger cadence (42 ticks/h is Rem's freshness
choice; post-fix a tick costs ~160 rows so cadence stopped mattering), the render-path
caching (already keyed on the write marker), and the replica (stays off — see
ARCHITECTURE for the read-architecture decision).

## The guard (a mechanism, not a convention)

Two dashboard-at-86% surprises in one week establish that a doc rule is not a guard. The
standing mechanism is `/api/cron/usage-check`: reads the org's usage from Turso's
platform API (`TURSO_PLATFORM_TOKEN`), compares **every** metered dimension (rows read,
rows written, syncs, storage) against a pro-rated month line with a 1.5× allowance, and
returns HTTP 500 on breach. A daily cron-job.org job calls it; cron-job.org emails on
failing jobs, so a breach lands in Rem's inbox while there is still headroom, instead of
in a dashboard nobody re-visits. Tripping it deliberately (allowance temporarily set
below current usage) is part of its acceptance test — a guard that has never fired is a
guard that does not work.

## Sibling sweep — every read path, its shape, its verdict

Verdicts: **bounded** = cost independent of history size, or indexed to the rows it
returns; **linear-rare** = full scan but only on real change, cost named; **fixed**.

| path | shape | verdict |
|---|---|---|
| `unresolvedContextUris` (per-sync) | was `SCAN plays`+probes every call | **fixed** → bounded (≤50 indexed rows) |
| `recomputeOrphanFlags({newOnly})` | was `SCAN plays` per landing tick | **fixed** → bounded (partial index) |
| `recomputeAllTimeStats` | full plays scan + tracks probes (~14.4K) | **fixed** → throttled 10 min; linear growth remains, queued lever: incremental accumulator |
| `recomputeOrphanFlags({})` full pass | predicate over every play × its playlist's members ≈ **1.3M+ rows** | linear-rare: only on a playlist-list rewrite (`library_seq` = 5 lifetime). A landmine if that path ever runs hot — the change-probe in `storePlaylists` is what keeps it cold |
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
| `storePlaylists` change-probe | 180-row scan hourly | bounded (table is the playlist list) |
| `recomputeUniqueSongCount` | DISTINCT over playlist_tracks + probes ≈ 30K | linear-rare: only when the library actually changed |
| meta reads (tokens, locks, seq, stamps) | single-key indexed | bounded |
| `api_log` writes/reads | indexed, 1 h TTL | bounded |

## Measurement outcomes

- **W0 (pre-fix, dirty):** never got a clean window — deliberately traded for cap safety.
  The platform API (token, Aug 6 10:48 PM) put the counter at **455,169,706 (91.0%)**:
  +26.66M over the 8.93 h since the 1:52 PM dashboard reading ≈ **2.99M/h** — an evening
  of open-tab listening plus the search-feature deploy, vs the model's 0.5–1.0M/h
  closed-app + ~1.7M/h open-tab. The ~1.4× gap is consistent with the index-entry
  calibration unknown; at that pace the cap was ~15 h away when the fix deployed.
- **W1 (post-fix, overnight Aug 6→7): +17.53M by 5:15 AM — fails the naive bar, and the
  mechanism is NOT a surviving scan.** The split, from the readings + DB markers:
  - **W1a (dirty):** the counter climbed at ~2.7M/h average until some point before
    5:15 AM. Last play recorded 12:58 AM; at ~5:26 AM Spotify rate-banned the app
    (`spotify_cooldown_until` = 9:04 AM ET — a ~3.6 h Retry-After). The only mechanism
    at that scale: **an already-open tab keeps its old client and, via Vercel's skew
    protection, keeps invoking the OLD deployment's pre-fix server actions** — a deploy
    does not reach an open tab until it reloads. The same stale-tab hammering is the
    plausible trigger of the Spotify ban. Multiplier beyond the modeled ~1.7M/h
    unexplained — possibly several stale tabs/devices. [UNVERIFIED beyond the markers]
  - **W1b:** 5:15→8:51 AM: **+1,168 rows total** — but ticks were short-circuiting on
    the cooldown (~2 rows each), so this proves the skip path only, not the fix.
  - **W1c (the clean test):** pre-registered 9:20 AM→1:20 PM, cooldown lifted, normal
    ticks on the new code. Prediction **≤0.1M** (30 ticks/h × ~100–160 rows + margin);
    if Rem uses the app on the NEW build add ~0.1M/h; **>1M = investigate a survivor.**
  - **Loss check during the 5:26–9:04 AM sync outage: zero.** The Zenbook backstop's
    last captured play (12:58 AM) matches the primary's exactly; timer alive (last run
    8:45 AM). Property 2 held through its first real incident.
  - Operational lesson, standing: **after any lazyboy deploy, close or reload every open
    lazyboy tab** — old tabs run pre-fix code indefinitely and bill accordingly.
- **W1c superseded by direct per-tick measurement (Aug 7, 11:50 AM–12:00 PM ET).** A 15 s
  counter-vs-tick timeline pinned the live costs: **steady tick = 159 rows** (the fix
  works — 99% below the pre-fix 14.25K), a landed-play tick with the 10-min-gated
  all-time recompute = ~14.8K (by design, ≤6/h while listening), and **~60K rows per
  landed play when the app is open** — the live-keyed rebuilds of the search payload +
  all-time list, which was the morning's ~2.1M/h (+5.16M, 9:20–11:47 AM, ~35 plays
  landed) and is what fix 5 (the slow marker) removes. Rem reports no tab was open
  overnight; the stale-tab attribution for W1a is **withdrawn to UNVERIFIED** — after
  subtracting his listening until 12:58 AM, several million of the overnight +17.5M
  remain unattributed, possibly counter-lag/batching around the Turso instance migration
  (all usage accrues on a new instance since Aug 6 afternoon; the old one is frozen at
  428.39M). The forward-looking truth is the measured per-path costs above, not the
  overnight aggregate.
- **Guard acceptance:** fired on the real condition Aug 6 10:52 PM — HTTP 500 naming
  `rows_read` (91.04%) and `bytes_synced` (75.15%) as breached, exact same code path
  prod runs (local `next start`, real platform API). Prod redeployed with
  `TURSO_PLATFORM_TOKEN` + `TURSO_ORG` minutes later.
