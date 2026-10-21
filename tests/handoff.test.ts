// The handoff verdict — every phantom-play vector from the audits, as executable cases, and the
// one-verdict rule (NOW_PLAYING_2S.md L2): Home judges how long the song was current, as the
// store does, from the instants it started and stopped.
import { describe, expect, it } from "vitest";
import { handoffBeaconMeta, handoffPredToken, judgeHandoff, type HandoffObservation } from "@/lib/handoff";
import { isSkip } from "@/lib/skip-rule";

const T = Date.parse("2026-08-19T21:37:00Z");
const obs = (over: Partial<HandoffObservation>): HandoffObservation => ({
  seenAt: T - 6_000, // seen playing 6s ago (normal poll cadence)
  sawPlaying: true,
  startAt: T - 150_000, // current for 150 s of 180
  durationMs: 180_000,
  ...over,
});

describe("judgeHandoff — the phantom vectors", () => {
  it("normal song change commits", () => {
    expect(judgeHandoff(obs({}), T, T, true)).toBe("commit");
  });

  it("Abracadabra (2026-08-16): a suspended tab waking hours later is STALE", () => {
    expect(judgeHandoff(obs({ seenAt: T - 3 * 3600_000 }), T, T, true)).toBe("stale");
  });

  it("cache/broadcast seed (2026-08-19): never seen playing → NEVER-PLAYED despite fresh seenAt", () => {
    expect(judgeHandoff(obs({ sawPlaying: false }), T, T, true)).toBe("never-played");
  });

  it("paused launder (2026-08-19): paused for hours then swapped — pause never refreshed seenAt → STALE", () => {
    // den-home only stamps seenAt on isPlaying polls; a paused evening = old seenAt.
    expect(judgeHandoff(obs({ seenAt: T - 3.5 * 3600_000 }), T, T, true)).toBe("stale");
  });

  it("spam-click (2026-08-16): current for under 40% of the song is a SKIP", () => {
    expect(judgeHandoff(obs({ startAt: T - 10_000 }), T, T, true)).toBe("skip");
  });

  it("unknown duration uses the 30s floor", () => {
    expect(judgeHandoff(obs({ durationMs: 0, startAt: T - 29_000 }), T, T, true)).toBe("skip");
    expect(judgeHandoff(obs({ durationMs: 0, startAt: T - 31_000 }), T, T, true)).toBe("commit");
  });

  it("first play of a new day (2026-08-17): no today card → NO-TODAY, the sync owns it", () => {
    expect(judgeHandoff(obs({}), T, T, false)).toBe("no-today");
  });

  it("a private session mints nothing: Spotify lists none of those plays", () => {
    expect(judgeHandoff(obs({ privateSession: true }), T, T, true)).toBe("private");
  });
});

// Production, Oct 15-21 (lane 0136): Home listed these at 99-100% of the furthest position it
// saw (seeked near their end); the store ruled them skips from their played_at stamps. Start and
// end are the store's own stamps here: the previous play's end and this play's.
describe("one verdict: the store's rule on the instants", () => {
  const cases = [
    { name: "一路生花", prev: "2026-10-15T16:50:45.649Z", at: "2026-10-15T16:50:57.751Z", d: 256_250 },
    { name: "未必", prev: "2026-10-15T16:50:57.751Z", at: "2026-10-15T16:51:15.647Z", d: 193_163 },
    { name: "Faint", prev: "2026-10-21T06:39:44.158Z", at: "2026-10-21T06:40:07.550Z", d: 162_106 },
  ];
  for (const c of cases) {
    it(`${c.name}: current ${((Date.parse(c.at) - Date.parse(c.prev)) / 1000).toFixed(1)} s of ${c.d / 1000} s is a skip on both sides`, () => {
      const end = Date.parse(c.at);
      const p = obs({ startAt: Date.parse(c.prev), durationMs: c.d, seenAt: end - 1_000 });
      expect(isSkip(c.prev, c.at, c.d)).toBe(1);
      expect(judgeHandoff(p, end, end, true)).toBe("skip");
    });
  }

  it("40% exactly commits (strict <, as isSkip) once outside the pending band", () => {
    // 40% of 1,000 s = 400 s; the band is ±1.5 s, so the exact bar is pending, and 1.5 s past it too.
    const D = 1_000_000;
    const at = (ran: number) => judgeHandoff(obs({ durationMs: D, startAt: T - ran }), T, T, true);
    expect(at(400_000)).toBe("pending");
    expect(at(401_500)).toBe("pending");
    expect(at(401_501)).toBe("commit");
    expect(at(398_500)).toBe("pending");
    expect(at(398_499)).toBe("skip");
    expect(isSkip(new Date(T - 400_000).toISOString(), new Date(T).toISOString(), D)).toBe(0);
    expect(isSkip(new Date(T - 399_999).toISOString(), new Date(T).toISOString(), D)).toBe(1);
  });

  it("a song current longer than itself (paused, or idle after it) is capped at its duration", () => {
    expect(judgeHandoff(obs({ startAt: T - 3_600_000 }), T, T, true)).toBe("commit");
  });

  it("a pending play outside today's view is the sync's, like a commit", () => {
    expect(judgeHandoff(obs({ startAt: T - 72_000 }), T, T, false)).toBe("no-today");
  });
});

// The beacon's meta (client_metrics "handoff"): the track by its Spotify ID, never its name,
// artist or playlist (multi-user PLAN §13.1, Phase 4a's rule), and for a private-session song
// not even the ID (code review 0156 M2): the user asked Spotify not to record that listen.
describe("handoffBeaconMeta", () => {
  const p = {
    id: "4uLU6hMCjMI75M1A2tKUQC",
    title: "Faint",
    artist: "Linkin Park",
    source: "Gym",
    seenAt: T - 6_000,
    maxProgress: 90_000,
    durationMs: 180_000,
    privateSession: false,
  };
  const i = { ran: 150_000, endedAt: T, pred: "prev1", now: T, vsEndMs: 1_500 };

  it("carries the verdict, the ids and the timings; no song name, artist or playlist", () => {
    expect(handoffBeaconMeta("commit", p, i)).toBe(
      `commit|id=4uLU6hMCjMI75M1A2tKUQC|run=150.0s|at=${T}|pred=prev1|gap=6s|prog=50%|end=1.5s`,
    );
  });

  it("a private-session song is filed as private with its run only", () => {
    expect(handoffBeaconMeta("private", { ...p, privateSession: true }, i)).toBe("private|run=150.0s");
    // ...and the song after it names no ID as its predecessor (np-latency still excludes it).
    expect(handoffPredToken({ ...p, privateSession: true })).toBe("private");
    expect(handoffPredToken(p)).toBe(p.id);
  });

  it("scripts/np-latency.mjs joins what it builds", async () => {
    const { joinVerdicts } = await import("../scripts/np-latency.mjs");
    const at = Date.parse("2026-10-21T06:40:07.900Z");
    const meta = handoffBeaconMeta("skip", p, { ...i, endedAt: at, pred: "prev1" });
    const plays = [
      { played_at: "2026-10-21T06:39:44.158Z", track_id: "prev1", skipped: 0 },
      { played_at: "2026-10-21T06:40:07.550Z", track_id: p.id, skipped: 1 },
    ];
    expect(joinVerdicts([{ meta: `pv:ab12cd34|${meta}` }], plays)).toMatchObject({ judged: 1, agree: 1 });
  });
});
