// currentlyPlaying() reads /me/player alone (NOW_PLAYING_2S.md L2): one Spotify call per poll
// instead of two when idle (currently-playing 204s, then /me/player), and it carries what the
// handoff needs: the device's private-session flag and Spotify's playback-state timestamp.
import { afterEach, describe, expect, it, vi } from "vitest";

function scriptFetch(status: number, body?: unknown) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return paths;
}

async function client() {
  vi.resetModules();
  const mod = await import("@/lib/spotify");
  const { ownerUid } = await import("./owner-store");
  const owner = ownerUid();
  return mod.spotifyClient(owner, { uid: owner, accessToken: "test-token" }, false, "sim");
}

const ITEM = {
  type: "track",
  id: "t1",
  name: "Faint",
  uri: "spotify:track:t1",
  duration_ms: 162_106,
  artists: [{ name: "Linkin Park" }],
  album: { name: "Meteora", images: [{ url: "big" }, { url: "small" }] },
};

describe("currentlyPlaying reads /me/player alone", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a playing device: one call, with timestamp and the private-session flag", async () => {
    const paths = scriptFetch(200, {
      is_playing: true,
      progress_ms: 23_000,
      timestamp: 1_761_028_807_550,
      item: ITEM,
      device: { is_private_session: true },
      context: { type: "playlist", uri: "spotify:playlist:p1" },
    });
    const playing = await (await client()).currentlyPlaying();
    expect(paths).toEqual(["/v1/me/player"]);
    expect(playing).toMatchObject({
      track: { id: "t1", albumImage: "big" },
      isPlaying: true,
      progressMs: 23_000,
      durationMs: 162_106,
      timestamp: 1_761_028_807_550,
      privateSession: true,
      context: { type: "playlist", uri: "spotify:playlist:p1" },
    });
  });

  it("no active device (204): null after one call", async () => {
    const paths = scriptFetch(204);
    expect(await (await client()).currentlyPlaying()).toBeNull();
    expect(paths).toEqual(["/v1/me/player"]);
  });
});
