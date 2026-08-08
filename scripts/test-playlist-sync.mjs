// Known-answer tests for the playlist-list sync's THREE-TIER write path.
//
//   node scripts/test-playlist-sync.mjs
//
// What is under test, and why it is worth a script of its own: `storePlaylists` used to be a
// two-way decision — the cached list matches exactly, or rewrite the whole thing — and 156 of
// 180 stored playlists carry a rotating `mosaic.scdn.co` artwork URL, so "matches exactly"
// failed nearly every hour. The full branch then billed ~640 rows_written for a delete-all +
// reinsert and ~2.5M rows_read for the unscoped `recomputeOrphanFlags()` that followed it,
// every hour, for weeks (docs/quota-forensic/PREREG.md, "The burst decomposition"). The tiers
// and the orphan-pass gate are what stop that, so both need known answers.
//
// Verified the same way as scripts/test-ledger.mjs, and split the same way:
//
//   • The DECISIONS — `diffPlaylistList` (which tier) and `needsFullOrphanPass` (does the
//     expensive pass run) — are imported from src/lib/store-diff.ts, so what is tested is
//     exactly what ships. That file is dependency-free for this reason; keep it that way.
//   • The STATEMENTS cannot be imported (src/lib/db.ts pulls in `server-only`, `next/cache`
//     and React), so the SQL below is a COPY carrying the same obligation as the copies in
//     test-ledger.mjs and verify-derived.mjs: it MUST MATCH db.ts. A divergence is caught by
//     nothing, which is why the copies stay literal.
//
// Every assertion reads the DATABASE, never a return value: the point is the billed side
// effect — which rows were written, whether the marker moved, whether the purge fired,
// whether the orphan pass ran — and a function can return the right thing while writing the
// wrong rows. The witness for delete-all-vs-update is the `position` column: the seed stores
// NON-CONTIGUOUS positions (5, 9, 12), which the reinsert renumbers to 0, 1, 2 and a
// per-row image UPDATE cannot touch. (`rowid` cannot do this job — SQLite hands the
// reinserted rows the same 1, 2, 3 the delete-all just freed.)
//
// Runs against a THROWAWAY file DB in the OS temp dir, created and deleted per run. It never
// opens data/listens.db or data/replica.db — the replica is live and the prod primary is
// quota-blocked, so no test may touch either.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffPlaylistList, needsFullOrphanPass } from "../src/lib/store-diff.ts";

// ── MUST MATCH src/lib/db.ts ───────────────────────────────────────────────────────────
// The schema this path touches (db.ts init(), plus the ctx_orphan column its migration adds).
const SCHEMA = `
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL, uri TEXT NOT NULL,
    album TEXT, album_image TEXT, duration_ms INTEGER
  );
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, played_at TEXT NOT NULL,
    context_type TEXT, context_uri TEXT, ctx_orphan INTEGER, UNIQUE (track_id, played_at)
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE playlists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT, image TEXT,
    track_count INTEGER, position INTEGER
  );
  CREATE TABLE playlist_tracks (
    playlist_id TEXT NOT NULL, position INTEGER NOT NULL, track_id TEXT NOT NULL,
    added_at TEXT, PRIMARY KEY (playlist_id, position)
  );`;

// db.ts storePlaylists() — the change-probe read.
const PROBE_SQL =
  "SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount FROM playlists ORDER BY position";

// db.ts storePlaylists() — the image-only tier's whole write.
const IMAGE_UPDATE_SQL = "UPDATE playlists SET image = :image WHERE id = :id";

// db.ts storePlaylists() — the rewrite tier.
const DELETE_ALL_SQL = "DELETE FROM playlists";
const INSERT_SQL = `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
            VALUES (:id, :name, :ownerId, :image, :trackCount, :position)`;
const PURGE_SQL = "DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists)";
const PLSNAP_PURGE_SQL = `DELETE FROM meta WHERE key LIKE 'plsnap:%'
          AND substr(key, 8) NOT IN (SELECT id FROM playlists)`;
const PLTRACKS_AT_PURGE_SQL = `DELETE FROM meta WHERE key LIKE 'pltracks_at:%'
          AND substr(key, 13) NOT IN (SELECT id FROM playlists)`;

// db.ts storePlaylists() — the stamps (meta only; not replica-served, so not marker-relevant).
const SYNCED_AT_SQL = `INSERT INTO meta (key, value) VALUES ('playlists_synced_at', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
const ME_ID_SQL = `INSERT INTO meta (key, value) VALUES ('me_id', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
const SET_META_SQL =
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

// db.ts writeSeqStmt() / librarySeqStmt().
const WRITE_SEQ_SQL = `INSERT INTO meta (key, value) VALUES ('write_seq', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`;
const LIBRARY_SEQ_SQL = `INSERT INTO meta (key, value) VALUES ('library_seq', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`;

// db.ts ORPHAN_PREDICATE + recomputeOrphanFlags({}) — the unscoped pass, the ~2.5M term.
const ORPHAN_PREDICATE = `
  CASE WHEN p.context_type = 'playlist' AND p.context_uri IS NOT NULL
            AND EXISTS (SELECT 1 FROM playlist_tracks pl
                        WHERE pl.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
            AND NOT EXISTS (
              SELECT 1 FROM playlist_tracks plm JOIN tracks tm ON tm.id = plm.track_id
              WHERE plm.playlist_id = replace(p.context_uri, 'spotify:playlist:', '')
                AND lower(tm.artist) = (SELECT lower(artist) FROM tracks WHERE id = p.track_id)
                AND lower(tm.name) = (SELECT lower(name) FROM tracks WHERE id = p.track_id))
       THEN 1 ELSE 0 END`;
const ORPHAN_FULL_SQL = `UPDATE plays AS p SET ctx_orphan = (${ORPHAN_PREDICATE})
  WHERE (p.ctx_orphan IS NULL OR p.ctx_orphan <> (${ORPHAN_PREDICATE}))`;

// ── the path under test, assembled from the imported decisions + the copied SQL ─────────
async function storePlaylists(client, rows, meId) {
  const now = new Date().toISOString();
  const cached = (await client.execute(PROBE_SQL)).rows.map((r) => ({ ...r }));
  const diff = diffPlaylistList(rows, cached);

  if (diff.tier === "unchanged") {
    await client.execute({ sql: SET_META_SQL, args: ["playlists_synced_at", now] });
    if (meId) await client.execute({ sql: SET_META_SQL, args: ["me_id", meId] });
    return { diff, fullPass: false, purged: 0 };
  }

  const stamps = [{ sql: SYNCED_AT_SQL, args: { v: now } }];
  if (meId) stamps.push({ sql: ME_ID_SQL, args: { v: meId } });

  if (diff.tier === "image-only") {
    const stmts = diff.imageChanges.map((c) => ({
      sql: IMAGE_UPDATE_SQL,
      args: { image: c.image, id: c.id },
    }));
    stmts.push(...stamps, { sql: WRITE_SEQ_SQL, args: [] });
    await client.batch(stmts, "write");
    return { diff, fullPass: false, purged: 0 };
  }

  const stmts = [{ sql: DELETE_ALL_SQL, args: [] }];
  rows.forEach((r, i) =>
    stmts.push({
      sql: INSERT_SQL,
      args: {
        id: r.id,
        name: r.name,
        ownerId: r.ownerId,
        image: r.image,
        trackCount: r.trackCount,
        position: i,
      },
    }),
  );
  const purgeAt = stmts.length;
  stmts.push({ sql: PURGE_SQL, args: [] });
  stmts.push({ sql: PLSNAP_PURGE_SQL, args: [] });
  stmts.push({ sql: PLTRACKS_AT_PURGE_SQL, args: [] });
  stmts.push(...stamps);
  stmts.push({ sql: WRITE_SEQ_SQL, args: [] }, { sql: LIBRARY_SEQ_SQL, args: [] });
  const results = await client.batch(stmts, "write");
  const purged = Number(results[purgeAt]?.rowsAffected ?? 0);
  const fullPass = needsFullOrphanPass(diff.idSetChanged, purged);
  if (fullPass) await client.execute(ORPHAN_FULL_SQL);
  return { diff, fullPass, purged };
}

// ── harness ───────────────────────────────────────────────────────────────────────────
let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lazyboy-playlists-"));
const dbPath = path.join(tmpDir, "playlist-sync-test.db");
// Guard the guard: a bug in the path above must not be able to open the real store.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (dbPath.startsWith(repo)) throw new Error(`refusing to test against a repo path: ${dbPath}`);

const client = createClient({ url: `file:${dbPath}`, intMode: "number" });

// The cached list: three playlists, two of them carrying mosaic artwork.
const P1 = { id: "p1", name: "Runs", ownerId: "me", image: "https://mosaic.scdn.co/a1", trackCount: 12 };
const P2 = { id: "p2", name: "Focus", ownerId: "me", image: "https://mosaic.scdn.co/a2", trackCount: 3 };
const P3 = { id: "p3", name: "Shared", ownerId: "friend", image: null, trackCount: 7 };
const BASE = [P1, P2, P3];
const SEED_POSITIONS = [5, 9, 12];

/** Reset to a known store. `staleMembership` seeds a playlist_tracks row for a playlist that
 *  is NOT in the list — a leftover the purge is supposed to bite on, and the only way a
 *  rewrite with an unchanged id set can still have moved membership.
 *
 *  The seeded play is the orphan-pass witness: it played track t2 from playlist p1, whose
 *  cached membership is {t1}, so its TRUE verdict is 1 (orphan) — but it is stored as 0. The
 *  unscoped pass is the only thing in this path that would fix it, so `ctx_orphan` after the
 *  call says whether the pass ran, without trusting anything the code reports. */
async function seed({ staleMembership = false } = {}) {
  await client.executeMultiple(
    "DELETE FROM playlists; DELETE FROM playlist_tracks; DELETE FROM tracks; DELETE FROM plays; DELETE FROM meta;",
  );
  const stmts = [
    { sql: "INSERT INTO tracks (id, name, artist, uri) VALUES ('t1', 'Song A', 'Artist A', 'spotify:track:t1')", args: [] },
    { sql: "INSERT INTO tracks (id, name, artist, uri) VALUES ('t2', 'Song B', 'Artist B', 'spotify:track:t2')", args: [] },
    { sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('p1', 0, 't1')", args: [] },
    { sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('p2', 0, 't1')", args: [] },
    {
      sql: `INSERT INTO plays (track_id, played_at, context_type, context_uri, ctx_orphan)
            VALUES ('t2', '2026-08-07T12:15:00Z', 'playlist', 'spotify:playlist:p1', 0)`,
      args: [],
    },
    { sql: SET_META_SQL, args: ["write_seq", "5"] },
    { sql: SET_META_SQL, args: ["library_seq", "3"] },
  ];
  if (staleMembership) {
    stmts.splice(4, 0, {
      sql: "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('gone', 0, 't1')",
      args: [],
    });
  }
  // Non-contiguous positions on purpose — see the witness note in the header.
  BASE.forEach((p, i) =>
    stmts.push({
      sql: INSERT_SQL,
      args: { ...p, position: SEED_POSITIONS[i] },
    }),
  );
  await client.batch(stmts, "write");
}

const one = async (sql, args = []) => (await client.execute({ sql, args })).rows[0];
const all = async (sql, args = []) => (await client.execute({ sql, args })).rows.map((r) => ({ ...r }));
const meta = async (key) => (await one("SELECT value FROM meta WHERE key = ?", [key]))?.value ?? null;
const orphanFlag = async () => Number((await one("SELECT ctx_orphan AS f FROM plays")).f);
const listRows = () =>
  all("SELECT id, image, position, track_count AS trackCount FROM playlists ORDER BY position");
const memberships = () =>
  all("SELECT playlist_id AS pid, track_id AS tid FROM playlist_tracks ORDER BY playlist_id, position");

try {
  await client.executeMultiple(SCHEMA);

  // ── tier 1: the list is identical → stamps only ──────────────────────────────────────
  console.log("identical list");
  await seed();
  const before1 = await listRows();
  const r1 = await storePlaylists(client, BASE, "me");
  check("tier is unchanged", r1.diff.tier, "unchanged");
  check("nothing to report in the diff line", r1.diff.firstDiff, null);
  check("the playlist rows are untouched, stored positions included", await listRows(), before1);
  check("write_seq does NOT move", await meta("write_seq"), "5");
  check("library_seq does NOT move", await meta("library_seq"), "3");
  check("the synced-at stamp is written", (await meta("playlists_synced_at")) !== null, true);
  check("me_id is written", await meta("me_id"), "me");
  check("no orphan pass: the stale flag survives", await orphanFlag(), 0);

  // ── tier 2: only artwork rotated → per-row UPDATEs, no rewrite, no purge, no pass ────
  console.log("\nimage-only change (the hourly mosaic rotation)");
  await seed({ staleMembership: true });
  const before2 = await listRows();
  const rotated = [{ ...P1, image: "https://mosaic.scdn.co/a1-rotated" }, P2, P3];
  const r2 = await storePlaylists(client, rotated, "me");
  check("tier is image-only", r2.diff.tier, "image-only");
  check("only the rotated row is listed as changed", r2.diff.imageChanges, [
    { id: "p1", image: "https://mosaic.scdn.co/a1-rotated" },
  ]);
  check("the diff line names the field that actually moved", r2.diff.firstDiff, {
    playlistId: "p1",
    field: "image",
    cached: "https://mosaic.scdn.co/a1",
    incoming: "https://mosaic.scdn.co/a1-rotated",
  });
  check("the id set did not move", r2.diff.idSetChanged, false);
  const after2 = await listRows();
  check("exactly the changed image is written", after2.map((r) => r.image), [
    "https://mosaic.scdn.co/a1-rotated",
    "https://mosaic.scdn.co/a2",
    null,
  ]);
  check("no delete-all + reinsert: the stored positions are not renumbered", after2.map((r) => r.position), SEED_POSITIONS);
  check("counts are untouched", after2.map((r) => r.trackCount), before2.map((r) => r.trackCount));
  check("write_seq DOES move (playlists is replica-served)", await meta("write_seq"), "6");
  check("library_seq does NOT move (the payload has no playlist art)", await meta("library_seq"), "3");
  check("no purge: even the stale membership survives", (await memberships()).length, 3);
  check("no orphan pass: the stale flag survives", await orphanFlag(), 0);

  // ── tier 3a: the id set moved → rewrite + purge + the full pass ──────────────────────
  console.log("\nid-set change (a playlist disappeared)");
  await seed();
  const r3 = await storePlaylists(client, [P1, P3], "me");
  check("tier is rewrite", r3.diff.tier, "rewrite");
  check("the id set moved", r3.diff.idSetChanged, true);
  const after3 = await listRows();
  check("the list is rewritten to the incoming one", after3.map((r) => [r.id, r.position]), [
    ["p1", 0],
    ["p3", 1],
  ]);
  check("the purge dropped the departed playlist's members", await memberships(), [{ pid: "p1", tid: "t1" }]);
  check("the purge reported the rows it deleted", r3.purged, 1);
  check("write_seq moves", await meta("write_seq"), "6");
  check("library_seq moves", await meta("library_seq"), "4");
  check("the full pass RAN: the stale flag was corrected", await orphanFlag(), 1);

  // ── tier 3b: a rewrite that cannot have moved membership → no full pass ──────────────
  console.log("\nreorder only, same id set");
  await seed();
  const r4 = await storePlaylists(client, [P2, P1, P3], "me");
  check("tier is rewrite", r4.diff.tier, "rewrite");
  check("the diff line names the reorder", r4.diff.firstDiff, {
    playlistId: "p2",
    field: "id",
    cached: "p1",
    incoming: "p2",
  });
  check("the id set did NOT move", r4.diff.idSetChanged, false);
  const after4 = await listRows();
  check("the new order is stored", after4.map((r) => [r.id, r.position]), [
    ["p2", 0],
    ["p1", 1],
    ["p3", 2],
  ]);
  check("write_seq moves", await meta("write_seq"), "6");
  check("library_seq moves", await meta("library_seq"), "4");
  check("the purge deleted nothing", r4.purged, 0);
  check("memberships are untouched", (await memberships()).length, 2);
  check("the full pass did NOT run: the stale flag survives", await orphanFlag(), 0);

  // ── tier 3c: same id set, but the purge bit → the pass runs after all ────────────────
  console.log("\nreorder with a leftover membership the purge bites");
  await seed({ staleMembership: true });
  const r5 = await storePlaylists(client, [P2, P1, P3], "me");
  check("the id set did NOT move", r5.diff.idSetChanged, false);
  check("the purge dropped the leftover", r5.purged, 1);
  check("memberships after the purge", await memberships(), [
    { pid: "p1", tid: "t1" },
    { pid: "p2", tid: "t1" },
  ]);
  check("the full pass RAN anyway: the stale flag was corrected", await orphanFlag(), 1);

  // ── the gate itself, on both sides ───────────────────────────────────────────────────
  console.log("\nneedsFullOrphanPass");
  check("id set moved, purge quiet → runs", needsFullOrphanPass(true, 0), true);
  check("id set stable, purge bit → runs", needsFullOrphanPass(false, 3), true);
  check("neither → skipped", needsFullOrphanPass(false, 0), false);
} finally {
  client.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log("FAIL: the playlist sync does not match its known answers.");
  process.exit(1);
}
process.exit(0);
