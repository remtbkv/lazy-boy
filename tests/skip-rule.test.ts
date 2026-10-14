// Known answers for the pure skip / listened-time rule (src/lib/skip-rule.ts). Spotify's
// played_at is the END of a play (C1, burn lazyboy-review 2026-10-03), so a play ran from the
// previous play's end to its own, capped at its duration.
import { describe, expect, it } from "vitest";
import {
  CONVENTION_MIN_PAIRS,
  isSkip,
  listenedMs,
  playedAtConvention,
} from "@/lib/skip-rule";

const T = Date.parse("2026-07-01T10:00:00.000Z");
const at = (offMs: number) => new Date(T + offMs).toISOString();

describe("isSkip — from the previous play", () => {
  it("no predecessor → the play ran in full", () => {
    expect(isSkip(null, at(0), 200_000)).toBe(0);
  });
  it("35% exactly is a listen, one ms under is a skip", () => {
    expect(isSkip(at(0), at(35_000), 100_000)).toBe(0);
    expect(isSkip(at(0), at(34_999), 100_000)).toBe(1);
  });
  it("unknown or zero duration and a negative gap are permissive", () => {
    expect(isSkip(at(0), at(1), null)).toBe(0);
    expect(isSkip(at(0), at(1), 0)).toBe(0);
    expect(isSkip(at(10_000), at(0), 100_000)).toBe(0);
  });
});

describe("listenedMs — from the previous play", () => {
  it("is the gap, capped at the song", () => {
    expect(listenedMs(at(0), at(30_000), 180_000)).toBe(30_000);
    expect(listenedMs(at(0), at(3_600_000), 180_000)).toBe(180_000);
    expect(listenedMs(null, at(0), 180_000)).toBe(180_000);
  });
  it("under 5 s counts zero; unknown duration falls back to 10 min", () => {
    expect(listenedMs(at(0), at(4_999), 180_000)).toBe(0);
    expect(listenedMs(at(0), at(900_000), null)).toBe(600_000);
  });
});

describe("playedAtConvention — the end-stamp self-check", () => {
  const durs = [200_000, 180_000, 240_000, 150_000];
  // n plays, each stamped `gapOf(i)` after the previous one.
  function series(n: number, gapOf: (i: number) => number) {
    const rows = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) t += gapOf(i);
      rows.push({ playedAt: at(t), durationMs: durs[i % durs.length] });
    }
    return rows;
  }

  it("end stamps: every gap matches the LATER play → not inverted", () => {
    const r = playedAtConvention(series(4, (i) => durs[i % 4]));
    expect(r).toEqual({ pairs: 3, later: 3, earlier: 0, inverted: false });
  });

  it("start stamps: every gap matches the EARLIER play → inverted once there are enough pairs", () => {
    expect(playedAtConvention(series(4, (i) => durs[(i - 1) % 4])).inverted).toBe(false);
    const n = CONVENTION_MIN_PAIRS + 1;
    const r = playedAtConvention(series(n, (i) => durs[(i - 1) % 4]));
    expect(r).toEqual({ pairs: n - 1, later: 0, earlier: n - 1, inverted: true });
  });

  it("pairs more than 20 min apart or with an unknown duration don't count", () => {
    const rows = [
      { playedAt: at(0), durationMs: 200_000 },
      { playedAt: at(1_200_001), durationMs: 200_000 },
      { playedAt: at(1_400_001), durationMs: null },
      { playedAt: at(1_600_001), durationMs: 200_000 },
    ];
    expect(playedAtConvention(rows)).toEqual({ pairs: 0, later: 0, earlier: 0, inverted: false });
  });

  it("a match within 2 s counts, 2.001 s off doesn't", () => {
    const rows = [
      { playedAt: at(0), durationMs: 100_000 },
      { playedAt: at(202_000), durationMs: 200_000 },
      { playedAt: at(352_001), durationMs: 150_001 + 2_001 },
    ];
    expect(playedAtConvention(rows)).toMatchObject({ pairs: 2, later: 1, earlier: 0 });
  });
});
