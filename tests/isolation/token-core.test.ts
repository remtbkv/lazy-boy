// The token core keyed by user (PLAN.md §5.2, T5's token half). Before Phase 1 the in-flight
// refresh was one promise per process (auth.ts `inflightRefresh`): a second user's concurrent
// refresh would have joined the first's and received the first's tokens, the one leak in the
// census that is silent (01e A2). These run the core against a two-user store in memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { mintUid } from "@/lib/identity";
import { createTokenCore } from "@/lib/token-core";
import {
  A,
  B,
  EXPIRED,
  FAR,
  expectConcurrentRefreshIsolated,
  expectRefreshLosesToSignIn,
  expectStoreAnswersOwnRow,
  freshAppDb,
  memoryTokenStore,
  scriptedSpotify,
  until,
} from "./harness";

let spotify: ReturnType<typeof scriptedSpotify>;
beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = "cid";
  process.env.SPOTIFY_CLIENT_SECRET = "csecret";
});
afterEach(() => vi.unstubAllGlobals());

function setup(rows: Parameters<typeof memoryTokenStore>[0], opts?: Parameters<typeof scriptedSpotify>[0]) {
  spotify = scriptedSpotify({ delayMs: 20, ...opts });
  vi.stubGlobal("fetch", spotify.fetch);
  const mem = memoryTokenStore(rows);
  return { ...mem, core: createTokenCore(mem.store) };
}

describe("token core, two users in one process", () => {
  it("concurrent refreshes: each user ends with their own token, one token call each", async () => {
    const { core, rows } = setup({
      [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED },
      [B]: { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED },
    });
    await expectConcurrentRefreshIsolated((uid) => core.getValidAccessToken(uid), spotify);
    expect(rows.get(A)?.accessToken).toBe("at:rt-A");
    expect(rows.get(B)?.accessToken).toBe("at:rt-B");
  });

  it("many concurrent calls for one user still share one refresh", async () => {
    const { core } = setup({ [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED } });
    const got = await Promise.all([1, 2, 3, 4].map(() => core.getValidAccessToken(A)));
    expect(new Set(got.map((t) => t?.accessToken))).toEqual(new Set(["at:rt-A"]));
    expect(spotify.calls.filter((c) => c.url.includes("/api/token"))).toHaveLength(1);
  });

  it("A's refresh lock held elsewhere does not delay B", async () => {
    const { core, store } = setup({
      [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED },
      [B]: { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED },
    });
    expect(await store.lock(A, 30_000)).not.toBeNull();
    const t0 = Date.now();
    const b = await core.getValidAccessToken(B);
    expect(b?.accessToken).toBe("at:rt-B");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("invalid_grant for A clears A's row only", async () => {
    const { core, rows, writes } = setup(
      {
        [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED },
        [B]: { accessToken: "live-B", refreshToken: "rt-B", expiresAt: FAR },
      },
      { dead: ["rt-A"] },
    );
    expect(await core.getValidAccessToken(A)).toBeNull();
    expect(rows.has(A)).toBe(false);
    expect(rows.get(B)?.accessToken).toBe("live-B");
    expect(writes.filter((w) => w.uid === B)).toEqual([]);
  });

  it("no row means no Spotify call", async () => {
    const { core } = setup({});
    expect(await core.getValidAccessToken(A)).toBeNull();
    expect(spotify.calls).toHaveLength(0);
  });

  it("a fresh token is returned with its owner, with no call", async () => {
    const { core } = setup({ [B]: { accessToken: "live-B", refreshToken: "rt-B", expiresAt: FAR } });
    expect(await core.getValidAccessToken(B)).toEqual({
      uid: B,
      accessToken: "live-B",
      refreshToken: "rt-B",
      expiresAt: FAR,
    });
    expect(spotify.calls).toHaveLength(0);
  });

  it("setTokens refuses a token object that names another user", async () => {
    const { core, rows } = setup({ [A]: { accessToken: "a", refreshToken: "rt-A", expiresAt: FAR } });
    await expect(
      core.setTokens(B, { uid: A, accessToken: "a", refreshToken: "rt-A", expiresAt: FAR } as never),
    ).rejects.toThrow(/owner/);
    expect(rows.has(B)).toBe(false);
  });

  it("a token-owner refusal is an isolation event: the caller's uid and the code, no token (PLAN.md §6.5)", async () => {
    const db = freshAppDb();
    await getAppMeta("tick_at"); // the app database opens empty, so a missing row is the answer
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" ")));
    const { core } = setup({});
    await expect(
      core.setTokens(B, { uid: A, accessToken: "at-secret", refreshToken: "rt-secret", expiresAt: FAR } as never),
    ).rejects.toThrow(/owner/);
    expect((await db.raw().execute("SELECT uid, code FROM events")).rows).toEqual([{ uid: B, code: "token-owner" }]);
    expect(logged).toContain(`[isolation] token-owner uid=${B}`);
    expect(logged.join("\n")).not.toMatch(/secret/);
    db.close();
    vi.restoreAllMocks();
  });

  it("assertTokenOwner throws on a token another user's getter produced", async () => {
    const { core } = setup({});
    const t = { uid: A, accessToken: "a", refreshToken: "r", expiresAt: FAR } as never;
    await expect(core.assertTokenOwner(t, A)).resolves.toBeUndefined();
    await expect(core.assertTokenOwner(t, B)).rejects.toThrow(/owner/);
  });
});

describe("conditional writes (PLAN.md §5.2; security R3, R4)", () => {
  it("a refresh finishing after a sign-in leaves the sign-in's grant", async () => {
    const { store } = setup({}, { delayMs: 50 });
    await expectRefreshLosesToSignIn(store, spotify);
  });

  it("a refresh finishing after the row is gone stores nothing", async () => {
    const { core, store, rows } = setup({ [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED } }, { delayMs: 50 });
    const refreshing = core.getValidAccessToken(A);
    await until(() => spotify.calls.length > 0);
    await store.clear(A, (await store.get(A))!); // the deletion job's first step
    expect(await refreshing).toBeNull();
    expect(rows.has(A)).toBe(false);
  });

  it("a dead grant's clear does not take a sign-in that landed meanwhile", async () => {
    const { core, store } = setup({ [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED } }, { dead: ["rt-A"], delayMs: 50 });
    const refreshing = core.getValidAccessToken(A);
    await until(() => spotify.calls.length > 0);
    await store.set(A, { accessToken: "signin-A", refreshToken: "rt-A2", expiresAt: FAR });
    await refreshing;
    expect((await store.get(A))?.accessToken).toBe("signin-A");
  });

  it("each store answers each uid with its own row", async () => {
    const { store } = setup({});
    await expectStoreAnswersOwnRow(store);
  });
});

describe("the tick's token read (PLAN.md §5.4 step 1, §7.2 step 3)", () => {
  it("a fresh token as stored; an expiring one refreshed; no row, null", async () => {
    const { core } = setup({
      [A]: { accessToken: "at-A", refreshToken: "rt-A", expiresAt: FAR },
      [B]: { accessToken: "old-B", refreshToken: "rt-B", expiresAt: EXPIRED },
    });
    expect((await core.tokenForTick(A))?.accessToken).toBe("at-A");
    expect(await core.tokenForTick(B)).toMatchObject({ uid: B, accessToken: "at:rt-B" });
    expect(await core.tokenForTick(mintUid("cccccccccccc"))).toBeNull();
  });

  it("invalid_grant stops and keeps: it throws the terminal error and leaves the row for the confirmation", async () => {
    const { core, rows, writes } = setup({ [A]: { accessToken: "old-A", refreshToken: "rt-A", expiresAt: EXPIRED } }, { dead: ["rt-A"] });
    await expect(core.tokenForTick(A)).rejects.toMatchObject({ name: "RefreshError", terminal: true });
    expect(rows.get(A)?.refreshToken).toBe("rt-A");
    expect(writes.filter((w) => w.op === "clear")).toEqual([]);
    // The request path's read still clears a dead grant (single-user behaviour, unchanged here).
    expect(await core.getValidAccessToken(A)).toBeNull();
    expect(rows.has(A)).toBe(false);
  });

  it("a store that fails the read throws, so the step can tell it from no row", async () => {
    const { core, store } = setup({});
    store.get = async () => {
      throw new Error("token blob does not decrypt: bad tag");
    };
    await expect(core.tokenForTick(A)).rejects.toThrow(/does not decrypt/);
  });
});
