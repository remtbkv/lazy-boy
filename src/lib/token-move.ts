// Moving the admin's token into `user_tokens`, and back (docs/multi-user/PLAN.md §11.4 step 3 and
// "Rollback"; §5.3: everything that needs the production key runs in the runtime, so no script
// on the Mac ever holds it, security R9).
//
// - The copy: the admin's first token read in a process, finding no `user_tokens` row, encrypts
//   his plaintext `meta.spotify_tokens` row from `lazyboy` into one, reads it back, and logs
//   that the blob it wrote decrypts to the plaintext row. It runs once ever: `app_meta`
//   `token_copy:<uid>` records that it ran (or that a sign-in wrote the row first), so a later
//   clear of a dead grant never brings the old plaintext token back. The plaintext row stays in
//   `lazyboy` for a week (§11.4 step 6 deletes it).
// - The rollback: with LB_TOKEN_ROLLBACK=1, the admin's first token read in a process writes his
//   plaintext row back from the blob, and so does every later write of his tokens, so the
//   build the revert brings back finds a live token in `meta`.
import "server-only";
import { getAppMeta, insertTokensIfAbsent, readTokenRow, setAppMeta } from "@/lib/app-db";
import { forUser, type SpotifyTokens } from "@/lib/db";
import type { Uid } from "@/lib/identity";
import type { TokenStore } from "@/lib/token-core";
import { decryptTokens, encryptTokens } from "@/lib/token-crypto";
import { tokenKeysReady } from "@/lib/token-keys";

/** The admin's plaintext row in `lazyboy.meta`, his own database (forUser's for his uid). */
export type Plaintext = { read(): Promise<SpotifyTokens | null>; write(t: SpotifyTokens): Promise<void> };
const metaPlaintext = (uid: Uid): Plaintext => ({
  read: () => forUser(uid).getSpotifyTokens(),
  write: (t) => forUser(uid).setSpotifyTokens(t),
});

const copyKey = (uid: string) => `token_copy:${uid}`;
export const rollbackOn = () => process.env.LB_TOKEN_ROLLBACK === "1";

export type CopyResult = "ran-before" | "row-present" | "no-plaintext" | "no-live-user" | "copied";

export async function copyAdminTokens(uid: Uid, plain: Plaintext = metaPlaintext(uid)): Promise<CopyResult> {
  if (await getAppMeta(copyKey(uid))) return "ran-before";
  const keys = await tokenKeysReady();
  if (await readTokenRow(uid)) {
    await setAppMeta(copyKey(uid), `row-present:${Date.now()}`);
    return "row-present";
  }
  const t = await plain.read();
  if (!t) return "no-plaintext";
  const inserted = await insertTokensIfAbsent(uid, {
    blob: encryptTokens(keys, uid, t),
    expiresAt: t.expiresAt,
    grantedAt: Math.floor(Date.now() / 1000),
  });
  const back = await readTokenRow(uid);
  if (!back) return "no-live-user";
  if (!inserted) {
    await setAppMeta(copyKey(uid), `row-present:${Date.now()}`);
    return "row-present";
  }
  const d = decryptTokens(keys, uid, back.blob);
  if (d.accessToken !== t.accessToken || d.refreshToken !== t.refreshToken || back.expiresAt !== t.expiresAt) {
    console.error(`[token-move] admin ${uid}: the blob written does NOT decrypt to the plaintext row`);
    throw new Error("token copy did not verify");
  }
  await setAppMeta(copyKey(uid), `copied:${Date.now()}`);
  console.log(`[token-move] admin ${uid}: the blob written decrypts to the plaintext row`);
  return "copied";
}

export async function rollbackAdminTokens(uid: Uid, plain: Plaintext = metaPlaintext(uid)): Promise<boolean> {
  const keys = await tokenKeysReady();
  const row = await readTokenRow(uid);
  if (!row) {
    console.error(`[token-move] rollback: admin ${uid} has no blob to write back`);
    return false;
  }
  await plain.write({ ...decryptTokens(keys, uid, row.blob), expiresAt: row.expiresAt });
  console.log(`[token-move] rollback: admin ${uid}'s plaintext row written back from the blob`);
  return true;
}

/** The store auth.ts runs: the copy (or the rollback's write-back) before the admin's first
 *  token read in this process, and in rollback every later write of his tokens mirrored to
 *  the plaintext row. Every other uid passes straight through. */
export function withAdminTokenMove(
  store: TokenStore,
  admin: () => string | null,
  plain?: Plaintext,
): TokenStore {
  let prepared: Promise<unknown> | null = null;
  const isAdmin = (uid: string) => uid === admin();
  const plainOf = (uid: Uid) => plain ?? metaPlaintext(uid);
  const prepare = (uid: Uid) => {
    if (!isAdmin(uid)) return;
    prepared ??= (rollbackOn() ? rollbackAdminTokens(uid, plainOf(uid)) : copyAdminTokens(uid, plainOf(uid))).catch((e) => {
      prepared = null; // retried at the next read
      console.error(`[token-move] ${String(e)}`);
    });
    return prepared;
  };
  const mirror = async (uid: Uid, t: SpotifyTokens) => {
    if (isAdmin(uid) && rollbackOn()) await plainOf(uid).write({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
  };
  return {
    ...store,
    async get(uid) {
      await prepare(uid);
      return store.get(uid);
    },
    async set(uid, t) {
      await store.set(uid, t);
      await mirror(uid, t);
    },
    async update(uid, t, read) {
      const ok = await store.update(uid, t, read);
      if (ok) await mirror(uid, t);
      return ok;
    },
  };
}
