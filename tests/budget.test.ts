// The budget module's known answers (docs/multi-user/CAPACITY.md §6; src/lib/budget/budget.ts):
// the month projected from month-to-date on day 1, mid-month and the last day of 28-, 30- and
// 31-day UTC months; every mode boundary and the 50% way back; the allowances and the CPU
// calibration; a dimension nobody could measure keeping the mode it had.
import { describe, expect, it } from "vitest";
import {
  CPU_CALIBRATION,
  HARD_LIMITS,
  OTHER_PROJECTS,
  budgetReport,
  nextMode,
  projectMonth,
  worstMode,
} from "@/lib/budget/budget";

const H = 3_600_000;
const D = 24 * H;
const at = (iso: string) => Date.parse(iso);

describe("projectMonth", () => {
  it("28-day month (Feb 2026): day 1, mid-month, the last day", () => {
    // 12 hours into a 28-day month: 1/56 of it elapsed.
    expect(projectMonth(100, at("2026-02-01T12:00:00Z"))).toBeCloseTo(5_600, 6);
    // 14 days in: half.
    expect(projectMonth(100, at("2026-02-15T00:00:00Z"))).toBeCloseTo(200, 6);
    // 27.5 days in.
    expect(projectMonth(275, at("2026-02-28T12:00:00Z"))).toBeCloseTo(280, 6);
  });

  it("30-day month (Apr 2026): day 1, mid-month, the last day", () => {
    expect(projectMonth(10, at("2026-04-01T06:00:00Z"))).toBeCloseTo(10 * 120, 6);
    expect(projectMonth(150, at("2026-04-16T00:00:00Z"))).toBeCloseTo(300, 6);
    expect(projectMonth(290, at("2026-04-30T00:00:00Z"))).toBeCloseTo(300, 6);
  });

  it("31-day month (Oct 2026): day 1, mid-month, the last day", () => {
    expect(projectMonth(31, at("2026-10-01T09:00:00Z"))).toBeCloseTo(31 * (31 * 24) / 9, 6);
    expect(projectMonth(155, at("2026-10-16T12:00:00Z"))).toBeCloseTo(155 * 31 / 15.5, 6);
    expect(projectMonth(305, at("2026-10-31T12:00:00Z"))).toBeCloseTo(310, 6);
  });

  it("the first hour of a month projects from at least an hour, never divides by zero", () => {
    expect(projectMonth(1, at("2026-10-01T00:00:00Z"))).toBeCloseTo(31 * 24, 6);
    expect(projectMonth(0, at("2026-10-01T00:00:00Z"))).toBe(0);
  });

  it("the month is the UTC one: 23:59 on the 31st ET is already Nov 1 UTC", () => {
    expect(projectMonth(1, at("2026-11-01T03:59:00Z"))).toBeCloseTo((30 * D) / (3 * H + 59 * 60_000), 6);
  });
});

describe("nextMode: thresholds on the projected share of the HARD limit", () => {
  it("each band from normal", () => {
    expect(nextMode("normal", 0)).toBe("normal");
    expect(nextMode("normal", 0.5)).toBe("normal");
    expect(nextMode("normal", 0.55)).toBe("normal");
    expect(nextMode("normal", 0.6)).toBe("normal");
    expect(nextMode("normal", 0.6001)).toBe("economy");
    expect(nextMode("normal", 0.8)).toBe("economy");
    expect(nextMode("normal", 0.8001)).toBe("freeze");
    expect(nextMode("normal", 3)).toBe("freeze");
  });

  it("the way back: normal only at or under 50%; the band above it holds", () => {
    expect(nextMode("economy", 0.6)).toBe("economy");
    expect(nextMode("economy", 0.5001)).toBe("economy");
    expect(nextMode("economy", 0.5)).toBe("normal");
    expect(nextMode("freeze", 0.8)).toBe("economy");
    expect(nextMode("freeze", 0.55)).toBe("economy");
    expect(nextMode("freeze", 0.5)).toBe("normal");
    expect(nextMode("freeze", 0.81)).toBe("freeze");
  });

  it("the app's mode is its worst dimension's", () => {
    expect(worstMode([])).toBe("normal");
    expect(worstMode(["normal", "economy", "normal"])).toBe("economy");
    expect(worstMode(["economy", "freeze"])).toBe("freeze");
  });
});

describe("budgetReport", () => {
  const mid = at("2026-04-16T00:00:00Z"); // 15 of 30 days: the projection doubles

  it("projects each dimension, adds the other projects' allowance and the CPU calibration", () => {
    const r = budgetReport(
      {
        meter: { cpuUs: 30 * 60_000 * 1000, invocations: 100_000, bytes: 1e9 },
        turso: { rows_read: 50_000_000, rows_written: 1_000_000 },
      },
      {},
      "normal",
      mid,
    );
    const by = Object.fromEntries(r.dims.map((d) => [d.dimension, d]));
    // 30 CPU-minutes so far → 60 a month, ×calibration, + the other projects' 0.3 h.
    expect(by.vercel_cpu_ms.used).toBe(30 * 60_000);
    expect(by.vercel_cpu_ms.projected).toBeCloseTo(60 * 60_000 * CPU_CALIBRATION + 0.3 * H, 3);
    expect(OTHER_PROJECTS.vercel_cpu_ms).toBe(0.3 * H);
    expect(by.vercel_invocations.projected).toBeCloseTo(200_000 + 50_000, 3);
    expect(by.vercel_cdn_requests.projected).toBeCloseTo(200_000 * 1.1 + OTHER_PROJECTS.vercel_cdn_requests, 3);
    expect(by.vercel_origin_bytes.projected).toBeCloseTo(2e9 + OTHER_PROJECTS.vercel_origin_bytes, 3);
    expect(by.turso_rows_read.projected).toBeCloseTo(100_000_000, 3);
    expect(by.turso_rows_written.projected).toBeCloseTo(2_000_000, 3);
    for (const d of r.dims) {
      expect(d.limit).toBe(HARD_LIMITS[d.dimension]);
      expect(d.fraction).toBeCloseTo(d.projected! / d.limit, 9);
    }
    expect(r.mode).toBe("normal");
  });

  it("one dimension past 60% puts the app in economy, past 80% in freeze", () => {
    // 1.25 h so far → 2.5 h + 0.3 h = 2.8 h of 4 h: 70%.
    const eco = budgetReport({ meter: { cpuUs: 1.25 * H * 1000, invocations: 0, bytes: 0 }, turso: null }, {}, "normal", mid);
    expect(eco.dims.find((d) => d.dimension === "vercel_cpu_ms")!.mode).toBe("economy");
    expect(eco.mode).toBe("economy");
    // Turso rows read 205M so far → 410M of 500M: 82%.
    const frz = budgetReport({ meter: null, turso: { rows_read: 205_000_000, rows_written: 0 } }, {}, "normal", mid);
    expect(frz.mode).toBe("freeze");
  });

  it("a dimension nobody could measure keeps the mode it had (or the app's, with no record)", () => {
    const r = budgetReport({ meter: null, turso: null }, { turso_rows_read: "freeze" }, "economy", mid);
    const by = Object.fromEntries(r.dims.map((d) => [d.dimension, d]));
    expect(by.turso_rows_read.mode).toBe("freeze");
    expect(by.turso_rows_read.used).toBeNull();
    expect(by.turso_rows_read.projected).toBeNull();
    expect(by.vercel_cpu_ms.mode).toBe("economy");
    expect(r.mode).toBe("freeze");
  });

  it("hysteresis per dimension: 55% stays economy if it was, normal if it was", () => {
    // 0.95 h so far → 1.9 h a month + the other projects' 0.3 h = 2.2 h of 4 h: 55%.
    const cpuUs = ((2.2 * H - 0.3 * H) / 2) * 1000;
    const was = budgetReport({ meter: { cpuUs, invocations: 0, bytes: 0 }, turso: null }, { vercel_cpu_ms: "economy" }, "normal", mid);
    expect(was.dims.find((d) => d.dimension === "vercel_cpu_ms")!.fraction).toBeCloseTo(0.55, 6);
    expect(was.mode).toBe("economy");
    const fresh = budgetReport({ meter: { cpuUs, invocations: 0, bytes: 0 }, turso: null }, { vercel_cpu_ms: "normal" }, "normal", mid);
    expect(fresh.mode).toBe("normal");
  });
});
