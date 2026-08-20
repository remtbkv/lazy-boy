// The instant-handoff verdict, extracted from den-home so the guards that killed three
// separate phantom-play bugs (Abracadabra 2026-08-16, the cache seed and the paused-state
// launder 2026-08-19) are a pure, known-answer-tested function. den-home supplies the
// observation state; this decides. Keep the constants in ONE place — the 0.35 bar is the
// same SKIP_FRACTION the store applies in recomputeSkipFlags (db.ts).

export type HandoffObservation = {
  /** When a poll last saw this song ACTUALLY PLAYING (never refreshed while paused). */
  seenAt: number;
  /** Whether this tab ever observed the song playing — a track first seen paused carries
   *  progress it earned before we were watching. */
  sawPlaying: boolean;
  /** Max observed progress while playing (starts at 0 for a paused-seeded track). */
  maxProgress: number;
  durationMs: number;
};

export type HandoffVerdict = "stale" | "never-played" | "skip" | "no-today" | "commit";

export const HANDOFF_STALE_MS = 60_000;
export const HANDOFF_SKIP_FRACTION = 0.35;
export const HANDOFF_UNKNOWN_DURATION_FLOOR_MS = 30_000;

export function judgeHandoff(
  p: HandoffObservation,
  now: number,
  /** The strip's leading day vs the browser's local today — a mismatch means today has no
   *  card yet and the play belongs entirely to the sync. */
  dailyHeadIsToday: boolean,
): HandoffVerdict {
  // STALE = the tab slept holding this song and woke to a different one; a song that old
  // is the SYNC's business (it recorded the real play with its real time long ago).
  if (now - p.seenAt > HANDOFF_STALE_MS) return "stale";
  // Never observed playing in this tab = nothing to credit; its progress predates us.
  if (!p.sawPlaying) return "never-played";
  const need =
    p.durationMs > 0 ? p.durationMs * HANDOFF_SKIP_FRACTION : HANDOFF_UNKNOWN_DURATION_FLOOR_MS;
  if (p.maxProgress < need) return "skip";
  if (!dailyHeadIsToday) return "no-today";
  return "commit";
}
