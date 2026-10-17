// ADVERSARIAL — src/lib/handoff.ts
// The file documents exact rules, so its state space is enumerated exhaustively against a
// predicate written from the prose, not from the code. (The harvest gate this file also
// enumerated left with the single-user tick; Phase 3's policy is tests/harvest-policy.test.ts.)

import { describe, expect, it } from "vitest";
import {
  handoffRun,
  judgeHandoff,
  HANDOFF_STALE_MS,
  HANDOFF_SKIP_FRACTION,
  HANDOFF_UNKNOWN_DURATION_FLOOR_MS,
  HANDOFF_PENDING_BAND_MS,
  type HandoffObservation,
  type HandoffVerdict,
} from "@/lib/handoff";

describe("judgeHandoff — exhaustive enumeration", () => {
  const NOW = 1_000_000_000;
  const DUR = 200_000;
  const need = DUR * HANDOFF_SKIP_FRACTION; // 80_000
  const B = HANDOFF_PENDING_BAND_MS;

  // The contract, transcribed from handoff.ts's prose, in precedence order: stale, never
  // played, private, then the run (end − start, capped at the song) against the bar with
  // strict <, a ±1.5 s band around the bar that waits for the store, and today's card.
  const expected = (p: HandoffObservation, end: number, now: number, head: boolean): HandoffVerdict => {
    if (now - p.seenAt > HANDOFF_STALE_MS) return "stale";
    if (!p.sawPlaying) return "never-played";
    if (p.privateSession) return "private";
    const ran = Math.min(Math.max(0, end - p.startAt), p.durationMs > 0 ? p.durationMs : Infinity);
    const bar = p.durationMs > 0 ? p.durationMs * HANDOFF_SKIP_FRACTION : HANDOFF_UNKNOWN_DURATION_FLOOR_MS;
    const band = p.durationMs > 0 && Math.abs(ran - bar) <= B;
    if (ran < bar && !band) return "skip";
    if (!head) return "no-today";
    return band ? "pending" : "commit";
  };

  const ages = [0, HANDOFF_STALE_MS - 1, HANDOFF_STALE_MS, HANDOFF_STALE_MS + 1];
  const runs = [0, need - B - 1, need - B, need - 1, need, need + B, need + B + 1, DUR, DUR + 60_000];

  for (const age of ages) {
    for (const sawPlaying of [false, true]) {
      for (const ran of runs) {
        for (const head of [false, true]) {
          for (const privateSession of [false, true]) {
            it(`age=${age} sawPlaying=${sawPlaying} ran=${ran} head=${head} private=${privateSession}`, () => {
              const p: HandoffObservation = {
                seenAt: NOW - age,
                sawPlaying,
                startAt: NOW - ran,
                durationMs: DUR,
                privateSession,
              };
              expect(judgeHandoff(p, NOW, NOW, head)).toBe(expected(p, NOW, NOW, head));
            });
          }
        }
      }
    }
  }

  it("exactly 40% of a known duration is not a skip (the bar is not exclusive)", () => {
    const p: HandoffObservation = { seenAt: NOW, sawPlaying: true, startAt: NOW - 80_000, durationMs: 200_000 };
    expect(judgeHandoff(p, NOW, NOW, true)).toBe("pending");
    expect(judgeHandoff({ ...p, startAt: NOW - 81_501 }, NOW, NOW, true)).toBe("commit");
  });

  // The explicit cases the one-verdict rewrite dropped (code review 0156 M3), and known answers
  // computed by hand at a duration the matrix does not use, so a wrong rule fails here even
  // when `expected` above drifts with it.
  it("exactly HANDOFF_STALE_MS old is NOT stale", () => {
    const p: HandoffObservation = { seenAt: NOW - HANDOFF_STALE_MS, sawPlaying: true, startAt: NOW - DUR, durationMs: DUR };
    expect(judgeHandoff(p, NOW, NOW, true)).toBe("commit");
    expect(judgeHandoff({ ...p, seenAt: NOW - HANDOFF_STALE_MS - 1 }, NOW, NOW, true)).toBe("stale");
  });

  it("staleness outranks every other reason", () => {
    const p: HandoffObservation = {
      seenAt: NOW - HANDOFF_STALE_MS - 1,
      sawPlaying: false,
      startAt: NOW,
      durationMs: 0,
      privateSession: true,
    };
    expect(judgeHandoff(p, NOW, NOW, false)).toBe("stale");
  });

  for (const durationMs of [0, -1, Number.NaN]) {
    it(`durationMs=${String(durationMs)} falls back to the 30 s floor, uncapped`, () => {
      const base: HandoffObservation = { seenAt: NOW, sawPlaying: true, startAt: NOW, durationMs };
      const at = (ran: number) => judgeHandoff({ ...base, startAt: NOW - ran }, NOW, NOW, true);
      expect(at(HANDOFF_UNKNOWN_DURATION_FLOOR_MS - 1)).toBe("skip");
      expect(at(HANDOFF_UNKNOWN_DURATION_FLOOR_MS)).toBe("commit");
      expect(handoffRun({ startAt: NOW - 3_600_000, durationMs }, NOW)).toBe(3_600_000);
    });
  }

  it("a clock that jumped backwards does not read as stale", () => {
    const p: HandoffObservation = { seenAt: NOW + 2 * HANDOFF_STALE_MS, sawPlaying: true, startAt: NOW - DUR, durationMs: DUR };
    expect(judgeHandoff(p, NOW, NOW, true)).toBe("commit");
  });

  it("Faint's length (162.106 s), by hand: bar 64.8424 s, band ±1.5 s", () => {
    const D = 162_106;
    const at = (ran: number) => judgeHandoff({ seenAt: NOW, sawPlaying: true, startAt: NOW - ran, durationMs: D }, NOW, NOW, true);
    expect(at(63_342)).toBe("skip"); // 1.5004 s under the bar
    expect(at(63_343)).toBe("pending");
    expect(at(66_342)).toBe("pending"); // 1.4996 s over
    expect(at(66_343)).toBe("commit");
    expect(at(10 * D)).toBe("commit"); // capped at the song
  });
});

describe("the 0.40 bar lives in ONE place", () => {
  it("db.ts consumes the shared constant instead of re-declaring the literal", async () => {
    // handoff.ts:4-5: "Keep the constants in ONE place — the 0.40 bar is the same
    // SKIP_FRACTION the store applies in recomputeSkipFlags (db.ts)."
    const { readFileSync } = await import("node:fs");
    const db = readFileSync(new URL("../../src/lib/db.ts", import.meta.url), "utf8");
    expect(db).not.toMatch(/const\s+SKIP_FRACTION\s*=\s*0\.[0-9]+/);
  });

  it("if it IS re-declared, the two values at least agree", () => {
    expect(HANDOFF_SKIP_FRACTION).toBe(0.4);
  });
});
