// /usage with a dead telemetry store (docs/STORE_MIGRATION.md §6.6): each log section that
// failed comes back empty and flagged, the others keep their data, and nothing throws, so the
// page renders its core half instead of failing whole.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => new Set<string>());
const dead = (name: string, value: unknown) => async () => {
  if (fail.has(name)) throw new Error("telemetry store down");
  return value;
};
vi.mock("@/lib/db", () => ({
  readLedger: dead("ledger", [{ day: "2026-10-15", reader: "day_strip", calls: 1, modeledRows: 9 }]),
  getClientLoadSpeed: dead("client", { pages: [{ page: "/home" }], opens: [], errors: [] }),
  getSpotifyCallBreakdown: dead("spotifyCalls", [{ source: "cron", calls: 3 }]),
  getRecentlyPlayedQuotaWindows: dead("quotaWindows", [{ windowStart: 1, calls: 2 }]),
  readBudgetDay: dead("budget", [{ day: "2026-10-15", dimension: "vercel_cpu_ms", mode: "normal" }]),
}));

const { loadUsageTelemetry } = await import("@/app/(app)/usage/telemetry");

describe("loadUsageTelemetry", () => {
  beforeEach(() => fail.clear());

  it("all up: every section has its data and none is flagged", async () => {
    const t = await loadUsageTelemetry(14);
    expect(t.ledger).toHaveLength(1);
    expect(t.client.pages).toHaveLength(1);
    expect(t.spotifyCalls).toHaveLength(1);
    expect(t.quotaWindows).toHaveLength(1);
    expect(t.budget).toHaveLength(1);
    expect(t.down).toEqual({ ledger: false, client: false, spotifyCalls: false, quotaWindows: false, budget: false });
  });

  it("all down: empty sections, all flagged, no throw", async () => {
    for (const s of ["ledger", "client", "spotifyCalls", "quotaWindows", "budget"]) fail.add(s);
    const t = await loadUsageTelemetry(14);
    expect(t.ledger).toEqual([]);
    expect(t.client).toEqual({ pages: [], opens: [], errors: [] });
    expect(t.spotifyCalls).toEqual([]);
    expect(t.quotaWindows).toEqual([]);
    expect(t.budget).toEqual([]);
    expect(t.down).toEqual({ ledger: true, client: true, spotifyCalls: true, quotaWindows: true, budget: true });
  });

  it("one down: only that section is empty", async () => {
    fail.add("spotifyCalls");
    const t = await loadUsageTelemetry(14);
    expect(t.spotifyCalls).toEqual([]);
    expect(t.down.spotifyCalls).toBe(true);
    expect(t.ledger).toHaveLength(1);
    expect(t.down.ledger).toBe(false);
  });
});
