// T11 (PLAN.md §6.4, §12.3): the deletion job for B, including a token refresh for B finishing while
// it runs, then the retry that finishes it; and its refusals, each of which changes nothing. The
// app database and the telemetry store are the real modules over local files; Turso's Platform API
// is a map of local database files, so "destroyed" means the file and its entry are gone.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execDeletionStatements, updateTokensIfUnchanged } from "@/lib/app-db";
import { LEASE_WINDOW_MS, runDeletion, withdrawInvite, type DeletionDeps } from "@/lib/deletion";
import { readIdentity, resolveSignIn } from "@/lib/identity-read";
import { appendLifecycle, deleteUserTelemetry } from "@/lib/telemetry-lifecycle";
import { appTokenStore } from "@/lib/token-store-app";
import { freshAppDb, seedApprovedInvite, seedUser } from "./harness";

const A = "aaaaaaaaaaaa"; // the admin
const B = "bbbbbbbbbbbb"; // the friend who leaves
const C = "cccccccccccc"; // another friend, who stays
const T0 = 1_800_000_000_000;
let db: ReturnType<typeof freshAppDb>;
let dir: string;
let files: Map<string, string>;
let destroyed: string[];
let tele: Client;
let clock: number;
const q = async (sql: string, args: Record<string, string | number> = {}) => (await db.raw().execute({ sql, args })).rows;

async function userFile(name: string, owner: string | null): Promise<void> {
  const file = path.join(dir, `${name}.db`);
  rmSync(file, { force: true });
  const c = createClient({ url: `file:${file}` });
  await c.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  await c.execute("CREATE TABLE plays (played_at TEXT, track_id TEXT)");
  if (owner !== null) await c.execute({ sql: "INSERT INTO meta VALUES ('owner_uid', ?)", args: [owner] });
  await c.execute({ sql: "INSERT INTO plays VALUES ('2026-10-16T00:00:00Z', ?)", args: [`${name}-only-track`] });
  c.close();
  files.set(name, file);
}

async function dump(name: string): Promise<unknown[]> {
  const c = createClient({ url: `file:${files.get(name)}` });
  const out = [...(await c.execute("SELECT * FROM meta ORDER BY key")).rows, ...(await c.execute("SELECT * FROM plays")).rows];
  c.close();
  return out;
}

function deps(over: Partial<DeletionDeps> = {}): DeletionDeps {
  return {
    exec: execDeletionStatements,
    async ownerOf(name) {
      const file = files.get(name);
      if (!file) return null;
      const c = createClient({ url: `file:${file}` });
      const r = await c.execute("SELECT value FROM meta WHERE key = 'owner_uid'");
      c.close();
      return r.rows[0] ? String(r.rows[0].value) : "";
    },
    async destroy(name) {
      const file = files.get(name);
      if (file) rmSync(file);
      files.delete(name);
      destroyed.push(name);
    },
    telemetry: { deleteUser: deleteUserTelemetry, appendLifecycle },
    now: () => clock,
    by: "test",
    ...over,
  };
}

const appRows = async (uid: string) => ({
  tokens: (await q("SELECT count(*) AS n FROM user_tokens WHERE uid = :u", { u: uid }))[0].n,
  queue: (await q("SELECT count(*) AS n FROM sync_state WHERE uid = :u", { u: uid }))[0].n,
  lock: (await q("SELECT count(*) AS n FROM app_meta WHERE key = :k", { k: `lock:spotify_refresh:${uid}` }))[0].n,
  request: (await q("SELECT count(*) AS n FROM requests WHERE uid = :u", { u: uid }))[0].n,
});
const teleRows = async (uid: string) =>
  Number((await tele.execute({ sql: "SELECT (SELECT count(*) FROM api_log WHERE user_id = ?) + (SELECT count(*) FROM client_metrics WHERE user_id = ?) AS n", args: [uid, uid] })).rows[0].n);

const untouched = async () => {
  expect(destroyed).toEqual([]);
  expect(await appRows(B)).toEqual({ tokens: 1, queue: 1, lock: 1, request: 1 });
  expect(await teleRows(B)).toBe(2);
};

beforeEach(async () => {
  db = freshAppDb();
  dir = mkdtempSync(path.join(tmpdir(), "lazyboy-t11-"));
  files = new Map();
  destroyed = [];
  clock = T0;
  vi.stubEnv("TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")}`);
  vi.stubEnv("SIGNUPS", "invite");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const store = appTokenStore();
  await store.get(A as never);
  await seedUser(db.raw(), { uid: A, status: "active", admin: true });
  for (const u of [B, C]) {
    await seedUser(db.raw(), { uid: u, status: "active", accountId: `acct-${u}` });
    await store.set(u as never, { accessToken: `at-${u}`, refreshToken: `rt-${u}`, expiresAt: 4_000_000_000 });
    await q("INSERT INTO sync_state (uid, state, next_probe_at) VALUES (:u, 'idle', 0)", { u });
    await q("INSERT INTO app_meta (key, value) VALUES (:k, '1')", { k: `lock:spotify_refresh:${u}` });
    await q("INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version, uid) VALUES (:id, :e, 'n', 'claimed', 0, 0, 't', :u)", {
      id: u.replace(/./g, "r").slice(0, 11) + u[0],
      e: `${u}@example.com`,
      u,
    });
  }
  await userFile("lazyboy", A);
  await userFile(`lb-u-${B}`, B);
  await userFile(`lb-u-${C}`, C);
  tele = createClient({ url: process.env.TURSO_DATABASE_URL! });
  await tele.execute("CREATE TABLE IF NOT EXISTS api_log (id INTEGER PRIMARY KEY, ts INTEGER, path TEXT, user_id TEXT)");
  await tele.execute("CREATE TABLE IF NOT EXISTS client_metrics (id INTEGER PRIMARY KEY, ts INTEGER, event TEXT, user_id TEXT)");
  await tele.execute("DELETE FROM api_log");
  await tele.execute("DELETE FROM client_metrics");
  for (const u of [A, B, C]) {
    await tele.execute({ sql: "INSERT INTO api_log (ts, path, user_id) VALUES (1, '/v1/me/player', ?)", args: [u] });
    await tele.execute({ sql: "INSERT INTO client_metrics (ts, event, user_id) VALUES (1, 'paint', ?)", args: [u] });
  }
});
afterEach(() => {
  db.close();
  tele.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("T11: deleting B", () => {
  it("ends B's sessions, stops B's sync and grant, destroys B's database, deletes B's telemetry, and touches no one else", async () => {
    const before = { a: await dump("lazyboy"), c: await dump(`lb-u-${C}`), cRows: await appRows(C) };
    const readBeforeDeletion = (await q("SELECT blob FROM user_tokens WHERE uid = :u", { u: B }))[0].blob as string;

    expect(await runDeletion(B, deps())).toEqual({ kind: "pending", step: "window" });
    // Every session dies at its next request: the status is deleting and the epoch moved.
    const [u] = await q("SELECT status, session_epoch FROM users WHERE uid = :u", { u: B });
    expect(u).toEqual({ status: "deleting", session_epoch: 1 });
    expect(await readIdentity({ uid: B, ep: 0, auth_time: Math.floor(Date.now() / 1000) - 60 })).toEqual({ kind: "refused", reason: "status" });
    expect(await appRows(B)).toEqual({ tokens: 0, queue: 0, lock: 0, request: 0 });
    expect(destroyed).toEqual([`lb-u-${B}`]);
    expect(existsSync(path.join(dir, `lb-u-${B}.db`))).toBe(false);
    expect(await teleRows(B)).toBe(0);
    expect((await tele.execute("SELECT uid, action, by FROM lifecycle_log")).rows).toEqual([{ uid: B, action: "deleted", by: "test" }]);

    // A token refresh for B that read the old row before step 1 finishes now: it stores nothing,
    // and neither does a sign-in's write.
    expect(await updateTokensIfUnchanged(B, readBeforeDeletion, { blob: "v1.late", expiresAt: 9, rotated: false, now: 9 })).toBe(false);
    await expect(appTokenStore().set(B as never, { accessToken: "late", refreshToken: "late", expiresAt: 9 })).rejects.toThrow(/no live user/);
    expect((await appRows(B)).tokens).toBe(0);

    // After the lease window the retry finishes it: the row keeps only uid, account_id, status, status_at.
    clock = T0 + LEASE_WINDOW_MS;
    expect(await runDeletion(B, deps())).toEqual({ kind: "done" });
    const [gone] = await q("SELECT * FROM users WHERE uid = :u", { u: B });
    expect(gone).toMatchObject({ status: "deleted", status_at: T0 + LEASE_WINDOW_MS, account_id: `acct-${B}`, spotify_id: "", db_name: `deleted:${B}`, last_sign_in: null, terms_version: null });
    // A returning sign-in is told the account was deleted, and when.
    expect(await resolveSignIn({ id: "sp-b", account_id: `acct-${B}` })).toMatchObject({ kind: "refused", code: "AccountDeleted" });

    // Nobody else's anything moved.
    expect(await dump("lazyboy")).toEqual(before.a);
    expect(await dump(`lb-u-${C}`)).toEqual(before.c);
    expect(await appRows(C)).toEqual(before.cRows);
    expect(await teleRows(A)).toBe(2);
    expect(await teleRows(C)).toBe(2);
    expect((await q("SELECT status FROM users WHERE uid IN (:a, :c) ORDER BY uid", { a: A, c: C })).map((r) => r.status)).toEqual(["active", "active"]);

    // A second run is a no-op.
    destroyed = [];
    expect(await runDeletion(B, deps())).toEqual({ kind: "done" });
    expect(destroyed).toEqual([]);
    expect((await tele.execute("SELECT count(*) AS n FROM lifecycle_log")).rows[0].n).toBe(1);
  });

  it("resumes where it stopped: the Platform API down, then the telemetry store down, then both back", async () => {
    const down = async () => {
      throw new Error("down");
    };
    expect(await runDeletion(B, deps({ destroy: down }))).toEqual({ kind: "pending", step: "destroy" });
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: B }))[0].status).toBe("deleting");
    expect(await runDeletion(B, deps({ telemetry: { deleteUser: down, appendLifecycle } }))).toEqual({ kind: "pending", step: "telemetry" });
    expect(await teleRows(B)).toBe(2);
    clock = T0 + 10 * LEASE_WINDOW_MS;
    expect(await runDeletion(B, deps())).toEqual({ kind: "done" });
    expect(await teleRows(B)).toBe(0);
    expect(files.has(`lb-u-${B}`)).toBe(false);
    // A retry never resets the clock it started: the status_at it kept is step 1's.
    expect((await q("SELECT status FROM users WHERE uid = :u", { u: B }))[0].status).toBe("deleted");
  });
});

describe("T11: the refusals, each changing nothing", () => {
  it("never the admin", async () => {
    const before = await dump("lazyboy");
    expect(await runDeletion(A, deps())).toEqual({ kind: "refused", reason: "admin" });
    for (const status of ["revoked", "needs_reconnect", "disabled", "removed", "deleting"]) {
      await q("UPDATE users SET status = :s WHERE uid = :u", { s: status, u: A });
      expect(await runDeletion(A, deps()), status).toEqual({ kind: "refused", reason: "admin" });
    }
    expect(await dump("lazyboy")).toEqual(before);
    expect(destroyed).toEqual([]);
    expect(await teleRows(A)).toBe(2);
  });

  it("never a database the users row does not name as lb-u-<uid>", async () => {
    // users.db_name is UNIQUE, so B's row cannot even name A's or C's database; these are the rest.
    for (const name of ["lb-u-dddddddddddd", "lb-u-bbbbbbbbbbbbx", "lazyboy-app", "lazyboy-copy"]) {
      await q("UPDATE users SET db_name = :n WHERE uid = :u", { n: name, u: B });
      expect(await runDeletion(B, deps()), name).toEqual({ kind: "refused", reason: "name" });
    }
    await untouched();
  });

  it("never a database whose owner_uid is not the departing uid", async () => {
    await userFile(`lb-u-${B}`, C);
    expect(await runDeletion(B, deps())).toEqual({ kind: "refused", reason: "owner-mismatch" });
    await userFile(`lb-u-${B}`, null);
    expect(await runDeletion(B, deps())).toEqual({ kind: "refused", reason: "owner-mismatch" });
    await untouched();
  });

  it("an unknown uid, or an unclaimed invite (withdrawn instead), is not deleted", async () => {
    expect(await runDeletion("dddddddddddd", deps())).toEqual({ kind: "refused", reason: "unknown" });
    await q("UPDATE users SET status = 'invited' WHERE uid = :u", { u: B });
    expect(await runDeletion(B, deps())).toEqual({ kind: "refused", reason: "status" });
    await untouched();
  });
});

describe("withdrawing an unclaimed invite (invite.mjs --revoke, the 14-day expiry)", () => {
  it("destroys its empty database and removes its row and request; refuses a claimed row", async () => {
    await q("INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version) VALUES ('rrrrrrrrrrrd', 'd@example.com', 'n', 'pending', 0, 0, 't')");
    await seedApprovedInvite(db.raw(), { rid: "rrrrrrrrrrrd", uid: "dddddddddddd", invitedAt: 0 });
    await userFile("lb-u-dddddddddddd", "dddddddddddd");
    expect(await withdrawInvite("dddddddddddd", deps())).toEqual({ kind: "done" });
    expect(destroyed).toEqual(["lb-u-dddddddddddd"]);
    expect(await q("SELECT uid FROM users WHERE uid = 'dddddddddddd'")).toEqual([]);
    expect(await q("SELECT id FROM requests WHERE id = 'rrrrrrrrrrrd'")).toEqual([]);
    destroyed = [];
    expect(await withdrawInvite(B, deps())).toEqual({ kind: "refused", reason: "status" });
    expect(await withdrawInvite(A, deps())).toEqual({ kind: "refused", reason: "admin" });
    await untouched();
  });

  it("the runtime's statement runner refuses anything but the deletion job's statements", async () => {
    await expect(execDeletionStatements([{ sql: "DELETE FROM users", args: {} }])).rejects.toThrow(/not a deletion statement/);
    expect((await q("SELECT count(*) AS n FROM users"))[0].n).toBe(3);
  });
});
