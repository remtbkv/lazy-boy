// /api/now-playing's per-user memo (PLAN.md §6.2 layer 4, §6.6; security R13): a user's tabs share
// one Spotify call per ~5 s; another user never gets that answer and pays their own call with their
// own bearer; a failure is never replayed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "aaaaaaaaaaaa",
  calls: [] as string[],
  fail: false,
  mode: "normal" as "normal" | "economy" | "freeze",
  player: { isPlaying: true, progressMs: 1_000, durationMs: 200_000 },
  callMs: 0,
  trackId: null as string | null,
  empty: false,
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
      if (state.callMs) vi.setSystemTime(Date.now() + state.callMs);
      if (state.empty) return null;
      return { track: { id: state.trackId ?? `${token}-track`, name: "x" }, ...state.player, context: null };
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
  state.callMs = 0;
  state.trackId = null;
  state.empty = false;
  state.uid = "aaaaaaaaaaaa";
  state.player = { isPlaying: true, progressMs: 1_000, durationMs: 200_000 };
  vi.useRealTimers();
});

describe("the now-playing memo", () => {
  it("one Spotify call per user per window; each user their own answer on their own bearer", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.player = { isPlaying: true, progressMs: 1_000, durationMs: 200_000 };
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

// NOW_PLAYING_2S.md §0 item 1, lane L0: a flat 5 s memo answered the poll timed to a song's end with the
// song that just ended, at the progress it had up to 5 s earlier, so the change waited for the next
// poll (natural-end p95 2.1 -> 6.3 s in the replay). The memo lives min(5 s, what was left of the song)
// and ages the progress it replays.
describe("the memo at a song's end", () => {
  const progress = async () => (await (await GET()).json()).playing?.progressMs as number;

  it("an answer sampled 2 s before the song ends is not replayed after it ends", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.player = { isPlaying: true, progressMs: 198_000, durationMs: 200_000 };
    await GET();
    vi.advanceTimersByTime(2_300); // the poll timed to the end: predicted end + 300 ms
    await GET();
    expect(state.calls).toHaveLength(2);
  });

  it("a hit 3 s after the sample reports the progress 3 s on", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.player = { isPlaying: true, progressMs: 60_000, durationMs: 200_000 };
    expect(await progress()).toBe(60_000);
    vi.advanceTimersByTime(3_000);
    expect(await progress()).toBe(63_000);
    expect(state.calls).toHaveLength(1);
  });

  // Code review 0156 L-f: the sample is as old as Spotify's answer, not as the request that went
  // out before it; stamped with the request's time, a replay ran the call's latency ahead.
  it("a slow Spotify call: the replay ages from when the answer came back", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.callMs = 400;
    state.player = { isPlaying: true, progressMs: 60_000, durationMs: 200_000 };
    expect(await progress()).toBe(60_000);
    vi.advanceTimersByTime(3_000);
    expect(await progress()).toBe(63_000);
    expect(state.calls).toHaveLength(1);
  });

  it("a paused answer keeps its progress for the whole window", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.player = { isPlaying: false, progressMs: 198_000, durationMs: 200_000 };
    expect(await progress()).toBe(198_000);
    vi.advanceTimersByTime(4_000);
    expect(await progress()).toBe(198_000);
    expect(state.calls).toHaveLength(1);
  });
});

// Code review 0156 H2: merged with L1/L2, the memo answered the poll that follows an in-app play
// with the song from before the click (the bar flipped back, Home finished the new song as a 2 s
// skip, the np-change beacon filed a bogus change), and answered M3's confirming re-ask of an
// empty answer with that same empty sample, so the confirmation always passed. The poll after an
// in-app action and the re-ask send ?fresh=1, which skips the memo's read (it still writes). An
// empty answer is memoized like any other (review 0158 finding 3: an idle player is the commonest
// state for a tab left open, and R13's bound has to cover it); the fresh re-ask confirms it.
describe("the memo around an in-app action and an empty answer", () => {
  const req = (fresh: boolean) => new Request(`http://127.0.0.1:3000/api/now-playing${fresh ? "?fresh=1" : ""}`);
  const id = async (fresh: boolean) => ((await (await GET(req(fresh))).json()).playing?.track?.id ?? null) as string | null;

  it("the poll after a Play (fresh) reaches Spotify inside the window and gets the new song", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.trackId = "A";
    expect(await id(false)).toBe("A");
    state.trackId = "B"; // the user played B in the app
    vi.advanceTimersByTime(2_050); // playOptimistic's 2 s suppression, then the kicked poll
    expect(await id(true)).toBe("B");
    expect(state.calls).toHaveLength(2);
    // ...and writes: another tab's plain poll in the window shares B.
    expect(await id(false)).toBe("B");
    expect(state.calls).toHaveLength(2);
  });

  it("a plain poll inside the window still shares the call", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.trackId = "A";
    await id(false);
    state.trackId = "B";
    vi.advanceTimersByTime(2_050);
    expect(await id(false)).toBe("A");
    expect(state.calls).toHaveLength(1);
  });

  it("an idle player: plain polls inside the window share one Spotify call (R13)", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.empty = true;
    expect(await id(false)).toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(await id(false)).toBeNull();
    state.uid = "bbbbbbbbbbbb"; // another user's tab is not answered from it
    expect(await id(false)).toBeNull();
    expect(state.calls).toEqual(["tok-aaaaaaaaaaaa", "tok-bbbbbbbbbbbb"]);
  });

  it("an empty answer is not replayed to the re-ask: 600 ms later (fresh) it asks Spotify again", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state.trackId = "A";
    state.empty = true;
    expect(await id(false)).toBeNull();
    state.empty = false; // the empty answer was transient
    vi.advanceTimersByTime(600);
    expect(await id(true)).toBe("A");
    expect(state.calls).toHaveLength(2);
  });
});
