// scripts/phase1-meta-keys.mjs (PLAN.md §11.4): the step Phase 1's deploy runs on Rem's `lazyboy`
// before the code that checks the keys. Against a copy of a pre-Phase-1 store (every table, no
// keys): a dry run writes nothing; --apply writes the four keys, the app's open then accepts the
// database as written (no provisioning of its own); a second run writes nothing; a database
// that names another owner, or is not at schema 1, is refused untouched.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it } from "vitest";
import { forUserAt, USER_SCHEMA_VERSION } from "@/lib/db";
import { SCHEMA_VERSION } from "../scripts/phase1-meta-keys.mjs";
import { ownerUid } from "./owner-store";

const root = path.resolve(__dirname, "..");
let dir = "";

const url = (db: string) => `file:${path.join(dir, `${db}.db`)}`;

function run(db: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "phase1-meta-keys.mjs"), ...args, "--db", url(db)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OWNER_UID: ownerUid() },
  });
}

async function sql(db: string, statements: string): Promise<void> {
  const c = createClient({ url: url(db) });
  await c.executeMultiple(statements);
  c.close();
}

async function keys(db: string): Promise<Record<string, string>> {
  const c = createClient({ url: url(db) });
  const r = await c.execute(
    "SELECT key, value FROM meta WHERE key IN ('owner_uid', 'schema_version', 'min_reader', 'store_epoch')",
  );
  c.close();
  return Object.fromEntries(r.rows.map((x) => [String(x.key), String(x.value)]));
}

/** A store as it is before Phase 1: the whole schema, some data, none of the four keys. */
async function prePhase1(db: string): Promise<void> {
  process.env.STORE_URL_TEMPLATE = `file:${dir}/{db}.db`;
  const s = forUserAt(ownerUid(), `${db}-src`);
  await s.setUserTzOffset(-240);
  const { copyFileSync } = await import("node:fs");
  copyFileSync(path.join(dir, `${db}-src.db`), path.join(dir, `${db}.db`));
  await sql(db, "DELETE FROM meta WHERE key IN ('owner_uid', 'schema_version', 'min_reader', 'store_epoch');");
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lazyboy-keys-"));
});

describe("phase1-meta-keys.mjs", () => {
  it("its schema version is the app's", () => {
    expect(SCHEMA_VERSION).toBe(USER_SCHEMA_VERSION);
  });

  it("a dry run reports the four keys it would write and writes none", async () => {
    await prePhase1("dry");
    const r = run("dry", "--user", ownerUid(), "--dry-run");
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Object.keys(out.write).sort()).toEqual(["min_reader", "owner_uid", "schema_version", "store_epoch"]);
    expect(out.applied).toBe(false);
    expect(await keys("dry")).toEqual({});
  });

  it("--apply writes them; the app opens the database as written; a second run writes nothing", async () => {
    await prePhase1("apply");
    const r = run("apply", "--user", ownerUid(), "--apply");
    expect(r.status, r.stderr).toBe(0);
    const k = await keys("apply");
    expect(k).toMatchObject({ owner_uid: ownerUid(), schema_version: String(USER_SCHEMA_VERSION), min_reader: "1" });
    expect(k.store_epoch).toMatch(/^[a-z2-7]{12}$/);
    expect(await forUserAt(ownerUid(), "apply").storeEpoch()).toBe(k.store_epoch);
    const again = run("apply", "--user", ownerUid(), "--apply");
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).write).toEqual({});
    expect(await keys("apply")).toEqual(k);
  });

  it("a database that names another owner is refused and left as it was", async () => {
    await prePhase1("other");
    await sql("other", "INSERT INTO meta (key, value) VALUES ('owner_uid', 'bbbbbbbbbbbb');");
    const r = run("other", "--user", ownerUid(), "--apply");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing to change a database's owner/);
    expect(await keys("other")).toEqual({ owner_uid: "bbbbbbbbbbbb" });
  });

  it("a database not at schema 1 is refused before anything is written", async () => {
    await prePhase1("old");
    await sql("old", "DROP INDEX idx_plays_context;");
    const r = run("old", "--user", ownerUid(), "--apply");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing: index idx_plays_context/);
    expect(await keys("old")).toEqual({});
  });

  it("needs --user and exactly one of --dry-run and --apply", async () => {
    await prePhase1("args");
    expect(run("args", "--apply").status).toBe(2);
    expect(run("args", "--user", ownerUid()).status).toBe(2);
    expect(run("args", "--user", ownerUid(), "--apply", "--dry-run").status).toBe(2);
    expect(await keys("args")).toEqual({});
  });
});
