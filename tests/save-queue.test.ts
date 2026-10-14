// Simulation: Service.saveQueue against a scripted player (queue + context, transport
// commands applied in order). Q1 of the 2026-10-03 review: the end-of-queue sentinel
// ("bittersweet") is one of Rem's own songs, so a genuine queued copy must not end the walk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Service } from "@/lib/spotify/service";

const SENTINEL = "spotify:track:6sVK7RXMHRGxAefiqEGEbP";
const uri = (id: string) => `spotify:track:${id}`;
const track = (u: string) => ({ id: u.split(":")[2], uri: u, name: u });

function scriptedPlayer(current: string, queue: string[], context: string[]) {
  const p = {
    playing: current as string | null,
    queue: [...queue],
    context: [...context],
    seeks: [] as { uri: string | null; ms: number }[],
    volume: 50,
    saved: [] as string[],
  };
  const svc = new Service(async () => "t");
  Object.assign(svc.resources, {
    playbackState: async () => ({
      isPlaying: true,
      progressMs: 42_000,
      trackId: current.split(":")[2],
      trackUri: current,
      volumePercent: 50,
    }),
    resumePlayback: async () => {},
    setVolume: async (v: number) => {
      p.volume = v;
    },
    addToQueue: async (u: string) => {
      p.queue.push(u);
    },
    nextTrack: async () => {
      p.playing = p.queue.shift() ?? p.context.shift() ?? null;
    },
    currentlyPlaying: async () => (p.playing ? { track: track(p.playing) } : null),
    seek: async (ms: number) => {
      p.seeks.push({ uri: p.playing, ms });
    },
    createPlaylist: async () => "pl1",
    addItems: async (_id: string, uris: string[]) => {
      p.saved.push(...uris);
    },
  });
  return { svc, p };
}

async function run(svc: Service) {
  const out = svc.saveQueue();
  await vi.runAllTimersAsync();
  return out;
}

describe("saveQueue (scripted player)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a genuinely queued sentinel is saved and the walk continues past it (Q1)", async () => {
    const C = uri("cur");
    const { svc, p } = scriptedPlayer(C, [uri("x"), SENTINEL, uri("y")], [uri("z1"), uri("z2")]);
    const r = await run(svc);
    expect(p.saved).toEqual([uri("x"), SENTINEL, uri("y")]);
    expect(r.count).toBe(3);
    expect(p.playing).toBe(C);
    expect(p.seeks).toEqual([{ uri: C, ms: 42_000 }]);
    expect(p.queue).toEqual([]);
    expect(p.context).toEqual([uri("z1"), uri("z2")]);
    expect(p.volume).toBe(50);
  });

  it("an ordinary queue saves in order and lands back on the current song", async () => {
    const C = uri("cur");
    const { svc, p } = scriptedPlayer(C, [uri("x"), uri("y")], [uri("z1")]);
    await run(svc);
    expect(p.saved).toEqual([uri("x"), uri("y")]);
    expect(p.playing).toBe(C);
    expect(p.seeks).toEqual([{ uri: C, ms: 42_000 }]);
    expect(p.queue).toEqual([]);
    expect(p.context).toEqual([uri("z1")]);
  });

  it("when the current song IS the sentinel, the appended pair still ends the walk", async () => {
    const { svc, p } = scriptedPlayer(SENTINEL, [uri("x")], [uri("z1")]);
    await run(svc);
    expect(p.saved).toEqual([uri("x")]);
    expect(p.playing).toBe(SENTINEL);
    expect(p.seeks).toEqual([{ uri: SENTINEL, ms: 42_000 }]);
    expect(p.queue).toEqual([]);
    expect(p.context).toEqual([uri("z1")]);
  });
});
