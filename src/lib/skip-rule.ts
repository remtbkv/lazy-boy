// The skip verdict and listened-time estimate, as pure functions over played_at stamps.
// Dependency-free on purpose: db.ts uses it, and so do scripts/verify-derived.mjs and
// scripts/migrate-skip-rule.mjs, which import it straight from this file (Node strips the
// types) — so the store, its verifier and its migration cannot drift apart.
//
// Spotify's played_at is the moment a play ENDED (C1, burn lazyboy-review 2026-10-03: on
// 13,262 production plays, the gap from the PREVIOUS play matched this play's duration with a
// 568 ms median residual; the gap to the NEXT play missed by 48 s). So a play ran from the
// previous play's end to its own, capped at its duration. A play with no predecessor, or one
// that ended more than a song-length after the previous play, ran in full — the cap does that.
// Spotify has switched this convention before (github.com/spotify/web-api/issues/1083), which
// is why playedAtConvention() below exists.

// A play with less than this fraction of the song actually listened is a SKIP — spam-clicking
// through tracks must not read as listening (Rem, 2026-08-16). handoff.ts's client-side gate
// applies the same bar.
export const SKIP_FRACTION = 0.35;
// Listened time for a track whose duration is unknown.
export const LISTEN_FALLBACK_MS = 600000;
// A play that ran under this adds 0 to listened-time totals (it still counts as a play
// unless the skip verdict drops it).
export const LISTEN_MIN_MS = 5000;

/** ms between the previous play's end and this one's; null when there is no previous play or
 *  the clock went backwards (then the play is taken to have run in full). */
function gapMs(prevAt: string | null, playedAt: string): number | null {
  if (prevAt === null) return null;
  const gap = Date.parse(playedAt) - Date.parse(prevAt);
  return gap >= 0 ? gap : null;
}

/** 1 when the play ran under SKIP_FRACTION of its song. Unknown/zero duration is permissive. */
export function isSkip(prevAt: string | null, playedAt: string, durationMs: number | null): 0 | 1 {
  if (!durationMs) return 0;
  const gap = gapMs(prevAt, playedAt);
  if (gap === null) return 0;
  return Math.min(gap, durationMs) < SKIP_FRACTION * durationMs ? 1 : 0;
}

/** Estimated ms actually listened: the run from the previous play, capped at the song. */
export function listenedMs(prevAt: string | null, playedAt: string, durationMs: number | null): number {
  const dur = durationMs ?? LISTEN_FALLBACK_MS;
  const gap = gapMs(prevAt, playedAt);
  const ran = gap === null ? dur : Math.min(dur, gap);
  return ran < LISTEN_MIN_MS ? 0 : ran;
}

export type AllTimeStats = {
  plays: number;
  uniqueTracks: number;
  durationMs: number;
  since: string | null; // earliest counted play (ISO), null if none
};

/** All-time totals over EVERY real (non-backfill) play, ordered by (played_at, track_id).
 *  Gaps run over the full chain — a skip still ends when it ends, so the next play's run is
 *  measured from it — and then skipped rows drop out of every aggregate. */
export function allTimeStats(
  rows: { playedAt: string; trackId: string; durationMs: number | null; skipped: number | null }[],
): AllTimeStats {
  const tracks = new Set<string>();
  let plays = 0;
  let durationMs = 0;
  let since: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.skipped === 1) continue;
    plays++;
    tracks.add(r.trackId);
    durationMs += listenedMs(i > 0 ? rows[i - 1].playedAt : null, r.playedAt, r.durationMs);
    since ??= r.playedAt;
  }
  return { plays, uniqueTracks: tracks.size, durationMs, since };
}

// ── The convention self-check ───────────────────────────────────────────────────────────
// Consecutive plays close together are mostly back-to-back listens, so their gap equals one
// of the two durations: the LATER one under end stamps, the EARLIER one under start stamps.
// Production (2026-06 → 10, per half-month): later 54–64%, earlier 2–4% (the coincidence
// baseline). If the earlier share ever overtakes the later one, Spotify flipped the convention
// and every verdict above is inverted.
const CONVENTION_MAX_GAP_MS = 20 * 60_000;
const CONVENTION_MATCH_MS = 2_000;
// Below this many pairs the shares are noise; a listening week has hundreds.
export const CONVENTION_MIN_PAIRS = 20;

export function playedAtConvention(rows: { playedAt: string; durationMs: number | null }[]): {
  pairs: number;
  later: number;
  earlier: number;
  inverted: boolean;
} {
  let pairs = 0;
  let later = 0;
  let earlier = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (!a.durationMs || !b.durationMs) continue;
    const gap = Date.parse(b.playedAt) - Date.parse(a.playedAt);
    if (gap < 0 || gap > CONVENTION_MAX_GAP_MS) continue;
    pairs++;
    if (Math.abs(gap - b.durationMs) <= CONVENTION_MATCH_MS) later++;
    if (Math.abs(gap - a.durationMs) <= CONVENTION_MATCH_MS) earlier++;
  }
  return { pairs, later, earlier, inverted: pairs >= CONVENTION_MIN_PAIRS && earlier > later };
}
