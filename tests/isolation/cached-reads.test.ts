// T2 over db.ts's real cached reads (PLAN.md §6.4): the seven reads that ride userCache, run as A
// then as B over two users' own databases whose counters are equal (the same writes made the same
// write_seq and library_seq), against a cache stub keyed the way Next 16.2.6 keys. B never sees an
// A marker. Then an entry forged under B's key and stamped with A: refused, B's data served
// uncached, a `cache-stamp` isolation event recorded for B.
import { createClient } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", async () => await import("../stubs/next-cache-faithful"));

import { __cache } from "../stubs/next-cache-faithful";
import { forUserAt, type UserStore } from "@/lib/db";
import { A, B, PLAY_DAY, seedUser, useUserFiles, type Tag } from "./user-dbs";

const TODAY = new Date().toISOString().slice(0, 10);

// Each wrapper by its userCache name, with the read that reaches it.
const READS: Record<string, (s: UserStore) => Promise<unknown>> = {
  "all-time-plays": (s) => s.getAllTimePlays(10),
  "daily-stats": (s) => s.getDailyStats(0, 30),
  "plays-by-day-frozen": (s) => s.getPlaysByDay(PLAY_DAY, 0),
  "plays-by-day-live": (s) => s.getPlaysByDay(TODAY, 0),
  "library-index": async (s) => s.getLibraryIndex(await s.getLibraryIndexVersion()),
  "history-index": async (s) => s.getHistoryIndex(await s.getHistoryIndexVersion()),
  "stored-playlists": (s) => s.getStoredPlaylists(),
};
// The reads whose answer carries a name: these must show their own user's marker.
const MARKED = new Set(["all-time-plays", "plays-by-day-frozen", "plays-by-day-live", "library-index", "history-index", "stored-playlists"]);

let a: UserStore;
let b: UserStore;

async function seed(s: UserStore, tag: Tag): Promise<void> {
  await seedUser(s, tag);
  // A play a few minutes ago, so today's day is a LIVE entry with rows in it.
  await s.recordPlays([
    {
      trackId: "t8",
      name: `${tag}-only-song-8`,
      artist: `${tag}-only-artist`,
      uri: "spotify:track:t8",
      album: null,
      albumImage: null,
      durationMs: 200_000,
      playedAt: new Date(Math.max(Date.now() - 5 * 60_000, Date.parse(`${TODAY}T00:00:30Z`))).toISOString(),
      contextType: null,
      contextUri: null,
    },
  ]);
}

async function isolationEvents(): Promise<string[]> {
  const c = createClient({ url: process.env.TURSO_DATABASE_URL as string });
  const r = await c.execute("SELECT meta FROM client_metrics WHERE event = 'isolation'").catch(() => ({ rows: [] }));
  c.close();
  return r.rows.map((x) => String(x.meta));
}

/** The same counters in both databases: their data differ (B's playlist orphans a play A's
 *  does not), so the seeds' own bumps may not land on the same numbers. */
async function equalCounters(db: string): Promise<void> {
  const url = (process.env.STORE_URL_TEMPLATE as string).replaceAll("{db}", db);
  const c = createClient({ url });
  await c.executeMultiple(`
    UPDATE meta SET value = '50' WHERE key = 'write_seq';
    UPDATE meta SET value = '20' WHERE key = 'library_seq';
    DELETE FROM meta WHERE key = 'slow_seq_pub';`);
  c.close();
}

beforeAll(async () => {
  useUserFiles();
  a = forUserAt(A, "c-a");
  b = forUserAt(B, "c-b");
  await seed(a, "A");
  await seed(b, "B");
  await equalCounters("c-a");
  await equalCounters("c-b");
});

describe("T2: the cached reads with equal counters", () => {
  it("the two users' versions are equal, so only the user separates their entries", async () => {
    expect(await a.getLibraryIndexVersion()).toBe(await b.getLibraryIndexVersion());
    expect(await a.getHistoryIndexVersion()).toBe(await b.getHistoryIndexVersion());
  });

  for (const [name, read] of Object.entries(READS)) {
    it(`${name}: A then B then A, each sees only their own`, async () => {
      __cache.clear();
      const asA = JSON.stringify(await read(a));
      const asB = JSON.stringify(await read(b));
      const asAagain = JSON.stringify(await read(a));
      expect(asB).not.toContain("A-only");
      expect(asA).not.toContain("B-only");
      expect(asAagain).toBe(asA);
      if (MARKED.has(name)) {
        expect(asA).toContain("A-only");
        expect(asB).toContain("B-only");
      }
      // Both were cached, under keys that name their user.
      const keys = __cache.keys().filter((k) => k.includes(`u,${name},`));
      expect(keys.some((k) => k.includes(`u,${name},${A},`))).toBe(true);
      expect(keys.some((k) => k.includes(`u,${name},${B},`))).toBe(true);
    });

    it(`${name}: an entry forged under B's key and stamped with A is refused`, async () => {
      __cache.clear();
      const aValue = await read(a);
      const honest = JSON.stringify(await read(b));
      const bKey = __cache.keys().find((k) => k.includes(`u,${name},${B},`));
      expect(bKey).toBeTruthy();
      __cache.forge(bKey!, { o: A, v: aValue });
      const before = (await isolationEvents()).filter((m) => m === `cache-stamp|${B}`).length;
      const served = JSON.stringify(await read(b));
      expect(served).toBe(honest);
      expect(served).not.toContain("A-only");
      expect((await isolationEvents()).filter((m) => m === `cache-stamp|${B}`).length).toBe(before + 1);
    });
  }
});
