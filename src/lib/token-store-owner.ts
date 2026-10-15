// Phase 1's TokenStore (docs/multi-user/PLAN.md §11.4): the owner's plaintext row in `meta`, as
// today, behind the per-user interface. Any other uid has no row: a read returns null (so no
// Spotify call is made for it) and a write throws. Phase 2 replaces this with `user_tokens`.
//
// The lock keeps today's name, `spotify_refresh`, rather than Phase 2's
// `lock:spotify_refresh:<uid>`: during a deploy the previous build is still refreshing with the
// old name, and two names would let both refresh the one grant at once.
import "server-only";
import {
  acquireLock,
  clearSpotifyTokens,
  getSpotifyTokens,
  releaseLock,
  setSpotifyTokens,
} from "@/lib/db";
import type { Uid } from "@/lib/identity";
import type { TokenStore } from "@/lib/token-core";

export function ownerTokenStore(owner: () => string | null): TokenStore {
  const isOwner = (uid: Uid) => {
    const o = owner();
    return !!o && uid === o;
  };
  const refuse = (uid: Uid): never => {
    throw new Error(`no token row for user ${uid} in Phase 1`);
  };
  return {
    async get(uid) {
      return isOwner(uid) ? getSpotifyTokens() : null;
    },
    async set(uid, t) {
      if (!isOwner(uid)) refuse(uid);
      await setSpotifyTokens({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    },
    async clear(uid) {
      if (!isOwner(uid)) refuse(uid);
      await clearSpotifyTokens();
    },
    async lock(uid, ttlMs) {
      if (!isOwner(uid)) refuse(uid);
      return acquireLock("spotify_refresh", ttlMs);
    },
    async unlock(uid, lockOwner) {
      if (!isOwner(uid)) refuse(uid);
      await releaseLock("spotify_refresh", lockOwner);
    },
  };
}
