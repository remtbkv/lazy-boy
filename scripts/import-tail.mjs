// The shared tail of the offline play importers (backfill-from-backstop.mjs,
// import-extended-history.mjs): what a batch of gap-filling inserts owes the rest of the store.
//
// Skip verdicts are ruled from a play's neighbour, so an insert that lands BETWEEN stored plays
// leaves the stored plays on either side of it with a verdict measured against a neighbour that
// is no longer adjacent. recordPlays (src/lib/db.ts) re-opens those per insert; an importer
// writes hundreds at once, so it re-opens them per RUN — a maximal stretch of inserts that no
// stored play separates. The run's interior is all new rows, pending already; only its two
// edges border stored plays. The rule judges a play by its PREDECESSOR (played_at is an END
// stamp, C1), so the stored play after the run is the one whose verdict moved; the stored play
// before it is re-opened too, which re-rules to the same verdict and costs one row.
// recomputeSkipFlags re-rules every NULL on the next sync that lands a play.
//
// Re-opening only the oldest captured item's predecessor (the backstop script's first cut)
// missed every window but the first, because the recorder dump spans its whole history
// (lazyboy-review D3, 2026-10-03).

const NOT_BACKFILL = "(context_type IS NULL OR context_type <> 'backfill')";

/** Group inserted played_at stamps into runs no existing stamp separates. An existing stamp
 *  EQUAL to an insert also splits, so its tie-mates sit on a run edge and get re-opened.
 *  Both inputs are ISO strings (which sort chronologically); `existing` excludes backfill
 *  rows, which never take part in a verdict. */
export function insertedRuns(existing, inserted) {
  const ex = [...existing].sort();
  const ins = [...inserted].sort();
  // Count of existing stamps < at (strict) or <= at (inclusive), by binary search.
  const below = (at, inclusive) => {
    let lo = 0;
    let hi = ex.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ex[mid] < at || (inclusive && ex[mid] === at)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const runs = [];
  for (const at of ins) {
    const run = runs[runs.length - 1];
    // Same run iff no existing stamp lies in [run.last, at].
    if (run && below(run.last, false) === below(at, true)) run.last = at;
    else runs.push({ first: at, last: at });
  }
  return runs;
}

/** The statements that close an import batch: re-open the verdicts on each run's edges, bump
 *  write_seq (the marker every cached read and the client history payload key on), and drop
 *  Home's materialized payload so the next load computes it inline and rebuilds it — the
 *  payload is built in TypeScript on the write path (db.ts rebuildHomePayload), which a node
 *  script cannot call. Run after the inserts, in the same batch. */
export function importTailStmts(runs) {
  return [
    ...runs.map((r) => ({
      sql: `UPDATE plays SET skipped = NULL
            WHERE (played_at IN (?, ?) AND ${NOT_BACKFILL})
               OR id = (SELECT id FROM plays WHERE played_at < ? AND ${NOT_BACKFILL}
                        ORDER BY played_at DESC, track_id DESC LIMIT 1)
               OR id = (SELECT id FROM plays WHERE played_at > ? AND ${NOT_BACKFILL}
                        ORDER BY played_at ASC, track_id ASC LIMIT 1)`,
      args: [r.first, r.last, r.first, r.last],
    })),
    {
      sql: `INSERT INTO meta (key, value) VALUES ('write_seq', '1')
            ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`,
      args: [],
    },
    { sql: "DELETE FROM meta WHERE key = 'home_payload'", args: [] },
  ];
}
