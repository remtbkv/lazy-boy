// Per-user limits on the calls one person's tab could run away with (docs/multi-user/PLAN.md §6.6,
// security R13): a fixed window per (limit name, uid), in this process. With Fluid compute few
// instances serve everyone, so an in-process count catches a stuck tab cheaply; it does not stop a
// determined user spreading calls across instances (that answer is `user.mjs --disable`).
// `/api/playlists/[id]/tracks`, `searchPlaysAction` (ten a minute each) and the player actions in
// actions.ts (thirty a minute, shared) use it.
import "server-only";
import type { Uid } from "@/lib/identity";

type Window = { start: number; count: number };
const windows = new Map<string, Window>();

/** True when this call fits in `uid`'s window for `name`; false means refuse it. */
export function allowUserCall(name: string, uid: Uid, now: number, limit: number, windowMs: number): boolean {
  const key = `${name}:${uid}`;
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    for (const [k, x] of windows) if (now - x.start >= windowMs) windows.delete(k);
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}

/** Tests only. */
export function clearUserBuckets(): void {
  windows.clear();
}

/** §6.6: `/api/playlists/[id]/tracks`, ten a minute per user per instance (01b S13). */
export const PLAYLIST_TRACKS_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** §6.6: `searchPlaysAction`, an unindexable LIKE per call: ten a minute per user per instance. */
export const SEARCH_PLAYS_LIMIT = { limit: 10, windowMs: 60_000 } as const;

/** §6.6, security R13: every player action of one user shares one window. Thirty a minute is past
 *  a person queueing an album track by track, and a stuck tab reaches it within seconds. */
export const PLAYER_LIMIT = { limit: 30, windowMs: 60_000 } as const;
