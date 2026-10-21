// The instant-handoff verdict, extracted from den-home so the guards that killed three
// separate phantom-play bugs (Abracadabra 2026-08-16, the cache seed and the paused-state
// launder 2026-08-19) are a pure, known-answer-tested function. den-home supplies the
// observation state; this decides. Keep the constants in ONE place — the 0.40 bar is the
// same SKIP_FRACTION the store applies in recomputeSkipFlags (skip-rule.ts owns it).
//
// One verdict (docs/NOW_PLAYING_2S.md lane L2): Home judges how long the song was CURRENT,
// from the instant it became current to the instant it stopped, the quantity the store's
// isSkip reads off two played_at stamps: ran = min(end − start, duration), skip when
// ran < SKIP_FRACTION × duration. It used to judge the furthest position a poll saw, which a
// seek near the end inflated: 一路生花, 未必 and Faint were current for 12-23 s, Home saw
// 99-100% and listed them, and the store ruled all three skips. Pause time counts as
// listening on both sides. Within HANDOFF_PENDING_BAND_MS of the bar the two clocks cannot be
// told apart (the store's stamps carry ~0.5 s of noise), so the row shows as pending until the
// store lists the play.
import { SKIP_FRACTION } from "@/lib/skip-rule";

export type HandoffObservation = {
  /** When a poll last saw this song ACTUALLY PLAYING (never refreshed while paused). */
  seenAt: number;
  /** Whether this tab ever observed the song playing — a track first seen paused carries
   *  progress it earned before we were watching. */
  sawPlaying: boolean;
  /** When the song became current, on this tab's clock: the first playing observation's
   *  receipt minus its progress, never before the previous song's end. */
  startAt: number;
  durationMs: number;
  /** Seen in a private session: Spotify lists none of those plays, so neither does Home. */
  privateSession?: boolean;
};

export type HandoffVerdict =
  | "stale"
  | "never-played"
  | "private"
  | "skip"
  | "no-today"
  | "pending"
  | "commit";

export const HANDOFF_STALE_MS = 60_000;
export const HANDOFF_SKIP_FRACTION = SKIP_FRACTION;
export const HANDOFF_UNKNOWN_DURATION_FLOOR_MS = 30_000;
export const HANDOFF_PENDING_BAND_MS = 1_500;

/** How long the song was current: end − start, capped at its duration (unknown = uncapped). */
export function handoffRun(p: Pick<HandoffObservation, "startAt" | "durationMs">, endAt: number): number {
  const ran = Math.max(0, endAt - p.startAt);
  return p.durationMs > 0 ? Math.min(ran, p.durationMs) : ran;
}

export function judgeHandoff(
  p: HandoffObservation,
  /** When the song stopped being current (the next song's start, or when nothing was playing). */
  endAt: number,
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
  if (p.privateSession) return "private";
  const ran = handoffRun(p, endAt);
  const bar = p.durationMs > 0 ? p.durationMs * HANDOFF_SKIP_FRACTION : HANDOFF_UNKNOWN_DURATION_FLOOR_MS;
  // Strict `<`, as isSkip: exactly at the bar is a listen.
  const inBand = p.durationMs > 0 && Math.abs(ran - bar) <= HANDOFF_PENDING_BAND_MS;
  if (ran < bar && !inBand) return "skip";
  if (!dailyHeadIsToday) return "no-today";
  return inBand ? "pending" : "commit";
}
