// What the provider does with a poll's answer before it reaches the bar and Home's handoff
// (NOW_PLAYING_2S.md L2 and its review, M3): a lone empty answer while a song is shown is held
// and asked again, so a transient empty player cannot finish the song on Home; a flip back to the
// song that just ended, pinned at its end, is Spotify catching up, not a change.
import { describe, expect, it } from "vitest";
import {
  EMPTY_CONFIRM_MS,
  FLIP_BACK_MS,
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
