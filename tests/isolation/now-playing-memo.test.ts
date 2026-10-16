// /api/now-playing's per-user memo (PLAN.md §6.2 layer 4, §6.6; security R13): a user's tabs share
// one Spotify call per ~5 s; another user never gets that answer and pays their own call with their
// own bearer; a failure is never replayed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "aaaaaaaaaaaa",
  calls: [] as string[],
  fail: false,
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => ({ user: {}, uid: state.uid, admin: false }),
  spotifyAccessTokenFor: async (uid: string) => `tok-${uid}`,
}));
vi.mock("@/lib/spotify", () => ({
  SpotifyError: class SpotifyError extends Error {},
  spotifyCooldownMs: () => 0,
  spotifyClient: (_uid: string, token: string) => ({
    currentlyPlaying: async () => {
      state.calls.push(token);
      if (state.fail) throw new Error("429");
      return { track: { id: `${token}-track`, name: "x" }, isPlaying: true, progressMs: 1, durationMs: 2, context: null };
    },
    contextName: async () => null,
  }),
}));
vi.mock("@/lib/db", () => ({ forUser: () => ({ getContextName: async () => undefined, recordContexts: async () => {} }) }));

const { GET } = await import("@/app/api/now-playing/route");
const { clearNowPlayingMemo, NOW_PLAYING_MEMO_MS } = await import("@/lib/now-playing-memo");
const track = async () => ((await (await GET()).json()).playing?.track?.id ?? null) as string | null;

beforeEach(() => {
  clearNowPlayingMemo();
  state.calls = [];
  state.fail = false;
  state.uid = "aaaaaaaaaaaa";
  vi.useRealTimers();
});

describe("the now-playing memo", () => {
  it("one Spotify call per user per window; each user their own answer on their own bearer", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    expect(await track()).toBe("tok-aaaaaaaaaaaa-track");
    expect(await track()).toBe("tok-aaaaaaaaaaaa-track");
    state.uid = "bbbbbbbbbbbb";
    expect(await track()).toBe("tok-bbbbbbbbbbbb-track");
    expect(state.calls).toEqual(["tok-aaaaaaaaaaaa", "tok-bbbbbbbbbbbb"]);
    state.uid = "aaaaaaaaaaaa";
    vi.advanceTimersByTime(NOW_PLAYING_MEMO_MS);
    expect(await track()).toBe("tok-aaaaaaaaaaaa-track");
    expect(state.calls).toEqual(["tok-aaaaaaaaaaaa", "tok-bbbbbbbbbbbb", "tok-aaaaaaaaaaaa"]);
  });

  it("a failure is not remembered", async () => {
    state.fail = true;
    expect((await GET()).status).toBe(503);
    state.fail = false;
    expect(await track()).toBe("tok-aaaaaaaaaaaa-track");
    expect(state.calls).toHaveLength(2);
  });
});
