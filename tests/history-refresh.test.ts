// refreshHistoryAction off Spotify (multi-user PLAN §7.6, decision 15 as approved Oct 15 6:21 PM):
// the forced refresh at a track change re-reads the user's store and makes no Spotify call; the
// stored row arrives with the next tick, the provisional row standing in until it does. Before
// Phase 3 it harvested on every call, with no debounce, from every open tab.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spotifyCalls = vi.hoisted(() => [] as string[]);

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "tzoffset" ? { name: n, value: "0" } : undefined) }),
  headers: async () => new Headers(),
}));
// The gate is the authz suite's subject; here the caller is the owner.
vi.mock("@/lib/require-user", async () => {
  const { mintUid } = await import("@/lib/identity");
  return { requireActionUser: async () => ({ uid: mintUid(process.env.OWNER_UID as string), admin: true }) };
});

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  spotifyCalls.push(url);
  return new Response("no Spotify in this test", { status: 500 });
});

const { refreshHistoryAction } = await import("@/app/(app)/history-actions");
const { ownerStore } = await import("./owner-store");
const { resetStore } = await import("./adversarial/helpers");

beforeEach(async () => {
  spotifyCalls.length = 0;
  await resetStore();
});

describe("refreshHistoryAction (decision 15)", () => {
  it("re-reads the store and calls nobody: a play the tick stored is in the delta, no harvest ran", async () => {
    const minute = Math.floor((Date.now() - 5 * 60_000) / 60_000);
    await ownerStore().recordPlays([
      {
        trackId: "t1",
        name: "Song",
        artist: "Artist",
        uri: "spotify:track:t1",
        album: null,
        albumImage: null,
        durationMs: 200_000,
        playedAt: new Date(Date.now() - 60_000).toISOString(),
        contextType: null,
        contextUri: null,
      },
    ]);
    const r = await refreshHistoryAction("latest", 14, minute);
    expect(spotifyCalls).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.added).toBe(0);
    expect(r.newPlays?.map((p) => p.name)).toEqual(["Song"]);
    expect(r.daily[0]?.plays).toBe(1);
  });
});
