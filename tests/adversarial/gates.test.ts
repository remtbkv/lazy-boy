// ADVERSARIAL — src/lib/harvest-gate.ts and src/lib/handoff.ts
// Both files document exact rules, so both state spaces are enumerated exhaustively against
// a predicate written from the prose, not from the code.

import { describe, expect, it } from "vitest";
import { shouldHarvest, HARVEST_BACKSTOP_MS, type HarvestGate } from "@/lib/harvest-gate";
import {
  judgeHandoff,
  HANDOFF_STALE_MS,
  HANDOFF_SKIP_FRACTION,
  HANDOFF_UNKNOWN_DURATION_FLOOR_MS,
  type HandoffObservation,
  type HandoffVerdict,
} from "@/lib/handoff";

describe("shouldHarvest — exhaustive enumeration", () => {
  // The contract, transcribed from harvest-gate.ts:5-14:
  //   playing tick            -> harvest
  //   lastActive >= lastHarvest (the session tail is still open) -> harvest
  //   the backstop has lapsed (> 1h since the last harvest)      -> harvest
  //   otherwise                                                  -> don't
  const expected = (g: HarvestGate, playing: boolean, now: number) =>
    playing || g.lastActive >= g.lastHarvest || now - g.lastHarvest > HARVEST_BACKSTOP_MS;

  const T = 1_000_000_000;
  const deltas = [-1, 0, 1, -60_000, 60_000]; // lastActive relative to lastHarvest
  const sinceHarvest = [
    0,
    1,
    HARVEST_BACKSTOP_MS - 1,
    HARVEST_BACKSTOP_MS,
    HARVEST_BACKSTOP_MS + 1,
    HARVEST_BACKSTOP_MS * 5,
  ];

  for (const playing of [false, true]) {
    for (const d of deltas) {
      for (const s of sinceHarvest) {
        it(`playing=${playing} lastActive-lastHarvest=${d} sinceHarvest=${s}`, () => {
          const gate: HarvestGate = { lastHarvest: T, lastActive: T + d };
          expect(shouldHarvest(gate, playing, T + s)).toBe(expected(gate, playing, T + s));
        });
      }
    }
  }

  it("the documented tick sequence: play -> idle tail -> closed", () => {
    // "a PLAYING tick stamps lastActive = now, harvests, and stamps lastHarvest = now
    //  (equal stamps); the first IDLE tick after playback sees lastActive >= lastHarvest
    //  (equal) -> harvests the session's tail once, and its own fresher lastHarvest closes
    //  the branch" (harvest-gate.ts:6-10)
    let gate: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    const t1 = 1_000_000;
    expect(shouldHarvest(gate, true, t1)).toBe(true);
    gate = { lastActive: t1, lastHarvest: t1 }; // equal stamps

    const t2 = t1 + 120_000;
    expect(shouldHarvest(gate, false, t2)).toBe(true); // the tail
    gate = { ...gate, lastHarvest: t2 };

    const t3 = t2 + 120_000;
    expect(shouldHarvest(gate, false, t3)).toBe(false); // closed
  });

  it("a cooldown-skipped harvest leaves the branch open for the next tick", () => {
    // "a cooldown-skipped harvest withholds the lastHarvest stamp ... so the branch stays
    //  open and retries next tick" (harvest-gate.ts:11-12)
    const t1 = 1_000_000;
    const gate: HarvestGate = { lastActive: t1, lastHarvest: t1 };
    expect(shouldHarvest(gate, false, t1 + 60_000)).toBe(true);
    expect(shouldHarvest(gate, false, t1 + 120_000)).toBe(true); // no stamp written
  });

  it("the backstop fires strictly AFTER an hour, and re-arms after each harvest", () => {
    const t = 1_000_000;
    const closed: HarvestGate = { lastActive: t - 1, lastHarvest: t };
    expect(shouldHarvest(closed, false, t + HARVEST_BACKSTOP_MS)).toBe(false);
    expect(shouldHarvest(closed, false, t + HARVEST_BACKSTOP_MS + 1)).toBe(true);
    const restamped: HarvestGate = { lastActive: t - 1, lastHarvest: t + HARVEST_BACKSTOP_MS + 1 };
    expect(shouldHarvest(restamped, false, t + HARVEST_BACKSTOP_MS + 2)).toBe(false);
  });

  it("a cold gate (both stamps zero) harvests once", () => {
    expect(shouldHarvest({ lastActive: 0, lastHarvest: 0 }, false, 1)).toBe(true);
  });
});

describe("judgeHandoff — exhaustive enumeration", () => {
  const NOW = 1_000_000_000;
  const DUR = 200_000;
  const need = DUR * HANDOFF_SKIP_FRACTION; // 70_000

  // The contract, transcribed from handoff.ts:31-40, in precedence order.
  const expected = (p: HandoffObservation, now: number, head: boolean): HandoffVerdict => {
    if (now - p.seenAt > HANDOFF_STALE_MS) return "stale";
    if (!p.sawPlaying) return "never-played";
    const bar =
      p.durationMs > 0 ? p.durationMs * HANDOFF_SKIP_FRACTION : HANDOFF_UNKNOWN_DURATION_FLOOR_MS;
    if (p.maxProgress < bar) return "skip";
    if (!head) return "no-today";
    return "commit";
  };

  const ages = [0, HANDOFF_STALE_MS - 1, HANDOFF_STALE_MS, HANDOFF_STALE_MS + 1];
  const progresses = [0, need - 1, need, need + 1, DUR];

  for (const age of ages) {
    for (const sawPlaying of [false, true]) {
      for (const maxProgress of progresses) {
        for (const head of [false, true]) {
          it(`age=${age} sawPlaying=${sawPlaying} progress=${maxProgress} head=${head}`, () => {
            const p: HandoffObservation = {
              seenAt: NOW - age,
              sawPlaying,
              maxProgress,
              durationMs: DUR,
            };
            expect(judgeHandoff(p, NOW, head)).toBe(expected(p, NOW, head));
          });
        }
      }
    }
  }

  it("exactly 35% of a known duration commits (the bar is not exclusive)", () => {
    const p: HandoffObservation = {
      seenAt: NOW,
      sawPlaying: true,
      maxProgress: 70_000,
      durationMs: 200_000,
    };
    expect(judgeHandoff(p, NOW, true)).toBe("commit");
    expect(judgeHandoff({ ...p, maxProgress: 69_999 }, NOW, true)).toBe("skip");
  });

  it("exactly HANDOFF_STALE_MS old is NOT stale", () => {
    const p: HandoffObservation = {
      seenAt: NOW - HANDOFF_STALE_MS,
      sawPlaying: true,
      maxProgress: 200_000,
      durationMs: 200_000,
    };
    expect(judgeHandoff(p, NOW, true)).toBe("commit");
    expect(judgeHandoff({ ...p, seenAt: NOW - HANDOFF_STALE_MS - 1 }, NOW, true)).toBe("stale");
  });

  it("staleness outranks every other reason", () => {
    const p: HandoffObservation = {
      seenAt: NOW - HANDOFF_STALE_MS - 1,
      sawPlaying: false,
      maxProgress: 0,
      durationMs: 0,
    };
    expect(judgeHandoff(p, NOW, false)).toBe("stale");
  });

  it("a paused-seeded track (sawPlaying false) is never credited, however far along", () => {
    // "a track first seen paused carries progress it earned before we were watching"
    // (handoff.ts:12-14)
    const p: HandoffObservation = {
      seenAt: NOW,
      sawPlaying: false,
      maxProgress: 200_000,
      durationMs: 200_000,
    };
    expect(judgeHandoff(p, NOW, true)).toBe("never-played");
  });

  for (const durationMs of [0, -1, Number.NaN]) {
    it(`durationMs=${String(durationMs)} falls back to the 30s floor`, () => {
      const base: HandoffObservation = { seenAt: NOW, sawPlaying: true, maxProgress: 0, durationMs };
      expect(
        judgeHandoff({ ...base, maxProgress: HANDOFF_UNKNOWN_DURATION_FLOOR_MS - 1 }, NOW, true),
      ).toBe("skip");
      expect(
        judgeHandoff({ ...base, maxProgress: HANDOFF_UNKNOWN_DURATION_FLOOR_MS }, NOW, true),
      ).toBe("commit");
    });
  }

  it("a clock that jumped backwards does not read as stale", () => {
    const p: HandoffObservation = {
      seenAt: NOW + 5_000, // observation stamped after `now`
      sawPlaying: true,
      maxProgress: 200_000,
      durationMs: 200_000,
    };
    expect(judgeHandoff(p, NOW, true)).toBe("commit");
  });
});

describe("the 0.35 bar lives in ONE place", () => {
  it("db.ts consumes the shared constant instead of re-declaring the literal", async () => {
    // handoff.ts:4-5: "Keep the constants in ONE place — the 0.35 bar is the same
    // SKIP_FRACTION the store applies in recomputeSkipFlags (db.ts)."
    const { readFileSync } = await import("node:fs");
    const db = readFileSync(new URL("../../src/lib/db.ts", import.meta.url), "utf8");
    expect(db).not.toMatch(/const\s+SKIP_FRACTION\s*=\s*0\.35/);
  });

  it("if it IS re-declared, the two values at least agree", () => {
    expect(HANDOFF_SKIP_FRACTION).toBe(0.35);
  });
});
