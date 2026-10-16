// The Spotify token core, per user (docs/multi-user/PLAN.md §5.2). Moved out of auth.ts so the
// simulated environment can load it (auth.ts imports next-auth, which it cannot), and keyed by
// uid throughout:
//   - the in-flight refresh is a Map<Uid, Promise>. As one promise per process it would let a
//     second user's concurrent refresh join the first's and receive the first's tokens (01e A2);
//   - the cross-instance refresh lock, the stored row and every write are per uid, through a
//     `TokenStore` (Phase 2: `user_tokens`, encrypted, token-store-app.ts);
//   - a token object names its owner, and `setTokens` / `assertTokenOwner` refuse a mismatch,
//     so a refactor that shares a promise or cache across users fails on the first mixed call,
//     and record a `token-owner` isolation event first (PLAN.md §6.5);
//   - a refresh writes, and a dead grant clears, only over the row it read (Phase 2, security
//     R3-R4): a refresh that read the old grant before a sign-in cannot overwrite the new one,
//     and one finishing after the deletion job removed the row stores nothing.
// The refresh rules themselves (retries, the fresh-token veto, the lock and its waits) are the
// single-user code's, unchanged; their comments say why each is there.
import type { SpotifyTokens } from "@/lib/db";
import type { Uid } from "@/lib/identity";
import { reportIsolation } from "@/lib/isolation";

const TOKEN_URL = "https://accounts.spotify.com/api/token";

export type UserTokens = SpotifyTokens & { uid: Uid };

/** What a store hands back: the tokens, and `rev`, an opaque version of the row they came from
 *  (Phase 2: its blob), which a refresh's write and a clear must name. */
export type StoredTokens = SpotifyTokens & { rev: string };

export interface TokenStore {
  get(uid: Uid): Promise<StoredTokens | null>;
  /** A sign-in's write: insert or replace, only while the user is live; throws if nothing landed. */
  set(uid: Uid, t: SpotifyTokens): Promise<void>;
  /** A refresh's write, only over the row `read` came from; false when that row moved on or is gone. */
  update(uid: Uid, t: SpotifyTokens, read: StoredTokens): Promise<boolean>;
  /** Clear only the row `read` came from. */
  clear(uid: Uid, read: StoredTokens): Promise<void>;
  /** Log out: the row goes, whatever it holds, so capture stops (RULINGS Oct 15 1:33 PM); a
   *  refresh racing it then stores nothing, since its write names a row that is gone. */
  remove(uid: Uid): Promise<void>;
  /** A cross-instance lease on this user's refresh; the owner string, or null if held. */
  lock(uid: Uid, ttlMs: number): Promise<string | null>;
  unlock(uid: Uid, owner: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `terminal` distinguishes a genuinely dead refresh token (revoked / re-consent
// needed → force re-login) from a transient failure (token endpoint rate-limited,
// network blip → keep the session and retry later). Only terminal failures should
// log the user out; a transient one must not.
export class RefreshError extends Error {
  terminal: boolean;
  constructor(terminal: boolean, message: string) {
    super(message);
    this.name = "RefreshError";
    this.terminal = terminal;
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<SpotifyTokens> {
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");

  // Up to 3 tries with small, bounded backoff. Bounded so a slow token endpoint
  // can't hang the page render — we'd rather keep the session and retry next load.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
        cache: "no-store",
        // Hard timeout: a slow/hanging token endpoint must NOT block the page
        // render (the layout awaits auth()). On timeout we fall back to the
        // existing session and retry on a later request.
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      // Network error or timeout: at most one retry, so render is never blocked
      // for more than ~10s before falling back to the current session.
      if (attempt >= 1) throw new RefreshError(false, `network: ${String(e)}`);
      await sleep(300 * (attempt + 1));
      continue;
    }

    if (res.ok) {
      // Guarded: a 200 with a non-JSON body used to escape as a raw SyntaxError, skipping
      // the RefreshError terminal/transient classification every caller relies on.
      let data: { access_token?: string; refresh_token?: string; expires_in?: number };
      try {
        data = await res.json();
      } catch {
        throw new RefreshError(false, "token endpoint returned non-JSON 200");
      }
      if (!data.access_token || !data.expires_in) {
        throw new RefreshError(false, "token endpoint 200 missing fields");
      }
      return {
        accessToken: data.access_token as string,
        // Spotify may or may not return a new refresh token.
        refreshToken: (data.refresh_token as string | undefined) ?? refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in as number),
      };
    }

    const data = await res.json().catch(() => ({}) as { error?: string });
    // A revoked/invalid refresh token is the one case that truly needs re-login.
    if (res.status === 400 && data?.error === "invalid_grant") {
      throw new RefreshError(true, "invalid_grant");
    }
    // Rate-limited or server error: retry, then give up transiently (no logout).
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(300 * (attempt + 1));
      continue;
    }
    throw new RefreshError(false, `token endpoint ${res.status}`);
  }
}

export const isFresh = (t: SpotifyTokens) => Date.now() / 1000 < t.expiresAt - 60;

export type TokenCoreOptions = {
  /** Phase 4a (PLAN.md §5.4 step 1): a dead grant on the request path stops and keeps instead of
   *  clearing the row, so the tick's confirming refresh 10 minutes later can ask again. Called once
   *  the row is shown to still hold the refresh token that died. Without it, the row is cleared
   *  (the single-user rule). */
  onDeadGrant?: (uid: Uid) => Promise<void>;
};

export function createTokenCore(store: TokenStore, opts: TokenCoreOptions = {}) {
  const own = (uid: Uid, t: SpotifyTokens): UserTokens => ({
    uid,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  });

  async function assertTokenOwner(t: UserTokens, uid: Uid): Promise<void> {
    if (t.uid === uid) return;
    await reportIsolation("token-owner", uid);
    throw new Error(`token owner mismatch`);
  }

  // A row as read: the tokens, owned, and the version a write over it must name.
  type Row = { t: UserTokens; read: StoredTokens };
  async function readRow(uid: Uid): Promise<Row | null> {
    const r = await store.get(uid);
    return r ? { t: own(uid, r), read: r } : null;
  }

  async function getStored(uid: Uid): Promise<UserTokens | null> {
    return (await readRow(uid))?.t ?? null;
  }

  /** A sign-in's write (the store lands it only while the user is live). */
  async function setTokens(uid: Uid, t: UserTokens): Promise<void> {
    await assertTokenOwner(t, uid);
    await store.set(uid, t);
    knownDead.delete(uid);
  }

  // The refresh token that last died for each user on the request path, so an open tab polling a
  // dead grant does not send it to Spotify's token endpoint at every request. Keyed by uid; the
  // tick's confirmation (tokenForTick) never reads it, so the question still reaches Spotify.
  const knownDead = new Map<Uid, string>();

  /** A terminal refresh failure on the request path: stop and keep (opts.onDeadGrant), or clear. */
  async function deadGrant(uid: Uid, attemptedRefreshToken: string): Promise<void> {
    if (!opts.onDeadGrant) return clearTokensIfStale(uid, attemptedRefreshToken);
    const current = await readRow(uid);
    if (!current || isFresh(current.t) || current.t.refreshToken !== attemptedRefreshToken) return;
    if (knownDead.get(uid) === attemptedRefreshToken) return;
    knownDead.set(uid, attemptedRefreshToken);
    await opts.onDeadGrant(uid);
  }

  /** The request path's refresh: refreshShared, unless this refresh token is already known dead. */
  function refreshForRequest(uid: Uid, refreshToken: string): Promise<UserTokens> {
    if (knownDead.get(uid) === refreshToken) return Promise.reject(new RefreshError(true, "invalid_grant (known)"));
    return refreshShared(uid);
  }

  // A refresh's write lands only over the row it read. If that row moved on (a sign-in wrote a
  // newer grant) or is gone (the deletion job), this refresh stores nothing and answers with
  // whatever fresh grant the row now holds.
  async function writeRefreshed(uid: Uid, updated: UserTokens, read: StoredTokens): Promise<UserTokens> {
    await assertTokenOwner(updated, uid);
    if (await store.update(uid, updated, read)) return updated;
    const now = await getStored(uid);
    if (now && isFresh(now)) return now;
    throw new RefreshError(false, "token row moved on during the refresh");
  }

  // Guard against a cross-process rotation race wiping good tokens. A terminal
  // `invalid_grant` only means the refresh token *we* sent is dead — but if another
  // process already refreshed successfully in the meantime, the stored refresh token
  // has moved on and is still valid. Only clear when what's stored is still the exact
  // token we just failed with; otherwise someone else won the race, so keep theirs.
  async function clearTokensIfStale(uid: Uid, attemptedRefreshToken: string): Promise<void> {
    const current = await readRow(uid);
    // A FRESH stored access token vetoes the clear regardless of the refresh-token compare:
    // Spotify doesn't always rotate refresh tokens, so a winner's successful refresh can
    // leave the same refresh token beside a brand-new access token — and the loser's
    // invalid_grant (a replay rejection) then matched on refreshToken and logged the user
    // out of a live session (wave-2 audit, B4).
    if (!current || isFresh(current.t)) return;
    if (current.t.refreshToken === attemptedRefreshToken) await store.clear(uid, current.read);
  }

  // In-process lock, per user: concurrent requests in THIS instance that all see the same
  // user's expired token share ONE refresh instead of each firing their own (which, with
  // Spotify's rotating PKCE refresh token, would invalidate each other and log the user out).
  const inflight = new Map<Uid, Promise<UserTokens>>();
  function refreshShared(uid: Uid): Promise<UserTokens> {
    let p = inflight.get(uid);
    if (!p) {
      p = coordinatedRefresh(uid).finally(() => {
        inflight.delete(uid);
      });
      inflight.set(uid, p);
    }
    return p;
  }

  // Cross-INSTANCE coordination for serverless: the in-process lock above only covers
  // one instance, but Vercel can run several. The DB is the shared source of truth, so:
  //   1) double-check the DB — another request/instance may have already refreshed;
  //   2) take a short-lived DB lock so only one refresh hits Spotify with a given
  //      rotating token; losers poll the DB for the winner's freshly-written token.
  // This is what stops concurrent cold starts from racing into invalid_grant.
  // No row means nothing to refresh: a row the deletion job removed is never written back.
  async function coordinatedRefresh(uid: Uid): Promise<UserTokens> {
    const first = await readRow(uid);
    if (!first) throw new RefreshError(false, "no token row");
    if (isFresh(first.t)) return first.t;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 30s, not 15: the refresh worst-case (3 attempts × 3s + backoff, plus the DB writes)
      // can overrun a 15s lease, and a holder past its lease writing tokens is the PKCE
      // collision the lock exists to prevent (wave-2 audit, B2).
      const lockOwner = await store.lock(uid, 30_000);
      if (lockOwner) {
        try {
          const current = await readRow(uid); // the winner may have just written
          if (!current) throw new RefreshError(false, "no token row");
          if (isFresh(current.t)) return current.t;
          const updated = own(uid, await refreshAccessToken(current.t.refreshToken));
          return await writeRefreshed(uid, updated, current.read);
        } finally {
          await store.unlock(uid, lockOwner);
        }
      }
      // Lost the lock — wait for whoever holds it to publish a fresh token. Two 16s waits
      // total 32s > the 30s lease, so by the time the loop falls through to the unilateral
      // last resort the holder's lease has genuinely expired (and the last resort re-reads
      // the STORE's current refresh token, not this caller's original — audit T2.13).
      const published = await waitForFreshToken(uid, 16_000);
      if (published) return published;
      // Holder stalled/crashed; loop to retry (its lock TTL has genuinely expired now).
    }
    // Last resort: refresh ourselves rather than fail the request — with the STORE's current
    // refresh token, not the one this caller started with, which the winner may have rotated.
    const latest = await readRow(uid);
    if (!latest) throw new RefreshError(false, "no token row");
    const updated = own(uid, await refreshAccessToken(latest.t.refreshToken));
    return writeRefreshed(uid, updated, latest.read);
  }

  // Freshness alone proves the winner published: callers only wait here after seeing an
  // expired stored token, so any fresh one is new. (Don't also require the refresh token
  // to have changed — Spotify doesn't always rotate it, and that check made losers stare
  // at a perfectly good token for the whole timeout, then refresh redundantly.)
  async function waitForFreshToken(uid: Uid, timeoutMs: number): Promise<UserTokens | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(500);
      const t = await getStored(uid);
      if (t && isFresh(t)) return t;
    }
    return null;
  }

  // Session-less access token for background jobs (the cron tick, library scans) that run
  // without a request. Reuses the same stored row and refresh lock as the request path, so
  // background and request refreshes coordinate (no PKCE rotation races). Null when the user
  // has no row or the refresh token is dead.
  async function getValidAccessToken(uid: Uid): Promise<UserTokens | null> {
    const stored = await getStored(uid);
    if (!stored) return null;
    if (isFresh(stored)) return stored;
    try {
      const fresh = await refreshForRequest(uid, stored.refreshToken);
      await assertTokenOwner(fresh, uid);
      return fresh;
    } catch (e) {
      if (e instanceof RefreshError && e.terminal) await deadGrant(uid, stored.refreshToken);
      return null;
    }
  }

  // The cron tick's read (PLAN.md §5.4 step 1, §7.2 step 3): the same row, lock and in-flight map
  // as getValidAccessToken, but every failure reaches the step, which treats each differently: a
  // dead grant throws the terminal RefreshError and clears nothing, so the user stops with the
  // blob kept for the confirming refresh 10 minutes later; a read that fails (a blob that does
  // not decrypt, the keys refusing, the store) throws as it is. Null only when there is no row.
  async function tokenForTick(uid: Uid): Promise<UserTokens | null> {
    const stored = await getStored(uid);
    if (!stored) return null;
    if (isFresh(stored)) return stored;
    const fresh = await refreshShared(uid);
    await assertTokenOwner(fresh, uid);
    return fresh;
  }

  return {
    getStored,
    setTokens,
    clearTokensIfStale,
    deadGrant,
    refreshShared,
    refreshForRequest,
    getValidAccessToken,
    tokenForTick,
    assertTokenOwner,
  };
}

export type TokenCore = ReturnType<typeof createTokenCore>;
