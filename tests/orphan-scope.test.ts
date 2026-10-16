// The stored orphan verdict (`plays.ctx_orphan`) is refreshed by scoped passes only
// (docs/STORE_MIGRATION.md §3 and §7 L10). Each test states its expectation against the verdict
// recomputed from source with the PRE-L10 predicate — what today's full pass would have written —
// so "scoped equals full" is checked on every play, not on the one the test is about.
//
//   • a library-list rewrite re-rules exactly the playlists its purge deleted rows of
//     (`DELETE … RETURNING playlist_id`), and nothing when the purge deleted nothing;
//   • removing a cached track re-rules that playlist;
//   • a `tracks` row whose name or artist changes re-rules the plays sharing its old or new
//     identity, from whichever playlist;
//   • the identity-first predicate gives the old predicate's verdict on every identity case,
//     and its plan starts from the song;
//   • on a per-user store (multi-user Phase 1, forUser), a user's library change re-rules that
//     user's plays only, and the read-cost ledger charges the pass at that user's size.
// Every suite but the last runs as the owner (ownerStore(): OWNER_UID's database, the file
// TURSO_DATABASE_URL names); the last runs two users over their own files.
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every SQL text the app's client sends, so a test can say which orphan pass ran (or that none
// did). The raw helper client is created through the same factory; it only reads.
const sent: string[] = [];
vi.mock("@libsql/client", async (orig) => {
  const real = (await orig()) as typeof import("@libsql/client");
  return {
    ...real,
    createClient: (cfg: Parameters<typeof real.createClient>[0]) => {
      const c = real.createClient(cfg);
      const text = (s: unknown) => (typeof s === "string" ? s : (s as { sql: string }).sql);
      const execute = c.execute.bind(c);
      const batch = c.batch.bind(c);
      c.execute = ((s: Parameters<typeof execute>[0]) => {
        sent.push(text(s));
        return execute(s);
      }) as typeof c.execute;
      c.batch = ((stmts: Parameters<typeof batch>[0], mode?: Parameters<typeof batch>[1]) => {
        for (const s of stmts) sent.push(text(s));
        return batch(stmts, mode);
      }) as typeof c.batch;
      return c;
    },
  };
});

import { forUserAt, ORPHAN_PREDICATE } from "@/lib/db";
import { orphanPurgePassRows } from "@/lib/read-costs";
import { play, rawClient, resetStore, track } from "./adversarial/helpers";
import { A, B, dumpDb, useUserFiles } from "./isolation/user-dbs";
import { ownerStore } from "./owner-store";

const store = () => ownerStore();

// The predicate as it stood before L10 (db.ts at origin/main 4577215): the reference verdict.
const OLD_PREDICATE = `
  CASE WHEN p.context_type = 'playlist' AND p.context_uri IS NOT NULL
            AND EXISTS (SELECT 1 FROM playlist_tracks pl
                        WHERE pl.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
            AND NOT EXISTS (
              SELECT 1 FROM playlist_tracks plm JOIN tracks tm ON tm.id = plm.track_id
              WHERE plm.playlist_id = replace(p.context_uri, 'spotify:playlist:', '')
                AND lower(tm.artist) = (SELECT lower(artist) FROM tracks WHERE id = p.track_id)
                AND lower(tm.name) = (SELECT lower(name) FROM tracks WHERE id = p.track_id))
       THEN 1 ELSE 0 END`;

const orphanPasses = () => sent.filter((s) => /UPDATE plays AS p SET ctx_orphan/.test(s));

/** Every play: its stored flag and the full-pass verdict from source (the owner's file unless a
 *  client is given). */
async function flags(client?: Client): Promise<{ id: number; key: string; stored: number | null; full: number }[]> {
  const c = client ?? (await rawClient());
  const res = await c.execute(
    `SELECT p.id AS id, p.track_id || '@' || COALESCE(p.context_uri, '-') AS key,
            p.ctx_orphan AS stored, (${OLD_PREDICATE}) AS full
     FROM plays p ORDER BY p.id`,
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    key: String(r.key),
    stored: r.stored === null ? null : Number(r.stored),
    full: Number(r.full),
  }));
}

async function expectScopedEqualsFull(client?: Client) {
  const rows = await flags(client);
  expect(rows.map((r) => [r.key, r.stored])).toEqual(rows.map((r) => [r.key, r.full]));
}

const pl = (id: string, name = `List ${id}`) => ({
  id,
  name,
  ownerId: "me",
  image: null,
  trackCount: 1,
});

/** Insert plays straight into the store with a given stored verdict (null = not ruled). */
async function seedPlays(rows: [trackId: string, contextUri: string | null, flag: number | null][]) {
  const c = await rawClient();
  await c.batch(
    rows.map(([tid, uri, flag], i) => ({
      sql: `INSERT INTO plays (track_id, played_at, context_type, context_uri, ctx_orphan)
            VALUES (?, ?, ?, ?, ?)`,
      args: [tid, `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`, uri ? "playlist" : null, uri, flag],
    })),
    "write",
  );
}

async function seedTracks(rows: [id: string, name: string, artist: string][]) {
  const c = await rawClient();
  await c.batch(
    rows.map(([id, name, artist]) => ({
      sql: "INSERT INTO tracks (id, name, artist, uri) VALUES (?, ?, ?, ?)",
      args: [id, name, artist, `spotify:track:${id}`],
    })),
    "write",
  );
}

/** Rule every play with the reference predicate, as the backfill would have. */
async function ruleAll() {
  const c = await rawClient();
  await c.execute(`UPDATE plays AS p SET ctx_orphan = (${OLD_PREDICATE})`);
}

describe("RETURNING through client.batch on the file client", () => {
  it("returns each statement's rows in its own result set (and reports rowsAffected 0 for it)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lazyboy-returning-"));
    const c = createClient({ url: `file:${path.join(dir, "r.db")}`, intMode: "number" });
    await c.executeMultiple(`
      CREATE TABLE playlists (id TEXT PRIMARY KEY);
      CREATE TABLE playlist_tracks (playlist_id TEXT, position INTEGER, track_id TEXT);
      INSERT INTO playlists VALUES ('keep');
      INSERT INTO playlist_tracks VALUES ('keep',0,'a'),('gone',0,'a'),('gone',1,'b'),('x',0,'c');`);
    const res = await c.batch(
      [
        { sql: "INSERT INTO playlists VALUES ('new')", args: [] },
        {
          sql: "DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists) RETURNING playlist_id",
          args: [],
        },
        { sql: "DELETE FROM playlists WHERE id = 'nope' RETURNING id", args: [] },
      ],
      "write",
    );
    expect(res).toHaveLength(3);
    expect(res[0].rows).toEqual([]);
    expect(res[1].rows.map((r) => r.playlist_id).sort()).toEqual(["gone", "gone", "x"]);
    expect(res[2].rows).toEqual([]);
    // The file client hard-codes 0 for any statement that returns rows: count rows, never this.
    expect(res[1].rowsAffected).toBe(0);
    c.close();
  });
});

describe("library-list rewrite: the pass covers exactly the purged playlists", () => {
  beforeEach(async () => {
    await resetStore();
    sent.length = 0;
  });

  it("1910's counterexample: a playlist in neither list, cached, then a rename-only rewrite", async () => {
    await store().storePlaylists([pl("L1")], "me");
    await store().storePlaylistTracks("L1", [track("t1")]);
    // X was cached (by URL, Resume's cold fetch, or a store racing a rewrite) but is in no list.
    await store().storePlaylistTracks("X", [track("t1")]);
    await seedTracks([["t2", "Song t2", "Artist t2"]]);
    await seedPlays([["t2", "spotify:playlist:X", null]]);
    await ruleAll();
    expect((await flags())[0].stored).toBe(1); // before: t2 is not among X's members
    sent.length = 0;

    await store().storePlaylists([pl("L1", "renamed")], "me");

    const rows = await flags();
    expect(rows[0]).toMatchObject({ stored: 0, full: 0 }); // 1910: before 1, full 0, scoped 0
    await expectScopedEqualsFull();
    const passes = orphanPasses();
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatch(/p\.context_uri IN \(/);
  });

  it("adds one playlist and removes another: scoped equals full on every play", async () => {
    await store().storePlaylists([pl("A"), pl("B"), pl("C")], "me");
    await store().storePlaylistTracks("A", [track("a1")]);
    await store().storePlaylistTracks("B", [track("b1")]);
    await store().storePlaylistTracks("C", [track("c1")]);
    // D is cached before it joins the list (opened by URL), so its plays already have verdicts.
    await store().storePlaylistTracks("D", [track("d1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([
      ["a1", "spotify:playlist:A", null], // member of an untouched playlist → 0
      ["z9", "spotify:playlist:A", null], // non-member, untouched playlist → 1
      ["b1", "spotify:playlist:B", null], // removed playlist, member → 0 stays 0
      ["z9", "spotify:playlist:B", null], // removed playlist, non-member → 1 flips to 0
      ["z9", "spotify:playlist:C", null], // untouched → 1
      ["d1", "spotify:playlist:D", null], // added playlist, member → 0
      ["z9", "spotify:playlist:D", null], // added playlist, non-member → 1
      ["z9", null, null], // no context → 0
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1, 0, 1, 1, 0, 1, 0]);
    sent.length = 0;

    await store().storePlaylists([pl("A"), pl("C"), pl("D")], "me");

    expect((await flags()).map((r) => r.stored)).toEqual([0, 1, 0, 0, 1, 0, 1, 0]);
    await expectScopedEqualsFull();
    const passes = orphanPasses();
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatch(/p\.context_uri IN \(\?\)/); // B only: one placeholder
  });

  it("nothing purged: no recompute statement is issued", async () => {
    await store().storePlaylists([pl("A"), pl("U")], "me"); // U is in the list but never cached
    await store().storePlaylistTracks("A", [track("a1")]);
    await seedPlays([["a1", "spotify:playlist:A", null]]);
    await ruleAll();
    sent.length = 0;

    await store().storePlaylists([pl("A"), pl("U"), pl("N")], "me"); // added, nothing cached for N
    await store().storePlaylists([pl("A"), pl("N")], "me"); // removed U, which had no cached rows
    await store().storePlaylists([pl("A", "renamed"), pl("N")], "me"); // rename only

    expect(sent.some((s) => /DELETE FROM playlist_tracks WHERE playlist_id NOT IN/.test(s))).toBe(true);
    expect(orphanPasses()).toEqual([]);
    await expectScopedEqualsFull();
  });
});

describe("the heals the full pass gave, now scoped at their call sites", () => {
  beforeEach(async () => {
    await resetStore();
    sent.length = 0;
  });

  it("removeCachedPlaylistTrack re-rules that playlist's plays", async () => {
    await store().storePlaylists([pl("P")], "me");
    await store().storePlaylistTracks("P", [track("t1"), track("t2")]);
    await seedPlays([
      ["t2", "spotify:playlist:P", null],
      ["t1", "spotify:playlist:P", null],
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([0, 0]);

    await store().removeCachedPlaylistTrack("P", "spotify:track:t2");
    expect((await flags()).map((r) => r.stored)).toEqual([1, 0]); // t2 is no longer a member
    await expectScopedEqualsFull();

    await store().removeCachedPlaylistTrack("P", "spotify:track:t1");
    // P's cache is now empty, so its plays are unverifiable → non-orphan.
    expect((await flags()).map((r) => r.stored)).toEqual([0, 0]);
    await expectScopedEqualsFull();
  });

  // One fixture, three writers. Q holds t3 ("Song X" by "Art"); t9 is a different id with
  // t3's identity; t4 ("Song Y") is in Q too. A rename of t3 from any writer moves both sides:
  // plays sharing t3's OLD identity (t9 from Q loses its match) and its NEW identity.
  async function identityFixture() {
    await store().storePlaylists([pl("Q"), pl("R")], "me");
    await store().storePlaylistTracks("Q", [
      track("t3", { title: "Song X", artist: "Art" }),
      track("t4", { title: "Song Y", artist: "Art" }),
    ]);
    await seedTracks([
      ["t9", "song x", "ART"],
      ["t8", "Song Z", "Art"],
    ]);
    await seedPlays([
      ["t9", "spotify:playlist:Q", null], // matches t3 by identity → 0; after rename → 1
      ["t8", "spotify:playlist:Q", null], // no match → 1; after rename to "Song Z" → 0
      ["t3", "spotify:playlist:Q", null], // its own row is a member → 0 either way
      ["t3", "spotify:playlist:R", null], // R uncached → 0
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1, 0, 0]);
    sent.length = 0;
  }
  const renamed = track("t3", { title: "Song Z", artist: "Art" });

  it("a rename landing through storePlaylistTracks (another playlist) re-rules both identities", async () => {
    await identityFixture();
    await store().storePlaylistTracks("R", [renamed]);
    expect((await flags()).map((r) => r.stored)).toEqual([1, 0, 0, 0]);
    await expectScopedEqualsFull();
  });

  it("a rename landing through storeSavedTracks re-rules both identities", async () => {
    await identityFixture();
    await store().storeSavedTracks([renamed]);
    expect((await flags()).map((r) => r.stored)).toEqual([1, 0, 0, 0]);
    await expectScopedEqualsFull();
  });

  it("a rename landing through recordPlays re-rules both identities", async () => {
    await identityFixture();
    await store().recordPlays([
      play("t3", "2026-10-02T00:00:00.000Z", 200_000, { name: "Song Z", artist: "Art" }),
    ]);
    expect((await flags()).map((r) => r.stored)).toEqual([1, 0, 0, 0, 0]);
    await expectScopedEqualsFull();
  });

  it("a write that changes no name or artist issues no identity pass", async () => {
    await identityFixture();
    await store().storeSavedTracks([track("t3", { title: "Song X", artist: "Art", album: "Another" })]);
    expect(orphanPasses()).toEqual([]);
  });
});

describe("identity-first predicate", () => {
  beforeEach(resetStore);

  it("gives the old predicate's verdict on every identity case", async () => {
    await seedTracks([
      ["own", "Own", "Art"],
      ["twin", "TWIN", "art"], // identity of `twinM`, different case
      ["twinM", "Twin", "Art"],
      ["half", "Half", "Other"], // artist differs from member `halfM`
      ["halfM", "Half", "Art"],
      ["elsewhere", "Elsewhere", "Art"], // its identity is a member of Q2 only
      ["elseM", "Elsewhere", "Art"],
      ["miss", "Miss", "Art"],
      ["many", "Many", "Art"],
      ["many2", "many", "ART"],
      ["many3", "MANY", "art"],
    ]);
    const c = await rawClient();
    const members: [string, number, string][] = [
      ["Q", 0, "own"],
      ["Q", 1, "twinM"],
      ["Q", 2, "halfM"],
      ["Q", 3, "ghost"], // member with no tracks row
      ["Q", 4, "many2"],
      ["Q", 5, "many3"],
      ["Q2", 0, "elseM"],
    ];
    await c.batch(
      members.map(([pid, pos, tid]) => ({
        sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)",
        args: [pid, pos, tid],
      })),
      "write",
    );
    const Q = "spotify:playlist:Q";
    await seedPlays([
      ["own", Q, null], // own row is a member → 0
      ["twin", Q, null], // another id with its identity is a member → 0
      ["half", Q, null], // name matches, artist does not → 1
      ["elsewhere", Q, null], // identity is a member of a different playlist only → 1
      ["miss", Q, null], // no match → 1
      ["notrack", Q, null], // the play's track has no tracks row → 1
      ["many", Q, null], // several identity matches → 0
      ["own", "spotify:playlist:Uncached", null], // playlist not cached → 0
      ["miss", null, null], // no context → 0
    ]);
    // A non-playlist context naming a cached id still reads as non-orphan.
    await c.execute(
      `INSERT INTO plays (track_id, played_at, context_type, context_uri) VALUES ('miss', '2026-10-01T01:00:00Z', 'album', '${Q}')`,
    );
    const res = await c.execute(
      `SELECT (${OLD_PREDICATE}) AS old, (${ORPHAN_PREDICATE}) AS new FROM plays p ORDER BY p.id`,
    );
    const got = res.rows.map((r) => [Number(r.old), Number(r.new)]);
    const known = [0, 0, 1, 1, 1, 1, 0, 0, 0, 0];
    expect(got).toEqual(known.map((v) => [v, v]));
  });

  it("starts from the song: own row, identity index, then memberships by track", async () => {
    await rawClient(); // the schema
    // Its own client, closed after: an EXPLAIN through the shared one left the file locked, and
    // the next test's resetStore failed with SQLITE_BUSY (lane 1911).
    const c = createClient({ url: process.env.TURSO_DATABASE_URL as string, intMode: "number" });
    const plan = await c.execute(`EXPLAIN QUERY PLAN SELECT (${ORPHAN_PREDICATE}) FROM plays p`);
    c.close();
    const detail = plan.rows.map((r) => String(r.detail)).join("\n");
    expect(detail).toMatch(/SEARCH me USING (INDEX sqlite_autoindex_tracks_1|PRIMARY KEY) \(id=\?\)/);
    expect(detail).toMatch(/SEARCH tm USING INDEX idx_tracks_artist_name/);
    expect(detail).toMatch(/SEARCH plm USING INDEX idx_pltracks_track \(track_id=\?\)/);
  });
});

// Lane 1911's attack list (the review brief): each write that can touch a verdict input, and the
// two scope chunk boundaries. Every step is checked as scoped == full on every play.
describe("review (lane 1911): the attack list", () => {
  beforeEach(async () => {
    await resetStore();
    sent.length = 0;
  });

  async function seedMembers(rows: [playlistId: string, position: number, trackId: string][]) {
    const c = await rawClient();
    await c.batch(
      rows.map(([pid, pos, tid]) => ({
        sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)",
        args: [pid, pos, tid],
      })),
      "write",
    );
  }

  it("a reorder-only rewrite purges nothing and issues no pass", async () => {
    await store().storePlaylists([pl("A"), pl("B")], "me");
    await store().storePlaylistTracks("A", [track("a1")]);
    await store().storePlaylistTracks("B", [track("b1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([
      ["a1", "spotify:playlist:A", null],
      ["z9", "spotify:playlist:B", null],
    ]);
    await ruleAll();
    sent.length = 0;

    await store().storePlaylists([pl("B"), pl("A")], "me");

    expect(orphanPasses()).toEqual([]);
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1]);
    await expectScopedEqualsFull();
  });

  it("an emptied playlist: its plays become unverifiable, so 0", async () => {
    await store().storePlaylists([pl("P")], "me");
    await store().storePlaylistTracks("P", [track("t1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([
      ["t1", "spotify:playlist:P", null],
      ["z9", "spotify:playlist:P", null],
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1]);

    await store().storePlaylistTracks("P", []);

    expect((await flags()).map((r) => r.stored)).toEqual([0, 0]);
    await expectScopedEqualsFull();
  });

  it("removed, then re-added under the same id, then re-cached: back to the first verdicts", async () => {
    await store().storePlaylists([pl("A"), pl("B")], "me");
    await store().storePlaylistTracks("A", [track("a1")]);
    await store().storePlaylistTracks("B", [track("b1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([
      ["b1", "spotify:playlist:B", null],
      ["z9", "spotify:playlist:B", null],
      ["z9", "spotify:playlist:A", null],
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1, 1]);

    await store().storePlaylists([pl("A")], "me"); // unfollowed: B's rows purged
    expect((await flags()).map((r) => r.stored)).toEqual([0, 0, 1]);
    await expectScopedEqualsFull();

    sent.length = 0;
    await store().storePlaylists([pl("A"), pl("B")], "me"); // followed again: nothing to purge
    expect(orphanPasses()).toEqual([]);
    await expectScopedEqualsFull();

    await store().storePlaylistTracks("B", [track("b1")]); // its tracks fetched again
    expect((await flags()).map((r) => r.stored)).toEqual([0, 1, 1]);
    await expectScopedEqualsFull();
  });

  it("a play naming a playlist never cached stays 0 through other writes, and is ruled once cached", async () => {
    await store().storePlaylists([pl("A"), pl("U")], "me");
    await store().storePlaylistTracks("A", [track("a1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([["z9", "spotify:playlist:U", null]]);
    await ruleAll();
    await store().storePlaylists([pl("A")], "me"); // U leaves the list; it had no rows to purge
    await store().storePlaylistTracks("A", [track("a1"), track("a2")]);
    expect((await flags()).map((r) => r.stored)).toEqual([0]);
    await expectScopedEqualsFull();

    await store().storePlaylistTracks("U", [track("a1")]); // opened by URL
    expect((await flags()).map((r) => r.stored)).toEqual([1]);
    await expectScopedEqualsFull();
  });

  it("deletePlaylistFromDb re-rules that playlist's plays", async () => {
    await store().storePlaylists([pl("D"), pl("K")], "me");
    await store().storePlaylistTracks("D", [track("d1")]);
    await store().storePlaylistTracks("K", [track("k1")]);
    await seedTracks([["z9", "Song z9", "Artist z9"]]);
    await seedPlays([
      ["z9", "spotify:playlist:D", null],
      ["z9", "spotify:playlist:K", null],
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([1, 1]);

    await store().deletePlaylistFromDb("D");

    expect((await flags()).map((r) => r.stored)).toEqual([0, 1]);
    await expectScopedEqualsFull();
  });

  it("a purge wider than one scope chunk (105 playlists) re-rules every one of them", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `P${String(i).padStart(3, "0")}`);
    await store().storePlaylists(ids.map((id) => pl(id)), "me");
    await seedTracks([
      ...ids.map((id): [string, string, string] => [`m${id}`, `Song m${id}`, "Art"]),
      ["z9", "Song z9", "Artist z9"],
    ]);
    await seedMembers(ids.map((id): [string, number, string] => [id, 0, `m${id}`]));
    await seedPlays(ids.map((id): [string, string, null] => ["z9", `spotify:playlist:${id}`, null]));
    await ruleAll();
    expect((await flags()).every((r) => r.stored === 1)).toBe(true);
    sent.length = 0;

    await store().storePlaylists([], "me"); // unfollow everything

    expect(orphanPasses()).toHaveLength(2);
    expect((await flags()).every((r) => r.stored === 0)).toBe(true);
    await expectScopedEqualsFull();
  });

  it("renames wider than one identity chunk (51 tracks, 102 identities) re-rule both halves of each", async () => {
    const n = 51;
    const ix = Array.from({ length: n }, (_, i) => i);
    await seedTracks([
      ...ix.map((i): [string, string, string] => [`r${i}`, `Old ${i}`, "Art"]),
      ...ix.map((i): [string, string, string] => [`z${i}`, `old ${i}`, "ART"]), // r's old identity
      ...ix.map((i): [string, string, string] => [`y${i}`, `New ${i}`, "Art"]), // r's new identity
    ]);
    await seedMembers(ix.map((i): [string, number, string] => ["Q", i, `r${i}`]));
    const Q = "spotify:playlist:Q";
    await seedPlays([
      ...ix.map((i): [string, string, null] => [`z${i}`, Q, null]),
      ...ix.map((i): [string, string, null] => [`y${i}`, Q, null]),
    ]);
    await ruleAll();
    expect((await flags()).map((r) => r.stored)).toEqual([...ix.map(() => 0), ...ix.map(() => 1)]);
    sent.length = 0;

    await store().storeSavedTracks(ix.map((i) => track(`r${i}`, { title: `New ${i}`, artist: "Art" })));

    expect(orphanPasses()).toHaveLength(2);
    expect((await flags()).map((r) => r.stored)).toEqual([...ix.map(() => 1), ...ix.map(() => 0)]);
    await expectScopedEqualsFull();
  });
});

// The same pass through forUser on per-user databases (PLAN §6.2 layer 3, PHASE1.md §7): A and B
// cache the same playlist ids with the same members and play the same songs from them; B
// unfollows one. Only B's plays are re-ruled, B's stored flags equal the full pass over B's own
// file, A's file is byte for byte what it was, and the ledger charges the pass at B's size.
describe("on a per-user store: one user's library change", () => {
  const ledgerRows = async (reader: string) => {
    const c = await rawClient(); // telemetry shares the owner's file in the tests
    const res = await c.execute({ sql: "SELECT calls, modeled_rows FROM usage_ledger WHERE reader = ?", args: [reader] });
    return res.rows.map((r) => ({ calls: Number(r.calls), rows: Number(r.modeled_rows) }));
  };
  // The charge is fire-and-forget (ledgerAddLinear): wait for the row to move.
  const total = async (reader: string) =>
    (await ledgerRows(reader)).reduce((t, r) => ({ calls: t.calls + r.calls, rows: t.rows + r.rows }), { calls: 0, rows: 0 });
  const untilMoved = async (reader: string, from: { calls: number }) => {
    for (let i = 0; i < 100 && (await total(reader)).calls === from.calls; i++) await new Promise((r) => setTimeout(r, 20));
    return total(reader);
  };

  it("re-rules that user's plays only, scoped equals full on their file, and charges their own size", async () => {
    await resetStore();
    useUserFiles();
    const a = forUserAt(A, "lb-u-a");
    const b = forUserAt(B, "lb-u-b");
    const P = "spotify:playlist:P";
    const K = "spotify:playlist:K";
    // A plays more than B, so a pass charged at the wrong user's size reads differently.
    const playsOf = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        // Five minutes apart, so no play is a skip and the all-time count is n.
        play(i % 2 ? "z9" : "p1", new Date(Date.UTC(2026, 9, 1) + i * 300_000).toISOString(), 200_000, {
          contextType: "playlist",
          contextUri: i % 3 ? P : K,
        }),
      );
    for (const [st, n] of [[a, 40], [b, 6]] as const) {
      await st.recordPlays(playsOf(n));
      await st.recomputeAllTimeStats();
      await st.storePlaylists([pl("P"), pl("K")], "me");
      await st.storePlaylistTracks("P", [track("p1")]);
      await st.storePlaylistTracks("K", [track("k1")]);
    }
    const url = (db: string) => (process.env.STORE_URL_TEMPLATE as string).replaceAll("{db}", db);
    const cb = createClient({ url: url("lb-u-b"), intMode: "number" });
    try {
      // z9 is in neither playlist: its plays from both are orphans, for both users.
      expect((await flags(cb)).filter((r) => r.stored === 1).length).toBeGreaterThan(0);
      const aBefore = await dumpDb("lb-u-a");
      const charged = await total("orphan_purge_pass");
      const full = await total("orphan_full_pass");
      sent.length = 0;

      await b.storePlaylists([pl("K")], "me"); // B unfollows P: P's cached rows are purged

      expect(orphanPasses()).toHaveLength(1);
      expect(orphanPasses()[0]).toMatch(/p\.context_uri IN \(\?\)/);
      // B's plays from P are unverifiable now (0); B's plays from K keep their verdict.
      const bRows = await flags(cb);
      expect(bRows.filter((r) => r.key.endsWith(`@${P}`)).every((r) => r.stored === 0)).toBe(true);
      expect(bRows.filter((r) => r.key === `z9@${K}`).every((r) => r.stored === 1)).toBe(true);
      await expectScopedEqualsFull(cb);
      expect(await dumpDb("lb-u-a")).toBe(aBefore);

      // The ledger line for the pass that ran, at B's size: B's 6 plays over B's 2 playlists
      // before the rewrite, one purged (read-costs.ts orphanPurgePassRows).
      expect(await untilMoved("orphan_purge_pass", charged)).toEqual({
        calls: charged.calls + 1,
        rows: charged.rows + Math.round(orphanPurgePassRows(1, 6, 2)),
      });
      expect(await total("orphan_full_pass")).toEqual(full);

      // A rename-only rewrite purges nothing: no pass, and no second charge.
      sent.length = 0;
      await b.storePlaylists([pl("K", "renamed")], "me");
      expect(orphanPasses()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 50));
      expect((await total("orphan_purge_pass")).calls).toBe(charged.calls + 1);
    } finally {
      cb.close();
    }
  });
});
