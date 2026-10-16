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
import { mintUid, type Uid } from "@/lib/identity";
import type { TokenStore } from "@/lib/token-core";
import { parseTokenKeys, type TokenKey } from "@/lib/token-crypto";

export const A: Uid = mintUid("aaaaaaaaaaaa");
export const B: Uid = mintUid("bbbbbbbbbbbb");

export const EXPIRED = 1_000; // epoch seconds, long past
export const FAR = 4_000_000_000;

/** One row per uid plus a lease per uid, as `user_tokens` and `lock:spotify_refresh:<uid>` will
 *  be in Phase 2. `writes` records every set/clear by uid. */
export function memoryTokenStore(initial: Record<string, SpotifyTokens>) {
  const rows = new Map<string, SpotifyTokens>(Object.entries(initial));
  const locks = new Map<string, { owner: string; until: number }>();
  const writes: { op: "set" | "clear"; uid: string }[] = [];
  const store: TokenStore = {
    async get(uid) {
      return rows.get(uid) ?? null;
    },
    async set(uid, t) {
      writes.push({ op: "set", uid });
      rows.set(uid, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
    },
    async clear(uid) {
      writes.push({ op: "clear", uid });
      rows.delete(uid);
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
 *  refresh token in `dead`), after `delayMs`, and every call is logged with the bearer it
 *  carried. Install with `vi.stubGlobal("fetch", spotify.fetch)`. */
export function scriptedSpotify(opts: { dead?: string[]; delayMs?: number } = {}) {
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
      return Response.json({ access_token: `at:${refreshToken}`, expires_in: 3600 });
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
