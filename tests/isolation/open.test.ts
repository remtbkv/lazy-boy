// T8 and the versioned open (PLAN.md §4.5, §6.2 layer 3): a database names its owner, and the
// first open of each (uid, db_name) in a process checks it before any read result is used or
// any write is sent. Which database a uid opens is its users row's db_name, handed to forUser by
// the identity read (§4.2). Known answers over the harness's app.db and per-user files, and the
// decision itself as a pure function for the cases a local file cannot stand in for (a remote
// database).
import { copyFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Every statement each store client sends, by URL: the open must ride the first read's batch.
const sent = vi.hoisted(() => ({ calls: [] as { url: string; kind: "execute" | "batch"; n: number }[] }));
vi.mock("@libsql/client", async (orig) => {
  const real = (await orig()) as typeof import("@libsql/client");
  return {
    ...real,
    createClient: (cfg: Parameters<typeof real.createClient>[0]) => {
      const c = real.createClient(cfg);
      const exec = c.execute.bind(c);
      const batch = c.batch.bind(c);
      c.execute = ((...a: Parameters<typeof c.execute>) => {
        sent.calls.push({ url: cfg.url, kind: "execute", n: 1 });
        return exec(...a);
      }) as typeof c.execute;
      c.batch = ((stmts: Parameters<typeof c.batch>[0], mode?: Parameters<typeof c.batch>[1]) => {
        sent.calls.push({ url: cfg.url, kind: "batch", n: stmts.length });
        return batch(stmts, mode);
      }) as typeof c.batch;
      return c;
    },
  };
});

import { forUser, forUserAt, mayApplySchema, openVerdict, StoreRefusedError, USER_SCHEMA_VERSION } from "@/lib/db";
import { mintUid } from "@/lib/identity";
import { adminStore } from "@/lib/identity-read";
import { A, B, dumpDb, nameDb, seedUser, signedIn, useUserFiles } from "./user-dbs";

let dir = "";
beforeAll(() => {
  dir = useUserFiles();
});

const fileOf = (db: string) => path.join(dir, `${db}.db`);
const sentTo = (db: string) => sent.calls.filter((c) => c.url === `file:${fileOf(db)}`);

/** A copy of a provisioned database under a new name: a database this process has never opened. */
function copyAs(from: string, to: string): void {
  copyFileSync(fileOf(from), fileOf(to));
}

async function setKey(db: string, key: string, value: string | null): Promise<void> {
  const c = createClient({ url: `file:${fileOf(db)}` });
  if (value === null) await c.execute({ sql: "DELETE FROM meta WHERE key = ?", args: [key] });
  else await c.execute({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", args: [key, value] });
  c.close();
}

async function keys(db: string): Promise<Record<string, string>> {
  const c = createClient({ url: `file:${fileOf(db)}` });
  const r = await c.execute(
    "SELECT key, value FROM meta WHERE key IN ('owner_uid', 'schema_version', 'min_reader', 'store_epoch')",
  );
  c.close();
  return Object.fromEntries(r.rows.map((x) => [String(x.key), String(x.value)]));
}

async function isolationEvents(): Promise<string[]> {
  const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
  const r = await c.execute("SELECT meta, user_id FROM client_metrics WHERE event = 'isolation'").catch(() => ({ rows: [] }));
  c.close();
  return r.rows.map((x) => `${x.meta}/${x.user_id}`);
}

describe("provisioning a local file", () => {
  it("the first opener owns it: owner_uid, the code's schema_version, min_reader and a store_epoch", async () => {
    await forUserAt(A, "prov").getLastSync();
    const k = await keys("prov");
    expect(k.owner_uid).toBe(A);
    expect(k.schema_version).toBe(String(USER_SCHEMA_VERSION));
    expect(k.min_reader).toBe("1");
    expect(k.store_epoch).toMatch(/^[a-z2-7]{12}$/);
    expect(await forUserAt(A, "prov").storeEpoch()).toBe(k.store_epoch);
  });
});

async function appEvents(): Promise<string[]> {
  const c = createClient({ url: process.env.APP_DATABASE_URL as string });
  const r = await c.execute("SELECT uid, code FROM events ORDER BY id");
  c.close();
  return r.rows.map((x) => `${x.code}|${x.uid}`);
}

describe("T8: a users row pointing B at A's database", () => {
  it("A opened in this process; a restore moves A to a new database and B's row names A's old one: B's open refuses before any read result or write, the event lands in app.db, A's old database is as it was, A reaches its new one", async () => {
    await nameDb(A, "t8");
    const a = await signedIn(A);
    expect(a.dbName).toBe("t8");
    await seedUser(a, "A");
    // The restore (§12.5): a copy under a new name with a new store_epoch; the users row moves.
    copyAs("t8", "t8-restored");
    await setKey("t8-restored", "store_epoch", "rrrrrrrrrrrr");
    const before = await dumpDb("t8");
    await nameDb(A, "t8-restored");
    await nameDb(B, "t8");
    const asB = await signedIn(B);
    expect(asB.dbName).toBe("t8");
    await expect(asB.searchHistory("")).rejects.toBeInstanceOf(StoreRefusedError);
    await expect(asB.setUserTzOffset(60)).rejects.toMatchObject({ code: "owner-mismatch" });
    await expect(asB.recordPlays([])).resolves.toBe(0); // no statement at all: nothing to refuse
    expect(await dumpDb("t8")).toBe(before);
    expect(await appEvents()).toContain(`owner-mismatch|${B}`);
    expect(await isolationEvents()).toContain(`owner-mismatch|${B}/${B}`);
    // A's next request reaches the restored database: the entry was rebuilt under the new
    // name, and the new database's own epoch is what the open read.
    const a2 = await signedIn(A);
    expect(a2.dbName).toBe("t8-restored");
    expect(await a2.storeEpoch()).toBe("rrrrrrrrrrrr");
    expect((await a2.searchHistory("")).length).toBeGreaterThan(0);
  });
});

describe("the identity read names the database (PLAN §4.2)", () => {
  it("forUser reaches the database the users row names, and nothing for a uid no read has named", async () => {
    await nameDb(A, "named-a");
    expect((await signedIn(A)).dbName).toBe("named-a");
    expect(forUser(A).dbName).toBe("named-a");
    expect(() => forUser(mintUid("cccccccccccc"))).toThrow(/no database is named/);
  });

  it("a name that changed is rebuilt: the old entry's open verdict goes, so a name met again is checked again", async () => {
    await nameDb(A, "move-1");
    await seedUser(await signedIn(A), "A"); // (A, move-1) opened and cached
    copyAs("move-1", "move-2");
    await nameDb(A, "move-2");
    await expect((await signedIn(A)).getLastSync()).resolves.not.toBeUndefined();
    // move-1 is now someone else's database (its owner_uid says so). Named again, it is
    // opened and refused, never served on the verdict this process cached before the move.
    await setKey("move-1", "owner_uid", B);
    await nameDb(A, "move-1");
    await expect((await signedIn(A)).getLastSync()).rejects.toMatchObject({ code: "owner-mismatch" });
  });

  it("the session-less paths reach the admin's database through his users row: none without it, none for a non-admin row", async () => {
    const owner = mintUid(process.env.OWNER_UID as string);
    expect(await adminStore()).toBeNull();
    await nameDb(owner, "admin-db");
    expect(await adminStore()).toBeNull(); // the row is not an admin's
    const c = createClient({ url: process.env.APP_DATABASE_URL as string });
    await c.execute({ sql: "UPDATE users SET is_admin = 1 WHERE uid = ?", args: [owner] });
    c.close();
    const s = await adminStore();
    expect([s?.uid, s?.dbName]).toEqual([owner, "admin-db"]);
    expect(forUser(owner).dbName).toBe("admin-db");
  });
});

describe("the open's round trips", () => {
  it("a first read carries the open in the same batch; the verdict is cached per (uid, db_name)", async () => {
    await seedUser(forUserAt(A, "rt-src"), "A");
    copyAs("rt-src", "rt");
    sent.calls.length = 0;
    const s = forUserAt(A, "rt");
    await s.getLastSync();
    expect(sentTo("rt")).toEqual([{ url: `file:${fileOf("rt")}`, kind: "batch", n: 2 }]);
    await s.getLastSync();
    expect(sentTo("rt").length).toBe(2); // the second read goes alone, unchecked again
    expect(sentTo("rt")[1]).toMatchObject({ kind: "execute" });
  });

  it("a first write is preceded by the open on its own round trip", async () => {
    copyAs("rt-src", "rt-w");
    sent.calls.length = 0;
    await forUserAt(A, "rt-w").setUserTzOffset(-240);
    expect(sentTo("rt-w").map((c) => c.kind)).toEqual(["execute", "execute"]);
  });
});

describe("schema states (PLAN §4.5)", () => {
  it("one additive step ahead (schema_version above the code, min_reader not) opens", async () => {
    copyAs("rt-src", "ahead");
    await setKey("ahead", "schema_version", String(USER_SCHEMA_VERSION + 1));
    await expect(forUserAt(A, "ahead").getLastSync()).resolves.not.toBeUndefined();
  });

  it("a rebuild ahead (min_reader above the code) refuses: updating", async () => {
    copyAs("rt-src", "rebuilt");
    await setKey("rebuilt", "schema_version", String(USER_SCHEMA_VERSION + 1));
    await setKey("rebuilt", "min_reader", String(USER_SCHEMA_VERSION + 1));
    await expect(forUserAt(A, "rebuilt").getLastSync()).rejects.toMatchObject({ code: "too-new" });
  });

  it("behind by an additive step, a local file is brought up to date", async () => {
    copyAs("rt-src", "behind");
    await setKey("behind", "schema_version", "0");
    await forUserAt(A, "behind").getLastSync();
    expect((await keys("behind")).schema_version).toBe(String(USER_SCHEMA_VERSION));
  });

  it("a first read of a column a pending step adds: the step is applied and the read answers", async () => {
    copyAs("rt-src", "behind-col");
    await setKey("behind-col", "schema_version", "0");
    const c = createClient({ url: `file:${fileOf("behind-col")}` });
    await c.execute("ALTER TABLE contexts DROP COLUMN checked_at");
    c.close();
    await expect(forUserAt(A, "behind-col").unresolvedContextUris()).resolves.toEqual(expect.any(Array));
    expect((await keys("behind-col")).schema_version).toBe(String(USER_SCHEMA_VERSION));
  });

  it("a local file with owner_uid but no store_epoch gets one, for its owner only", async () => {
    copyAs("rt-src", "noepoch");
    await setKey("noepoch", "store_epoch", null);
    await forUserAt(A, "noepoch").getLastSync();
    expect((await keys("noepoch")).store_epoch).toMatch(/^[a-z2-7]{12}$/);
    copyAs("noepoch", "noepoch-b");
    await setKey("noepoch-b", "store_epoch", null);
    await expect(forUserAt(B, "noepoch-b").getLastSync()).rejects.toMatchObject({ code: "owner-mismatch" });
  });
});

describe("openVerdict (the decision, for remote databases a test cannot open)", () => {
  const full = { owner_uid: A, schema_version: "1", min_reader: "1", store_epoch: "eeeeeeeeeeee" };
  const remote = { local: false, mayApply: false };

  it("opens its owner's database at the code's version", () => {
    expect(openVerdict(full, A, remote)).toEqual({ kind: "open", epoch: "eeeeeeeeeeee" });
  });
  it("refuses another owner, locally too", () => {
    expect(openVerdict(full, B, remote)).toMatchObject({ kind: "refuse", code: "owner-mismatch" });
    expect(openVerdict({ owner_uid: A }, B, { local: true, mayApply: true })).toMatchObject({ code: "owner-mismatch" });
  });
  it("a remote database without its keys is refused, never claimed", () => {
    expect(openVerdict({}, A, remote)).toMatchObject({ kind: "refuse", code: "unprovisioned" });
    expect(openVerdict({ owner_uid: A }, A, remote)).toMatchObject({ code: "unprovisioned" });
    expect(openVerdict({}, A, { local: true, mayApply: true })).toEqual({ kind: "provision" });
  });
  it("behind by an additive step: applied only where steps may be applied", () => {
    const behind = { ...full, schema_version: "0" };
    expect(openVerdict(behind, A, remote)).toMatchObject({ kind: "refuse", code: "schema-behind" });
    expect(openVerdict(behind, A, { local: false, mayApply: true })).toEqual({ kind: "apply", from: 0 });
  });
  it("min_reader above the code refuses whoever asks", () => {
    expect(openVerdict({ ...full, schema_version: "3", min_reader: "2" }, A, remote)).toMatchObject({ code: "too-new" });
  });

  it("only production code, or a local file, may apply a step: a dev server or a test against a remote URL refuses", () => {
    const turso = "https://lazyboy-remtbkv.aws-us-east-1.turso.io";
    expect(mayApplySchema(turso, {})).toBe(false);
    expect(mayApplySchema(turso, { VERCEL_ENV: "preview" })).toBe(false);
    expect(mayApplySchema(turso, { VERCEL_ENV: "development" })).toBe(false);
    expect(mayApplySchema(turso, { VERCEL_ENV: "production" })).toBe(true);
    expect(mayApplySchema("file:/tmp/x.db", {})).toBe(true);
  });
});
