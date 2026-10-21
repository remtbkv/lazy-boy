// The isolation harness drives /api/now-playing through its per-user context-name cache (code
// review 0156 M4): once the route read /me/player alone, the harness answered that endpoint
// 204 for every caller and the route stopped before forUser(uid).getContextName, so the
// isolation run no longer reached the path that reads and writes per-user rows on every poll of
// a new context.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", async () => (await import("./authz-context")).nextHeadersMock());
vi.mock("next/server", async (orig) => (await import("./authz-context")).nextServerMock(await orig()));

import { installSpotify, observe, REM_PLAYLIST } from "./authz-harness";

installSpotify();
const nowPlaying = async () => (await import("@/app/api/now-playing/route")).GET();

describe("GET /api/now-playing in the isolation harness", () => {
  it("as Rem: Spotify names Rem's playlist and the answer carries its name from Rem's context cache", async () => {
    const obs = await observe("rem", nowPlaying);
    expect(obs.outcome.kind).toBe("response");
    const body = obs.outcome.kind === "response" ? JSON.parse(obs.outcome.text) : null;
    expect(body.playing?.context).toEqual({ name: "REM-only-playlist", type: "playlist" });
    // A cache hit: the name came from the store, not from Spotify.
    const paths = obs.calls.map((c) => new URL(c.url).pathname);
    expect(paths).toContain("/v1/me/player");
    expect(paths).not.toContain(`/v1/playlists/${REM_PLAYLIST}`);
  });

  it("as a friend: nothing of Rem's, neither his playlist's name nor his grant nor his rows", async () => {
    const obs = await observe("friendA", nowPlaying);
    expect(obs.marker).toBe(false);
    expect(obs.remBearer).toBe(false);
    expect(obs.storeChanged).toBe(false);
  });
});
