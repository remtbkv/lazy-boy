# Hypothesis tree — RESOLVED (Aug 8, ~3:20 AM)

Kept as the record of how the verdict was reached; the live truth is in PREREG.md's
outcome sections and (once pruned) READ_QUOTA.md.

## The verdict

**The meter is honest and row-exact; the burn was real.** The dominant burner —
~2.5M rows_read + ~640 rows_written in one ~5-min burst every hour, ~60M/day at
August's store size, active for weeks at scale-appropriate amplitudes (July: ~339K/h
variant) — is the **hourly cron library sync's full-rewrite path**: `storePlaylists`'
change-probe fails nearly every hour on a volatile playlist field (leading suspect:
rotating mosaic art URLs, 156/180 playlists), so each hourly sync runs the playlist
delete-all+reinsert plus `recomputeOrphanFlags()`'s ~2.5M-row full pass. Cron-driven,
server-side, independent of tabs and deploys — which is why no client-side fix moved
it and why it survived every attribution model built from per-query measurements of
the OTHER paths.

How each hypothesis fared:

- **H1 delayed/batched posting — REFUTED.** P2: posting is continuous, ≤15–30 s,
  identical for long-lived open connections; the meter tracked 400 controlled inserts
  to the exact row. The timelines-vs-aggregates contradiction was sampling luck: the
  burst rides one 5-min slot/hour and both 6-min timelines dodged it; for their exact
  minutes the windowed meter agrees with what they saw.
- **H2 meter miscount — REFUTED for billing data; CONFIRMED for the reporting layer.**
  Every billing check passed exactly (quiet-window 1,168; split sums; instance sums;
  P2 row-exactness; P3 frozen counter through the block). The genuine Turso-side
  defects are reporting/ops: the pulse aggregation outage (hangs then 502s,
  1:37–2:23 AM), org storage_bytes=0 while instances carry real values, the transient
  bytes_synced dip (2.42→2.28→2.446 GB), the migration's ~25.9 MB of bytes_synced
  billed to the customer, and quota enforcement lagging ~14M (~5 h at the burn rate)
  past the 500M line.
- **H3 missed reader — CONFIRMED, but server-side:** the missed reader was the app's
  own hourly library sync full pass, invisible to every client-side model because it
  only fires on the probe-failure branch nobody thought was hot. Drizzle
  Studio/AI-Insights and the 401 pinger are real-but-negligible third readers.
- **H4 app burn via unmodeled path — CONFIRMED in mechanism** (this IS an app path),
  refuted in its specific stale-tab/broken-cache variants. The stale-tab class stays
  real (skew pinning is observed behavior) and the build-skew auto-reload guard ships
  regardless.

## Open residuals (tracked, non-blocking)

- WHICH probe field rotates hourly: confirmed post-unblock by the new
  `storePlaylists-diff` structured log line on the first hourly sync.
- The W1a overnight hours' burst slots (spot-check showed 2:10–2:25 AM quiet) — the
  overnight burn's hourly texture is unmapped; same mechanism presumed, phase drift
  expected. Map it from windowed queries if the post-fix forecast window misses.
- `library_seq` ground truth (READ_QUOTA claimed "5 lifetime", falsified-in-spirit by
  hourly rewrites — read the actual value post-unblock).
- The +190/30 s metronome (≈4.3K/12 min bucket seen at 12:30) — minor, unidentified.
- Old-build per-cycle model's ~1.5× read gap (index-entry billing calibration) —
  moot for the verdict now that the burner is identified, still worth one
  calibration experiment for future modeling.
