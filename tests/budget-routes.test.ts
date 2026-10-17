// The route halves of economy and freeze (docs/multi-user/CAPACITY.md §6): /api/now-playing's
// reply carries the floor the poller must not undercut, and /api/sync's carries SyncOnLoad's
// interval, with freeze stopping the on-load sync. The client halves are in
// budget-modes.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: null as string | null,
  modeReads: 0,
  signedIn: true,
  playing: null as unknown,
  harvests: 0,
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => (state.signedIn ? { user: {}, uid: "aaaaaaaaaaaa", admin: true } : null),
  spotifyAccessTokenFor: async () => "tok",
}));
vi.mock("@/lib/spotify", () => ({
  SpotifyError: class SpotifyError extends Error {
    status = 0;
  },
  spotifyCooldownMs: () => 0,
  spotifyClient: () => ({ currentlyPlaying: async () => state.playing, contextName: async () => null }),
}));
vi.mock("@/lib/db", () => ({
  getBudgetMode: async () => {
    state.modeReads++;
    return state.mode;
  },
  forUser: () => ({
    getContextName: async () => "Mix",
    recordContexts: async () => {},
    setUserTzOffset: async () => {},
    getLastSync: async () => null,
    ledgerSyncCall: async () => {},
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/sync/history", () => ({
  syncRecentPlays: async () => {
    state.harvests++;
    return { added: 1 };
  },
}));

const { GET: nowPlaying } = await import("@/app/api/now-playing/route");
const { POST: sync } = await import("@/app/api/sync/route");

const PLAYING = { track: { id: "t1" }, isPlaying: true, progressMs: 1, durationMs: 200_000, context: null };

beforeEach(() => {
  state.mode = null;
  state.modeReads = 0;
  state.signedIn = true;
  state.playing = PLAYING;
  state.harvests = 0;
});

describe("/api/now-playing carries the poll floor", () => {
  it.each([
    [null, 0],
    ["normal", 0],
    ["economy", 30_000],
    ["freeze", 60_000],
  ])("mode %s: minPollMs %d, playing or not", async (mode, floor) => {
    state.mode = mode;
    expect((await (await nowPlaying()).json()).minPollMs).toBe(floor);
    state.playing = null;
    const idle = await (await nowPlaying()).json();
    expect(idle).toMatchObject({ playing: null, minPollMs: floor });
  });

  it("a signed-out caller still costs no store read", async () => {
    state.signedIn = false;
    state.mode = "freeze";
    expect(await (await nowPlaying()).json()).toMatchObject({ playing: null, minPollMs: 0 });
    expect(state.modeReads).toBe(0);
  });
});

describe("/api/sync carries SyncOnLoad's interval", () => {
  it.each([
    [null, 120_000],
    ["normal", 120_000],
    ["economy", 300_000],
  ])("mode %s: intervalMs %d, and it syncs", async (mode, interval) => {
    state.mode = mode;
    const body = await (await sync()).json();
    expect(body).toMatchObject({ ok: true, added: 1, intervalMs: interval });
    expect(state.harvests).toBe(1);
  });

  it("freeze stops the on-load sync and asks again in 5 minutes", async () => {
    state.mode = "freeze";
    const body = await (await sync()).json();
    expect(body).toEqual({ ok: true, skipped: "freeze", intervalMs: 300_000 });
    expect(state.harvests).toBe(0);
  });
});
