// The planted probe (PLAN.md §13.1, Phase 4a's row; RULINGS Oct 15 9:27 PM): opened only by the
// Zenbook's CRON_SECRET (never CRON_SECRET_EXT), it forges one cache entry under a named uid's key
// stamped with another uid, which need not belong to any users row, and reads it back through
// userCache, so exactly one isolation event results and the health check turns red. Two calls,
// since Next stores a new entry only when its request ends. Run over the cache stub that keys the
// way Next 16.2.6 does, so the forged entry really sits under the key the real read uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMeta } from "@/lib/app-db";
import { freshAppDb, seedUser } from "./harness";

vi.mock("next/cache", async () => await import("../stubs/next-cache-faithful"));
vi.mock("@/lib/db", async (orig) => {
  const real = await orig<typeof import("@/lib/db")>();
  return {
    ...real,
    forUser: (uid: Parameters<typeof real.forUser>[0]) => ({
      ...real.forUser(uid),
      getCaptureHealth: async () => ({ ok: true, staleForMs: 60_000, reason: null }),
    }),
  };
});
const { __cache } = await import("../stubs/next-cache-faithful");

const REM = "aaaaaaaaaaaa";
const NOBODY = "zzzzzzzzzzzz"; // no users row holds it
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;
const probe = async (auth: string | null, body: unknown) => {
  const { POST } = await import("@/app/api/cron/probe/route");
  return POST(
    new Request("http://x/api/cron/probe", {
      method: "POST",
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

beforeEach(async () => {
  db = freshAppDb();
  await getAppMeta("schema_version");
  __cache.clear();
  vi.stubEnv("CRON_SECRET", "zen-secret");
  vi.stubEnv("CRON_SECRET_EXT", "ext-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await seedUser(db.raw(), { uid: REM, status: "active", admin: true });
  await q("INSERT INTO app_meta (key, value) VALUES ('daily_at', :t)", { t: String(Date.now()) });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the planted probe", () => {
  it("opens to CRON_SECRET only: not cron-job.org's, not none, not a wrong one; and nothing is written", async () => {
    for (const auth of [null, "Bearer ext-secret", "Bearer nope", "Bearer "]) {
      expect((await probe(auth, { uid: REM, stamp: NOBODY })).status, String(auth)).toBe(401);
      expect((await probe(auth, { uid: REM, nonce: "00000000-0000-4000-8000-000000000000" })).status, String(auth)).toBe(401);
    }
    expect(await q("SELECT count(*) AS n FROM events")).toEqual([{ n: 0 }]);
    expect(__cache.keys()).toEqual([]);
  });

  it("refuses anything but a uid with a different stamp, or a uid with a nonce", async () => {
    for (const body of [
      {},
      { uid: REM },
      { uid: REM, stamp: REM },
      { uid: "../x", stamp: NOBODY },
      { uid: REM, stamp: "not-a-uid" },
      { uid: REM, stamp: NOBODY, nonce: "x" },
      { uid: REM, nonce: "../../etc" },
    ]) {
      expect((await probe("Bearer zen-secret", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await q("SELECT count(*) AS n FROM events")).toEqual([{ n: 0 }]);
  });

  const run = async (stamp: string) => {
    const f = await probe("Bearer zen-secret", { uid: REM, stamp });
    expect(f.status).toBe(202);
    const { nonce } = await f.json();
    return probe("Bearer zen-secret", { uid: REM, nonce });
  };

  it("reading a nonce nobody forged raises nothing", async () => {
    const r = await probe("Bearer zen-secret", { uid: REM, nonce: "00000000-0000-4000-8000-000000000000" });
    expect(await r.json()).toEqual({ ok: false, events: 0 });
    expect(await q("SELECT count(*) AS n FROM events")).toEqual([{ n: 0 }]);
  });

  it("stamps Rem's key with a uid no row holds: exactly one isolation event, the health check red once, the record kept", async () => {
    const r = await run(NOBODY);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, events: 1 });
    expect(await q("SELECT uid, code FROM events")).toEqual([{ uid: REM, code: "cache-stamp" }]);
    // The forged entry sits under the probe's own wrapper, never a read path's.
    expect(__cache.keys().every((k) => k.includes(",planted-probe,"))).toBe(true);

    const { GET } = await import("@/app/api/cron/health/route");
    const health = await GET(new Request("http://x/api/cron/health", { headers: { authorization: "Bearer ext-secret" } }));
    expect(health.status).toBe(500);
    expect((await health.json()).reasons).toEqual(["isolation"]);
    const rec = await q("SELECT value FROM app_meta WHERE key LIKE 'health_red:%'");
    expect(rec).toEqual([{ value: "isolation" }]);
    // Rem's own row and status are untouched by the probe.
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: REM }))[0].status).toBe("active");
  });

  it("a second run is one more event, never more", async () => {
    await run(NOBODY);
    await run("yyyyyyyyyyyy");
    expect((await q("SELECT count(*) AS n FROM events"))[0].n).toBe(2);
  });
});
