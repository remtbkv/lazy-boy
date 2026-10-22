// Phase 2's TokenStore (docs/multi-user/PLAN.md §5.2-5.3): one encrypted row per user in the
// app database's `user_tokens`, and one refresh lease per user, `lock:spotify_refresh:<uid>`.
//
// Every read and write waits for the key check (token-keys.ts), so a deploy with a wrong key
// touches nothing. A row's version is its blob: a refresh writes, and a dead grant clears, only
// over the blob it read. `granted_at` moves only when the refresh token being written differs
// from the stored one, since Spotify's six-month clock runs from the grant (§5.4).
//
// A blob that fails to decrypt is the deployment's fault (§5.3): it is recorded as a `decrypt`
// event with the uid, never the blob, nothing about the user is written, and the read throws
// so that request or step fails retryably.
import "server-only";
import {
  acquireAppLock,
  deleteTokens,
  deleteTokensIfUnchanged,
  readTokenRow,
  releaseAppLock,
  updateTokensIfUnchanged,
  writeSignInTokens,
} from "@/lib/app-db";
import type { Uid } from "@/lib/identity";
import { reportIsolation } from "@/lib/isolation";
import type { TokenStore } from "@/lib/token-core";
import { DecryptError, decryptTokens, encryptTokens, type TokenKey } from "@/lib/token-crypto";
import { tokenKeysReady } from "@/lib/token-keys";

const lockName = (uid: Uid) => `lock:spotify_refresh:${uid}`;

async function decryptOrReport(keys: TokenKey[], uid: Uid, blob: string) {
  try {
    return decryptTokens(keys, uid, blob);
  } catch (e) {
    if (e instanceof DecryptError) await reportIsolation("decrypt", uid);
    throw e;
  }
}

export function appTokenStore(): TokenStore {
  return {
    async get(uid) {
      const keys = await tokenKeysReady();
      const row = await readTokenRow(uid);
      if (!row) return null;
      const t = await decryptOrReport(keys, uid, row.blob);
      return { ...t, expiresAt: row.expiresAt, rev: row.blob };
    },

    async set(uid, t) {
      const keys = await tokenKeysReady();
      const now = Math.floor(Date.now() / 1000);
      const prev = await readTokenRow(uid);
      let grantedAt = now;
      if (prev) {
        const old = await decryptOrReport(keys, uid, prev.blob).catch(() => null);
        if (old?.refreshToken === t.refreshToken) grantedAt = prev.grantedAt;
      }
      const blob = encryptTokens(keys, uid, t);
      if (!(await writeSignInTokens(uid, { blob, expiresAt: t.expiresAt, grantedAt }))) {
        throw new Error(`no live user ${uid} to hold this sign-in's tokens`);
      }
    },

    async update(uid, t, read) {
      const keys = await tokenKeysReady();
      return updateTokensIfUnchanged(uid, read.rev, {
        blob: encryptTokens(keys, uid, t),
        expiresAt: t.expiresAt,
        rotated: t.refreshToken !== read.refreshToken,
        now: Math.floor(Date.now() / 1000),
      });
    },

    async clear(uid, read) {
      await deleteTokensIfUnchanged(uid, read.rev);
    },

    remove: (uid) => deleteTokens(uid),

    lock: (uid, ttlMs) => acquireAppLock(lockName(uid), ttlMs),
    unlock: (uid, owner) => releaseAppLock(lockName(uid), owner),
  };
}
