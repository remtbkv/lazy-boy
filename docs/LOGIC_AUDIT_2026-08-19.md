# Logic audit — 2026-08-19

Whole-app pass hunting the phantom-play bug class: guards that check proxies, timestamps
stamped at processing time instead of observation time, caches consulted without age/version
checks, state assumed to survive lifetimes it doesn't, reconciliation that double-counts or
drops. Method: seven evidence-only collectors (banned from verdicts) inventoried every
invariant in their subsystem with quoted code; every finding below was adjudicated centrally,
and items marked CONFIRMED were re-verified against the source by the judge. Nothing here has
been fixed yet — this is the review list.

Verdicts: **CONFIRMED** (judge re-read the code), **LIKELY** (collector trace sound, quoted
code checks out, not independently re-executed), **REVIEW** (works as coded; whether it's the
intended behavior is Rem's call), **NOTE** (hygiene/dead code).

---

## Tier 1 — the phantom class and data correctness (fix first)

**T1.1 CONFIRMED — the phantom-play vector is still open via BroadcastChannel.**
The Aug 19 fix age-gated only the localStorage seed. The leader's `request` answer
(`now-playing-context.tsx:378-386`) ships `playingRef.current` with `at: lastAppliedAt.current`
and no age bound, and `applyShared` (:228-233) checks suppression + monotonicity only — a fresh
tab (`lastAppliedAt = 0`) accepts anything. Sequence: leader tab hidden since 9 AM holding song
X; new tab opens at noon → request → leader answers with the 9 AM state → den-home writes
`lastPlayingRef` with `seenAt = Date.now()` → first live poll returns a different song →
`finish(X)` passes every guard → phantom play stamped noon. Same laundering, sibling path.

**T1.2 CONFIRMED — paused counts as playing, twice.**
(a) `currentlyPlaying()` returns a truthy state for a *paused* device (`resources.ts:275-283`,
`isPlaying` carried but not consulted by callers). The cron gate does `!!(...)`
(`cron/sync/route.ts:81-83`), so a desktop client left paused sustains recently-played harvests
every 2 minutes indefinitely — the exact quota pressure the gate was built to stop.
(b) In den-home, the same-song branch re-stamps `seenAt = Date.now()` every 6s **while paused**
(:890-893) — pause song X at 80% at 9 PM, play song Y at 12:30 AM → `finish(X)` sees a 6s gap
→ mints a play 3.5 hours late, possibly on the wrong day. A second live phantom vector.

**T1.3 CONFIRMED — the harvest gate's "session tail" branch is unreachable.**
Both stamps use the same `now` (`cron/sync/route.ts:79,84,93`), so after any playing+harvested
tick `lastActive === lastHarvest` and `lastActive > lastHarvest` is never true. The final plays
of every session wait for the hourly backstop instead of the intended next-tick harvest.
Delay-only (the 50-play buffer covers loss), but the branch's reason for existing never fires.

**T1.4 CONFIRMED — skip verdicts are invisible to the cache fence.**
`recordPlays` bumps `write_seq` inside the batch (db.ts:527) *before* `recomputeSkipFlags`
writes verdicts (:543), and the recompute itself never bumps (contrast `recomputeOrphanFlags`
:731). A read sampling the new seq in that window caches pre-verdict rows under the new key for
up to `LIVE_TTL_S` = 1h. Violates the file's own rule (db.ts:337-355).

**T1.5 CONFIRMED — the derived-value verifier verifies nothing.**
`scripts/verify-derived.mjs` `PLAYS_ORDERED_SQL` (:39-43) has drifted: no `NOT_BACKFILL`, no
`skipped` — its all-time check compares filtered stored values against an unfiltered
recomputation (its `since` would read as the 2026-05-30 backfill sentinel). Always-fails ≠
verifier, per its own preamble.

**T1.6 LIKELY — skip verdicts are never re-adjudicated; out-of-order inserts poison them.**
`recomputeSkipFlags` anchors at MIN(pending) and skips already-verdicted rows
(db.ts:765,779), so a late-arriving older play (gap-filling harvest, backstop replay) leaves
its predecessor's verdict measured against a successor that is no longer adjacent —
permanently. `backfill-from-backstop.mjs` also inserts `skipped = NULL` and never recomputes:
replayed rows count as listened until an unrelated sync runs, and the next recompute walks
every play from the oldest replayed row to now (unbounded pass).

**T1.7 LIKELY — "frozen day" is contradicted by two of its own writers.**
`playsByDayFrozen` is keyed (day, offset) with no seq and a 24h TTL (db.ts:1138-1152); the
backstop replay's comment claims its write_seq bump "invalidates both" (script :101-103) —
false for frozen days. And the client persists past days to `sessionStorage["lb-days"]` with no
age, no version, no seq (den-home.tsx:402-433), surviving even build-skew reloads — while the
server's own frozen cache keeps a TTL *because* `source`/`ctx_orphan`/`skipped` can be
rewritten (db.ts:923-927). Same class as the phantom cache.

**T1.8 CONFIRMED-BY-QUOTE — metrics have no observation time.**
Events carry no client timestamp; the store stamps insert time per batch (db.ts recordClientMetrics),
and the only scheduled flush is one 10s setTimeout per tab — everything after sits until
pagehide. Every "open at" and error time after a tab's first 10 seconds is the pagehide
instant (an 8-hour sitting renders all its opens at one minute). Plus `MAX_BUFFER = 200`
silently drops the tail of long sittings — first casualty is the `handoff` breadcrumbs added to
diagnose phantoms, on exactly the long sessions that need them. A dropped `pageview` also makes
an open vanish while its samples still pollute percentiles.

**T1.9 LIKELY — provisional reconciliation both drops and double-counts.**
(a) Confirmation is existential over per-song aggregates: any server row of the same song with
`lastPlayed >= mint - 90s` confirms — a repeat play within the window is silently dropped
(repeat-one under-counts). (b) While searching or on a past day the server returns
`tracks: null` and the reconcile runs against `[]`, where nothing confirms — today's card
renders server-count + N provisionals for their whole 5-min TTL (over-count). (c) On the
"all" view the universe is the all-time top-300 (wrong in both directions). (d) `doRefresh`
has no concurrency guard: two overlapping runs can resurrect provisionals the other confirmed.
(optimistic-play.ts:59-80; den-home.tsx:729-790)

**T1.10 CONFIRMED (census) — the persisted rate-limit cooldown is consulted almost nowhere.**
Readers: history sync, library-scan kick, home-page notice. Non-readers include the cron's own
player probe, the cron library rescan (bypasses `startLibrarySync`), now-playing polls,
playlist detail/resync, every `action:*` path. Compounding: the persist write is `void`-ed
right before `return` (client.ts:150-151 — Vercel can freeze the invocation before it lands);
`setSpotifyCooldownUntil` is a plain overwrite so a later shorter ban shortens a longer one;
patient callers sleep `min(cooldown, 30s)` then send anyway — one poke per 30s through a
multi-hour ban ("one probe per 30min" comment is not what the code does).

---

## Tier 2 — correctness, narrower blast radius

**T2.1 LIKELY — un-debounced Spotify harvest per track change from the open tab.**
`refreshHistoryAction` checks no debounce/gate; den-home fires it on every `nowPlayingId`
change + again 4s later + every visibilitychange + every 120s. ~2 recently-played calls per
track while Home is open — real pressure on the daily-quota endpoint the cron gate protects.

**T2.2 LIKELY — Home's all-time card can lag a day.** The daily cron heal recomputes
`alltime_stats`, but Home renders the copy embedded in `home_payload`, which only rebuilds when
a play lands. Also `alltime_stats` depends on `tracks.duration_ms`, which library syncs rewrite
without recompute (NULL-duration plays count as the 10-min fallback until healed).

**T2.3 LIKELY — `unique_song_count` goes stale invisibly.** Recompute is triggered only by
`syncLibrary`'s own snapshot diff; playlist deletes, `removeCachedPlaylistTrack`, and every
out-of-band `storePlaylistTracks` (playlist page, tracks route, clean) change the DISTINCT set
without recomputing — and by writing the current snapshot they suppress the next recompute too.

**T2.4 LIKELY — search-payload version falls back to `"0"` on any store error**
(`?? "0"`), minting ETag + `unstable_cache` entries under key "0" that can serve stale bodies
for 24h. Related: track-metadata changes on the play path never bump `library_seq`; the
"UTC day bucket backstop" exists only in the ETag, not the body cache key.

**T2.5 LIKELY — history-patch identity and boundary defects.** Dedupe keys on *track index*
(docstring says identity) — payloads carry 18 identities under two ids, so overlapping deltas
can duplicate plays; the delta filter is strictly `>` at minute resolution, so a missing play
sharing its minute with the client's newest is dropped for the whole visit; two real plays of
one song in one minute collapse.

**T2.6 LIKELY — `entries = []` treated as a usable search index.** A 200 with an empty
payload (cold index, shape-token miss) makes every search render "No songs match" for the rest
of the visit, with no fallback scheduled — the answered/failed distinction the file draws
elsewhere is not drawn here. Similarly `fromMemory`'s `newest` (newest play ≠ today) silently
degrades yesterday+today to the server path after a quiet day.

**T2.7 LIKELY — "See all" replaces the live strip with a mount-time snapshot.**
`allDailyPromise` is memoized at mount and never merged with live updates: press the chevron
after an hour and today's card reverts to its mount-time count.

**T2.8 LIKELY — error.tsx auto-reload guard measures the wrong interval.** The stamp is
written at reload *initiation* and compared to the *next failure's arrival*: a failure that
takes >10s to fail (store/funnel timeout — the motivating case) reloads forever at ~timeout
period. And `isAuthError` message-matches text that prod's generic RSC error never contains, so
auth failures take the reload path. Also the error beacon requires `auth()` — the report fired
*because* the session expired gets 401 and is silently dropped.

**T2.9 LIKELY — library scan failure storm.** `library_synced_at` is stamped only on
completion, so a scan that throws is retried by the cron every 2 minutes — unpaced (the cron
path passes no `paceMs`), patient (won't fail fast), unlocked (the `currentSyncId` collapse is
per-instance and the cron bypasses it), while `playlists_synced_at` (stamped at scan *start*)
tells the client fallback everything is fresh. Two clocks, opposite conclusions.

**T2.10 LIKELY — in-memory task registry vs serverless.** `/api/tasks/[id]` 404s on any
instance that didn't run the task: the cold-start watcher dies on its first poll (empty grid
stays empty); `runTask`'s detached promise runs after the response returns, where Vercel may
freeze it (no `waitUntil`). `currentSyncId` is per-instance, so concurrent kicks each start a
full scan.

**T2.11 LIKELY — retry ladder contradictions (Spotify client).** "Fail fast" worst case ≈61s
per call (sleeps + 4×10s timeouts); cooldown set from the *capped* value (5s for a 60s ask;
hard-ban persistence only >120s; `Retry-After: 0`/HTTP-date parses to null → 1s and never
hard-ban); non-idempotent PUTs (play/seek) retried after timeout; 200-with-garbage → `undefined
as T` → TypeError instead of SpotifyError; `getAll` has no loop cap and per-page budgets.

**T2.12 LIKELY — saveQueue's inner sentinel loop has no cap or deadline.** Repeat-one on the
device spins it forever at 1-2 calls/150ms plus a forced track-skip every 1.5s — a runaway-call
generator of exactly the kind that triggers penalties. Its ~1-2min normal runtime also exceeds
the 60s token-freshness margin with no mid-operation refresh (string token).

**T2.13 LIKELY — auth seams.** Transient refresh failure leaves `session.error` unset, so
`!session.error` gates hand out a dead stored token; the refresh-lock numbers don't nest
(TTL 15s vs 10s wait → premature unilateral refresh with the *original* token — the PKCE
collision the lock exists to prevent); unguarded `res.json()` can throw a SyntaxError that
skips the RefreshError classification; the initial-sign-in DB-failure path puts live tokens
back into the JWT cookie.

**T2.14 LIKELY — negative context cache starvation + poll cost.** The now-playing route never
writes negative rows (only successes), so a never-cached 403 context costs ~2 forbidden Spotify
calls per 6s poll until a gated sync happens to carry the URI; the daily full pass is capped at
20 URIs but stamps the 24h marker even when truncated.

**T2.15 LIKELY — multi-tab chip starvation + skew-clearing laundering.** Leadership is held
for tab lifetime and every poll trigger is gated on the *leader's* visibility — a visible
follower can't self-rescue, so its chip freezes while the leader is hidden (idle leader arms
nothing at all). Undated build ids are replayed as "authoritative" on visibilitychange and on
every follower state message — a pre-deploy match can clear a genuine skew streak indefinitely
if the 5-min probe is failing; the reload throttle stamp is origin-wide while streaks are
per-tab (k stale tabs drain serially).

**T2.16 LIKELY — metrics attribution defects** (beyond T1.8): soft-nav marks record as exact
0 (children's effects run before `setPage` resets `viewStart`) and pool with real values;
marks are attributed to whatever page is current at observer-callback time (now-playing-ready
can land on the wrong page); `pendingNav` never expires (a same-page click arms it; minutes of
idle later reported as nav-ms); visit-ms double-counts across bfcache (no reset in pagehide, no
pageshow handler); CLS/INP report on visibilitychange which fires *after* the pagehide flush →
lost for never-hidden visits; `MAX_ERRORS` is per-tab (comment says per view) so after 5 errors
the tab reports zero forever; `server-error` rows are written but surfaced nowhere on /usage
(and mint blank page rows); `client_metrics` has no prune at all.

**T2.17 LIKELY — api_log retention is an accident of instance reuse.** The prune counter is
module-scoped (fires only when one warm instance serves 256 calls): retention is unpredictable
— unbounded growth or deletion of the ban history the quota table exists to compare against
(7-day TTL vs "compare every past exhaustion point" is a design contradiction as-is). The quota
scan is unbounded with no path index; the fixed UTC anchor drifts ~1min/day and shifts an hour
at DST.

**T2.18 LIKELY — slowSeq publish race.** A loser can publish a *lower* seq with a *newer*
timestamp; the next 10 minutes serve the superseded key ("never a wrong answer" comment does
not hold for that interleaving).

**T2.19 LIKELY — same-minute play resolution.** The history payload floors plays to the
minute; `patchHistoryPayload` and the delta query both key on it — two plays of one song within
a minute are structurally unrepresentable in the client payload (server rows keep both).

**T2.20 LIKELY — day-bucket offset split.** The home payload buckets in fixed
America/New_York; every later read uses the tz cookie (0 = UTC when absent, first render);
client `buildDays` uses the live runtime offset; `dayLabel` uses per-instant local date;
`scopeDay` hard-codes 1440-minute days. All agree in steady-state NY; they diverge on
missing-cookie renders, DST transition days, and travel.

---

## Tier 3 — Rem's call / hygiene / dead code

- **REVIEW** Resume ignores the skip filter (a skipped play advances the resume point) — defensible either way.
- **REVIEW** All-time card excludes backfill; the per-song all-time list includes it (documented-intended; surface inconsistency).
- **REVIEW** Chip's paused-state display semantics: `/me/player` fallback shows a device paused hours ago as current, no age bound ("never stale" comment vs implementation).
- **REVIEW** Playlist tracks route trusts the client-supplied snapshot for its `changed:false` skip; echoes Spotify's raw error text to the browser.
- **REVIEW** Phone rows come from the payload, so provisionals/freshKey flash never show on phone; phone ignores the sort; scroll fade computed from the other row set.
- **REVIEW** `/api/sync` debounce measures "did anything sync recently" (any writer stamps `last_sync`), not "did this path"; stamp skipped when a harvest yields zero rows.
- **NOTE** `clean_backup_pref` has **no writer anywhere** — the persisted preference is unreachable (always defaults on).
- **NOTE** dead/unread: `hasPlaysBeforeDay` (0 callers), `pltracks_at:<id>` meta (written+purged, never read), `QuotaWindow.banRetryAfterS` + `SpotifyCallSource.lastTs` (computed, never rendered), `MetricStat.n` (never rendered — a p50 over n=1 looks like one over n=500).
- **NOTE** /usage "errors" column includes 429s which are also the "429s" column (subset rendered as peer).
- **NOTE** suppressed-by-cooldown requests never reach api_log (invisible to the diagnostics); hard-ban persistence logs nothing.
- **NOTE** `verdict()` telemetry logs the re-stamped `seenAt` gap, so a T1.1/T1.2 phantom records `commit|gap=6s` — indistinguishable from healthy. Fixing T1.1/T1.2 should carry the observation time into the beacon.
- **NOTE** skip-bar client proxy measures max *observed position* (seek-forward passes; sparse polling fails everything) vs the store's min(gap, duration); `0.35` duplicated without a shared constant.
- **NOTE** `freshKey` timeout uncleared on unmount; `days<=100000` produces a negative-year ISO cutoff that works lexicographically by accident; `grandTotal` seeds liked as 1 (progress >100% possible); ledger misses several real readers (usage-page scans, getContextName per poll) — standing residual term.

---

## Provenance

Collector inventories (full evidence, ~90 raw items): session task outputs, 2026-08-19.
Judge ledger with per-item verdicts: adjudicated same day. CONFIRMED items were re-read in
source by the judge; LIKELY items rest on quoted code that was spot-checked but not executed;
nothing was verified at runtime. No live-store queries were made by collectors; data-dependent
claims (e.g. whether duplicate-id play pairs exist today) are code-path claims only.

---

## Outcome addendum (same day)

**Wave 1 (commit `50fb542`):** all Tier-1 items and ~15 Tier-2 items fixed and deployed.

**Wave 2 (commit `5bd709d`):** a second collector sweep covered everything wave 1 didn't
fully read (actions/clean pipelines, den-home render/search, db internals + ledger,
components), plus an adversarial review of the wave-1 diff itself. That review confirmed
three regressions wave 1 introduced (predecessor reset mistargeted and firing every tick;
`>=` harvest gate re-poking every 2 min under a persistently-throwing harvest; empty
Retry-After parsing as retry-in-250ms) — all three fixed in wave 2 along with ~25 new
findings, the largest being the clean pipeline's name-based self-exclusion (a rename or
name clamp could make the reconcile EMPTY the cleaned playlist it had just made) and the
sparse-position bug in the playlist-tracks cache (a single-track removal made later
writes silently drop a cached row).

**Still open (documented, not fixed — needs Rem or is accepted):**
- Tier-3 REVIEW items (resume-counts-skips semantics, all-time backfill list inclusion,
  paused-chip display, playlist route snapshot trust).
- ASCII-only SQL `lower()` vs JS `toLowerCase()`: non-ASCII artists ("Björk") can be
  orphan-flagged while the payload counts them as members — fixing means normalizing at
  write time (migration); parked.
- Ledger cost-model drift (wave-2 collector E1–E10): the models understate post-audit
  query shapes; the platform half is dormant (self-hosted store), so the residual has no
  right-hand side today. Re-calibrate if Turso ever comes back.
- Task registry is per-instance (ROADMAP Phase 3 seam); mitigations (after(), poll
  tolerance, blind-refresh caps) are in, the real fix is a store-backed registry.
- Same-song-same-minute plays are structurally unrepresentable in the minute-floored
  client payload; server rows keep both.
- clean_backup_pref still has no writer (the persisted preference is unreachable).
