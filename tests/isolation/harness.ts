// Shared pieces of the isolation suite (PLAN.md §6.4 "What the harness gains"): a two-user
// token store in memory, a scripted Spotify that answers per bearer and logs which bearer each
// call carried, and the check functions the planted-bug self-test runs against broken
// implementations (tests/isolation/planted-bugs.test.ts).
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, vi } from "vitest";
import type { SpotifyTokens } from "@/lib/db";
import { mintUid, type IdentityVerdict, type SessionClaims, type Uid } from "@/lib/identity";
import { createTokenCore, type TokenStore } from "@/lib/token-core";
import { parseTokenKeys, type TokenKey } from "@/lib/token-crypto";

export const A: Uid = mintUid("aaaaaaaaaaaa");
export const B: Uid = mintUid("bbbbbbbbbbbb");

export const EXPIRED = 1_000; // epoch seconds, long past
export const FAR = 4_000_000_000;

/** One row per uid plus a lease per uid, as `user_tokens` and `lock:spotify_refresh:<uid>` will
 *  be in Phase 2. `writes` records every set/clear by uid. */
export function memoryTokenStore(initial: Record<string, SpotifyTokens>) {
  const rows = new Map<string, SpotifyTokens>(Object.entries(initial));
  // Each row's version (Phase 2: its blob): a refresh writes and a clear deletes only over the
  // version it read.
  const revs = new Map<string, number>([...rows.keys()].map((k) => [k, 0]));
  let rev = 0;
  const locks = new Map<string, { owner: string; until: number }>();
  const writes: { op: "set" | "update" | "clear"; uid: string }[] = [];
  const put = (uid: string, t: SpotifyTokens) => {
    rows.set(uid, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    revs.set(uid, ++rev);
  };
  const store: TokenStore = {
    async get(uid) {
      const t = rows.get(uid);
      return t ? { ...t, rev: String(revs.get(uid)) } : null;
    },
    async set(uid, t) {
      writes.push({ op: "set", uid });
      put(uid, t);
    },
    async update(uid, t, read) {
      if (String(revs.get(uid)) !== read.rev || !rows.has(uid)) return false;
      writes.push({ op: "update", uid });
      put(uid, t);
      return true;
    },
    async clear(uid, read) {
      if (String(revs.get(uid)) !== read.rev) return;
      writes.push({ op: "clear", uid });
      rows.delete(uid);
      revs.delete(uid);
    },
    async lock(uid, ttlMs) {
      const l = locks.get(uid);
      if (l && l.until > Date.now()) return null;
      const owner = Math.random().toString(36).slice(2);
      locks.set(uid, { owner, until: Date.now() + ttlMs });
      return owner;
    },
    async unlock(uid, owner) {
      if (locks.get(uid)?.owner === owner) locks.delete(uid);
    },
  };
  return { store, rows, locks, writes };
}

export type SpotifyCall = { url: string; bearer: string | null; refreshToken: string | null };

/** A scripted Spotify: the token endpoint answers `at:<refresh token>` (or invalid_grant for a
 *  refresh token in `dead`; with `rotate`, also a new refresh token `<old>+`), after `delayMs`,
 *  and every call is logged with the bearer it carried. Install with
 *  `vi.stubGlobal("fetch", spotify.fetch)`. */
export function scriptedSpotify(opts: { dead?: string[]; delayMs?: number; rotate?: boolean } = {}) {
  const calls: SpotifyCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    let refreshToken: string | null = null;
    if (init?.body instanceof URLSearchParams) refreshToken = init.body.get("refresh_token");
    calls.push({ url, bearer, refreshToken });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (url.startsWith("https://accounts.spotify.com/api/token")) {
      if (refreshToken && opts.dead?.includes(refreshToken)) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: `at:${refreshToken}`,
        expires_in: 3600,
        ...(opts.rotate ? { refresh_token: `${refreshToken}+` } : {}),
      });
    }
    // A data call answers with the bearer's owner, so a test can see whose account it reached.
    return Response.json({ bearer });
  };
  return { calls, fetch: vi.fn(fetchImpl) };
}

/** Point app-db.ts at a fresh app database file (PLAN.md §6.4: the harness's `app.db`), created
 *  at first use by the production open path, and hand back a raw client on the same file for
 *  seeding and for reading what the code wrote. */
export function freshAppDb(): { url: string; raw: () => Client; close: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "lazyboy-app-"));
  const url = `file:${path.join(dir, "app.db")}`;
  process.env.APP_DATABASE_URL = url;
  let c: Client | null = null;
  return {
    url,
    raw: () => (c ??= createClient({ url, intMode: "number" })),
    close: () => c?.close(),
  };
}

/** A users row, seeded raw (provisioning itself is Phase 4a's invite script). */
export async function seedUser(
  raw: Client,
  u: { uid: string; status: string; admin?: boolean; epoch?: number; accountId?: string | null; spotifyId?: string; statusAt?: number },
): Promise<void> {
  await raw.execute({
    sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
          VALUES (:uid, :aid, :sid, :db, :status, :at, :admin, :ep, 0)`,
    args: {
      uid: u.uid,
      aid: u.accountId === undefined ? `acct-${u.uid}` : u.accountId,
      sid: u.spotifyId ?? `sp-${u.uid}`,
      db: u.admin ? "lazyboy" : `lb-u-${u.uid}`,
      status: u.status,
      at: u.statusAt ?? 0,
      admin: u.admin ? 1 : 0,
      ep: u.epoch ?? 0,
    },
  });
}

type Pair = { accessToken: string; refreshToken: string };
export type Cipher = {
  encrypt: (keys: TokenKey[], uid: string, t: Pair) => string;
  decrypt: (keys: TokenKey[], uid: string, blob: string) => Pair;
};
const testKeys = () => parseTokenKeys(`v1:${randomBytes(32).toString("base64")}`);

/** The associated data's contract (PLAN.md §5.3): A's ciphertext copied into B's row does not
 *  decrypt as B, so write access to the app database without the key cannot graft one user's
 *  grant onto another's account. */
export function expectCiphertextBoundToUser(c: Cipher): void {
  const keys = testKeys();
  const blob = c.encrypt(keys, A, { accessToken: "at-A", refreshToken: "rt-A" });
  expect(c.decrypt(keys, A, blob)).toEqual({ accessToken: "at-A", refreshToken: "rt-A" });
  expect(() => c.decrypt(keys, B, blob)).toThrow();
}

/** GCM's contract: never two writes under one key with the same IV. */
export function expectFreshIvPerWrite(encrypt: Cipher["encrypt"]): void {
  const keys = testKeys();
  const ivs = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const blob = encrypt(keys, A, { accessToken: "at-A", refreshToken: "rt-A" });
    ivs.add(Buffer.from(blob.slice(blob.indexOf(".") + 1), "base64url").subarray(0, 12).toString("hex"));
  }
  expect(ivs.size).toBe(64);
}

export async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Security R4 (PLAN.md §5.2): a refresh that read the old grant before a sign-in cannot
 *  overwrite the new one. A's token is expired; while its refresh is at Spotify, A signs in
 *  again; afterwards the row holds the sign-in's grant and the refresh answers with it. Needs a
 *  scripted Spotify with a delay, and A live in `store`. */
export async function expectRefreshLosesToSignIn(
  store: TokenStore,
  spotify: ReturnType<typeof scriptedSpotify>,
): Promise<void> {
  const core = createTokenCore(store);
  await store.set(A, { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED });
  const refreshing = core.getValidAccessToken(A);
  await until(() => spotify.calls.some((c) => c.url.includes("/api/token")));
  await store.set(A, { accessToken: "signin-A", refreshToken: "rt-A2", expiresAt: FAR });
  expect((await refreshing)?.accessToken).toBe("signin-A");
  expect(await store.get(A)).toMatchObject({ accessToken: "signin-A", refreshToken: "rt-A2", expiresAt: FAR });
}

/** A store answers each uid with that uid's own row, and nothing once that row is gone. */
export async function expectStoreAnswersOwnRow(store: TokenStore): Promise<void> {
  await store.set(A, { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
  await store.set(B, { accessToken: "at-B", refreshToken: "rt-B", expiresAt: FAR });
  expect((await store.get(A))?.accessToken).toBe("at-A");
  expect((await store.get(B))?.accessToken).toBe("at-B");
  await store.clear(A, (await store.get(A))!);
  expect(await store.get(A)).toBeNull();
  expect((await store.get(B))?.accessToken).toBe("at-B");
}

/** SIGNUPS=owner, the one-variable freeze (PLAN.md §12.1): unset or `owner`, the identity read
 *  refuses a friend's otherwise live cookie whatever the row says and still admits the admin;
 *  `invite` admits the friend (the positive control). Needs both rows live in the app database. */
export async function expectSignupsOwnerRefusesFriend(
  read: (claims: SessionClaims) => Promise<IdentityVerdict>,
  c: { admin: SessionClaims; friend: SessionClaims },
): Promise<void> {
  for (const mode of ["", "owner"]) {
    vi.stubEnv("SIGNUPS", mode);
    expect(await read(c.friend)).toEqual({ kind: "refused", reason: "signups" });
    expect((await read(c.admin)).kind).toBe("allowed");
  }
  vi.stubEnv("SIGNUPS", "invite");
  expect((await read(c.friend)).kind).toBe("allowed");
}

/** One sentinel per configured key (PLAN.md §5.3): a wrong key refuses to serve wherever it sits
 *  in TOKEN_KEYS, not only first. After a rotation the older key is second and every blob not yet
 *  re-encrypted needs it. Needs `TOKEN_KEYS` = one good `v1` key whose sentinel `ready` wrote. */
export async function expectWrongOlderKeyRefuses(ready: () => Promise<TokenKey[]>): Promise<void> {
  const good = process.env.TOKEN_KEYS!;
  const v2 = `v2:${randomBytes(32).toString("base64")}`;
  vi.stubEnv("TOKEN_KEYS", `${v2},v1:${randomBytes(32).toString("base64")}`);
  await expect(ready()).rejects.toThrow(/key v1 does not open its sentinel/);
  vi.stubEnv("TOKEN_KEYS", `${v2},${good}`);
  expect((await ready()).map((k) => k.id)).toEqual(["v2", "v1"]);
}

/** The core's contract that a shared in-flight promise breaks (01e A2, PLAN.md §5.2): two users
 *  whose tokens are both expired, refreshed at the same moment in one process, each end with
 *  their own token, after one token-endpoint call each. */
export async function expectConcurrentRefreshIsolated(
  getValid: (uid: Uid) => Promise<{ uid: string; accessToken: string } | null>,
  spotify: ReturnType<typeof scriptedSpotify>,
): Promise<void> {
  const [a, b] = await Promise.all([getValid(A), getValid(B)]);
  expect(a?.uid).toBe(A);
  expect(a?.accessToken).toBe("at:rt-A");
  expect(b?.uid).toBe(B);
  expect(b?.accessToken).toBe("at:rt-B");
  const tokenCalls = spotify.calls.filter((c) => c.url.includes("/api/token"));
  expect(tokenCalls.map((c) => c.refreshToken).sort()).toEqual(["rt-A", "rt-B"]);
}
