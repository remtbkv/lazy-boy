// One-shot import of the "Scan" folder's playlists as BACKFILL plays (Rem, 2026-08-15).
//
// The Scan folder = every playlist named "Cleaned: …", every artist "… - others", plus
// "test". Rem is about to delete them; their songs are his pre-tracking listening. This
// script (run with `node --env-file=.env.local scripts/backfill-scan.mjs [--run]`):
//
//   1. BACKS UP every member as "track \t artist \t id" per playlist under
//      ~/Downloads/lazyboy-scan-backup/ (the recreate-it-later record).
//   2. Inserts ONE play per unique track that has never been played, with
//      played_at = 2026-05-30T00:00:00.000Z (the sentinel day before tracking began)
//      and context_type = 'backfill'. db.ts's NOT_BACKFILL filter keeps these out of
//      every listening counter; search/history includes them, labeled "backfill".
//      INSERT OR IGNORE + the constant sentinel make the whole run idempotent.
//   3. Bumps write_seq and drops the home payload so caches/payloads rebuild.
//
// Without --run it reports what it WOULD insert (the backup files are always written).
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const RUN = process.argv.includes("--run");
const SENTINEL = "2026-05-30T00:00:00.000Z";
const BACKUP_DIR = path.join(homedir(), "Downloads", "lazyboy-scan-backup");

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("TURSO_DATABASE_URL missing — run with --env-file=.env.local");
const db = createClient({ url, authToken });

// ── The Scan folder, by name (Spotify's API doesn't expose folders) ──────────────────
const pls = (await db.execute("SELECT id, name FROM playlists ORDER BY name")).rows;
const scan = pls.filter(
  (p) =>
    (/^clean/i.test(p.name) && p.name.includes(":")) ||
    /others\s*$/i.test(p.name) ||
    p.name.trim().toLowerCase() === "test",
);
console.log(`Scan playlists matched: ${scan.length} (expect 70)`);
if (scan.length !== 70) {
  console.log(scan.map((p) => p.name).join("\n"));
  throw new Error("playlist match count changed — re-check the patterns before running");
}

// ── Members, per playlist ────────────────────────────────────────────────────────────
const members = new Map(); // playlist name -> rows
const uniq = new Map(); // track_id -> {name, artist}
for (const p of scan) {
  const res = await db.execute({
    sql: `SELECT pt.track_id AS id, COALESCE(t.name,'?') AS name, COALESCE(t.artist,'?') AS artist
          FROM playlist_tracks pt LEFT JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = ? ORDER BY pt.position`,
    args: [p.id],
  });
  members.set(p.name, res.rows);
  for (const r of res.rows) if (!uniq.has(r.id)) uniq.set(r.id, r);
}

// ── Backups (always) ─────────────────────────────────────────────────────────────────
mkdirSync(BACKUP_DIR, { recursive: true });
let manifest = `Scan-folder backup — ${new Date().toISOString()}\nFormat per line: track\\tartist\\tspotify_track_id\n\n`;
for (const [name, rows] of members) {
  const safe = name.replace(/[/\\:]/g, "_").slice(0, 120);
  const body = rows.map((r) => `${r.name}\t${r.artist}\t${r.id}`).join("\n") + "\n";
  writeFileSync(path.join(BACKUP_DIR, `${safe}.txt`), body);
  manifest += `${rows.length}\t${name}\n`;
}
manifest += `\n${uniq.size} unique tracks across ${scan.length} playlists\n`;
writeFileSync(path.join(BACKUP_DIR, "MANIFEST.txt"), manifest);
console.log(`Backed up ${uniq.size} unique tracks (${scan.length} files) → ${BACKUP_DIR}`);

// ── Which already have plays? ────────────────────────────────────────────────────────
const ids = [...uniq.keys()];
const played = new Set();
for (let i = 0; i < ids.length; i += 400) {
  const chunk = ids.slice(i, i + 400);
  const res = await db.execute({
    sql: `SELECT DISTINCT track_id FROM plays WHERE track_id IN (${chunk.map(() => "?").join(",")})`,
    args: chunk,
  });
  for (const r of res.rows) played.add(r.track_id);
}
const toInsert = ids.filter((id) => !played.has(id));
console.log(`${played.size} already have plays; ${toInsert.length} to backfill`);

if (!RUN) {
  console.log("DRY RUN — no inserts. Re-run with --run to write.");
  process.exit(0);
}

// ── Insert (idempotent) + wake the caches ────────────────────────────────────────────
let inserted = 0;
for (let i = 0; i < toInsert.length; i += 200) {
  const chunk = toInsert.slice(i, i + 200);
  const res = await db.batch(
    chunk.map((id) => ({
      sql: `INSERT OR IGNORE INTO plays (track_id, played_at, context_type, context_uri, ctx_orphan)
            VALUES (?, ?, 'backfill', NULL, 0)`,
      args: [id, SENTINEL],
    })),
    "write",
  );
  inserted += res.reduce((n, r) => n + (r.rowsAffected ?? 0), 0);
}
// write_seq bump = every cached read/payload/ETag revalidates; dropping home_payload makes
// the next /home load rebuild it (readHomeInline kicks rebuildHomePayload).
await db.execute(
  "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'write_seq'",
);
await db.execute("DELETE FROM meta WHERE key = 'home_payload'");
console.log(`Inserted ${inserted} backfill plays at ${SENTINEL}; write_seq bumped, payload dropped.`);
