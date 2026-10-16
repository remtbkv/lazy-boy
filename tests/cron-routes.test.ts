// The CRON_SECRET-gated routes added by the store split (docs/STORE_MIGRATION.md §6.5, §6.7,
// §6.9): /api/cron/daily runs each daily chore once and nothing else; /api/cron/store-bench and
// /api/cron/daily answer 401 without the secret; /api/cron/sync no longer has a daily block.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spy = vi.hoisted(() => {
  process.env.CRON_SECRET = "s3cret";
  const calls: string[] = [];
  const marks: [string, string][] = [];
  const chore =
    (name: string, fail = false) =>
    async () => {
      calls.push(name);
      if (fail || spy.failing.has(name)) throw new Error(`${name} failed`);
      return name === "runUsageCheck" ? spy.usage : undefined;
    };
  return { calls, marks, failing: new Set<string>(), chore, usage: { status: 200, body: { ok: true } as Record<string, unknown> } };
});

vi.mock("@/lib/db", () => ({
  pruneApiLog: spy.chore("pruneApiLog"),
  pruneClientMetrics: spy.chore("pruneClientMetrics"),
}));
// The admin's store (multi-user Phase 2: the cron and the chores run for the admin, at the
// database his users row names).
vi.mock("@/lib/identity-read", () => ({
  adminStore: async () => ({
    uid: "ownerownerow",
    recomputeAllTimeStats: spy.chore("recomputeAllTimeStats"),
    rebuildHomePayload: spy.chore("rebuildHomePayload"),
    checkPlayedAtConvention: spy.chore("checkPlayedAtConvention"),
    // The chores' bookkeeping: the health check's marks, not a chore.
    setHealthMark: async (key: string, value: string) => {
      spy.marks.push([key, value]);
    },
    benchStore: async (store: string) => {
      spy.calls.push(`benchStore:${store}`);
      return { store, host: "file", probes: {} };
    },
  }),
}));
// /api/cron/sync's no-token exit (no user_tokens row), so its GET returns before touching Spotify.
vi.mock("@/lib/app-db", () => ({ readTokenRow: async () => null }));
vi.mock("@/lib/usage-check", () => ({ runUsageCheck: spy.chore("runUsageCheck") }));
vi.mock("@/lib/budget/daily", () => ({ runBudgetChore: spy.chore("runBudgetChore") }));
vi.mock("@/lib/auth", () => ({ getValidAccessTokenFor: async () => null }));

const daily = await import("@/app/api/cron/daily/route");
const bench = await import("@/app/api/cron/store-bench/route");
const sync = await import("@/app/api/cron/sync/route");

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://lazy-boy.example${path}`, { headers });
const authed = { authorization: "Bearer s3cret" };

describe("cron routes", () => {
  beforeEach(() => {
    spy.calls.length = 0;
    spy.marks.length = 0;
    spy.failing.clear();
    spy.usage = { status: 200, body: { ok: true } };
  });

  it("daily and store-bench answer 401 without the secret, and run nothing", async () => {
    for (const h of [{}, { authorization: "Bearer wrong" }, { authorization: "s3cret" }]) {
      expect((await daily.GET(req("/api/cron/daily", h))).status).toBe(401);
      expect((await bench.GET(req("/api/cron/store-bench", h))).status).toBe(401);
    }
    expect(spy.calls).toEqual([]);
  });

  it("daily runs each chore exactly once, and nothing else", async () => {
    const res = await daily.GET(req("/api/cron/daily", authed));
    expect(res.status).toBe(200);
    const chores = [
      "recomputeAllTimeStats",
      "rebuildHomePayload",
      "pruneApiLog",
      "pruneClientMetrics",
      "checkPlayedAtConvention",
      "runUsageCheck",
      "runBudgetChore",
    ];
    for (const c of chores) expect(spy.calls.filter((x) => x === c), c).toHaveLength(1);
    expect(spy.calls).toHaveLength(chores.length);
  });

  it("one failing chore does not stop the rest, and the route still answers 200", async () => {
    spy.failing.add("pruneApiLog");
    const res = await daily.GET(req("/api/cron/daily", authed));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chores: Record<string, string> };
    expect(body.chores.pruneApiLog).toMatch(/failed/);
    expect(spy.calls).toContain("pruneClientMetrics");
    expect(spy.calls).toContain("runUsageCheck");
  });

  it("/api/cron/sync has no daily block: the old x-vercel-cron header runs no chore", async () => {
    const res = await sync.GET(req("/api/cron/sync", { ...authed, "x-vercel-cron": "1" }));
    expect(res.status).toBe(503); // the no-token exit, reached without any chore
    expect(spy.calls).toEqual([]);
  });

  it("store-bench passes ?store through and defaults to core", async () => {
    expect((await bench.GET(req("/api/cron/store-bench", authed))).status).toBe(200);
    expect((await bench.GET(req("/api/cron/store-bench?store=telemetry", authed))).status).toBe(200);
    expect((await bench.GET(req("/api/cron/store-bench?store=nope", authed))).status).toBe(400);
    expect(spy.calls).toEqual(["benchStore:core", "benchStore:telemetry"]);
  });

  // The health check reads these (PLAN §7.10): when the chores last finished, and Turso's pace.
  it("daily stamps daily_at when its run finishes, and the usage check's pace verdict", async () => {
    spy.usage = { status: 500, body: { ok: false, breached: ["rows_read"] } };
    spy.failing.add("pruneApiLog"); // a failed chore still finishes the run
    const t0 = Date.now();
    await daily.GET(req("/api/cron/daily", authed));
    const daily_at = spy.marks.find(([k]) => k === "daily_at");
    expect(Number(daily_at?.[1])).toBeGreaterThanOrEqual(t0);
    const pace = JSON.parse(spy.marks.find(([k]) => k === "quota_pace")?.[1] ?? "null");
    expect(pace).toMatchObject({ ahead: true });
  });

  it("an unconfigured usage check records no pace verdict", async () => {
    spy.usage = { status: 500, body: { ok: false, error: "unconfigured" } };
    await daily.GET(req("/api/cron/daily", authed));
    expect(spy.marks.map(([k]) => k)).toEqual(["daily_at"]);
  });
});
