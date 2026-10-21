// /api/now-playing's per-user memo (docs/multi-user/PLAN.md §6.2 layer 4, §6.6; security R13):
// each user's last answer for about 5 seconds, so their tabs and devices share one Spotify call per
// window and a stuck tab cannot run up the player bucket every user shares. Keyed by uid, so one
// user's answer can never be another's; only a 200 is kept, so a failure is never replayed.
//
// A playing answer lives min(5 s, what was left of its song) and is replayed with its progress
// aged by the time since the sample: the poll timed to a song's end must reach Spotify, not get the
// song that just ended back from here (docs/NOW_PLAYING_2S.md §0 item 1, lane L0).
import "server-only";
import type { Uid } from "@/lib/identity";

export const NOW_PLAYING_MEMO_MS = 5_000;

type Entry = { at: number; ttl: number; playing: unknown };
const memo = new Map<Uid, Entry>();

type Clock = { isPlaying: boolean; progressMs: number; durationMs: number };
const playingClock = (p: unknown): Clock | null => {
  const c = p as Partial<Clock> | null;
  return c && typeof c === "object" && c.isPlaying === true && typeof c.progressMs === "number" && typeof c.durationMs === "number"
    ? (c as Clock)
    : null;
};

export function memoizedNowPlaying(uid: Uid, now: number): { playing: unknown } | null {
  const e = memo.get(uid);
  if (!e || now - e.at >= e.ttl) return null;
  const c = playingClock(e.playing);
  if (!c) return { playing: e.playing };
  return { playing: { ...c, progressMs: Math.min(c.durationMs, c.progressMs + (now - e.at)) } };
}

export function rememberNowPlaying(uid: Uid, now: number, playing: unknown): void {
  for (const [k, e] of memo) if (now - e.at >= e.ttl) memo.delete(k);
  const c = playingClock(playing);
  const ttl = c ? Math.min(NOW_PLAYING_MEMO_MS, c.durationMs - c.progressMs) : NOW_PLAYING_MEMO_MS;
  memo.set(uid, { at: now, ttl, playing });
}

/** Tests only: forget every answer. */
export function clearNowPlayingMemo(): void {
  memo.clear();
}
