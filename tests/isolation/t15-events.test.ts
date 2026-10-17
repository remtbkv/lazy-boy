// T15 (PLAN.md §6.4, §6.5, §7.10; security R7): an owner mismatch while the telemetry store is
// down is still stored, in lazyboy-app's `events`, and the hourly health check reads it there:
// red once, then marked reported. The telemetry URL here rejects every request at once (the
// Funnel unreachable), as in telemetry-down.test.ts.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TELEMETRY_DATABASE_URL = "https://telemetry.invalid";
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith("https://telemetry.invalid")) return Promise.reject(new TypeError("fetch failed"));
    return realFetch(input, init);
  }) as typeof fetch;
});

import { createClient } from "@libsql/client";
import { GET } from "@/app/api/cron/health/route";
import { forUserAt, setBudgetMode, StoreRefusedError } from "@/lib/db";
import { ownerStore, ownerUid, seedOwnerApp } from "../owner-store";
import { setAppMeta } from "@/lib/app-db";
import { A, B, seedUser, useUserFiles } from "./user-dbs";

const FAR = 4_000_000_000;
const health = () =>
  GET(new Request("http://x/api/cron/health", { headers: { authorization: "Bearer ext-secret" } }));

beforeAll(async () => {
  process.env.CRON_SECRET_EXT = "ext-secret";
  useUserFiles();
  // A healthy owner: his row and token, a cron step a minute ago (sync_state, Phase 3), the
  // chores' stamps (daily_at in app_meta from Phase 3).
  await seedOwnerApp({ accessToken: "a", refreshToken: "r", expiresAt: FAR });
  const owner = ownerStore();
  await owner.getLastSync(); // the first open provisions the owner's file
  const app = createClient({ url: process.env.APP_DATABASE_URL as string });
  await app.execute({
    sql: "INSERT INTO sync_state (uid, state, next_probe_at, last_ok_at) VALUES (?, 'idle', 0, ?)",
    args: [ownerUid(), Date.now() - 60_000],
  });
  app.close();
  await setAppMeta("daily_at", String(Date.now() - 3_600_000));
  await owner.setHealthMark("quota_pace", JSON.stringify({ at: Date.now() - 3_600_000, ahead: false }));
  await setBudgetMode("normal"); // the meter's daily record, as the chores leave it
});

describe("T15: an isolation event with the telemetry store down", () => {
  it("is stored in lazyboy-app and turns the health check red once", async () => {
    // The CPU meter's last write lives in the telemetry store, down here: unmeasurable, not red.
    expect(await (await health()).json()).toEqual({ ok: true, reasons: [], unchecked: ["meter"] });
    await seedUser(forUserAt(A, "t15"), "A");
    await expect(forUserAt(B, "t15").getLastSync()).rejects.toBeInstanceOf(StoreRefusedError);

    const c = createClient({ url: process.env.APP_DATABASE_URL as string });
    const rows = (await c.execute("SELECT uid, code, alarmed FROM events")).rows.map((r) => ({ ...r }));
    expect(rows).toEqual([{ uid: B, code: "owner-mismatch", alarmed: 0 }]);

    const red = await health();
    expect(red.status).toBe(500);
    expect((await red.json()).reasons).toEqual(["isolation"]);
    expect((await c.execute("SELECT alarmed FROM events")).rows.map((r) => r.alarmed)).toEqual([1]);
    c.close();
    expect((await health()).status).toBe(200);
  });
});
