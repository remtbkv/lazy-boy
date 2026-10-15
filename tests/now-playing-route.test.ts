// /api/now-playing must keep "nothing is playing" (200 {playing:null}) distinct from "could not
// tell" (a non-200). The client's poll ignores a non-200 and keeps its last state; a 200 null
// on a transient error used to make Home finish() the current song and mint a provisional play
// mid-song (burn lazyboy-review 2026-10-03, L1).
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  signedIn: true,
  currentlyPlaying: (async () => null) as () => Promise<unknown>,
  getContextName: (async () => "Mix") as (uri: string) => Promise<string | null | undefined>,
}));

vi.mock("@/lib/auth", () => ({
  auth: async () => (state.signedIn ? { user: {} } : null),
  spotifyAccessToken: async () => "tok",
}));
const spotifyStub = vi.hoisted(() => ({
  SpotifyError: class SpotifyError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  cooldownMs: 0,
}));

vi.mock("@/lib/spotify", () => ({
  SpotifyError: spotifyStub.SpotifyError,
  spotifyCooldownMs: () => spotifyStub.cooldownMs,
  spotifyClient: () => ({
    currentlyPlaying: () => state.currentlyPlaying(),
    contextName: async () => null,
  }),
}));
vi.mock("@/lib/db", () => ({
  getContextName: (uri: string) => state.getContextName(uri),
  recordContexts: async () => {},
}));

const { GET } = await import("@/app/api/now-playing/route");

const PLAYING = {
  track: { id: "t1", name: "Song" },
  isPlaying: true,
  progressMs: 60_000,
  durationMs: 200_000,
  context: { type: "playlist", uri: "spotify:playlist:p1" },
};

beforeEach(() => {
  state.signedIn = true;
  state.currentlyPlaying = async () => null;
  state.getContextName = async () => "Mix";
});

describe("/api/now-playing", () => {
  it("answers 200 {playing:null} when nothing is playing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).playing).toBeNull();
  });

  it("answers 200 {playing:null} when signed out (no error spam on an expired session)", async () => {
    state.signedIn = false;
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).playing).toBeNull();
  });

  it("answers the track with its resolved context", async () => {
    state.currentlyPlaying = async () => PLAYING;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.playing.track.id).toBe("t1");
    expect(body.playing.context).toEqual({ name: "Mix", type: "playlist" });
  });

  it("answers non-200 when Spotify fails (429 / timeout), never a 200 null", async () => {
    state.currentlyPlaying = async () => {
      throw new Error("Spotify 429");
    };
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.ok).toBe(false);
  });

  it("answers a Spotify 429 as 429 with the cooldown as Retry-After, so the poller backs off", async () => {
    spotifyStub.cooldownMs = 42_300;
    state.currentlyPlaying = async () => {
      throw new spotifyStub.SpotifyError(429, "Spotify is rate-limiting — try again shortly.");
    };
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("43");
    spotifyStub.cooldownMs = 0;
    const res2 = await GET();
    expect(res2.headers.get("Retry-After")).toBe("1"); // no cooldown recorded: the 1 s floor
  });

  it("answers non-200 when the store blips while resolving the context name", async () => {
    state.currentlyPlaying = async () => PLAYING;
    state.getContextName = async () => {
      throw new Error("store timeout");
    };
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
