// The handoff verdict — every phantom-play vector from the audits, as executable cases.
import { describe, expect, it } from "vitest";
import { judgeHandoff, type HandoffObservation } from "@/lib/handoff";

const T = Date.parse("2026-08-19T21:37:00Z");
const obs = (over: Partial<HandoffObservation>): HandoffObservation => ({
  seenAt: T - 6_000, // seen playing 6s ago (normal poll cadence)
  sawPlaying: true,
  maxProgress: 150_000,
  durationMs: 180_000,
  ...over,
});

describe("judgeHandoff — the phantom vectors", () => {
  it("normal song change commits", () => {
    expect(judgeHandoff(obs({}), T, true)).toBe("commit");
  });

  it("Abracadabra (2026-08-16): a suspended tab waking hours later is STALE", () => {
    expect(judgeHandoff(obs({ seenAt: T - 3 * 3600_000 }), T, true)).toBe("stale");
  });

  it("cache/broadcast seed (2026-08-19): never seen playing → NEVER-PLAYED despite fresh seenAt + inherited progress", () => {
    expect(judgeHandoff(obs({ sawPlaying: false, maxProgress: 170_000 }), T, true)).toBe(
      "never-played",
    );
  });

  it("paused launder (2026-08-19): paused for hours then swapped — pause never refreshed seenAt → STALE", () => {
    // den-home only stamps seenAt on isPlaying polls; a paused evening = old seenAt.
    expect(judgeHandoff(obs({ seenAt: T - 3.5 * 3600_000, maxProgress: 144_000 }), T, true)).toBe(
      "stale",
    );
  });

  it("spam-click (2026-08-16): under 35% observed is a SKIP", () => {
    expect(judgeHandoff(obs({ maxProgress: 10_000 }), T, true)).toBe("skip");
  });

  it("35% boundary: exactly at the bar commits, just under skips", () => {
    expect(judgeHandoff(obs({ maxProgress: 63_000 }), T, true)).toBe("commit");
    expect(judgeHandoff(obs({ maxProgress: 62_999 }), T, true)).toBe("skip");
  });

  it("unknown duration uses the 30s floor", () => {
    expect(judgeHandoff(obs({ durationMs: 0, maxProgress: 29_000 }), T, true)).toBe("skip");
    expect(judgeHandoff(obs({ durationMs: 0, maxProgress: 31_000 }), T, true)).toBe("commit");
  });

  it("first play of a new day (2026-08-17): no today card → NO-TODAY, the sync owns it", () => {
    expect(judgeHandoff(obs({}), T, false)).toBe("no-today");
  });
});
