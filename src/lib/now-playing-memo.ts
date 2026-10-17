// /api/now-playing's per-user memo (docs/multi-user/PLAN.md §6.2 layer 4, §6.6; security R13):
// each user's last answer for about 5 seconds, so their tabs and devices share one Spotify call per
// window and a stuck tab cannot run up the player bucket every user shares. Keyed by uid, so one
// user's answer can never be another's; only a 200 is kept, so a failure is never replayed.
import "server-only";
import type { Uid } from "@/lib/identity";

export const NOW_PLAYING_MEMO_MS = 5_000;

type Entry = { at: number; playing: unknown };
const memo = new Map<Uid, Entry>();

export function memoizedNowPlaying(uid: Uid, now: number): { playing: unknown } | null {
  const e = memo.get(uid);
  return e && now - e.at < NOW_PLAYING_MEMO_MS ? { playing: e.playing } : null;
}

export function rememberNowPlaying(uid: Uid, now: number, playing: unknown): void {
  for (const [k, e] of memo) if (now - e.at >= NOW_PLAYING_MEMO_MS) memo.delete(k);
  memo.set(uid, { at: now, playing });
}

/** Tests only: forget every answer. */
export function clearNowPlayingMemo(): void {
  memo.clear();
}
