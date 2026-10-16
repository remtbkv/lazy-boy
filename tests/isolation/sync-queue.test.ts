// Phase 3's statements on the app database (PLAN.md §7.2, §7.5, §7.7-7.8; T6's claim half): the
// tick's stamp, the owner alarm's read, the claim joined to users and tokens, the release by
// compare-and-set on the lease owner, the brake's counter, the bucket cooldowns, the rescan claim
// and the invalid_grant bookkeeping. Each statement against a real app database file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "@/lib/app-db";
import { mintUid } from "@/lib/identity";
import { makeStoreFetch } from "@/lib/store-fetch";
import { freshAppDb, seedUser } from "./harness";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const ADMIN = "rrrrrrrrrrrr";
const NOW = Date.UTC(2026, 9, 16, 18, 0);
let db: ReturnType<typeof freshAppDb>;
const q = async (sql: string, args: Record<string, string | number | null> = {}) => (await db.raw().execute({ sql, args })).rows;

async function sync(uid: string, over: Record<string, string | number | null> = {}) {
  const row = { state: "idle", next_probe_at: NOW, lease_owner: null, lease_until: null, last_error: null, quota_day: null, rp_calls: 0, next_rescan_at: null, ...over };
  await q(
    `INSERT INTO sync_state (uid, state, next_probe_at, lease_owner, lease_until, last_error, quota_day, rp_calls, next_rescan_at)
     VALUES (:uid, :state, :next_probe_at, :lease_owner, :lease_until, :last_error, :quota_day, :rp_calls, :next_rescan_at)`,
    { uid, ...row },
  );
}

beforeEach(async () => {
  db = freshAppDb();
  await app.getAppMeta("schema_version");
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the stamp (§7.2 step 1)", () => {
  it("one tick per window: inserted if absent, refused inside the window, taken after it", async () => {
    expect(await app.stampTick(NOW, 45_000)).toBe(true);
    expect(await app.stampTick(NOW + 1, 45_000)).toBe(false);
    expect(await app.stampTick(NOW + 44_999, 45_000)).toBe(false);
    expect(await app.stampTick(NOW + 45_001, 45_000)).toBe(true);
    expect((await q("SELECT value FROM app_meta WHERE key = 'tick_at'"))[0].value).toBe(String(NOW + 45_001));
  });

  it("the window is a parameter: 90 s for the interim pinger", async () => {
    expect(await app.stampTick(NOW, 90_000)).toBe(true);
    expect(await app.stampTick(NOW + 60_000, 90_000)).toBe(false);
    expect(await app.stampTick(NOW + 120_000, 90_000)).toBe(true);
  });

  it("a burst of calls at one moment stamps once", async () => {
    const r = await Promise.all(Array.from({ length: 8 }, () => app.stampTick(NOW, 45_000)));
    expect(r.filter(Boolean)).toHaveLength(1);
  });
});

describe("the claim (§7.2 step 2, security R2, T6's claim half)", () => {
  beforeEach(async () => {
    await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true });
    await seedUser(db.raw(), { uid: A, status: "active" });
    await seedUser(db.raw(), { uid: B, status: "active" });
    await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'v1.blob-A', 99, 1)", { u: A });
  });

  it("leases every due active user, joined to db_name and the token in one round trip", async () => {
    const c = await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(c.users.map((u) => u.uid).sort()).toEqual([A, ADMIN, B].sort());
    const a = c.users.find((u) => u.uid === A)!;
    expect(a).toMatchObject({ dbName: `lb-u-${A}`, isAdmin: false, blob: "v1.blob-A", expiresAt: 99 });
    expect(c.users.find((u) => u.uid === ADMIN)).toMatchObject({ dbName: "lazyboy", isAdmin: true, blob: null });
    const leases = await q("SELECT uid, lease_owner, lease_until FROM sync_state ORDER BY uid");
    expect(leases.every((r) => r.lease_owner === "t1" && r.lease_until === NOW + 50_000)).toBe(true);
  });

  it("a user's first tick creates their queue row, due at once", async () => {
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect((await q("SELECT uid, state, next_probe_at FROM sync_state WHERE uid = :u", { u: B }))[0]).toEqual({
      uid: B,
      state: "idle",
      next_probe_at: NOW,
    });
  });

  it("SIGNUPS=owner leases the admin alone, whatever the rows say", async () => {
    const c = await app.claimDueUsers({ tick: "t1", now: NOW, signups: "owner" });
    expect(c.users.map((u) => u.uid)).toEqual([ADMIN]);
    expect(c.activeUsers).toBe(1);
    expect(await q("SELECT uid FROM sync_state WHERE lease_owner IS NOT NULL")).toEqual([{ uid: ADMIN }]);
  });

  it("a leased user is not due: a second tick, or an open tab, gets nobody", async () => {
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect((await app.claimDueUsers({ tick: "t2", now: NOW + 1_000, signups: "invite" })).users).toEqual([]);
    expect((await app.claimUser({ uid: mintUid(A), tick: "tab", now: NOW + 1_000, dueOnly: false, signups: "invite" })).users).toEqual([]);
  });

  it("only active, unpaused, due users: never needs_reconnect, removed, disabled or deleting", async () => {
    for (const [uid, status] of [["c00000000000", "needs_reconnect"], ["d00000000000", "removed"], ["e00000000000", "disabled"], ["f00000000000", "deleting"]]) {
      await seedUser(db.raw(), { uid, status });
      await sync(uid);
    }
    await sync(A, { state: "paused" });
    await sync(B, { next_probe_at: NOW + 31_000 });
    const c = await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(c.users.map((u) => u.uid)).toEqual([ADMIN]);
  });

  it("due 30 s early; a lapsed lease is due again, a live one is not", async () => {
    await sync(A, { next_probe_at: NOW + 30_000 });
    await sync(B, { lease_owner: "old", lease_until: NOW - 1 });
    await seedUser(db.raw(), { uid: C, status: "active" });
    await sync(C, { lease_owner: "live", lease_until: NOW + 10_000 });
    const c = await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(c.users.map((u) => u.uid).sort()).toEqual([A, ADMIN, B].sort());
  });

  it("the tick's view: the quota day's total, N, the daily stamp, the cooldowns and one due confirmation", async () => {
    await sync(A, { quota_day: "2026-10-16", rp_calls: 7 });
    await sync(B, { quota_day: "2026-10-15", rp_calls: 400 });
    await q("INSERT INTO app_meta (key, value) VALUES ('daily_at', '123'), ('cooldown:recently-played', '456'), ('cooldown:player', '789')");
    await seedUser(db.raw(), { uid: C, status: "needs_reconnect", statusAt: NOW - 11 * 60_000 });
    await sync(C, { last_error: "invalid_grant" });
    const c = await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(c).toMatchObject({ rpTotal: 7, activeUsers: 3, dailyAt: 123, cooldowns: { "recently-played": 456, player: 789 }, confirmUid: C });
    expect(c.users.find((u) => u.uid === A)).toMatchObject({ quotaDay: "2026-10-16", rpCalls: 7 });
  });

  it("a confirmation is due 10 minutes after the failure, once", async () => {
    await seedUser(db.raw(), { uid: C, status: "needs_reconnect", statusAt: NOW - 9 * 60_000 });
    await sync(C, { last_error: "invalid_grant" });
    expect((await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" })).confirmUid).toBeNull();
    await q("UPDATE users SET status_at = :t WHERE uid = :u", { t: NOW - 10 * 60_000, u: C });
    expect((await app.claimDueUsers({ tick: "t2", now: NOW + 60_000, signups: "invite" })).confirmUid).toBe(C);
    expect(await app.startGrantConfirm(C)).toBe(true);
    expect(await app.startGrantConfirm(C)).toBe(false);
    expect((await app.claimDueUsers({ tick: "t3", now: NOW + 120_000, signups: "invite" })).confirmUid).toBeNull();
  });
});

describe("the release: a compare-and-set on the lease owner (§7.2 step 3)", () => {
  const done = { state: "active" as const, nextProbeAt: NOW + 120_000, failures: 0, lastError: null, lastOkAt: NOW, lastHarvestAt: NOW };

  beforeEach(async () => {
    await seedUser(db.raw(), { uid: A, status: "active" });
    await sync(A);
  });

  it("the tick that holds the lease writes the next due time and frees it", async () => {
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(await app.releaseLease(A, "t1", NOW + 2_000, done)).toBe(true);
    expect((await q("SELECT * FROM sync_state WHERE uid = :u", { u: A }))[0]).toMatchObject({
      state: "active",
      next_probe_at: NOW + 120_000,
      lease_owner: null,
      lease_until: null,
      last_ok_at: NOW,
      last_harvest_at: NOW,
    });
  });

  it("a step that outlived its lease writes nothing once another tick holds the user", async () => {
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    await app.claimDueUsers({ tick: "t2", now: NOW + 51_000, signups: "invite" });
    expect(await app.releaseLease(A, "t1", NOW + 52_000, done)).toBe(false);
    expect((await q("SELECT lease_owner, next_probe_at FROM sync_state WHERE uid = :u", { u: A }))[0]).toEqual({
      lease_owner: "t2",
      next_probe_at: NOW,
    });
  });

  it("nor after its lease ran out, taken or not", async () => {
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    expect(await app.releaseLease(A, "t1", NOW + 50_001, done)).toBe(false);
  });

  it("keeps the last harvest when a step made none", async () => {
    await q("UPDATE sync_state SET last_harvest_at = 5 WHERE uid = :u", { u: A });
    await app.claimDueUsers({ tick: "t1", now: NOW, signups: "invite" });
    await app.releaseLease(A, "t1", NOW + 1, { ...done, lastHarvestAt: null, lastOkAt: null });
    expect((await q("SELECT last_harvest_at, last_ok_at FROM sync_state WHERE uid = :u", { u: A }))[0]).toEqual({
      last_harvest_at: 5,
      last_ok_at: null,
    });
  });
});

describe("one user's claim, for the open app (§7.6)", () => {
  const uidA = mintUid(A);
  beforeEach(async () => {
    await seedUser(db.raw(), { uid: A, status: "active" });
    await sync(A, { next_probe_at: NOW + 100_000 });
  });

  it("a load leases the user whether or not they are due; the timer only when due", async () => {
    expect((await app.claimUser({ uid: uidA, tick: "tab1", now: NOW, dueOnly: true, signups: "invite" })).users).toEqual([]);
    const c = await app.claimUser({ uid: uidA, tick: "tab2", now: NOW, dueOnly: false, signups: "invite" });
    expect(c.users).toHaveLength(1);
    expect(c.users[0]).toMatchObject({ uid: A, dbName: `lb-u-${A}` });
    expect(c.activeUsers).toBe(1);
    expect(await app.releaseLease(A, "tab2", NOW + 1, { state: "idle", nextProbeAt: NOW + 100_000, failures: 0, lastError: null, lastOkAt: null, lastHarvestAt: null })).toBe(true);
  });

  it("never a user who is not active, nor a friend under SIGNUPS=owner", async () => {
    expect((await app.claimUser({ uid: uidA, tick: "tab", now: NOW, dueOnly: false, signups: "owner" })).users).toEqual([]);
    await q("UPDATE users SET status = 'needs_reconnect' WHERE uid = :u", { u: A });
    expect((await app.claimUser({ uid: uidA, tick: "tab", now: NOW, dueOnly: false, signups: "invite" })).users).toEqual([]);
  });
});

describe("who succeeded lately (§7.8's not-registered rule)", () => {
  it("lists the users whose last step succeeded within 10 minutes", async () => {
    await seedUser(db.raw(), { uid: A, status: "active" });
    await seedUser(db.raw(), { uid: B, status: "active" });
    await sync(A, { next_probe_at: NOW + 999_999 });
    await sync(B, { next_probe_at: NOW + 999_999 });
    await q("UPDATE sync_state SET last_ok_at = :t WHERE uid = :u", { t: NOW - 9 * 60_000, u: A });
    await q("UPDATE sync_state SET last_ok_at = :t WHERE uid = :u", { t: NOW - 11 * 60_000, u: B });
    expect((await app.claimDueUsers({ tick: "t", now: NOW, signups: "invite" })).okRecent).toEqual([A]);
  });
});
describe("the brake's counter (§7.5 item 1)", () => {
  beforeEach(async () => {
    await seedUser(db.raw(), { uid: A, status: "active" });
    await sync(A);
  });

  it("counts within a quota day and starts again at the next", async () => {
    expect(await app.countRpCall(A, "2026-10-16")).toBe(1);
    expect(await app.countRpCall(A, "2026-10-16")).toBe(2);
    expect(await app.countRpCall(A, "2026-10-17")).toBe(1);
    expect((await q("SELECT quota_day, rp_calls FROM sync_state WHERE uid = :u", { u: A }))[0]).toEqual({
      quota_day: "2026-10-17",
      rp_calls: 1,
    });
  });
});

describe("bucket cooldowns (§7.8)", () => {
  it("only ever extend", async () => {
    await app.extendCooldown("recently-played", NOW + 1_000);
    await app.extendCooldown("recently-played", NOW + 500);
    expect(await app.getAppMeta("cooldown:recently-played")).toBe(String(NOW + 1_000));
    await app.extendCooldown("recently-played", NOW + 2_000);
    expect(await app.getAppMeta("cooldown:recently-played")).toBe(String(NOW + 2_000));
  });
});

describe("the rescan claim (§7.7)", () => {
  it("one tick takes a due rescan; the next waits for the retry time", async () => {
    await seedUser(db.raw(), { uid: A, status: "active" });
    await sync(A);
    expect(await app.claimRescan(A, NOW, NOW + 600_000)).toBe(true);
    expect(await app.claimRescan(A, NOW + 1, NOW + 600_001)).toBe(false);
    await app.scheduleRescan(A, NOW + 1_800_000);
    expect(await app.claimRescan(A, NOW + 1_799_999, 0)).toBe(false);
    expect(await app.claimRescan(A, NOW + 1_800_000, 0)).toBe(true);
  });
});

describe("invalid_grant across users (§5.4 step 3)", () => {
  it("counts the distinct users hit within the window, and whether the admin was one", async () => {
    await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true });
    await app.recordAppEvent("invalid-grant", A, NOW - 25 * 3_600_000);
    expect(await app.grantFailuresSince(NOW - 24 * 3_600_000)).toEqual({ users: 0, admin: false });
    await app.recordAppEvent("invalid-grant", A, NOW - 60_000);
    await app.recordAppEvent("invalid-grant", A, NOW);
    expect(await app.grantFailuresSince(NOW - 24 * 3_600_000)).toEqual({ users: 1, admin: false });
    await app.recordAppEvent("invalid-grant", ADMIN, NOW);
    expect(await app.grantFailuresSince(NOW - 24 * 3_600_000)).toEqual({ users: 2, admin: true });
  });
});

describe("the owner alarm's read (§7.2 step 0)", () => {
  it("the admin's status, whether he has a token row, and the last tick's decrypt failures", async () => {
    expect(await app.readOwnerAlarm(NOW)).toEqual({ adminStatus: null, adminHasToken: false, decryptUsers: 0, adminDecrypt: false });
    await seedUser(db.raw(), { uid: ADMIN, status: "active", admin: true });
    await q("INSERT INTO user_tokens (uid, blob, expires_at, granted_at) VALUES (:u, 'b', 1, 1)", { u: ADMIN });
    expect(await app.readOwnerAlarm(NOW)).toEqual({ adminStatus: "active", adminHasToken: true, decryptUsers: 0, adminDecrypt: false });
    await app.stampTick(NOW - 60_000, 45_000);
    await app.recordAppEvent("decrypt", A, NOW - 61_000); // before the last tick: not counted
    await app.recordAppEvent("decrypt", B, NOW - 30_000);
    await app.recordAppEvent("decrypt", ADMIN, NOW - 30_000);
    expect(await app.readOwnerAlarm(NOW)).toEqual({ adminStatus: "active", adminHasToken: true, decryptUsers: 2, adminDecrypt: true });
  });
});

describe("the tick's statements: one attempt and a 5-second timeout (§7.2 step 2)", () => {
  it("a second attempt is refused before it is sent, so the store fetch's ladder gives up", async () => {
    let sent = 0;
    const f = makeStoreFetch(app.oneAttemptFetch(async () => {
      sent++;
      return new Response("busy", { status: 503 });
    }));
    await expect(f("https://x.invalid/v2/pipeline", { method: "POST", body: "{}" })).rejects.toThrow(/one attempt/);
    expect(sent).toBe(1);
  });

  it("a store that does not answer is abandoned at the timeout", async () => {
    const hang = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const t0 = Date.now();
    await expect(app.oneAttemptFetch(hang, 50)("https://x.invalid/", { method: "POST" })).rejects.toThrow(/aborted/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(app.TICK_STATEMENT_TIMEOUT_MS).toBe(5_000);
  });

  it("the claim rides it in production: a store that answers 503 fails the tick after one request", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("accept-encoding") ?? "none");
        return new Response("no", { status: 503 });
      }),
    );
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_DATABASE_URL", "https://lazyboy-app-test.example.invalid");
    // The process's first app-database statement checks the schema on the same terms, so the
    // one request is that check's, and the claim is never sent.
    await expect(app.claimDueUsers({ tick: "t", now: NOW, signups: "owner" })).rejects.toThrow();
    expect(seen).toEqual(["gzip"]);
    await expect(app.stampTick(NOW, 45_000)).rejects.toThrow();
    expect(seen).toEqual(["gzip", "gzip"]);
  });
});
