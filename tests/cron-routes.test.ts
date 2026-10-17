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
      if (name === "runBudgetChore" && spy.during) await spy.during();
      if (fail || spy.failing.has(name)) throw new Error(`${name} failed`);
      return name === "runUsageCheck" ? spy.usage : undefined;
    };
  return {
    calls,
    marks,
    failing: new Set<string>(),
    chore,
    usage: { status: 200, body: { ok: true } as Record<string, unknown> },
    // Runs inside the route's run, mid-chores (the lock case).
    during: null as null | (() => Promise<void>),
  };
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
vi.mock("@/lib/usage-check", () => ({ runUsageCheck: spy.chore("runUsageCheck") }));
vi.mock("@/lib/budget/daily", () => ({ runBudgetChore: spy.chore("runBudgetChore") }));
// Phase 4a's chores (daily-4a.ts, its own tests) run after the route's.
vi.mock("@/lib/daily-4a", () => ({
  runPhase4aChores: async () => {
    spy.calls.push("phase4a");
    return { deletions: "retried none; day4 none; invites none", sweeps: "{}", cronJobs: "{}" };
  },
}));
vi.mock("@/lib/auth", () => ({ getValidAccessTokenFor: async () => null, tokenForTick: async () => null }));

const { getAppMeta, setAppMeta } = await import("@/lib/app-db");
const daily = await import("@/app/api/cron/daily/route");
const bench = await import("@/app/api/cron/store-bench/route");
const sync = await import("@/app/api/cron/sync/route");

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://lazy-boy.example${path}`, { headers });
const authed = { authorization: "Bearer s3cret" };

describe("cron routes", () => {
  beforeEach(async () => {
    spy.calls.length = 0;
    spy.marks.length = 0;
    spy.failing.clear();
    spy.usage = { status: 200, body: { ok: true } };
    // No run yet today: each case starts as the first delivery of the day.
    await setAppMeta("daily_at", "0");
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
      "phase4a",
    ];
    for (const c of chores) expect(spy.calls.filter((x) => x === c), c).toHaveLength(1);
    expect(spy.calls).toHaveLength(chores.length);
  });

  // The two-user rehearsal's daily cycle (docs/multi-user/REHEARSAL.md, check 9) ran the chores
  // twice in one UTC day both ways below: a tick found daily_at stale at 08:32 and Vercel's cron
  // came at 09:00, and a second delivery of the cron ran them again.
  it("runs the chores once a UTC day: a second delivery, or the cron after a tick's run that day, runs none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 20, 9, 0, 30));
      expect((await daily.GET(req("/api/cron/daily", authed))).status).toBe(200);
      // The day's run: every chore, once ("daily runs each chore exactly once" pins the list).
      const ran = [...spy.calls];
      expect(ran.length).toBeGreaterThan(0);
      spy.calls.length = 0;
      const again = await daily.GET(req("/api/cron/daily", authed));
      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ ok: true, skipped: "ran today" });
      expect(spy.calls).toEqual([]);
      // A tick ran them at 08:32 today; the cron at 09:00 runs none. Yesterday's run leaves today's due.
      await setAppMeta("daily_at", String(Date.UTC(2026, 9, 20, 8, 32)));
      expect((await (await daily.GET(req("/api/cron/daily", authed))).json()).skipped).toBe("ran today");
      expect(spy.calls).toEqual([]);
      await setAppMeta("daily_at", String(Date.UTC(2026, 9, 19, 9, 0)));
      expect((await daily.GET(req("/api/cron/daily", authed))).status).toBe(200);
      expect(spy.calls).toEqual(ran);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the tick's lock:daily while it runs, so the cron and a tick never run the chores at once", async () => {
    const { acquireAppLock, releaseAppLock } = await import("@/lib/app-db");
    // A tick holds it: the cron runs nothing.
    const tick = await acquireAppLock("lock:daily", 60_000);
    expect(tick).toBeTruthy();
    expect(await (await daily.GET(req("/api/cron/daily", authed))).json()).toMatchObject({ ok: true, skipped: "running" });
    expect(spy.calls).toEqual([]);
    await releaseAppLock("lock:daily", tick!);
    // The cron's run holds it: a tick asking mid-run is refused; it is free again afterwards.
    let midRun: string | null = "not asked";
    spy.during = async () => {
      midRun = await acquireAppLock("lock:daily", 60_000);
    };
    expect((await daily.GET(req("/api/cron/daily", authed))).status).toBe(200);
    spy.during = null;
    expect(midRun).toBeNull();
    const after = await acquireAppLock("lock:daily", 60_000);
    expect(after).toBeTruthy();
    await releaseAppLock("lock:daily", after!);
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
    // A tick runs the chores only when daily_at is over 26 hours old (PLAN §7.11).
    await setAppMeta("daily_at", String(Date.now()));
    const res = await sync.GET(req("/api/cron/sync", { ...authed, "x-vercel-cron": "1" }));
    expect(res.status).toBe(503); // the owner alarm (no admin row here), reached without any chore
    expect(spy.calls).toEqual([]);
  });

  it("store-bench passes ?store through and defaults to core", async () => {
    expect((await bench.GET(req("/api/cron/store-bench", authed))).status).toBe(200);
    expect((await bench.GET(req("/api/cron/store-bench?store=telemetry", authed))).status).toBe(200);
    expect((await bench.GET(req("/api/cron/store-bench?store=nope", authed))).status).toBe(400);
    expect(spy.calls).toEqual(["benchStore:core", "benchStore:telemetry"]);
  });

  // The health check and the tick read these (PLAN §7.10-7.11): when the chores last finished
  // (`app_meta.daily_at`), and Turso's pace.
  it("daily stamps daily_at when its run finishes, and the usage check's pace verdict", async () => {
    spy.usage = { status: 500, body: { ok: false, breached: ["rows_read"] } };
    spy.failing.add("pruneApiLog"); // a failed chore still finishes the run
    const t0 = Date.now();
    await daily.GET(req("/api/cron/daily", authed));
    expect(Number(await getAppMeta("daily_at"))).toBeGreaterThanOrEqual(t0);
    const pace = JSON.parse(spy.marks.find(([k]) => k === "quota_pace")?.[1] ?? "null");
    expect(pace).toMatchObject({ ahead: true });
  });

  it("an unconfigured usage check records no pace verdict", async () => {
    spy.usage = { status: 500, body: { ok: false, error: "unconfigured" } };
    await daily.GET(req("/api/cron/daily", authed));
    expect(spy.marks.map(([k]) => k)).toEqual([]);
  });

  // PLAN §7.11: the tick reads the app database's daily_at, so the cron's run must stamp it, or
  // the next overdue tick runs every chore a second time.
  it("daily stamps daily_at in the app database, and reports Phase 4a's chores", async () => {
    const t0 = Date.now();
    const res = await daily.GET(req("/api/cron/daily", authed));
    const body = (await res.json()) as { chores: Record<string, string> };
    expect(Number(await getAppMeta("daily_at"))).toBeGreaterThanOrEqual(t0);
    expect(body.chores.deletions).toMatch(/^retried/);
    expect(Object.keys(body.chores)).toEqual(expect.arrayContaining(["sweeps", "cronJobs"]));
  });

  it("runDailyChores is the same run for the tick (TickDeps.dailyChores): each chore once, no stamp of its own", async () => {
    const { runDailyChores } = await import("@/lib/daily-chores");
    const { adminStore } = await import("@/lib/identity-read");
    const out = await runDailyChores((await adminStore())!);
    expect(Object.keys(out)).toHaveLength(10);
    expect(spy.calls.filter((x) => x === "phase4a")).toHaveLength(1);
    expect(spy.calls.filter((x) => x === "runBudgetChore")).toHaveLength(1);
    // The caller stamps daily_at (the daily route, or the tick in the app database).
    expect(spy.marks).toEqual([]);
  });
});
