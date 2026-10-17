// /api/now-playing's per-user memo (PLAN.md §6.2 layer 4, §6.6; security R13): a user's tabs share
// one Spotify call per ~5 s; another user never gets that answer and pays their own call with their
// own bearer; a failure is never replayed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "aaaaaaaaaaaa",
  calls: [] as string[],
  fail: false,
  mode: "normal" as "normal" | "economy" | "freeze",
}));
vi.mock("@/lib/budget/mode", () => ({ currentMode: async () => state.mode }));

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
  state.mode = "normal";
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

  // The memo's reply and the fresh one are built in two places in the route, and every later field
  // has had to be added to both: the budget's floor was dropped from the memo's (lane 34's stitch,
  // 64d35d6), and lane 13's `u`, which tells a tab its cookie now names someone else (mu/rv-p1
  // 253ea15), meets this route only at lane 35's fold. A tab must not be able to tell them apart.
  it("a reply from the memo is the fresh reply, field for field", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.mode = "economy";
    const fresh = await (await GET()).json();
    const memoized = await (await GET()).json();
    expect(state.calls).toHaveLength(1); // the second answer is the memo's
    expect(fresh.minPollMs).toBe(30_000);
    expect(memoized).toEqual(fresh);
  });

  it("a failure is not remembered", async () => {
    state.fail = true;
    expect((await GET()).status).toBe(503);
    state.fail = false;
    expect(await track()).toBe("tok-aaaaaaaaaaaa-track");
    expect(state.calls).toHaveLength(2);
  });
});
