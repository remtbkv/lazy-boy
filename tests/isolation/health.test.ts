// The hourly health check (PLAN.md §7.10; T13's cron-secret half for this route). Known answers
// for each condition, and the route against the simulated store.
import { beforeEach, describe, expect, it } from "vitest";
import { setSpotifyTokens } from "@/lib/db";
import { healthVerdict, DAILY_STALE_MS } from "@/lib/health";
import { GET } from "@/app/api/cron/health/route";
import { rawClient, resetStore } from "../adversarial/helpers";
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

    await setSpotifyTokens({ accessToken: "a", refreshToken: "r", expiresAt: FAR });
    const c = await rawClient();
    await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)", args: [new Date().toISOString()] });
    const green = await call("Bearer ext-secret");
    expect(green.status).toBe(200);
    expect(Object.keys(await green.json()).sort()).toEqual(["ok", "reasons", "unchecked"]);
  });
});
