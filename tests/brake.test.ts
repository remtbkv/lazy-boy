// Known answers for the fair-share brake (docs/multi-user/PLAN.md §7.5): the quota day, the share,
// the two slow modes, and the one constant that switches it on in Phase 4a.
import { describe, expect, it, vi } from "vitest";
import { APP_DAILY_BUDGET, BRAKE_ON, brakeMode, nextQuotaReset, quotaDay, shareOf } from "@/lib/brake";
import { decideHarvest, state0 } from "./brake-helpers";

describe("the quota day starts at 14:51 UTC", () => {
  it("a call a minute before the reset counts toward the day before", () => {
    expect(quotaDay(Date.UTC(2026, 9, 16, 14, 50, 59))).toBe("2026-10-15");
    expect(quotaDay(Date.UTC(2026, 9, 16, 14, 51, 0))).toBe("2026-10-16");
    expect(quotaDay(Date.UTC(2026, 9, 17, 3, 0))).toBe("2026-10-16");
    expect(quotaDay(Date.UTC(2026, 9, 17, 14, 50))).toBe("2026-10-16");
  });

  it("holds across the year boundary and before the anchor", () => {
    expect(quotaDay(Date.UTC(2027, 0, 1, 14, 0))).toBe("2026-12-31");
    expect(quotaDay(Date.UTC(2025, 11, 31, 15, 0))).toBe("2025-12-31");
  });

  it("the next reset is the end of the current quota day", () => {
    expect(nextQuotaReset(Date.UTC(2026, 9, 16, 14, 50, 59))).toBe(Date.UTC(2026, 9, 16, 14, 51));
    expect(nextQuotaReset(Date.UTC(2026, 9, 16, 14, 51))).toBe(Date.UTC(2026, 9, 17, 14, 51));
    expect(nextQuotaReset(Date.UTC(2026, 9, 16, 23, 0))).toBe(Date.UTC(2026, 9, 17, 14, 51));
  });
});

describe("the share and the modes", () => {
  it("426 a day for the app, less the recorder's 24 of a 450 budget", () => {
    expect(APP_DAILY_BUDGET).toBe(426);
    expect(shareOf(1)).toBe(426);
    expect(shareOf(2)).toBe(213);
    expect(shareOf(5)).toBeCloseTo(85.2);
  });

  it("track-change harvests until a user reaches their share, then 15-minute batches for them alone", () => {
    expect(brakeMode({ mine: 212, total: 300, users: 2, on: true })).toBe("normal");
    expect(brakeMode({ mine: 213, total: 300, users: 2, on: true })).toBe("share");
    // The other user, under their share, is not slowed by the first one's day.
    expect(brakeMode({ mine: 87, total: 300, users: 2, on: true })).toBe("normal");
  });

  it("30-minute batches for everyone once the app's total reaches 426", () => {
    expect(brakeMode({ mine: 10, total: 425, users: 5, on: true })).toBe("normal");
    expect(brakeMode({ mine: 10, total: 426, users: 5, on: true })).toBe("all");
    expect(brakeMode({ mine: 400, total: 426, users: 2, on: true })).toBe("all");
    expect(brakeMode({ mine: 426, total: 426, users: 1, on: true })).toBe("all");
  });

  it("counting but inert in Phase 3: off, every user stays on track-change harvests", () => {
    expect(BRAKE_ON).toBe(false);
    expect(brakeMode({ mine: 999, total: 999, users: 2, on: false })).toBe("normal");
  });

  it("no users the claim could lease: nobody is braked by a division by zero", () => {
    expect(brakeMode({ mine: 0, total: 0, users: 0, on: true })).toBe("normal");
  });
});

describe("completeness, the tail, its retry and the backstop fire in every mode (§7.5 item 5)", () => {
  const now = Date.UTC(2026, 9, 16, 20, 0);
  for (const brake of ["share", "all"] as const) {
    it(`in ${brake}`, () => {
      expect(decideHarvest({ brake, now, probe: state0({ changes: 25 }), lastHarvestAt: now - 60_000 })).toBe("completeness");
      expect(decideHarvest({ brake, now, probe: state0({ tail: true }), lastHarvestAt: now - 60_000 })).toBe("tail");
      expect(decideHarvest({ brake, now, probe: state0({ retryAt: now }), lastHarvestAt: now - 5 * 60_000 })).toBe("tail-retry");
      expect(decideHarvest({ brake, now, probe: state0(), lastHarvestAt: now - 3_600_000 })).toBe("backstop");
      expect(decideHarvest({ brake, now, probe: state0({ changes: 1 }), lastHarvestAt: now - 2 * 60_000, openApp: true })).toBe("open-app");
    });
  }
});

describe("BRAKE_ON is the one switch Phase 4a flips (§7.5)", () => {
  it("the tick's Phase 3 numbers read it, so flipping it puts the brake to work", async () => {
    vi.resetModules();
    vi.doMock("@/lib/brake", async (orig) => ({ ...(await orig<typeof import("@/lib/brake")>()), BRAKE_ON: true }));
    try {
      const { PHASE3_TICK } = await import("@/lib/sync/tick");
      expect(PHASE3_TICK.brakeOn).toBe(true);
    } finally {
      vi.doUnmock("@/lib/brake");
      vi.resetModules();
    }
  });
});
