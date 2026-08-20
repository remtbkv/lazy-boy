// syncRecentPlays end-to-end: a fake Spotify service feeding the REAL store — cooldown
// gating, context resolution + negative caching, the home-payload rebuild trigger.
import { describe, expect, it } from "vitest";
import { syncRecentPlays } from "@/lib/sync/history";
import {
  getHomePayload,
  getPlaysByDay,
  getSpotifyCooldownUntil,
  setSpotifyCooldownUntil,
  getContextName,
} from "@/lib/db";


type FakeSp = Parameters<typeof syncRecentPlays>[0];

// The wire shape sp.recentlyPlayed hands back: {track, playedAt, contextType, contextUri}.
type RecentItem = {
  track: {
    id: string;
    title: string;
    artist: string;
    uri: string;
    album: string | null;
    albumImage: string | null;
    durationMs: number | null;
  };
  playedAt: string;
  contextType: string | null;
  contextUri: string | null;
};

function fakeSp(opts: {
  recent: RecentItem[];
  contexts?: Record<string, { name: string; type: string } | null>;
}): FakeSp {
  return {
    recentlyPlayed: async () => opts.recent,
    contextName: async (uri: string) => {
      const hit = opts.contexts?.[uri];
      if (hit === undefined) throw new Error("transient");
      return hit;
    },
  } as unknown as FakeSp;
}

const DAY = "2026-08-11";
const rec = (id: string, hhmm: string, ctx?: string): RecentItem => ({
  track: {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    uri: `spotify:track:${id}`,
    album: null,
    albumImage: null,
    durationMs: 180000,
  },
  playedAt: `${DAY}T${hhmm}:00.000Z`,
  contextType: ctx ? "playlist" : null,
  contextUri: ctx ?? null,
});

describe("syncRecentPlays (fake Spotify, real store)", () => {
  it("harvests, resolves context names, negative-caches dead ones, rebuilds the payload", async () => {
    const sp = fakeSp({
      recent: [rec("s2", "10:10", "spotify:playlist:good"), rec("s1", "10:00", "spotify:playlist:dead")],
      contexts: {
        "spotify:playlist:good": { name: "Good List", type: "playlist" },
        "spotify:playlist:dead": null, // 403/404 → negative cache
      },
    });
    const { added } = await syncRecentPlays(sp);
    expect(added).toBe(2);
    expect(await getContextName("spotify:playlist:good")).toBe("Good List");
    expect(await getContextName("spotify:playlist:dead")).toBeNull(); // negative, not undefined
    const payload = await getHomePayload();
    expect(payload).not.toBeNull(); // rebuild ran because plays landed
    expect(payload!.daily.some((d) => d.day === DAY)).toBe(true);
    const rows = await getPlaysByDay(DAY, 0);
    expect(rows.find((r) => r.id === "s2")?.source).toBe("Good List");
  });

  it("a second run with the same window adds nothing and skips the rebuild", async () => {
    const sp = fakeSp({ recent: [rec("s2", "10:10", "spotify:playlist:good")], contexts: {} });
    const before = (await getHomePayload())!.builtAt;
    const { added } = await syncRecentPlays(sp);
    expect(added).toBe(0);
    expect((await getHomePayload())!.builtAt).toBe(before); // unchanged
  });

  it("a persisted cooldown suppresses the harvest entirely", async () => {
    await setSpotifyCooldownUntil(Date.now() + 60_000);
    expect(await getSpotifyCooldownUntil()).toBeGreaterThan(Date.now());
    let called = 0;
    const sp = {
      recentlyPlayed: async () => {
        called += 1;
        return [];
      },
    } as unknown as FakeSp;
    const r = await syncRecentPlays(sp);
    expect(r.skipped).toBe("cooldown");
    expect(called).toBe(0); // zero Spotify calls
  });
});
