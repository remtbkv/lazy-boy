// The app database (PLAN.md §4.2, §4.5, T6): where it lives by environment, the client riding
// the store fetch, the versioned schema, the one compare-and-set writer of users.status, the
// identity read, the conditional token writes, the listed global keys, per-user locks, events.
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as app from "@/lib/app-db";
import { freshAppDb, seedUser } from "./harness";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
let db: ReturnType<typeof freshAppDb>;
const raw = () => db.raw();
const q = async (sql: string, args: Record<string, string | number> = {}) => (await raw().execute({ sql, args })).rows;

beforeEach(async () => {
  db = freshAppDb();
  await app.getAppMeta("schema_version"); // first open: the production code creates the schema
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("where the app database is (PLAN.md §4.2, §5.5)", () => {
  const url = app.appDatabaseUrl;
  it("dev without APP_DATABASE_URL: a file beside the dev store, or under data/", () => {
    expect(url({ TURSO_DATABASE_URL: "file:/tmp/x/sim.db" })).toBe("file:/tmp/x/app.db");
    expect(url({})).toBe(`file:${process.cwd()}/data/app.db`);
    expect(url({ VERCEL_ENV: "development" })).toBe(`file:${process.cwd()}/data/app.db`);
    expect(url({ APP_DATABASE_URL: "file:/tmp/y/app.db" })).toBe("file:/tmp/y/app.db");
  });
  it("production: https:// only", () => {
    expect(url({ VERCEL_ENV: "production", APP_DATABASE_URL: "https://lazyboy-app-x.turso.io" })).toBe(
      "https://lazyboy-app-x.turso.io",
    );
    for (const bad of ["libsql://lazyboy-app-x.turso.io", "wss://x", "http://x", "file:/tmp/a.db"]) {
      expect(() => url({ VERCEL_ENV: "production", APP_DATABASE_URL: bad }), bad).toThrow();
    }
  });
  it("a deployment never falls back to a file; dev and Preview never hold a remote URL", () => {
    expect(() => url({ VERCEL_ENV: "production" })).toThrow(/unset/);
    expect(() => url({ VERCEL_ENV: "preview" })).toThrow(/unset/);
    expect(() => url({ APP_DATABASE_URL: "https://lazyboy-app-x.turso.io" })).toThrow(/production's/);
    expect(() => url({ VERCEL_ENV: "preview", APP_DATABASE_URL: "https://lazyboy-app-x.turso.io" })).toThrow();
  });
});

describe("the client rides the store fetch (PLAN.md §4.2)", () => {
  it("every request carries the gzip pin and goes through the retry ladder", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("accept-encoding") ?? "none");
        return new Response("no", { status: 503 });
      }),
    );
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_DATABASE_URL", "https://lazyboy-app-test.example.invalid");
    await expect(app.getAppMeta("tick_at")).rejects.toThrow();
    // three attempts: the store fetch's ladder retries a 503 twice
    expect(seen).toEqual(["gzip", "gzip", "gzip"]);
  });
});

describe("the schema, versioned (PLAN.md §4.5)", () => {
  it("the first open creates every table at the code's version", async () => {
    const tables = (await q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => r.name);
    expect(tables).toEqual(["app_meta", "events", "requests", "sync_state", "user_tokens", "users"]);
    const meta = Object.fromEntries(
      (await q("SELECT key, value FROM app_meta")).map((r) => [String(r.key), String(r.value)]),
    );
    expect(meta).toEqual({ schema_version: String(app.APP_SCHEMA_VERSION), min_reader: "1" });
  });
  it("a database whose min_reader is above the code refuses", async () => {
    await q("UPDATE app_meta SET value = '99' WHERE key = 'min_reader'");
    await expect(app.ensureAppSchema(raw(), true)).rejects.toThrow(/newer code/);
  });
  it("a database behind the code is brought up only where applying is allowed", async () => {
    const empty = createClient({ url: `${db.url}.other` });
    await expect(app.ensureAppSchema(empty, false)).rejects.toThrow(/production deploy/);
    await app.ensureAppSchema(empty, true);
    expect((await empty.execute("SELECT value FROM app_meta WHERE key = 'schema_version'")).rows[0].value).toBe(String(app.APP_SCHEMA_VERSION));
    empty.close();
  });
  it("Phase 4a's requests table is additive: a version-1 database steps up and min_reader stays 1", async () => {
    const v1 = createClient({ url: `${db.url}.v1` });
    for (const stmt of app.APP_SCHEMA[0].statements) await v1.execute(stmt);
    await v1.execute("CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)");
    await v1.execute("INSERT INTO app_meta VALUES ('schema_version', '1'), ('min_reader', '1')");
    await v1.execute("INSERT INTO users (uid, spotify_id, db_name, status, status_at, invited_at) VALUES ('aaaaaaaaaaaa', 'rem', 'lazyboy', 'active', 0, 0)");
    await app.ensureAppSchema(v1, true);
    const meta = Object.fromEntries((await v1.execute("SELECT key, value FROM app_meta")).rows.map((r) => [r.key, r.value]));
    expect(meta).toEqual({ schema_version: "2", min_reader: "1" });
    expect((await v1.execute("SELECT count(*) AS n FROM users")).rows[0].n).toBe(1);
    expect((await v1.execute("SELECT count(*) AS n FROM requests")).rows[0].n).toBe(0);
    v1.close();
  });
});

describe("users.status: one compare-and-set writer (PLAN.md §4.2)", () => {
  it("moves from the status it read, stamps status_at, and loses to an earlier move", async () => {
    await seedUser(raw(), { uid: A, status: "active" });
    expect(await app.moveStatus(A, "active", "disabled", 5_000)).toBe(true);
    expect(await q("SELECT status, status_at FROM users WHERE uid = :u", { u: A })).toEqual([
      { status: "disabled", status_at: 5_000 },
    ]);
    expect(await app.moveStatus(A, "active", "deleting", 6_000)).toBe(false);
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: A }))[0].status).toBe("disabled");
  });
  it("a returning sign-in and the deletion job cannot both win", async () => {
    await seedUser(raw(), { uid: B, status: "revoked" });
    const [signIn, deletion] = await Promise.all([
      app.moveStatus(B, "revoked", "active", 1),
      app.moveStatus(B, "revoked", "deleting", 1),
    ]);
    expect([signIn, deletion].filter(Boolean)).toHaveLength(1);
  });
  it("knows no `dormant` (RULINGS Oct 15 12:26 PM) and no invented status", async () => {
    expect(app.USER_STATUSES).not.toContain("dormant");
    await seedUser(raw(), { uid: A, status: "active" });
    await expect(app.moveStatus(A, "active", "dormant" as never, 1)).rejects.toThrow(/unknown status/);
  });
});

describe("the identity read (PLAN.md §5.1)", () => {
  it("one statement: the row, its token columns, its sync state and the cooldown", async () => {
    await seedUser(raw(), { uid: A, status: "active", admin: true });
    expect(await app.readIdentityRow(A)).toEqual({
      status: "active",
      sessionEpoch: 0,
      isAdmin: true,
      dbName: "lazyboy",
      blob: null,
      expiresAt: null,
      syncState: null,
      lastOkAt: null,
      lastHarvestAt: null,
      rpCooldown: null,
    });
    await q("INSERT INTO user_tokens VALUES (:u, 'v1.blob', 99, 7)", { u: A });
    await app.setAppMeta("cooldown:recently-played", "123");
    expect(await app.readIdentityRow(A)).toMatchObject({ blob: "v1.blob", expiresAt: 99, rpCooldown: "123" });
    expect(await app.readIdentityRow(B)).toBeNull();
  });
});

describe("T6: the statements that take no uid", () => {
  it("the sign-in lookup returns only the row with that account_id", async () => {
    await seedUser(raw(), { uid: A, status: "active", accountId: "acct-A" });
    await seedUser(raw(), { uid: B, status: "active", accountId: "acct-B" });
    expect((await app.findUserByAccountId("acct-B"))?.uid).toBe(B);
    expect(await app.findUserByAccountId("acct-C")).toBeNull();
  });
  it("the admin's binding takes the admin row naming that Spotify id, once", async () => {
    await seedUser(raw(), { uid: A, status: "active", admin: true, accountId: null, spotifyId: "rem" });
    await seedUser(raw(), { uid: B, status: "active", accountId: null, spotifyId: "friend" });
    expect(await app.bindAdminAccount("acct-x", "friend", 1)).toBeNull();
    expect((await app.bindAdminAccount("acct-rem", "rem", 2))?.uid).toBe(A);
    expect(await app.bindAdminAccount("acct-other", "rem", 3)).toBeNull();
    expect(await q("SELECT uid, account_id FROM users ORDER BY uid")).toEqual([
      { uid: A, account_id: "acct-rem" },
      { uid: B, account_id: null },
    ]);
  });
  it("app_meta accepts only the listed global keys", async () => {
    for (const k of ["sentinel:v1", "token_copy:aaaaaaaaaaaa", "cooldown:recently-played", "tick_at"]) {
      await app.setAppMeta(k, "1");
    }
    for (const bad of ["owner_uid", "spotify_tokens", "lock:spotify_refresh:../x", "token_copy:", "sentinel:x"]) {
      await expect(app.setAppMeta(bad, "1"), bad).rejects.toThrow(/not a listed key/);
      await expect(app.getAppMeta(bad), bad).rejects.toThrow(/not a listed key/);
    }
  });
});

describe("refresh locks, one per user (PLAN.md §5.2)", () => {
  it("A's lock does not hold B's, and only the holder releases", async () => {
    const a = await app.acquireAppLock(`lock:spotify_refresh:${A}`, 30_000);
    expect(a).not.toBeNull();
    expect(await app.acquireAppLock(`lock:spotify_refresh:${A}`, 30_000)).toBeNull();
    expect(await app.acquireAppLock(`lock:spotify_refresh:${B}`, 30_000)).not.toBeNull();
    await app.releaseAppLock(`lock:spotify_refresh:${A}`, "someone-else");
    expect(await app.acquireAppLock(`lock:spotify_refresh:${A}`, 30_000)).toBeNull();
    await app.releaseAppLock(`lock:spotify_refresh:${A}`, a!);
    expect(await app.acquireAppLock(`lock:spotify_refresh:${A}`, 30_000)).not.toBeNull();
  });
});

describe("conditional token writes (PLAN.md §5.2; security R3, R4)", () => {
  const row = (blob: string) => ({ blob, expiresAt: 100, grantedAt: 10 });
  it("a sign-in's write lands only for a live owner", async () => {
    for (const [uid, status] of [
      ["aaaaaaaaaaab", "active"],
      ["aaaaaaaaaaac", "needs_reconnect"],
      ["aaaaaaaaaaad", "revoked"],
    ]) {
      await seedUser(raw(), { uid, status });
      expect(await app.writeSignInTokens(uid, row("v1.x")), status).toBe(true);
    }
    for (const [uid, status] of [
      ["bbbbbbbbbbbc", "disabled"],
      ["bbbbbbbbbbbd", "deleting"],
      ["bbbbbbbbbbbe", "deleted"],
      ["bbbbbbbbbbbf", "invited"],
    ]) {
      await seedUser(raw(), { uid, status });
      expect(await app.writeSignInTokens(uid, row("v1.x")), status).toBe(false);
    }
    expect(await app.writeSignInTokens("cccccccccccc", row("v1.x"))).toBe(false);
    expect((await q("SELECT count(*) AS n FROM user_tokens"))[0].n).toBe(3);
  });
  it("a refresh writes only over the blob it read; granted_at moves only on a new refresh token", async () => {
    await seedUser(raw(), { uid: A, status: "active" });
    await app.writeSignInTokens(A, row("v1.first"));
    const write = (read: string, blob: string, rotated: boolean) =>
      app.updateTokensIfUnchanged(A, read, { blob, expiresAt: 200, rotated, now: 50 });
    expect(await write("v1.first", "v1.second", false)).toBe(true);
    expect(await app.readTokenRow(A)).toEqual({ blob: "v1.second", expiresAt: 200, grantedAt: 10 });
    expect(await write("v1.first", "v1.stale", true)).toBe(false);
    expect((await app.readTokenRow(A))?.blob).toBe("v1.second");
    expect(await write("v1.second", "v1.third", true)).toBe(true);
    expect((await app.readTokenRow(A))?.grantedAt).toBe(50);
  });
  it("a clear takes only the row it read; the copy never overwrites", async () => {
    await seedUser(raw(), { uid: A, status: "active" });
    await app.writeSignInTokens(A, row("v1.new"));
    await app.deleteTokensIfUnchanged(A, "v1.old");
    expect((await app.readTokenRow(A))?.blob).toBe("v1.new");
    expect(await app.insertTokensIfAbsent(A, row("v1.copy"))).toBe(false);
    expect((await app.readTokenRow(A))?.blob).toBe("v1.new");
    await app.deleteTokensIfUnchanged(A, "v1.new");
    expect(await app.readTokenRow(A)).toBeNull();
  });
});

describe("events (PLAN.md §6.5)", () => {
  it("a row with the time, the uid and a code, not yet alarmed", async () => {
    await app.recordAppEvent("decrypt", A, 1234);
    expect(await q("SELECT at, uid, code, alarmed FROM events")).toEqual([{ at: 1234, uid: A, code: "decrypt", alarmed: 0 }]);
  });
});
