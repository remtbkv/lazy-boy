// The hourly health check (PLAN.md §7.10; T13's cron-secret half for this route). Known answers
// for each condition, and the route against the simulated store.
import { beforeEach, describe, expect, it } from "vitest";
import { healthVerdict, DAILY_STALE_MS } from "@/lib/health";
import { GET } from "@/app/api/cron/health/route";
import { rawClient, resetStore } from "../adversarial/helpers";
import { reportIsolation } from "@/lib/isolation";
import { ownerStore, ownerUid } from "../owner-store";
import { FAR } from "./harness";

const healthy = { ok: true, staleForMs: 60_000, reason: null } as const;

describe("healthVerdict", () => {
  it("green when every measurable condition holds, listing what it could not measure", () => {
    expect(healthVerdict({ isolationEvents: null, ownerCapture: healthy, dailyAgeMs: null, quotaAhead: null })).toEqual({
      ok: true,
      reasons: [],
      unchecked: ["isolation", "daily", "quota-pace"],
    });
  });

  it("each condition turns it red on its own", () => {
    const base = { isolationEvents: 0, ownerCapture: healthy, dailyAgeMs: 0, quotaAhead: false };
    expect(healthVerdict(base)).toEqual({ ok: true, reasons: [], unchecked: [] });
    expect(healthVerdict({ ...base, isolationEvents: 1 }).reasons).toEqual(["isolation"]);
    expect(
      healthVerdict({ ...base, ownerCapture: { ok: false, staleForMs: null, reason: "signed out" } }).reasons,
    ).toEqual(["owner-capture"]);
    expect(healthVerdict({ ...base, dailyAgeMs: DAILY_STALE_MS + 1 }).reasons).toEqual(["daily"]);
    expect(healthVerdict({ ...base, dailyAgeMs: DAILY_STALE_MS }).ok).toBe(true);
    expect(healthVerdict({ ...base, quotaAhead: true }).reasons).toEqual(["quota-pace"]);
  });
});

describe("/api/cron/health", () => {
  const call = (auth?: string) =>
    GET(new Request("http://x/api/cron/health", { headers: auth ? { authorization: auth } : {} }));

  beforeEach(async () => {
    process.env.CRON_SECRET = "zen-secret";
    process.env.CRON_SECRET_EXT = "ext-secret";
    await resetStore();
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

  it("red when the owner has no token row; green with a token and a recent harvest; no listening data", async () => {
    const red = await call("Bearer ext-secret");
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["owner-capture"]);

    await ownerStore().setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: FAR });
    const c = await rawClient();
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)", args: [new Date().toISOString()] });
    const green = await call("Bearer ext-secret");
    expect(green.status).toBe(200);
    expect(Object.keys(await green.json()).sort()).toEqual(["ok", "reasons", "unchecked"]);
  });

  // The inputs Phase 1's turn wired in (PLAN §7.10): isolation events where Phase 1 records them
  // (telemetry rows), the daily chores' stamp, the pace verdict the chores record.
  async function healthy(): Promise<void> {
    await ownerStore().setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: FAR });
    const c = await rawClient();
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)", args: [new Date().toISOString()] });
    await ownerStore().setHealthMark("daily_at", String(Date.now() - 3_600_000));
    await ownerStore().setHealthMark("quota_pace", JSON.stringify({ at: Date.now() - 3_600_000, ahead: false }));
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

  it("a daily stamp over 26 hours old is red; none yet is unchecked", async () => {
    await healthy();
    await ownerStore().setHealthMark("daily_at", String(Date.now() - DAILY_STALE_MS - 60_000));
    expect((await (await call("Bearer ext-secret")).json()).reasons).toEqual(["daily"]);
    const c = await rawClient();
    await c.execute("DELETE FROM meta WHERE key = 'daily_at'");
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
});
