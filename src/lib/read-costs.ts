// The MODELED rows-read cost of every named read path, in one place.
//
// Why this file exists: Turso bills rows SCANNED and reports one counter per organization.
// That counter cannot say which read path spent it, which is how August 2026 reached 86% of
// the 500M monthly cap before anything was attributed (docs/READ_QUOTA.md). The ledger
// (`usage_ledger`, src/lib/db.ts) closes that gap by having each path record what it models
// itself to cost as it runs, and /api/cron/usage-check diffs a day's ledger against the
// platform counter — so the UNEXPLAINED part of the burn is a number on /usage instead of a
// surprise on a dashboard.
//
// EVERY FIGURE HERE IS A MODEL, not a measurement of the call that just ran. Each one states
// what it was calibrated against and when. Two consequences, stated rather than buried:
//   • The linear terms drift as the store grows. They take the size as a parameter for
//     exactly that reason; the defaults are the calibration store, not a constant of nature.
//   • A path whose SQL or query plan changes silently invalidates its constant here. Nothing
//     detects that locally — the reconciliation residual is what catches it, as a widening
//     gap against the platform counter.
//
// Deliberately dependency-free: scripts/test-ledger.mjs imports this file directly (Node 24
// strips the types), so the math the tests exercise is the math that ships. Keep it that way
// — no `import`, no `server-only`, no path aliases.

// ── Calibration ─────────────────────────────────────────────────────────────────────────
/** The store every figure below was calibrated against: docs/READ_QUOTA.md "State when this
 *  was written", 2026-08-06 — 7,194 plays (6,951 of them carrying a playback context),
 *  15,019 tracks, 15,327 playlist_tracks rows, 180 playlists. Used as the fallback size when
 *  a caller cannot cheaply learn the current one; a modeled cost must never block on a scan
 *  to find out how big the table is. */
export const CALIBRATION = {
  plays: 7_194,
  contextedPlays: 6_951,
  tracks: 15_019,
  libraryMembers: 15_327,
  playlists: 180,
} as const;

/** Plays land at roughly this rate, from the same reading (67 days of history, ~90 rows on a
 *  typical day). Only used as the default window size for the day-scoped reads. */
export const TYPICAL_PLAYS_PER_DAY = 90;

/** A read that walks a table and probes a second one per row bills both: the scan row and
 *  the index probe. Turso counts index entries the same way it counts table rows, which is
 *  the single biggest unknown in this model (docs/READ_QUOTA.md calls it "the index-entry
 *  calibration unknown" — the pre-fix model came in ~1.4× low against the real counter). */
const SCAN_PLUS_PROBE = 2;

// ── The sync path ───────────────────────────────────────────────────────────────────────

/** One sync call that lands nothing — the steady-state cron tick, the open tab's poll, and
 *  the on-load POST when the debounce lets it through.
 *
 *  MEASURED, not modeled: 159 rows, from the 15-second counter-vs-tick timeline run against
 *  the live counter on 2026-08-07 11:50 AM–12:00 PM ET (docs/READ_QUOTA.md, "Measurement
 *  outcomes"). Its parts — `unseenContexts` over ≤50 indexed URIs, `recordPlays`' cached-
 *  tracks and existing-plays probes (~120), a handful of single-key meta reads — sum to the
 *  same order, but the 159 is the observed figure and stays the constant. Pre-fix this same
 *  call was ~14.25K. */
export const STEADY_SYNC_TICK_ROWS = 159;

/** `recomputeOrphanFlags({newOnly})` after a landing tick. The partial index
 *  `idx_plays_orphan_null` holds only unverdicted rows, so the scan is the incoming batch,
 *  which Spotify caps at 50. Modeled from the plan (docs/READ_QUOTA.md fix 2), not measured
 *  on its own. */
export const ORPHAN_NEW_ONLY_ROWS = 50;

/** `recomputeAllTimeStats` → `playsWithListened`: an ordered full scan of `plays` with a
 *  `tracks` probe per row. ~14.4K at the calibration store — the figure the sibling sweep
 *  names. Grows linearly with history, which is why it is throttled to once per 10 minutes
 *  and why the queued lever is an incremental accumulator. */
export function allTimeRecomputeRows(plays: number = CALIBRATION.plays): number {
  return SCAN_PLUS_PROBE * plays;
}

/** One sync call that lands at least one play: the steady cost, the bounded orphan
 *  recompute, and the all-time recompute. ~14.6K modeled at the calibration store against
 *  ~14.8K measured for a landed-play tick on 2026-08-07 — the closest agreement in this file.
 *
 *  KNOWN BIAS: the all-time recompute is gated to once per 10 minutes
 *  (`ALLTIME_RECOMPUTE_MIN_MS` in db.ts), and the sync route cannot see whether the gate
 *  opened, so consecutive landed ticks inside one window are each charged the full recompute
 *  when only the first paid it. That OVERSTATES the ledger during a listening session, which
 *  shrinks the residual — the bias runs toward under-alarming, never toward a false alarm. */
export function landedSyncTickRows(plays: number = CALIBRATION.plays): number {
  return STEADY_SYNC_TICK_ROWS + ORPHAN_NEW_ONLY_ROWS + allTimeRecomputeRows(plays);
}

/** `refreshHistoryAction`'s own reads on top of the sync call it makes: the
 *  `searchHistory("", 1)` head check (one indexed row) and, only when the client's index is
 *  actually behind, up to 50 more delta rows. The strip / day / all-time reads it also
 *  triggers are ledgered under their OWN readers, so they are deliberately not counted here
 *  — including them would double-count them. */
export const HISTORY_REFRESH_EXTRA_ROWS = 5;

/** The once-a-day full context pass, `unresolvedContextUris()`: a full `plays` scan plus a
 *  `contexts` probe for every play that has a context. 7,194 + 6,951 ≈ 14.1K at calibration
 *  — the sibling sweep's figure for the pre-fix per-call cost, which now runs once daily. */
export function contextsFullPassRows(
  plays: number = CALIBRATION.plays,
  contextedPlays: number = CALIBRATION.contextedPlays,
): number {
  return plays + contextedPlays;
}

// ── The derived payloads and lists ──────────────────────────────────────────────────────

/** `readHistoryIndex` — the browser search payload's history half. A full `plays` scan with
 *  a `tracks` join and a `contexts` join, ≈3 billed rows per play: ~21.6K at calibration
 *  (sibling sweep). Runs once per slow-marker change, not once per play. */
export function historyPayloadRebuildRows(plays: number = CALIBRATION.plays): number {
  return 3 * plays;
}

/** `readAllTimePlays` — the all-time list. A full scan plus the per-track `source` subquery,
 *  ≈3.5 billed rows per play: ~25K at calibration (sibling sweep). Also slow-marker keyed. */
export function allTimeListRebuildRows(plays: number = CALIBRATION.plays): number {
  return 3.5 * plays;
}

/** `readLibraryIndex` — the search payload's library half. Driven from `playlist_tracks`
 *  (one seek per membership) with a `tracks` probe each, plus the saved-tracks and playlist
 *  lists: ~30K at calibration (sibling sweep). Keyed on `library_seq`, which has moved five
 *  times in the store's life. */
export function libraryPayloadRebuildRows(members: number = CALIBRATION.libraryMembers): number {
  return SCAN_PLUS_PROBE * members;
}

/** `recomputeUniqueSongCount` — DISTINCT (artist, title) over `playlist_tracks` joined to
 *  `tracks`: ~30K at calibration (sibling sweep). Only runs when a library sync actually
 *  changed something. */
export function uniqueSongCountRows(members: number = CALIBRATION.libraryMembers): number {
  return SCAN_PLUS_PROBE * members;
}

// ── The render-path reads ───────────────────────────────────────────────────────────────

/** `readPlaysByDay` — one local day. The redundant UTC range bound lets
 *  `idx_plays_played_at` seek the day's ~90 rows instead of scanning the table, and the
 *  `source` subquery probes once per output row. ~180 at the typical day size. A frozen day
 *  served from the cache costs zero and is never ledgered. */
export function dayPlaysRows(playsInDay: number = TYPICAL_PLAYS_PER_DAY): number {
  return SCAN_PLUS_PROBE * playsInDay;
}

/** `readDailyStats` — the day strip. An indexed window of (days + 2) days with a `tracks`
 *  probe per play: ~2.9K for the default 14-day strip at the typical day size (the sibling
 *  sweep quotes the scan half of that, "~1.7K + probes"). Bounded by the window, not by
 *  history. Callers that know the real row count should pass it. */
export function dailyStatsRows(windowPlays: number = 16 * TYPICAL_PLAYS_PER_DAY): number {
  return SCAN_PLUS_PROBE * windowPlays;
}

/** `searchHistory` with a query — the `LIKE '%q%'` fallback, unindexable by construction, so
 *  it scans `tracks`: ~15K at calibration. Only reachable while the browser payloads are in
 *  flight or after both failed (docs/GOTCHAS.md, "If a query is slow, count the rows it
 *  SCANS"). The empty-query branch is a bounded indexed head/delta read and is not this. */
export function searchHistoryLikeRows(tracks: number = CALIBRATION.tracks): number {
  return tracks;
}

/** `readStoredPlaylists` — the playlist grid, one row per playlist: ~180. Named for
 *  completeness and NOT instrumented: at 180 rows a handful of times a day it is below the
 *  noise floor of the residual it would feed. */
export function playlistGridRows(playlists: number = CALIBRATION.playlists): number {
  return playlists;
}

// ── The instrument's own cost ───────────────────────────────────────────────────────────

/** What one `ledgerAdd` costs: a primary-key probe plus the upsert. At the post-fix traffic
 *  of roughly 1,500 instrumented calls a day that is ~3K rows/day against a ~0.69M/day
 *  budget — the price of knowing where the rest went. Not itself ledgered: an instrument
 *  that measures itself never terminates. */
export const LEDGER_WRITE_ROWS = 2;

/** `/api/cron/usage-check`'s own DB cost: one bounded range read of the reconciled day (one
 *  row per reader, ~15) plus the two reconciliation upserts. The platform API calls are HTTP
 *  and cost no rows. */
export const USAGE_CHECK_ROWS = 30;

// ── Reconciliation ──────────────────────────────────────────────────────────────────────
// The residual is the whole point: platform_rows_read − Σ(ledger) for a UTC day. A residual
// near zero means the model explains the burn; a large one means a read path is spending
// rows that nothing in this file knows about, which is precisely the condition that went
// undetected for a month.
//
// THE THRESHOLDS BELOW ARE PROVISIONAL. They are set to catch a burn of the shape that
// actually happened (millions of unattributed rows), not calibrated against a known
// distribution of the residual — nobody has one yet. Two experiments have to land before
// they mean anything: P2/P4 in docs/READ_QUOTA.md, which measure the platform counter's
// POSTING LAG (usage attributed to a day can still be arriving when the next day's cron
// reads it, which shows up as a spurious positive residual and then a matching negative one
// the day after). Until those calibrate the lag, expect to re-tune these — and treat a
// single day's alarm as an invitation to look, not a proof.

/** Absolute floor: a residual under a million rows is never worth an email. At the post-fix
 *  ~0.69M/day budget this is more than a day's entire spend. */
export const RESIDUAL_FLOOR_ROWS = 1_000_000;
/** Relative bar: half the day's platform total. Anything that unexplained is a path, not
 *  model drift. */
export const RESIDUAL_FRACTION = 0.5;
/** Below this much traffic on the day, don't alarm at all — a quiet day's residual is
 *  dominated by the posting lag and by paths too small to instrument. */
export const RESIDUAL_MIN_PLATFORM_ROWS = 200_000;

export type ResidualVerdict = {
  /** platform − ledger. Positive = the platform counter saw rows the model didn't explain.
   *  Negative = the model over-charged (the landed-tick bias above is the known source). */
  residual: number;
  /** The bar |residual| had to clear, for the record in the alarm body. */
  threshold: number;
  alarm: boolean;
};

/** The alarm decision, as a pure function so it can be tested on both sides of the line.
 *  Alarms when the day had real traffic AND the unexplained part exceeds both bars. */
export function residualVerdict(platformRows: number, ledgerRows: number): ResidualVerdict {
  const residual = platformRows - ledgerRows;
  const threshold = Math.max(RESIDUAL_FLOOR_ROWS, RESIDUAL_FRACTION * platformRows);
  return {
    residual,
    threshold,
    alarm: platformRows > RESIDUAL_MIN_PLATFORM_ROWS && Math.abs(residual) > threshold,
  };
}
