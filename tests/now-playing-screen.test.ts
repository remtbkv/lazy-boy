// What the provider does with a poll's answer before it reaches the bar and Home's handoff
// (NOW_PLAYING_2S.md L2 and its review, M3): a lone empty answer while a song is shown is held
// and asked again, so a transient empty player cannot finish the song on Home; a flip back to the
// song that just ended, pinned at its end, is Spotify catching up, not a change.
import { describe, expect, it } from "vitest";
import {
  agePlaying,
  EMPTY_CONFIRM_MS,
  FLIP_BACK_MS,
  HOLD_MAX_MS,
  holdWhile,
  NO_SCREEN_MEMORY,
  screenAnswer,
  type PolledPlaying,
} from "@/lib/now-playing-poll";

const song = (id: string, progressMs: number, durationMs = 200_000): PolledPlaying => ({
  track: { id },
  isPlaying: true,
  progressMs,
  durationMs,
});
const T = 1_000_000;

describe("screenAnswer: nothing playing is confirmed by a second answer", () => {
  it("one empty answer while a song is shown is held and asked again", () => {
    const r = screenAnswer(song("A", 60_000), null, T, NO_SCREEN_MEMORY);
    expect(r.action).toBe("hold");
    expect(r.action === "hold" && r.retryInMs).toBeGreaterThanOrEqual(EMPTY_CONFIRM_MS);
  });

  it("a second empty answer at least 500 ms after the first applies", () => {
    const first = screenAnswer(song("A", 60_000), null, T, NO_SCREEN_MEMORY);
    expect(screenAnswer(song("A", 60_000), null, T + 499, first.mem).action).toBe("hold");
    expect(screenAnswer(song("A", 60_000), null, T + EMPTY_CONFIRM_MS, first.mem).action).toBe("apply");
  });

  it("a song between the two empty answers starts the count again", () => {
    const first = screenAnswer(song("A", 60_000), null, T, NO_SCREEN_MEMORY);
    const back = screenAnswer(song("A", 60_000), song("A", 61_000), T + 600, first.mem);
    expect(back.action).toBe("apply");
    expect(screenAnswer(song("A", 61_000), null, T + 700, back.mem).action).toBe("hold");
  });

  it("nothing shown: an empty answer applies at once", () => {
    expect(screenAnswer(null, null, T, NO_SCREEN_MEMORY).action).toBe("apply");
  });
});

describe("screenAnswer: flip-back", () => {
  // A → B, then Spotify answers A at its end, then B again: one change, not three.
  it("A → B → A(at its end) within 3 s → the A answer is ignored", () => {
    const toB = screenAnswer(song("A", 199_000), song("B", 400), T, NO_SCREEN_MEMORY);
    expect(toB.action).toBe("apply");
    expect(screenAnswer(song("B", 400), song("A", 199_200), T + 1_000, toB.mem).action).toBe("ignore");
  });

  it("A → B → A(0 s) is a real 'previous': two changes", () => {
    const toB = screenAnswer(song("A", 199_000), song("B", 400), T, NO_SCREEN_MEMORY);
    expect(screenAnswer(song("B", 400), song("A", 500), T + 1_000, toB.mem).action).toBe("apply");
  });

  it("A at its end more than 3 s after the change is applied (not a flip-back)", () => {
    const toB = screenAnswer(song("A", 199_000), song("B", 400), T, NO_SCREEN_MEMORY);
    expect(screenAnswer(song("B", 400), song("A", 199_200), T + FLIP_BACK_MS, toB.mem).action).toBe("apply");
  });
});

// Save Queue walks the queue with `next` (~300 ms a step) and comes back to the song: the polls
// in between would see songs "leave" and Home would mint rows for them. The provider holds its
// polls for the walk (NOW_PLAYING_2S.md §1.3, L1; REVIEW M5).
describe("holdWhile: no poll during a Save Queue walk", () => {
  it("holds before the walk and releases after it, success or failure", async () => {
    const holds: number[] = [];
    await holdWhile(async () => { expect(holds).toEqual([1_000 + HOLD_MAX_MS]); return 1; }, (u) => holds.push(u), () => 1_000);
    expect(holds).toEqual([1_000 + HOLD_MAX_MS, 0]);
    holds.length = 0;
    await expect(holdWhile(async () => { throw new Error("walk failed"); }, (u) => holds.push(u), () => 2_000)).rejects.toThrow("walk failed");
    expect(holds).toEqual([2_000 + HOLD_MAX_MS, 0]);
  });
});

// A state painted from the localStorage cache (≤ 30 s old) or relayed by another tab carries
// the progress its sender saw then. Home dates a song's start as receipt − progress, so an
// unaged state made the song look up to 30 s younger (and its run that much shorter).
describe("agePlaying: a relayed state's progress is moved on by its age", () => {
  it("playing: progress + age, capped at the song", () => {
    expect(agePlaying(song("A", 60_000), T - 20_000, T)?.progressMs).toBe(80_000);
    expect(agePlaying(song("A", 195_000), T - 20_000, T)?.progressMs).toBe(200_000);
  });
  it("paused or nothing: unchanged", () => {
    const paused = { ...song("A", 60_000), isPlaying: false };
    expect(agePlaying(paused, T - 20_000, T)).toBe(paused);
    expect(agePlaying(null, T - 20_000, T)).toBeNull();
  });
});
