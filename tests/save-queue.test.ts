// Simulation: Service.saveQueue's skip-through walk against a scripted player (review Q1,
// ~/.claude/burn/20261003/lazyboy-review.md). The sentinel track is one Rem owns and plays,
// so a genuine queue entry with the sentinel's id must not end the walk: the end marker is
// "sentinel immediately followed by the re-queued current track".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Service } from "@/lib/spotify/service";

const SENTINEL = "6sVK7RXMHRGxAefiqEGEbP";
const uri = (id: string) => `spotify:track:${id}`;

// A player whose up-next is `queue`; addToQueue appends, nextTrack pops into "now playing".
function scriptedService(current: string, queue: string[]) {
  const svc = new Service(async () => "test-token", false, "sim");
  const player = { now: current, queue: [...queue], seeks: [] as number[], created: [] as string[][] };
  const track = (id: string) => ({ id, uri: uri(id), name: id, artists: [], album: null, durationMs: 1 });
  Object.assign(svc.resources, {
    playbackState: async () => ({ trackUri: uri(player.now), progressMs: 42_000, isPlaying: true, volumePercent: 50 }),
    setVolume: async () => {},
    resumePlayback: async () => {},
    addToQueue: async (u: string) => void player.queue.push(u.replace("spotify:track:", "")),
    nextTrack: async () => {
      const n = player.queue.shift();
      if (n) player.now = n;
    },
    currentlyPlaying: async () => ({ track: track(player.now) }),
    seek: async (ms: number) => void player.seeks.push(ms),
    createPlaylist: async () => "new-pl",
    addItems: async (_id: string, uris: string[]) => void player.created.push(uris),
  });
  return { svc, player };
}

async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("saveQueue sentinel walk (Q1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a queued copy of the sentinel is saved, not taken as the end", async () => {
    const { svc, player } = scriptedService("CUR", ["X", SENTINEL, "Y"]);
    const r = await run(svc.saveQueue());
    expect(player.created).toEqual([[uri("X"), uri(SENTINEL), uri("Y")]]);
    expect(r.count).toBe(3);
    expect(player.now).toBe("CUR"); // back on the original song…
    expect(player.queue).toEqual([]); // …with nothing of ours left queued
    expect(player.seeks).toEqual([42_000]); // at the original position
  });

  it("a plain queue still saves in order and lands on the original song", async () => {
    const { svc, player } = scriptedService("CUR", ["A", "B"]);
    await run(svc.saveQueue());
    expect(player.created).toEqual([[uri("A"), uri("B")]]);
    expect(player.now).toBe("CUR");
    expect(player.queue).toEqual([]);
    expect(player.seeks).toEqual([42_000]);
  });
});
