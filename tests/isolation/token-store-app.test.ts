// T5's token half over Phase 2's real store (PLAN.md §5.2-5.3): `user_tokens` in a throwaway app
// database, encrypted under a test key, run through the token core with a scripted Spotify.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveStatus } from "@/lib/app-db";
import { createTokenCore, type TokenStore } from "@/lib/token-core";
import { DecryptError } from "@/lib/token-crypto";
import { TokenKeyError } from "@/lib/token-keys";
import { appTokenStore } from "@/lib/token-store-app";
import {
  A,
  B,
  EXPIRED,
  FAR,
  expectConcurrentRefreshIsolated,
  expectRefreshLosesToSignIn,
  expectStoreAnswersOwnRow,
  freshAppDb,
  scriptedSpotify,
  seedUser,
  until,
} from "./harness";

const key = () => `v1:${randomBytes(32).toString("base64")}`;
let db: ReturnType<typeof freshAppDb>;
let store: TokenStore;
let errors: string[];
const rows = async (sql: string, args: Record<string, string> = {}) => (await db.raw().execute({ sql, args })).rows;

function spotifyWith(opts: Parameters<typeof scriptedSpotify>[0] = {}) {
  const s = scriptedSpotify({ delayMs: 20, ...opts });
  vi.stubGlobal("fetch", s.fetch);
  return s;
}

beforeEach(async () => {
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", key());
  vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "cs");
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
  store = appTokenStore();
  await store.get(A); // first open: schema, then the sentinel
  await seedUser(db.raw(), { uid: A, status: "active", admin: true });
  await seedUser(db.raw(), { uid: B, status: "active" });
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the row is ciphertext under the user's associated data", () => {
  it("stores v1.<base64url>, never a token in the clear, and reads back its owner's tokens", async () => {
    await store.set(A, { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
    const [r] = await rows("SELECT blob, expires_at FROM user_tokens WHERE uid = :u", { u: A });
    expect(String(r.blob)).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(String(r.blob)).not.toMatch(/at-A|rt-A/);
    expect(r.expires_at).toBe(FAR);
    expect(await store.get(A)).toMatchObject({ accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
  });

  it("each uid gets its own row", async () => {
    await expectStoreAnswersOwnRow(store);
  });
});

describe("T5: the token core over user_tokens", () => {
  it("two users' concurrent refreshes each end with their own token, one call each", async () => {
    const s = spotifyWith();
    await store.set(A, { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED });
    await store.set(B, { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED });
    const core = createTokenCore(store);
    await expectConcurrentRefreshIsolated((uid) => core.getValidAccessToken(uid), s);
    expect((await store.get(A))?.accessToken).toBe("at:rt-A");
    expect((await store.get(B))?.accessToken).toBe("at:rt-B");
  });

  it("A's refresh lock held does not delay B", async () => {
    spotifyWith();
    await store.set(B, { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED });
    expect(await store.lock(A, 30_000)).not.toBeNull();
    const t0 = Date.now();
    expect((await createTokenCore(store).getValidAccessToken(B))?.accessToken).toBe("at:rt-B");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("invalid_grant for A clears A's row only", async () => {
    spotifyWith({ dead: ["rt-A"] });
    await store.set(A, { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED });
    await store.set(B, { accessToken: "live-B", refreshToken: "rt-B", expiresAt: FAR });
    const blobB = (await rows("SELECT blob FROM user_tokens WHERE uid = :u", { u: B }))[0].blob;
    expect(await createTokenCore(store).getValidAccessToken(A)).toBeNull();
    expect(await store.get(A)).toBeNull();
    expect((await rows("SELECT blob FROM user_tokens WHERE uid = :u", { u: B }))[0].blob).toBe(blobB);
  });

  it("no row means no Spotify call", async () => {
    const s = spotifyWith();
    expect(await createTokenCore(store).getValidAccessToken(B)).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("a refresh finishing after a sign-in leaves the sign-in's grant and its granted_at", async () => {
    const s = spotifyWith({ delayMs: 60 });
    await expectRefreshLosesToSignIn(store, s);
    const [r] = await rows("SELECT granted_at FROM user_tokens WHERE uid = :u", { u: A });
    expect(Math.abs(Number(r.granted_at) - Date.now() / 1000)).toBeLessThan(5);
  });

  it("a refresh finishing after the deletion job's first step stores nothing", async () => {
    const s = spotifyWith({ delayMs: 60 });
    await store.set(B, { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED });
    const refreshing = createTokenCore(store).getValidAccessToken(B);
    await until(() => s.calls.length > 0);
    expect(await moveStatus(B, "active", "deleting", Date.now())).toBe(true);
    await db.raw().execute({ sql: "DELETE FROM user_tokens WHERE uid = ?", args: [B] });
    expect(await refreshing).toBeNull();
    expect(await rows("SELECT uid FROM user_tokens WHERE uid = :u", { u: B })).toEqual([]);
  });

  it("a sign-in landing after the deletion job's first step stores nothing", async () => {
    expect(await moveStatus(B, "active", "deleting", Date.now())).toBe(true);
    await expect(store.set(B, { accessToken: "a", refreshToken: "r", expiresAt: FAR })).rejects.toThrow(/no live user/);
    expect(await rows("SELECT uid FROM user_tokens")).toEqual([]);
  });
});

describe("granted_at moves only with a new refresh token (PLAN.md §5.2)", () => {
  const granted = async () => Number((await rows("SELECT granted_at FROM user_tokens WHERE uid = :u", { u: A }))[0].granted_at);
  const age = async (seconds: number) =>
    db.raw().execute({ sql: "UPDATE user_tokens SET granted_at = granted_at - ? WHERE uid = ?", args: [seconds, A] });

  it("a sign-in with the same refresh token keeps it; a new one moves it", async () => {
    await store.set(A, { accessToken: "a1", refreshToken: "rt-A", expiresAt: FAR });
    await age(1_000);
    const before = await granted();
    await store.set(A, { accessToken: "a2", refreshToken: "rt-A", expiresAt: FAR });
    expect(await granted()).toBe(before);
    await store.set(A, { accessToken: "a3", refreshToken: "rt-A-new", expiresAt: FAR });
    expect(await granted()).toBeGreaterThan(before);
  });

  it("a refresh keeps it unless Spotify hands back a new refresh token", async () => {
    await store.set(A, { accessToken: "old", refreshToken: "rt-A", expiresAt: EXPIRED });
    await age(1_000);
    const before = await granted();
    spotifyWith();
    await createTokenCore(store).getValidAccessToken(A);
    expect(await granted()).toBe(before);
    await db.raw().execute({ sql: "UPDATE user_tokens SET expires_at = 1 WHERE uid = ?", args: [A] });
    spotifyWith({ rotate: true });
    expect((await createTokenCore(store).getValidAccessToken(A))?.refreshToken).toBe("rt-A+");
    expect(await granted()).toBeGreaterThan(before);
  });
});

describe("a blob that fails to decrypt (PLAN.md §5.3)", () => {
  it("A's ciphertext in B's row: a decrypt event with B's uid and no blob; nothing of B's written", async () => {
    await store.set(A, { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
    const blobA = String((await rows("SELECT blob FROM user_tokens WHERE uid = :u", { u: A }))[0].blob);
    await db.raw().execute({ sql: "INSERT INTO user_tokens VALUES (?, ?, ?, 0)", args: [B, blobA, EXPIRED] });
    const userB = await rows("SELECT * FROM users WHERE uid = :u", { u: B });
    const s = spotifyWith();

    await expect(createTokenCore(store).getValidAccessToken(B)).rejects.toBeInstanceOf(DecryptError);

    expect(await rows("SELECT uid, code FROM events")).toEqual([{ uid: B, code: "decrypt" }]);
    expect(errors.join("\n")).not.toContain(blobA.slice(3, 24));
    expect(await rows("SELECT * FROM users WHERE uid = :u", { u: B })).toEqual(userB);
    expect((await rows("SELECT blob FROM user_tokens WHERE uid = :u", { u: B }))[0].blob).toBe(blobA);
    expect(s.calls).toHaveLength(0);
  });
});

describe("TOKEN_KEYS sentinels (PLAN.md §5.3)", () => {
  it("the first runtime holding a key writes its sentinel", async () => {
    const r = await rows("SELECT key, value FROM app_meta WHERE key LIKE 'sentinel:%'");
    expect(r.map((x) => x.key)).toEqual(["sentinel:v1"]);
    expect(String(r[0].value)).toMatch(/^v1\./);
  });

  it("a wrong key refuses every read and write and leaves users active; the right key resumes with no sign-in", async () => {
    const good = process.env.TOKEN_KEYS!;
    await store.set(A, { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
    vi.stubEnv("TOKEN_KEYS", key()); // same id, wrong bytes
    await expect(store.get(A)).rejects.toBeInstanceOf(TokenKeyError);
    await expect(store.set(B, { accessToken: "x", refreshToken: "y", expiresAt: FAR })).rejects.toBeInstanceOf(TokenKeyError);
    expect(errors.some((e) => /does not open its sentinel: refusing to serve/.test(e))).toBe(true);
    expect((await rows("SELECT status FROM users ORDER BY uid")).map((x) => x.status)).toEqual(["active", "active"]);
    expect(await rows("SELECT code FROM events")).toEqual([]);
    vi.stubEnv("TOKEN_KEYS", good);
    expect((await store.get(A))?.accessToken).toBe("at-A");
  });

  it("missing or malformed keys refuse", async () => {
    for (const bad of ["", "v1:short", "v1"]) {
      vi.stubEnv("TOKEN_KEYS", bad);
      await expect(store.get(A), bad).rejects.toBeInstanceOf(TokenKeyError);
    }
  });

  it("a new key put first: its sentinel is written, old blobs read, new writes take it", async () => {
    const v1 = process.env.TOKEN_KEYS!;
    await store.set(A, { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR });
    vi.stubEnv("TOKEN_KEYS", `v2:${randomBytes(32).toString("base64")},${v1}`);
    expect((await store.get(A))?.accessToken).toBe("at-A");
    expect((await rows("SELECT key FROM app_meta WHERE key LIKE 'sentinel:%' ORDER BY key")).map((x) => x.key)).toEqual([
      "sentinel:v1",
      "sentinel:v2",
    ]);
    await store.set(B, { accessToken: "at-B", refreshToken: "rt-B", expiresAt: FAR });
    expect(String((await rows("SELECT blob FROM user_tokens WHERE uid = :u", { u: B }))[0].blob)).toMatch(/^v2\./);
  });
});
