// The health check's Phase 4a conditions (PLAN.md §7.10) and T15's server half (§6.4, §6.5): an
// isolation event recorded while telemetry is down is still stored in lazyboy-app, turns the
// health check red once (each event e-mails once), and the red verdict is recorded with its time and
// reasons in app_meta, where lanes 28 and 29 read that the planted probe's alarm went out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { healthVerdict } from "@/lib/health";
import { freshAppDb, seedUser } from "./harness";

vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return {
    ...real,
    // The owner's capture is healthy here, so every red below is the app database's.
    forUser: (uid: Parameters<typeof real.forUser>[0]) => ({
      ...real.forUser(uid),
      getCaptureHealth: async () => ({ ok: true, staleForMs: 60_000, reason: null }),
    }),
    // Telemetry is down for every test in this file.
    recordClientMetrics: async () => {
      throw new Error("telemetry down");
    },
    isolationEventsAfter: async () => {
      throw new Error("telemetry down");
    },
  };
});

const HOUR = 3_600_000;
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
const call = async () => {
  const { GET } = await import("@/app/api/cron/health/route");
  const r = await GET(new Request("http://x/api/cron/health", { headers: { authorization: "Bearer zen-secret" } }));
  return { status: r.status, body: await r.json() };
};

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  vi.stubEnv("CRON_SECRET", "zen-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await seedUser(db.raw(), { uid: "aaaaaaaaaaaa", status: "active", admin: true });
  await q("INSERT INTO app_meta (key, value) VALUES ('daily_at', :t)", { t: String(Date.now()) });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T15's server half", () => {
  it("an owner mismatch while telemetry is down is stored, turns the check red once, and the red verdict is recorded", async () => {
    expect((await call()).status).toBe(200);
    const { reportIsolation } = await import("@/lib/isolation");
    await reportIsolation("owner-mismatch", "bbbbbbbbbbbb");
    expect(await q("SELECT uid, code, alarmed FROM events")).toEqual([{ uid: "bbbbbbbbbbbb", code: "owner-mismatch", alarmed: 0 }]);

    const red = await call();
    expect(red).toEqual({ status: 500, body: { ok: false, reasons: ["isolation"], unchecked: ["quota-pace"] } });
    const recs = await q("SELECT key, value FROM app_meta WHERE key LIKE 'health_red:%'");
    expect(recs).toHaveLength(1);
    expect(recs[0].value).toBe("isolation");
    expect(Math.abs(Number(String(recs[0].key).slice("health_red:".length)) - Date.now())).toBeLessThan(10_000);
    expect((await q("SELECT alarmed FROM events"))[0].alarmed).toBe(1);

    // Reported once: the next hour is green again, and the reply never names the uid.
    const next = await call();
    expect(next.status).toBe(200);
    expect(JSON.stringify(red.body) + JSON.stringify(next.body)).not.toContain("bbbbbbbbbbbb");
  });
});

describe("Phase 4a's conditions", () => {
  it("each turns the check red on its own, with a one-word reason and no uid", async () => {
    const now = Date.now();
    const cases: [string, () => Promise<unknown>][] = [
      ["deletion", () => seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "deleting", statusAt: now - 25 * HOUR })],
      ["reconnect", () => seedUser(db.raw(), { uid: "cccccccccccc", status: "needs_reconnect", statusAt: now - 7 * HOUR })],
      ["removed", () => seedUser(db.raw(), { uid: "dddddddddddd", status: "removed", statusAt: now - 8 * 24 * HOUR })],
      [
        "backoff",
        async () => {
          await seedUser(db.raw(), { uid: "eeeeeeeeeeee", status: "active" });
          await q("INSERT INTO sync_state (uid, state, next_probe_at, last_ok_at) VALUES ('eeeeeeeeeeee', 'backoff', 0, :t)", { t: now - 7 * HOUR });
        },
      ],
      ["grant", () => q("INSERT INTO events (at, uid, code) VALUES (:t, 'cccccccccccc', 'revoked')", { t: now })],
    ];
    const seen: string[] = [];
    for (const [reason, plant] of cases) {
      await plant();
      seen.push(reason);
      const r = await call();
      expect(r.status, reason).toBe(500);
      expect(r.body.reasons, reason).toEqual(expect.arrayContaining([reason]));
      expect(JSON.stringify(r.body)).not.toMatch(/[a-z2-7]{12}/);
    }
  });

  it("inside the windows, and for the admin, nothing is red", async () => {
    const now = Date.now();
    await seedUser(db.raw(), { uid: "bbbbbbbbbbbb", status: "revoked", statusAt: now - 23 * HOUR });
    await seedUser(db.raw(), { uid: "cccccccccccc", status: "needs_reconnect", statusAt: now - 5 * HOUR });
    await seedUser(db.raw(), { uid: "dddddddddddd", status: "removed", statusAt: now - 6 * 24 * HOUR });
    await q("UPDATE users SET status = 'needs_reconnect', status_at = 0 WHERE uid = 'aaaaaaaaaaaa'");
    expect((await call()).status).toBe(200);
  });

  it("the verdict's known answers", () => {
    const base = { isolationEvents: 0, ownerCapture: { ok: true, staleForMs: 0, reason: null }, dailyAgeMs: 0, quotaAhead: false } as const;
    const app = { events: {}, stuckDeletions: 0, reconnect: 0, backoff: 0, removed: 0 };
    expect(healthVerdict({ ...base, app })).toEqual({ ok: true, reasons: [], unchecked: [] });
    expect(healthVerdict({ ...base, app: { ...app, events: { drift: 1 } } }).reasons).toEqual(["event"]);
    expect(healthVerdict({ ...base, app: { ...app, events: { "grant-wide": 1 } } }).reasons).toEqual(["grant"]);
    expect(healthVerdict({ ...base, isolationEvents: 1, app: { ...app, events: { "cache-stamp": 1 } } }).reasons).toEqual(["isolation"]);
  });
});
