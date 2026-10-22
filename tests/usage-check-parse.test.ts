import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reconciliation's parser against the body Turso's windowed database-usage endpoint
// actually returned (captured by lane 1904 for `lazyboy`, 2026-10-16T09:05Z, HTTP 200):
// top-level `total`, `database.usage`, `database.instances` as an array of {uuid, usage}.
// The old parser read `database.total` / a map in `database.instances`, found nothing, and
// recorded `_platform_error` every day (docs/READ_QUOTA.md, "The reconciliation").
const captured = JSON.parse(
  readFileSync(path.resolve(__dirname, "fixtures/turso-db-usage-2026-10-16.json"), "utf8"),
);

const ledger = vi.hoisted(() => ({ sets: [] as [string, string, number][] }));
vi.mock("@/lib/db", () => ({
  ledgerAdd: async () => {},
  ledgerSet: async (day: string, reader: string, rows: number) => {
    ledger.sets.push([day, reader, rows]);
  },
  ledgerDayModeledTotal: async () => 5_000_000,
}));

const { runUsageCheck } = await import("@/lib/usage-check");

function stubPlatform(day: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/databases/")) return Response.json(day.body, { status: day.status });
      return Response.json({ organization: { usage: { rows_read: 1 } } });
    }),
  );
}

const readers = () => ledger.sets.map(([, r]) => r);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe("usage-check reconciliation parser", () => {
  beforeEach(() => {
    ledger.sets.length = 0;
    process.env.TURSO_PLATFORM_TOKEN = "t";
    process.env.TURSO_ORG = "o";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the day's rows_read from the captured body, with no _platform_error", async () => {
    stubPlatform({ status: 200, body: captured });
    const res = await runUsageCheck();
    expect(ledger.sets).toContainEqual([yesterday(), "_platform_total", 5_209_457]);
    expect(readers()).not.toContain("_platform_error");
    expect(res.body.reconcile).toMatchObject({ platformRows: 5_209_457, modeledRows: 5_000_000 });
  });

  it("sums database.instances[] when no total is given", async () => {
    stubPlatform({
      status: 200,
      body: {
        database: {
          instances: [
            { uuid: "a", usage: { rows_read: 100 } },
            { uuid: "b", usage: { rows_read: 23 } },
          ],
        },
      },
    });
    await runUsageCheck();
    expect(ledger.sets).toContainEqual([yesterday(), "_platform_total", 123]);
  });

  it.each([
    ["an error status", { status: 500, body: { error: "boom" } }],
    ["an error body", { status: 200, body: { error: "database not found" } }],
    ["a body missing rows_read", { status: 200, body: { total: { rows_written: 4 }, database: { usage: {} } } }],
  ])("%s records _platform_error and never a zero total", async (_, day) => {
    stubPlatform(day);
    await runUsageCheck();
    expect(readers()).toContain("_platform_error");
    expect(readers()).not.toContain("_platform_total");
    expect(readers()).not.toContain("_residual");
  });
});
