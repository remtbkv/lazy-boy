// A friend's database, as invite.mjs provisions it (user-schema.ts), holds exactly the seven core
// tables, columns, keys and indexes db.ts's init() builds for Rem's (PLAN.md §4.1): the same code
// reads both, so a column one has and the other lacks would break a friend's first request.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { USER_SCHEMA_VERSION as DB_USER_SCHEMA_VERSION } from "@/lib/db";
import { USER_SCHEMA_STATEMENTS, USER_SCHEMA_VERSION, userMetaStatement } from "@/lib/user-schema";
import { ownerStore } from "../owner-store";

const SEVEN = ["contexts", "meta", "playlist_tracks", "playlists", "plays", "saved_tracks", "tracks"];

async function shape(c: Client) {
  const out: Record<string, unknown> = {};
  for (const t of SEVEN) {
    out[t] = (await c.execute(`PRAGMA table_info(${t})`)).rows.map((r) => [r.name, r.type, r.notnull, r.pk]);
    out[`${t}:indexes`] = (await c.execute(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}' ORDER BY name`)).rows.map((r) => [
      r.name,
      r.sql == null ? null : String(r.sql).replace(/\s+/g, " "),
    ]);
  }
  return out;
}

describe("user-schema.ts", () => {
  it("builds what db.ts's init() builds, table for table and index for index", async () => {
    await ownerStore().getMeId(); // db.ts's first open runs init() on the simulated store
    const dbts = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const fresh = createClient({ url: `file:${path.join(mkdtempSync(path.join(tmpdir(), "lazyboy-us-")), "u.db")}` });
    for (const s of USER_SCHEMA_STATEMENTS) await fresh.execute(s);
    expect(await shape(fresh)).toEqual(await shape(dbts));
    dbts.close();
    fresh.close();
  });

  it("is version 1 of db.ts's versioned open, so a friend's database opens without a step", () => {
    expect(USER_SCHEMA_VERSION).toBe(DB_USER_SCHEMA_VERSION);
  });

  it("writes the four meta keys once", async () => {
    const c = createClient({ url: `file:${path.join(mkdtempSync(path.join(tmpdir(), "lazyboy-us-")), "u.db")}` });
    for (const s of USER_SCHEMA_STATEMENTS) await c.execute(s);
    await c.execute(userMetaStatement("bbbbbbbbbbbb", "epoch-1"));
    await c.execute(userMetaStatement("cccccccccccc", "epoch-2"));
    const meta = Object.fromEntries((await c.execute("SELECT key, value FROM meta")).rows.map((r) => [r.key, r.value]));
    expect(meta).toEqual({ owner_uid: "bbbbbbbbbbbb", schema_version: "1", min_reader: "1", store_epoch: "epoch-1" });
    c.close();
  });
});
