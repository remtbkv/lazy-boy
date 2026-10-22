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

/** What Home keeps about the song on the bar between answers (den-home's lastPlayingRef). */
export type HandoffTrack = Omit<HandoffObservation, "startAt" | "privateSession"> & {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumImage: string | null;
  source: string | null;
  /** The furthest position a playing observation saw (the beacon's `prog`). */
  maxProgress: number;
  /** When the last PLAYING observation predicted the song would end (receipt + duration −
   *  progress); the beacon's `end` is the finish minus this. Null when unknown. */
  endAt: number | null;
  /** When the song became current; null until it is seen playing. */
  startAt: number | null;
  privateSession: boolean;
  /** The receipt of the last answer that showed this song, paused included. */
  lastObservedAt: number;
  /** When that answer was sampled: its receipt for a live poll, earlier for a cached or relayed
   *  state or the one the provider holds when Home mounts. The song was still current then, so
   *  the next song cannot have started earlier (review 0156 H1). The receipt would date a cached
   *  state's song as current at the paint and move a skip's end forward (review 0158 finding 2). */
  lastSampledAt: number;
  /** That answer's progress, and whether it was playing (repeat-one reads where the song is). */
  lastProgressMs: number;
  lastWasPlaying: boolean;
};

/** One answer as the provider hands it to Home (now-playing-context's Playing). */
export type HandoffAnswer = {
  track: { id: string; title: string; artist: string; album?: string | null; albumImage: string | null };
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  context: { name: string } | null;
  privateSession?: boolean;
} | null;

export type HandoffFold = {
  /** The song on the bar after this answer, or null. */
  current: HandoffTrack | null;
  /** The song this answer ended, and the instant it stopped being current. */
  finished: { p: HandoffTrack; endedAt: number } | null;
  /** When the last song this tab watched stopped being current. */
  lastChangeAt: number | null;
};

/** Fold one answer, received at `receivedAt` on this tab's clock, into Home's observation of
 *  the song on the bar. Pure: den-home keeps `current` and `lastChangeAt` between answers and
 *  judges `finished` (judgeFinished). Every instant is this tab's receipt minus Spotify's own
 *  progress (a duration); nothing subtracts a stamp from another machine's clock. `sampledAt` is
 *  when the provider took the state (never after its receipt); its progress is already aged to
 *  the receipt. */
export function foldHandoff(
  prev: HandoffTrack | null,
  playing: HandoffAnswer,
  receivedAt: number,
  lastChangeAt: number | null,
  sampledAt: number = receivedAt,
): HandoffFold {
  const sampled = Math.min(sampledAt, receivedAt);
  // The previous song stopped being current at `changeAt` (the next song's start, or now):
  // never before it started, never in the future.
  const stop = (p: HandoffTrack, changeAt: number) => Math.min(receivedAt, Math.max(changeAt, p.startAt ?? changeAt));
  if (!playing?.track) {
    if (!prev) return { current: null, finished: null, lastChangeAt };
    const endedAt = stop(prev, receivedAt);
    return { current: null, finished: { p: prev, endedAt }, lastChangeAt: endedAt };
  }
  // Repeat-one: the same song, back under 3 s once it was due to end, is a new play (a
  // natural end, which Spotify lists). A jump back mid-song stays a seek. "Due to end" is the
  // last observed position, moved on only if it was playing: a pause past the old predicted
  // end followed by "previous" is a seek (review 0156 L-a).
  const restarted =
    !!prev &&
    prev.id === playing.track.id &&
    playing.isPlaying &&
    prev.durationMs > 0 &&
    prev.lastProgressMs + (prev.lastWasPlaying ? receivedAt - prev.lastObservedAt : 0) >= prev.durationMs - 2_000 &&
    playing.progressMs < 3_000;
  if (prev && prev.id === playing.track.id && !restarted) {
    const next = {
      ...prev,
      source: playing.context?.name ?? prev.source,
      lastObservedAt: receivedAt,
      lastSampledAt: sampled,
      lastProgressMs: playing.progressMs,
      lastWasPlaying: playing.isPlaying,
    };
    if (playing.privateSession) next.privateSession = true;
    // An in-app play is shown before Spotify answers, sometimes with no duration: the first
    // answer that knows it fills it in, or the run goes uncapped against the 30 s floor
    // (review 0156 M1).
    if (playing.durationMs > 0) next.durationMs = playing.durationMs;
    // Only a PLAYING observation refreshes the liveness stamp and earns progress — a paused
    // chip re-observed every 6s must not keep a dead song "fresh".
    if (playing.isPlaying) {
      next.maxProgress = Math.max(prev.maxProgress, playing.progressMs);
      next.seenAt = receivedAt;
      next.sawPlaying = true;
      next.endAt = playing.durationMs > 0 ? receivedAt + playing.durationMs - playing.progressMs : null;
      next.startAt ??= Math.max(receivedAt - playing.progressMs, lastChangeAt ?? -Infinity);
    }
    return { current: next, finished: null, lastChangeAt };
  }
  let finished: HandoffFold["finished"] = null;
  if (prev) {
    // The new song's progress dates the change, but a seek before this first look moves that
    // date back, past the moment the previous song was last seen current (review 0156 H1: the
    // previous song's run went to the new one). Bounded by it, the error is one poll interval.
    const endedAt = stop(prev, Math.max(receivedAt - playing.progressMs, prev.lastSampledAt));
    finished = { p: prev, endedAt };
    lastChangeAt = endedAt;
  }
  const current: HandoffTrack = {
    id: playing.track.id,
    title: playing.track.title,
    artist: playing.track.artist,
    album: playing.track.album ?? null,
    albumImage: playing.track.albumImage,
    durationMs: playing.durationMs,
    source: playing.context?.name ?? null,
    // A track first seen PAUSED starts with no credit: whatever progress it shows was earned
    // before this tab was watching.
    maxProgress: playing.isPlaying ? playing.progressMs : 0,
    seenAt: receivedAt,
    lastObservedAt: receivedAt,
    lastSampledAt: sampled,
    lastProgressMs: playing.progressMs,
    lastWasPlaying: playing.isPlaying,
    sawPlaying: !!playing.isPlaying,
    endAt: playing.isPlaying && playing.durationMs > 0 ? receivedAt + playing.durationMs - playing.progressMs : null,
    // Never before the previous song stopped: a seek before our first look would otherwise
    // date the start earlier.
    startAt: playing.isPlaying ? Math.max(receivedAt - playing.progressMs, lastChangeAt ?? -Infinity) : null,
    privateSession: !!playing.privateSession,
  };
  return { current, finished, lastChangeAt };
}

/** Home's verdict on a song the fold finished. A song never seen playing has no start; it is
 *  judged on its end alone (judgeHandoff rules it never-played first). */
export function judgeFinished(
  f: { p: HandoffTrack; endedAt: number },
  now: number,
  dailyHeadIsToday: boolean,
): HandoffVerdict {
  return judgeHandoff({ ...f.p, startAt: f.p.startAt ?? f.endedAt }, f.endedAt, now, dailyHeadIsToday);
}

/** The handoff beacon's meta (client_metrics "handoff"). The machine fields lead (meta is cut
 *  at 180 characters): `id` and `at` (the instant it stopped, epoch ms on this tab's clock) let
 *  scripts/np-latency.mjs find the store's row for the play and compare verdicts; `pred` is the
 *  song before it here, so a play whose predecessor Spotify never listed is excluded (REVIEW M7).
 *  The track by its id, never its name, artist or playlist (multi-user PLAN §13.1): telemetry is
 *  what agents read while debugging, and from the first friend it is theirs too. A song played in
 *  a private session is filed with its run alone: the user asked Spotify not to record that
 *  listen (code review 0156 M2). /privacy's diagnostic-logs line says exactly this. */
export function handoffBeaconMeta(
  verdict: string,
  p: Pick<HandoffTrack, "id" | "seenAt" | "maxProgress" | "durationMs" | "privateSession">,
  i: { ran: number | null; endedAt: number; pred: string | null; now: number; vsEndMs: number | undefined },
): string {
  const run = i.ran === null ? "?" : `${(i.ran / 1000).toFixed(1)}s`;
  if (p.privateSession) return `private|run=${run}`;
  const prog = p.durationMs > 0 ? `${Math.round((p.maxProgress / p.durationMs) * 100)}%` : "?";
  const end = i.vsEndMs === undefined ? "?" : `${(i.vsEndMs / 1000).toFixed(1)}s`;
  return `${verdict}|id=${p.id}|run=${run}|at=${i.endedAt}|pred=${i.pred ?? ""}|gap=${Math.round((i.now - p.seenAt) / 1000)}s|prog=${prog}|end=${end}`;
}

/** What the next song's beacon names as its `pred`: a private-session song by no id, which
 *  np-latency still reads as "not the store's predecessor" and excludes. */
export function handoffPredToken(p: Pick<HandoffTrack, "id" | "privateSession">): string {
  return p.privateSession ? "private" : p.id;
}
