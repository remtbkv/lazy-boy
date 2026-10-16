// The daily budget record (docs/multi-user/CAPACITY.md §6; src/lib/budget/daily.ts): the daily
// chores read the meter's month-to-date sums and Turso's month-to-date usage (the usage
// check's own platform read, here a stubbed fetch), store one row per dimension for /usage,
// and write the app-wide mode the hot paths read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBudgetMode, meterFlush, readBudgetDay, setBudgetMode } from "@/lib/db";
import { runBudgetChore } from "@/lib/budget/daily";
import { resetStore, rawClient } from "./adversarial/helpers";

const H = 3_600_000;
const NOW = Date.parse("2026-10-16T09:00:00Z"); // 15.375 of October's 31 days
const realFetch = globalThis.fetch;

function tursoReplies(usage: Record<string, number> | "down") {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    if (!u.startsWith("https://api.turso.tech/")) return realFetch(input);
    if (usage === "down") throw new Error("connect ECONNREFUSED");
    return Response.json({ organization: { usage } });
  }) as typeof fetch;
}

async function meterMonth(cpuHours: number) {
  await meterFlush([
    { day: "2026-10-01", route: "/api/cron/sync", uid: "-", invocations: 1000, cpuUs: (cpuHours / 2) * H * 1000, wallMs: 1, bytes: 0 },
    { day: "2026-10-15", route: "/api/now-playing", uid: "u1", invocations: 500, cpuUs: (cpuHours / 2) * H * 1000, wallMs: 1, bytes: 1e6 },
    // Last month's row is not this month's usage.
    { day: "2026-09-30", route: "/api/cron/sync", uid: "-", invocations: 1e6, cpuUs: 100 * H * 1000, wallMs: 1, bytes: 0 },
  ]);
}

beforeEach(async () => {
  process.env.TURSO_PLATFORM_TOKEN = "platform-token";
  process.env.TURSO_ORG = "org";
  await resetStore();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the daily budget chore", () => {
  it("projects every dimension, records it, and writes the app's mode", async () => {
    await meterMonth(1.2);
    tursoReplies({ rows_read: 100_000_000, rows_written: 1_000_000 });
    const out = await runBudgetChore(NOW);
    expect(out).toMatch(/^economy/);
    expect(await getBudgetMode(0)).toBe("economy");

    const rows = await readBudgetDay();
    expect(rows.map((r) => r.dimension).sort()).toEqual([
      "turso_rows_read",
      "turso_rows_written",
      "vercel_cdn_requests",
      "vercel_cpu_ms",
      "vercel_invocations",
      "vercel_origin_bytes",
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.dimension, r]));
    expect(rows.every((r) => r.day === "2026-10-16")).toBe(true);
    // 1.2 CPU-hours in 15.375 days → 2.42 h a month, + 0.3 h for the other projects: 68% of 4 h.
    expect(by.vercel_cpu_ms.used).toBeCloseTo(1.2 * H, 0);
    expect(by.vercel_cpu_ms.projected).toBeCloseTo(1.2 * H * (31 / 15.375) + 0.3 * H, 0);
    expect(by.vercel_cpu_ms.mode).toBe("economy");
    expect(by.vercel_invocations.used).toBe(1500);
    expect(by.turso_rows_read.used).toBe(100_000_000);
    expect(by.turso_rows_read.mode).toBe("normal");
  });

  it("a Turso it cannot reach keeps the Turso dimensions' last modes", async () => {
    await meterMonth(0.1);
    tursoReplies({ rows_read: 230_000_000, rows_written: 0 });
    expect(await runBudgetChore(NOW)).toMatch(/^freeze/);
    tursoReplies("down");
    expect(await runBudgetChore(NOW + 24 * H)).toMatch(/^freeze/);
    const by = Object.fromEntries((await readBudgetDay()).map((r) => [r.dimension, r]));
    expect(by.turso_rows_read).toMatchObject({ day: "2026-10-17", used: null, projected: null, mode: "freeze" });
    expect(by.vercel_cpu_ms.mode).toBe("normal");
    expect(await getBudgetMode(0)).toBe("freeze");
  });

  it("with no record yet, an unmeasured dimension starts from the stored app mode", async () => {
    await setBudgetMode("economy");
    tursoReplies("down");
    const c = await rawClient();
    await c.execute("ALTER TABLE cpu_meter RENAME TO cpu_meter_off");
    try {
      expect(await runBudgetChore(NOW)).toMatch(/^economy/);
    } finally {
      await c.execute("ALTER TABLE cpu_meter_off RENAME TO cpu_meter");
    }
  });
});
