// The hourly health check (PLAN.md §7.10; T13's cron-secret half for this route). Known answers
// for each condition, and the route against the simulated store.
import { beforeEach, describe, expect, it } from "vitest";
import { healthVerdict, DAILY_STALE_MS, METER_QUIET_MS } from "@/lib/health";
import { GET } from "@/app/api/cron/health/route";
import { meterFlush, recordBudgetDay, setBudgetMode } from "@/lib/db";
import { rawClient, resetStore } from "../adversarial/helpers";
import { reportIsolation } from "@/lib/isolation";
import { ownerStore, ownerUid } from "../owner-store";
import { appDatabaseUrl, getAppMeta, setAppMeta } from "@/lib/app-db";
import { createClient } from "@libsql/client";

const healthy = { ok: true, staleForMs: 60_000, reason: null } as const;

describe("healthVerdict", () => {
  it("green when every measurable condition holds, listing what it could not measure", () => {
    expect(
      healthVerdict({
        isolationEvents: null,
        ownerCapture: healthy,
        dailyAgeMs: null,
        quotaAhead: null,
        budgetMode: null,
        meterAgeMs: null,
      }),
    ).toEqual({
      ok: true,
      reasons: [],
      unchecked: ["isolation", "daily", "quota-pace", "budget", "meter"],
    });
  });

  it("each condition turns it red on its own", () => {
    const base = {
      isolationEvents: 0,
      ownerCapture: healthy,
      dailyAgeMs: 0,
      quotaAhead: false,
      budgetMode: "normal" as const,
      meterAgeMs: 0,
    };
    expect(healthVerdict(base)).toEqual({ ok: true, reasons: [], unchecked: [] });
    expect(healthVerdict({ ...base, isolationEvents: 1 }).reasons).toEqual(["isolation"]);
    expect(
      healthVerdict({ ...base, ownerCapture: { ok: false, staleForMs: null, reason: "signed out" } }).reasons,
    ).toEqual(["owner-capture"]);
    expect(healthVerdict({ ...base, dailyAgeMs: DAILY_STALE_MS + 1 }).reasons).toEqual(["daily"]);
    expect(healthVerdict({ ...base, dailyAgeMs: DAILY_STALE_MS }).ok).toBe(true);
    expect(healthVerdict({ ...base, quotaAhead: true }).reasons).toEqual(["quota-pace"]);
    // The budget (CAPACITY §6): any dimension in economy or freeze; the meter quiet six hours.
    expect(healthVerdict({ ...base, budgetMode: "economy" }).reasons).toEqual(["budget"]);
    expect(healthVerdict({ ...base, budgetMode: "freeze" }).reasons).toEqual(["budget"]);
    expect(healthVerdict({ ...base, meterAgeMs: METER_QUIET_MS }).ok).toBe(true);
    expect(healthVerdict({ ...base, meterAgeMs: METER_QUIET_MS + 1 }).reasons).toEqual(["meter"]);
    expect(healthVerdict({ ...base, meterAgeMs: Number.POSITIVE_INFINITY }).reasons).toEqual(["meter"]);
    expect(METER_QUIET_MS).toBe(6 * 3_600_000);
  });
});

describe("/api/cron/health", () => {
  const call = (auth?: string) =>
    GET(new Request("http://x/api/cron/health", { headers: auth ? { authorization: auth } : {} }));

  // The owner in the app database (Phase 3 reads his capture from sync_state): his users row,
  // a token row when `token`, and his last successful step `okAgoMs` ago.
  async function ownerApp(o: { token: boolean; okAgoMs: number | null }): Promise<void> {
    const app = createClient({ url: appDatabaseUrl(), intMode: "number" });
    try {
      for (const t of ["user_tokens", "sync_state", "users"]) await app.execute(`DELETE FROM ${t}`);
      await app.execute({
        sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
              VALUES (?, 'acct', 'sp', 'lazyboy', 'active', 0, 1, 0, 0)`,
        args: [ownerUid()],
      });
      if (o.token) await app.execute({ sql: "INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (?, 'v1.x', 0, 0)", args: [ownerUid()] });
      if (o.okAgoMs !== null) {
        await app.execute({
          sql: "INSERT INTO sync_state (uid, state, next_probe_at, last_ok_at) VALUES (?, 'idle', 0, ?)",
          args: [ownerUid(), Date.now() - o.okAgoMs],
        });
      }
    } finally {
      app.close();
    }
  }

  beforeEach(async () => {
    process.env.CRON_SECRET = "zen-secret";
    process.env.CRON_SECRET_EXT = "ext-secret";
    await resetStore();
    await getAppMeta("schema_version"); // the first open creates the app database
    await ownerApp({ token: false, okAgoMs: null });
  });

  it("refuses no secret and a wrong one; accepts either pinger's", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("Bearer zen-secret")).status).not.toBe(401);
    expect((await call("Bearer ext-secret")).status).not.toBe(401);
  });

  it("an unset secret opens nothing", async () => {
    delete process.env.CRON_SECRET_EXT;
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer undefined")).status).toBe(401);
  });

  it("red when the owner has no token row; green with a token and a recent step; no listening data", async () => {
    // The meter writes on every metered request in production; a meter that never wrote is red.
    await meterFlush([{ day: new Date().toISOString().slice(0, 10), route: "/api/x", uid: "-", invocations: 1, cpuUs: 1, wallMs: 1, bytes: 0 }]);
    // The plaintext row alone is not a token from Phase 2: the token of record is user_tokens.
    await ownerStore().setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: 4_000_000_000 });
    const red = await call("Bearer ext-secret");
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["owner-capture"]);

    await ownerApp({ token: true, okAgoMs: 2 * 60_000 });
    const green = await call("Bearer ext-secret");
    expect(green.status).toBe(200);
    expect(Object.keys(await green.json()).sort()).toEqual(["ok", "reasons", "unchecked"]);
  });

  it("red when the owner's last successful step is over 30 minutes old, however recent his last harvest", async () => {
    await ownerApp({ token: true, okAgoMs: 31 * 60_000 });
    await meterFlush([{ day: new Date().toISOString().slice(0, 10), route: "/api/x", uid: "-", invocations: 1, cpuUs: 1, wallMs: 1, bytes: 0 }]);
    // What the single-user rule read, both green: a plaintext token row and a harvest a moment ago.
    await ownerStore().setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: 4_000_000_000 });
    const c = await rawClient();
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)", args: [new Date().toISOString()] });
    const res = await call("Bearer ext-secret");
    expect(res.status).toBe(500);
    expect((await res.json()).reasons).toEqual(["owner-capture"]);
  });

  // The inputs (PLAN §7.10): isolation events in the app database's `events`, the daily chores'
  // stamp, the pace verdict the chores record, the budget mode and the CPU meter.
  async function healthy(): Promise<void> {
    await ownerApp({ token: true, okAgoMs: 2 * 60_000 });
    await setAppMeta("daily_at", String(Date.now() - 3_600_000));
    await ownerStore().setHealthMark("quota_pace", JSON.stringify({ at: Date.now() - 3_600_000, ahead: false }));
    await setBudgetMode("normal");
    await meterFlush([{ day: new Date().toISOString().slice(0, 10), route: "/api/cron/sync", uid: "-", invocations: 1, cpuUs: 1, wallMs: 1, bytes: 0 }]);
  }

  it("with every input measurable it checks them all: green, nothing unchecked", async () => {
    await healthy();
    const res = await call("Bearer ext-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reasons: [], unchecked: [] });
  });

  it("an isolation event turns it red once; the next check has reported it", async () => {
    await healthy();
    await reportIsolation("cache-stamp", ownerUid());
    const red = await call("Bearer ext-secret");
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["isolation"]);
    const after = await call("Bearer ext-secret");
    expect(after.status).toBe(200);
  });

  it("no admin row (or no OWNER_UID) is a store failure: red", async () => {
    await healthy();
    const owner = process.env.OWNER_UID;
    process.env.OWNER_UID = "";
    try {
      const res = await call("Bearer ext-secret");
      expect(res.status).toBe(500);
      expect((await res.json()).reasons).toEqual(["store"]);
    } finally {
      process.env.OWNER_UID = owner;
    }
  });

  it("a daily stamp over 26 hours old is red; none yet is unchecked", async () => {
    await healthy();
    await setAppMeta("daily_at", String(Date.now() - DAILY_STALE_MS - 60_000));
    expect((await (await call("Bearer ext-secret")).json()).reasons).toEqual(["daily"]);
    const app = createClient({ url: appDatabaseUrl(), intMode: "number" });
    await app.execute("DELETE FROM app_meta WHERE key = 'daily_at'");
    app.close();

    expect((await (await call("Bearer ext-secret")).json()).unchecked).toEqual(["daily"]);
  });

  it("the chores' pace verdict: ahead is red, older than a day is unchecked", async () => {
    await healthy();
    await ownerStore().setHealthMark("quota_pace", JSON.stringify({ at: Date.now(), ahead: true }));
    expect((await (await call("Bearer ext-secret")).json()).reasons).toEqual(["quota-pace"]);
    await ownerStore().setHealthMark("quota_pace", JSON.stringify({ at: Date.now() - DAILY_STALE_MS - 60_000, ahead: true }));
    const old = await (await call("Bearer ext-secret")).json();
    expect(old.reasons).toEqual([]);
    expect(old.unchecked).toEqual(["quota-pace"]);
  });

  it("red while the budget is in economy or freeze, green again at normal", async () => {
    await healthy();
    await setBudgetMode("economy");
    const red = await call("Bearer ext-secret");
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["budget"]);
    await setBudgetMode("freeze");
    expect((await (await call("Bearer ext-secret")).json()).reasons).toEqual(["budget"]);
    await setBudgetMode("normal");
    expect((await call("Bearer ext-secret")).status).toBe(200);
    // Never recorded: not measurable yet. The mode is the app's, in app_meta.
    const app = createClient({ url: appDatabaseUrl(), intMode: "number" });
    await app.execute("DELETE FROM app_meta WHERE key = 'budget_mode'");
    app.close();
    expect((await (await call("Bearer ext-secret")).json()).unchecked).toEqual(["budget"]);
  });

  it("red while the daily record holds a dimension in economy or freeze, whatever the stored mode says", async () => {
    // The chores write the record, then the mode; a failed mode write leaves the record alone
    // saying economy, and /api/cron/daily still stamps daily_at ("the run finished").
    await healthy();
    const day = new Date().toISOString().slice(0, 10);
    const rec = (mode: string) =>
      recordBudgetDay([
        { day, dimension: "vercel_cpu_ms", used: 1, projected: 1, limit: 4, mode: "normal", at: Date.now() },
        { day, dimension: "turso_rows_read", used: 1, projected: 3.2e8, limit: 5e8, mode, at: Date.now() },
      ]);
    await rec("economy");
    const red = await call("Bearer ext-secret");
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["budget"]);
    await rec("normal");
    expect((await call("Bearer ext-secret")).status).toBe(200);
    // A record with the stored mode never written is enough to check.
    const c = await rawClient();
    await c.execute("DELETE FROM meta WHERE key = 'budget_mode'");
    const v = await (await call("Bearer ext-secret")).json();
    expect(v.unchecked).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("red when the meter has written nothing for six hours, or ever", async () => {
    await healthy();
    const c = await rawClient();
    await c.execute({ sql: "UPDATE cpu_meter SET updated_at = ?", args: [Date.now() - METER_QUIET_MS + 60_000] });
    expect((await call("Bearer ext-secret")).status).toBe(200);
    await c.execute({ sql: "UPDATE cpu_meter SET updated_at = ?", args: [Date.now() - METER_QUIET_MS - 60_000] });
    const quiet = await call("Bearer ext-secret");
    expect(quiet.status).toBe(500);
    expect((await quiet.json()).reasons).toEqual(["meter"]);
    await c.execute("DELETE FROM cpu_meter");
    expect((await (await call("Bearer ext-secret")).json()).reasons).toEqual(["meter"]);
  });
});
