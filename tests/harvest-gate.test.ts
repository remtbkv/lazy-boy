// The harvest-gate decision across full tick sequences — the two subtlest audit findings
// (paused-as-playing, unreachable session tail) live in this boolean.
import { describe, expect, it } from "vitest";
import { HARVEST_BACKSTOP_MS, shouldHarvest, type HarvestGate } from "@/lib/harvest-gate";

// Simulate the route's stamping rules (documented in harvest-gate.ts).
function tick(
  gate: HarvestGate,
  playingNow: boolean,
  now: number,
  outcome: "ok" | "cooldown-skip" | "throw" = "ok",
): { gate: HarvestGate; harvested: boolean } {
  const next = { ...gate };
  if (playingNow) next.lastActive = now;
  if (!shouldHarvest(next, playingNow, now)) return { gate: next, harvested: false };
  if (outcome !== "cooldown-skip") next.lastHarvest = now; // ok AND throw both stamp
  return { gate: next, harvested: outcome === "ok" };
}

const MIN = 60_000;

describe("harvest gate sequences", () => {
  it("fresh store harvests once, then goes idle", () => {
    let g: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    let r = tick(g, false, 10 * MIN);
    expect(r.harvested).toBe(true);
    g = r.gate;
    r = tick(g, false, 12 * MIN);
    expect(r.harvested).toBe(false);
  });

  it("session tail: exactly one extra harvest after playback stops", () => {
    let g: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    g = tick(g, false, 0).gate; // settle fresh-store harvest
    for (const t of [2, 4, 6]) {
      const r = tick(g, true, t * MIN);
      expect(r.harvested).toBe(true);
      g = r.gate;
    }
    // Playback stops. First idle tick harvests the tail…
    let r = tick(g, false, 8 * MIN);
    expect(r.harvested).toBe(true);
    g = r.gate;
    // …then idle ticks stay idle until the hourly backstop.
    for (const t of [10, 12, 30]) {
      r = tick(g, false, t * MIN);
      expect(r.harvested).toBe(false);
      g = r.gate;
    }
    r = tick(g, false, 8 * MIN + HARVEST_BACKSTOP_MS + MIN);
    expect(r.harvested).toBe(true);
  });

  it("cooldown-skipped harvests keep the branch open (retry next tick)", () => {
    let g: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    g = tick(g, false, 0).gate;
    g = tick(g, true, 2 * MIN, "cooldown-skip").gate; // played but harvest suppressed
    const r = tick(g, false, 4 * MIN); // cooldown lifted → tail caught immediately
    expect(r.harvested).toBe(true);
  });

  it("a persistently THROWING harvest degrades to the hourly backstop, not every tick", () => {
    let g: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    g = tick(g, false, 0).gate;
    g = tick(g, true, 2 * MIN, "throw").gate; // playing tick, harvest threw — stamped anyway
    // The equal stamps grant ONE tail retry (by design); after that, idle ticks must NOT
    // re-poke every 2 minutes — the pre-fix behavior this test pins out.
    let pokes = 0;
    let now = 4 * MIN;
    for (; now < 2 * MIN + HARVEST_BACKSTOP_MS; now += 2 * MIN) {
      const r = tick(g, false, now, "throw");
      if (r.gate.lastHarvest !== g.lastHarvest) pokes += 1;
      g = r.gate;
    }
    expect(pokes).toBe(1); // the single tail retry, then silence
    const r = tick(g, false, now + HARVEST_BACKSTOP_MS, "throw");
    expect(r.gate.lastHarvest).toBeGreaterThan(g.lastHarvest); // backstop attempt happened
  });

  it("paused device (playingNow=false with equal stamps already consumed) stays idle", () => {
    let g: HarvestGate = { lastActive: 0, lastHarvest: 0 };
    g = tick(g, false, 0).gate;
    g = tick(g, true, 2 * MIN).gate;
    g = tick(g, false, 4 * MIN).gate; // tail
    // Hours of a paused device = playingNow false → no harvests until backstop.
    for (const t of [6, 8, 20, 40]) {
      expect(tick(g, false, t * MIN).harvested).toBe(false);
    }
  });
});
