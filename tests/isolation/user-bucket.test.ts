// §6.6's per-user bound on /api/playlists/[id]/tracks (01b S13): ten a minute per user per
// instance; one user at the limit costs another nothing; the next window opens again.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ uid: "aaaaaaaaaaaa", calls: 0 }));
vi.mock("@/lib/require-user", () => ({
  requireRouteUser: async () => ({ uid: state.uid, admin: false, canCallSpotify: true }),
}));
vi.mock("@/lib/auth", () => ({ spotifyAccessTokenFor: async () => "tok" }));
vi.mock("@/lib/spotify", () => ({
  SpotifyError: class extends Error {},
  spotifyClient: () => ({
    playlist: async () => {
      state.calls++;
      return { snapshot: "s1" };
    },
    playlistTracks: async () => [],
  }),
}));
vi.mock("@/lib/db", () => ({ storePlaylistTracks: async () => {} }));

const { POST } = await import("@/app/api/playlists/[id]/tracks/route");
const { allowUserCall, clearUserBuckets } = await import("@/lib/user-bucket");
const call = () =>
  POST(new Request("http://x/api/playlists/p1/tracks", { method: "POST", body: JSON.stringify({ snapshot: "s1" }) }), {
    params: Promise.resolve({ id: "p1" }),
  });

beforeEach(() => {
  clearUserBuckets();
  state.calls = 0;
  state.uid = "aaaaaaaaaaaa";
});

describe("/api/playlists/[id]/tracks per user", () => {
  it("ten a minute for A, then 429 with no Spotify call; B unaffected", async () => {
    for (let i = 0; i < 10; i++) expect((await call()).status).toBe(200);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(state.calls).toBe(10);
    state.uid = "bbbbbbbbbbbb";
    expect((await call()).status).toBe(200);
  });

  it("the window reopens", () => {
    const A = "aaaaaaaaaaaa" as never;
    for (let i = 0; i < 3; i++) expect(allowUserCall("t", A, 1_000 + i, 3, 60_000)).toBe(true);
    expect(allowUserCall("t", A, 2_000, 3, 60_000)).toBe(false);
    expect(allowUserCall("t", A, 61_000, 3, 60_000)).toBe(true);
    expect(allowUserCall("other", A, 2_000, 3, 60_000)).toBe(true);
  });
});
