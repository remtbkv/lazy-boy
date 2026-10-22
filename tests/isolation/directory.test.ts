// The user-to-database mapping's first layer (PLAN.md §6.2 layer 3, M9): the directory (from
// Phase 2, each uid's db_name as its users row names it) knows only the uids a users row has
// named, and the one URL rule never falls back to Rem's URL. The owner check at
// open is the second layer (open.test.ts T8); these pin the first, so a fallback that the owner
// check would only catch after reaching Rem's database fails here (lane 13's review, brief (b)).
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { forUser, forUserAt } from "@/lib/db";
import { mintUid } from "@/lib/identity";
import { ownerStore, ownerUid } from "../owner-store";

const B = mintUid("bbbbbbbbbbbb");

async function isolationEvents(): Promise<number> {
  const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
  const r = await c.execute("SELECT count(*) AS n FROM client_metrics WHERE event = 'isolation'").catch(() => null);
  c.close();
  return r ? Number(r.rows[0].n) : 0;
}

afterEach(() => {
  delete process.env.STORE_URL_TEMPLATE;
});

describe("the directory and the URL rule", () => {
  it("forUser maps the owner to Rem's database and throws for anyone else, opening nothing", async () => {
    expect(ownerStore().dbName).toBe("lazyboy");
    await ownerStore().getLastSync(); // Rem's file is provisioned for the owner
    expect(() => forUser(B)).toThrow(/no database is named for user bbbbbbbbbbbb/);
    expect(await isolationEvents()).toBe(0);
  });

  it("another db_name with no STORE_URL_TEMPLATE has no URL: refused before any statement, never Rem's", async () => {
    await ownerStore().getLastSync();
    await expect(forUserAt(B, "lb-u-bbbbbbbbbbbb").getLastSync()).rejects.toThrow(/no URL for database lb-u-bbbbbbbbbbbb/);
    await expect(forUserAt(ownerUid(), "lb-u-other").setUserTzOffset(0)).rejects.toThrow(/no URL for database/);
    expect(await isolationEvents()).toBe(0);
  });

  it("a template without {db} is no template", async () => {
    process.env.STORE_URL_TEMPLATE = "file:/tmp/lazyboy-one-file.db";
    await expect(forUserAt(B, "lb-u-bbbbbbbbbbbb").getLastSync()).rejects.toThrow(/no URL for database/);
  });
});
