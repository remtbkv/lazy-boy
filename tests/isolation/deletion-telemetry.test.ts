// The deletion's telemetry step (PLAN.md §12.3 step 3; RULINGS Oct 15 12:26 PM: a friend who
// disconnects has their data deleted within five days) against the telemetry tables as the app
// writes them: api_log (the Spotify client), client_metrics (the browser's beacons) and cpu_meter
// (the capacity meter, CAPACITY.md §6, which keys every invocation by route and user). /privacy
// names all three as the diagnostic logs a Disconnect deletes. Both runners are checked: the
// runtime's (deletion-runtime.ts) and the Mac's (`user.mjs --remove`, scripts/turso-mac.mjs).
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { runPhase4aChores } from "@/lib/daily-4a";
import { logSpotifyRequest, meterFlush, recordClientMetrics } from "@/lib/db";
import { purgeDeparted } from "@/lib/deletion-runtime";
import { deleteUserTelemetry } from "@/lib/telemetry-lifecycle";
import { freshAppDb, seedUser } from "./harness";
// @ts-expect-error -- plain-Node script with no type declarations
import { macDeletionDeps } from "../../scripts/turso-mac.mjs";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const tele = () => createClient({ url: process.env.TURSO_DATABASE_URL! });

/** Every table in the telemetry store with a `user_id` column, and how many rows name `uid`. */
async function rowsOf(uid: string): Promise<Record<string, number>> {
  const c = tele();
  try {
    const tables = await c.execute(
      "SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'user_id' ORDER BY m.name",
    );
    const out: Record<string, number> = {};
    for (const r of tables.rows) {
      const t = String(r.name);
      out[t] = Number((await c.execute({ sql: `SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, args: [uid] })).rows[0].n);
    }
    return out;
  } finally {
    c.close();
  }
}

async function writeTelemetryFor(uid: string): Promise<void> {
  // Each through the app's own write path, as production fills the store.
  await logSpotifyRequest({ method: "GET", path: "/v1/me/player", status: 200, retryAfter: null, source: "cron-probe", uid });
  await recordClientMetrics([{ session: "s", page: "/home", event: "fcp", value: 1, meta: null }], uid);
  await meterFlush([{ day: "2026-10-16", route: "/home", uid, invocations: 3, cpuUs: 900, wallMs: 12, bytes: 100 }]);
}

beforeEach(async () => {
  for (const u of [A, B]) await writeTelemetryFor(u);
});

afterEach(async () => {
  const c = tele();
  for (const t of ["api_log", "client_metrics", "cpu_meter"]) await c.execute(`DELETE FROM ${t}`);
  c.close();
});

describe("the deletion's telemetry step reaches every table that names a user", () => {
  it("the fixture: B has a row in each of api_log, client_metrics and cpu_meter", async () => {
    expect(await rowsOf(B)).toEqual({ api_log: 1, client_metrics: 1, cpu_meter: 1 });
  });

  it("the runtime's step (deletion-runtime.ts) leaves no row of B and every row of A", async () => {
    await deleteUserTelemetry(B);
    expect(await rowsOf(B)).toEqual({ api_log: 0, client_metrics: 0, cpu_meter: 0 });
    expect(await rowsOf(A)).toEqual({ api_log: 1, client_metrics: 1, cpu_meter: 1 });
  });

  it("user.mjs --remove's step (turso-mac.mjs) does the same", async () => {
    const c = tele();
    try {
      await macDeletionDeps({ now: () => 0 }, null, null, c, "test").telemetry.deleteUser(B);
    } finally {
      c.close();
    }
    expect(await rowsOf(B)).toEqual({ api_log: 0, client_metrics: 0, cpu_meter: 0 });
    expect(await rowsOf(A)).toEqual({ api_log: 1, client_metrics: 1, cpu_meter: 1 });
  });

  it("a row written after the job's telemetry step (the meter's flush, a task in flight) is gone at the next daily run", async () => {
    const app = freshAppDb();
    try {
      await getAppMeta("schema_version"); // the production open creates the app database's tables
      await seedUser(app.raw(), { uid: A, status: "active", admin: true });
      // B's deletion finished a day ago; the rows the beforeEach wrote stand for the late ones.
      await seedUser(app.raw(), { uid: B, status: "deleted", statusAt: Date.now() - 86_400_000 });
      const out = await runPhase4aChores({
        now: Date.now,
        deleteAccount: async () => ({ kind: "done" }),
        withdrawInvite: async () => ({ kind: "done" }),
        purgeDeparted,
        reenableJobs: async () => "skipped",
      });
      expect(out.deletions).toContain("departed done");
      expect(await rowsOf(B)).toEqual({ api_log: 0, client_metrics: 0, cpu_meter: 0 });
      expect(await rowsOf(A)).toEqual({ api_log: 1, client_metrics: 1, cpu_meter: 1 });
    } finally {
      app.close();
    }
  });

  it("a table a later lane adds with a user_id column is covered without a list to update", async () => {
    const c = tele();
    try {
      await c.execute("CREATE TABLE IF NOT EXISTS later_per_user (day TEXT, user_id TEXT)");
      await c.execute({ sql: "INSERT INTO later_per_user VALUES ('d', ?), ('d', ?)", args: [A, B] });
      await deleteUserTelemetry(B);
      expect((await c.execute({ sql: "SELECT user_id FROM later_per_user", args: [] })).rows.map((r) => r.user_id)).toEqual([A]);
    } finally {
      await c.execute("DROP TABLE IF EXISTS later_per_user");
      c.close();
    }
  });
});
