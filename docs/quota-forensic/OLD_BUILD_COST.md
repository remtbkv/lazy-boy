# The old-build tab's per-cycle cost: bottom-up arithmetic, not vibes

Question: does an idle tab pinned (Vercel skew protection) to a pre-fix build actually cost
~42.5K rows_read/min (2.55M/h, flat, Aug 7 10:00 AM – Aug 8 1:00 AM ET, and similar on prior
days)? Method: read the ACTUAL pre-fix source at the two candidate commit boundaries, trace
every DB call one idle refresh cycle makes, sum against `docs/READ_QUOTA.md`'s measured
per-query costs, and report whether the sum lands in range. All code cited below was read via
`git show <commit>:<path>` — nothing was checked out.

## Commit-era map

```
37af0ea  Aug 1 11:58  stores ctx_orphan (ends per-row correlated-subquery "From")
...
7728b3e  Aug 5 07:27  ← Build A: last commit before day/all-time caching
1852d76  Aug 5 07:38  adds unstable_cache (write_seq-keyed) to day-strip/per-day/all-time/playlists
...
13515d8  Aug 6 14:59  ← Build B: last commit before the row-cost fixes
6b8b1e6  Aug 6 16:36  bounded context resolution, partial orphan index, throttled all-time
                       (deployed ~11 PM ET per prior attribution — commit time ≠ deploy time)
16fb33d  Aug 6 16:36  usage guard (paired deploy with 6b8b1e6)
3d1e5f3  Aug 7 12:00  slow-marker keying for history/all-time payload rebuilds
```

The burner tab predates 6b8b1e6/16fb33d and was open by Aug 6, plausibly Aug 5 — that window
straddles 1852d76 (Aug 5, 7:38 AM), so two builds are plausible pins:

- **Build A** (≤ 7728b3e): day-strip, per-day and all-time reads are **uncached** — every
  refresh re-runs the full query.
- **Build B** (1852d76 – 13515d8): those same reads are wrapped in `unstable_cache` keyed on
  `meta.write_seq`. Confirmed by reading both versions of `src/lib/db.ts`: Build A has no
  `unstable_cache` import at all (`grep unstable_cache` on the Build A file: zero hits); Build B
  has it wired to `getDailyStats`/`getAllTimePlays`/`getPlaysByDay`.

Both builds share the code that matters most (`refreshHistoryAction` in
`src/app/(app)/history-actions.ts`, `syncRecentPlays` in `src/lib/sync/history.ts`,
`unresolvedContextUris` in `src/lib/db.ts`) unchanged since 37af0ea — verified by diffing
Build A's and Build B's `src/app/api/sync/route.ts` and `src/components/sync-on-load.tsx`
(byte-identical).

## What one idle refresh cycle does (no plays landing — the "flat" rate rules out a
## listening session, which would be bursty, not constant)

Two independent 120 s timers both call `syncRecentPlays`, unconditionally, every tick:

1. **`den-home.tsx`'s `setInterval(doRefresh, 120_000)`** → `refreshHistoryAction(want, days)`
   → `syncRecentPlays(sp)`, then `getDailyStats` + `getAllTimeStats` (parallel), then
   `getPlaysByDay`/`getAllTimePlays` depending on the client's `want` (default state,
   `followingLatest`, resolves to `"latest"` unless the tab was left on the All-time view or
   mid-search). Confirmed at `src/app/(app)/history-actions.ts:112-146` (both builds, identical).
2. **`sync-on-load.tsx`'s `setInterval(sync, 120_000)`** (gated on
   `document.visibilityState === "visible"`, true for a non-minimized background window) → POST
   `/api/sync` → `syncRecentPlays(sp)` only. The route's `STALE_MS = 60_000` debounce does not
   suppress this call — the client's 120 s cadence already exceeds the 60 s stale window, so
   every tick executes for real (`src/app/api/sync/route.ts:11-24`, identical both builds).

`syncRecentPlays` (`src/lib/sync/history.ts:18-68`, identical both builds) is unconditional:
`recordPlays(rows)` then `(await unresolvedContextUris()).slice(0,20)` — the context-resolution
pass runs on **every** call, not gated on whether anything new landed.

`/api/now-playing` polls every 6 s (`src/app/api/now-playing/route.ts`, identical both builds):
Spotify call (not billed to Turso) + `getContextName` (1 indexed row, cache hit once contexts
are resolved, which they are on a stale tab that's been running for days).

## Per-cycle cost table (one 120 s tick)

| term | cost | calls/cycle | provenance |
|---|---|---|---|
| `unresolvedContextUris()` | 14,145 rows (7,194 plays scanned + 6,951 context probes) | 2 (refresh + on-load sync) | `src/lib/db.ts:680`, both builds identical; cost = READ_QUOTA.md "Attribution" table + Aug 6 store-size line (7,194 plays, 6,951 with a context) |
| `recordPlays` diff reads (cached-tracks + existing-plays range read) | ~120 rows | 2 | READ_QUOTA.md Attribution table; `src/lib/db.ts:574-649`, identical both builds |
| `getDailyStats` (16-day bounded window, `idx_plays_played_at` seek) | ~1,700 rows | 1 (refresh only) | READ_QUOTA.md sibling-sweep "day strip window ~1.7K"; query itself unchanged, `src/lib/db.ts:897` (Build A) — **Build A: runs uncached, every call. Build B: cache HIT (~0) while `write_seq` is unmoved, which it is when idle** |
| `getPlaysByDay` (day view, `want="latest"` default) | ~7,194 rows (full `plays` scan — `date()` predicate can't use `idx_plays_played_at`) | 1 (refresh only) | 1852d76 commit message: "one day's ~90 rows cost a scan of all 6,995"; query at `src/lib/db.ts:961` (Build A) — **Build A: uncached, every call. Build B: cache HIT (~0) while idle** |
| `getAllTimePlays` (alt: tab pinned on All-time view instead of a day) | ~25,000 rows | 1 (refresh only, replaces the row above) | READ_QUOTA.md sibling-sweep "readAllTimePlays … ≈25K" |
| `getAllTimeStats` | ~1 row (meta-key read, same mechanism both eras — not gated on `write_seq`) | 1 | `src/lib/db.ts:842-860`, identical both builds |
| `/api/now-playing` → `getContextName` | ~1 row | 20 (6 s × 20 = 120 s) | `src/app/api/now-playing/route.ts`, identical both builds |

## Rows/minute totals

- **Build B (cached, 1852d76–13515d8), idle:** 2×14,145 + 2×120 + ~0 + ~0 + 1 + 20×1 ≈
  **28,551/cycle → 856.5K/h → 14.3K/min**
- **Build A (uncached, ≤7728b3e), idle, `want="latest"`:** 2×14,145 + 2×120 + 1,700 + 7,194 + 1
  + 20 ≈ **37,445/cycle → 1.12M/h → 18.7K/min**
- **Build A, idle, `want="all"`:** 2×14,145 + 2×120 + 1,700 + 25,000 + 1 + 20 ≈
  **55,251/cycle → 1.66M/h → 27.6K/min**

Target: **42.5K/min (2.55M/h).** None of the three modeled scenarios reach it. The closest —
Build A pinned on the All-time view — lands at **27.6K/min, ≈65% of the observed rate.**
`unresolvedContextUris` is the single largest and most certain term in every scenario: 28,290 of
the ≥28,551-row cycle floor (>99% of Build B's total, ~76% of Build A's), consistent with
READ_QUOTA.md's own finding that it dominates "at any plausible calibration."

## What doesn't fit

The arithmetic does **not** clearly land in 35–50K/min under the base assumption that Turso
bills one row per table row scanned. The gap (target ÷ best model ≈ 1.5×) has three named,
unverified candidates, in order of how much of the gap each could plausibly close:

1. **Turso may bill index-entry touches separately from table-row scans.** READ_QUOTA.md
   already flags this as an open, uncalibrated ~1.4–2× unknown (its own W0 window ran ~1.4×
   over the model for the same reason). Applied uniformly to the closest scenario (Build A,
   "all" view, 27.6K/min), 1.4–2× lands at **38.6–55.2K/min** — squarely in or above the target
   band. This is the leading candidate, but it is exactly as unverified here as it was in
   READ_QUOTA.md; nothing in this pass measured it directly.
2. **A second concurrent stale source.** READ_QUOTA.md's own W1a entry records an unresolved
   ~1.4×+ gap with the identical shape ("possibly several stale tabs/devices... [UNVERIFIED
   beyond the markers]") — this investigation did not rule out a second pinned session (another
   tab, another device) contributing its own independent 120 s cycles alongside the one
   attributed here.
3. **A wider `days` window.** If the session had expanded the day strip before going stale,
   `getDailyStats`'s bound grows toward the ~67-day span of the whole store, pushing that term
   from ~1.7K toward something closer to the ~7K `getPlaysByDay` figure — worth a few thousand
   rows/cycle, not enough alone to close a ~900K/h gap.

Not a candidate: real plays landing on this tab. A flat, constant rate across 15+ hours rules
out a listening session (which would show as bursts tied to song timing), and even if genuine
new plays existed, `recordPlays`'s existing-play dedup means whichever session (cron, a live
session, this tab) recorded a play first would make every other session's `recordPlays` on the
same play a no-op (`added = 0`) — the expensive landing-tick-only terms
(`recomputeOrphanFlags`/`recomputeAllTimeStats`) would not fire on this tab regardless.

## Rows written/hour — idle tab, old build

Per idle cycle: `syncRecentPlays`'s `sp.recentlyPlayed(50)` call is NOT the excluded
`/me/player/currently-playing` endpoint, so it logs unconditionally
(`logSpotifyRequest`, `src/lib/db.ts:1587-1615`, identical both builds) — 1 `api_log` INSERT.
`recordPlays` always stamps `last_sync` (`src/lib/db.ts:628-632`) — 1 more write, even when
nothing new landed. `/api/now-playing`'s successful polls are explicitly excluded from
`api_log` (`db.ts:1606-1608`, "each log row costs 2 billed Turso row writes... for no
diagnostic value" — this guard predates both candidate builds) — **0 writes** from the 6 s
poll.

- 2 sync calls/cycle (refresh + on-load) × (1 `api_log` insert + 1 `last_sync` stamp) = 4
  writes/cycle → **120 writes/h**, before `pruneApiLog`.
- `pruneApiLog` fires every 256th `api_log` write on a given warm instance
  (`apiLogWrites % 256 === 0`, `db.ts:1614`) and deletes ~1 hour's worth of accumulated rows in
  one `DELETE` — bursty, shared across whatever else is writing `api_log` on the same instance,
  and not cleanly attributable to this tab alone; not added to the total below.

**Modeled: ~120 writes/h from this tab alone — well below the observed ~700-970/h.** This
doesn't fit as "the idle tab explains the writes": either the observed total is dominated by a
different source (the cron tick's own sync calls, or genuine active-session traffic, neither
modeled here — this analysis only traces the one tab), or a write path this pass didn't trace
(token-refresh writes are hourly and small, checked and ruled out as a material contributor).
No mechanism was found that would lift this tab's own write footprint into the observed range —
that gap is reported, not closed.
