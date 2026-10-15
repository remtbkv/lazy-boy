// The token core keyed by user (PLAN.md §5.2, T5's token half). Before Phase 1 the in-flight
// refresh was one promise per process (auth.ts `inflightRefresh`): a second user's concurrent
// refresh would have joined the first's and received the first's tokens, the one leak in the
// census that is silent (01e A2). These run the core against a two-user store in memory.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenCore } from "@/lib/token-core";
import { A, B, EXPIRED, FAR, expectConcurrentRefreshIsolated, memoryTokenStore, scriptedSpotify } from "./harness";

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

  it("assertTokenOwner throws on a token another user's getter produced", () => {
    const { core } = setup({});
    const t = { uid: A, accessToken: "a", refreshToken: "r", expiresAt: FAR } as never;
    expect(() => core.assertTokenOwner(t, A)).not.toThrow();
    expect(() => core.assertTokenOwner(t, B)).toThrow(/owner/);
  });
});
