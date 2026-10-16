// The admin's token moved into user_tokens by the runtime, and back by the rollback flag
// (PLAN.md §11.4 step 3, "Rollback"; §5.3 security R9). The plaintext row is the simulated
// store's `meta` (db.ts, as production's `lazyboy.meta.spotify_tokens`).
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenCore } from "@/lib/token-core";
import { appTokenStore } from "@/lib/token-store-app";
import { copyAdminTokens, withAdminTokenMove } from "@/lib/token-move";
import { resetStore } from "../adversarial/helpers";
import { ownerStore, ownerUid } from "../owner-store";
import { B, EXPIRED, FAR, freshAppDb, scriptedSpotify, seedUser } from "./harness";

// The admin is OWNER_UID (tests/setup.ts), the one uid forUser maps to Rem's database, where
// his plaintext row lives.
const A = ownerUid();
const getSpotifyTokens = () => ownerStore().getSpotifyTokens();
const setSpotifyTokens = (t: typeof PLAIN) => ownerStore().setSpotifyTokens(t);

const PLAIN = { accessToken: "plain-at", refreshToken: "plain-rt", expiresAt: FAR };
let db: ReturnType<typeof freshAppDb>;
let logs: string[];
const q = async (sql: string, args: Record<string, string> = {}) => (await db.raw().execute({ sql, args })).rows;
const bridge = () => withAdminTokenMove(appTokenStore(), () => A);

beforeEach(async () => {
  await resetStore();
  db = freshAppDb();
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SPOTIFY_CLIENT_ID", "cid");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "cs");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
  await appTokenStore().get(B); // first open
  await seedUser(db.raw(), { uid: A, status: "active", admin: true });
  await seedUser(db.raw(), { uid: B, status: "active" });
  await setSpotifyTokens(PLAIN);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the copy (§11.4 step 3)", () => {
  it("the admin's first read encrypts his plaintext row, verifies it, logs it, and leaves the plaintext", async () => {
    expect(await bridge().get(A)).toMatchObject({ accessToken: "plain-at", refreshToken: "plain-rt", expiresAt: FAR });
    const [row] = await q("SELECT blob FROM user_tokens WHERE uid = :u", { u: A });
    expect(String(row.blob)).toMatch(/^v1\./);
    expect(logs).toContain(`[token-move] admin ${A}: the blob written decrypts to the plaintext row`);
    expect(String((await q("SELECT value FROM app_meta WHERE key = :k", { k: `token_copy:${A}` }))[0].value)).toMatch(/^copied:/);
    expect(await getSpotifyTokens()).toEqual(PLAIN);
  });

  it("runs once ever: a later clear of a dead grant does not bring the plaintext token back", async () => {
    const store = bridge();
    await store.get(A);
    await store.clear(A, (await store.get(A))!);
    expect(await bridge().get(A)).toBeNull();
    expect(await copyAdminTokens(A)).toBe("ran-before");
  });

  it("Log out removes the admin's row and his plaintext copy, which never comes back; a friend's removes only their own row", async () => {
    const store = bridge();
    await store.get(A);
    await appTokenStore().set(B, { accessToken: "b-at", refreshToken: "b-rt", expiresAt: FAR });
    await store.remove(B);
    expect(await appTokenStore().get(B)).toBeNull();
    expect(await getSpotifyTokens()).toEqual(PLAIN);
    await store.remove(A);
    expect(await appTokenStore().get(A)).toBeNull();
    expect(await getSpotifyTokens()).toBeNull();
    expect(await bridge().get(A)).toBeNull();
  });

  it("never overwrites a row a sign-in wrote first", async () => {
    await appTokenStore().set(A, { accessToken: "signin-at", refreshToken: "signin-rt", expiresAt: FAR });
    expect((await bridge().get(A))?.accessToken).toBe("signin-at");
    expect(String((await q("SELECT value FROM app_meta WHERE key = :k", { k: `token_copy:${A}` }))[0].value)).toMatch(/^row-present:/);
  });

  it("only the admin's row is copied, and nothing without a plaintext row or a live admin", async () => {
    expect(await bridge().get(B)).toBeNull();
    expect(await q("SELECT uid FROM user_tokens")).toEqual([]);
    await resetStore();
    expect(await copyAdminTokens(A)).toBe("no-plaintext");
    await setSpotifyTokens(PLAIN);
    await q("UPDATE users SET status = 'disabled' WHERE uid = :u", { u: A });
    expect(await copyAdminTokens(A)).toBe("no-live-user");
    expect(await q("SELECT key FROM app_meta WHERE key LIKE 'token_copy:%'")).toEqual([]);
  });

  it("the copied token refreshes like any other", async () => {
    await setSpotifyTokens({ ...PLAIN, expiresAt: EXPIRED });
    const spotify = scriptedSpotify();
    vi.stubGlobal("fetch", spotify.fetch);
    expect((await createTokenCore(bridge()).getValidAccessToken(A))?.accessToken).toBe("at:plain-rt");
  });
});

describe("the rollback flag (§11.4 Rollback)", () => {
  it("writes the plaintext row back from the blob, then mirrors every later write of the admin's tokens", async () => {
    await appTokenStore().set(A, { accessToken: "blob-at", refreshToken: "blob-rt", expiresAt: EXPIRED });
    await setSpotifyTokens({ accessToken: "stale", refreshToken: "stale", expiresAt: 1 });
    vi.stubEnv("LB_TOKEN_ROLLBACK", "1");
    const store = bridge();
    await store.get(A);
    expect(await getSpotifyTokens()).toEqual({ accessToken: "blob-at", refreshToken: "blob-rt", expiresAt: EXPIRED });
    expect(logs).toContain(`[token-move] rollback: admin ${A}'s plaintext row written back from the blob`);
    vi.stubGlobal("fetch", scriptedSpotify().fetch);
    await createTokenCore(store).getValidAccessToken(A);
    expect((await getSpotifyTokens())?.accessToken).toBe("at:blob-rt");
  });

  it("touches no other user's row and copies nothing", async () => {
    vi.stubEnv("LB_TOKEN_ROLLBACK", "1");
    await bridge().set(B, { accessToken: "b", refreshToken: "b", expiresAt: FAR });
    expect(await getSpotifyTokens()).toEqual(PLAIN);
    expect(await bridge().get(A)).toBeNull();
    expect(await q("SELECT uid FROM user_tokens WHERE uid = :u", { u: A })).toEqual([]);
  });
});
