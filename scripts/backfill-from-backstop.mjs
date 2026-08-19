// Backfill plays from the Zenbook backstop recorder into the primary store.
//
// The recorder (~/lazyboy-recorder on the Zenbook, lazyboy-recorder.timer) captures
// Spotify recently-played every 15 minutes into its own SQLite file, independently of
// Turso — so a window where the primary was blocked or unreachable is repairable instead
// of a permanent hole. This script replays that capture into the primary, inserting only
// what is missing.
//
// Usage:
//   ssh ubuntu 'python3 -c "import sqlite3,json;\
//     [print(r[0]) for r in sqlite3.connect(\"/home/remtbkv/lazyboy-recorder/backstop.db\")\
//     .execute(\"SELECT raw FROM plays\")]"' > /tmp/backstop.jsonl
//   node --env-file=.env.local scripts/backfill-from-backstop.mjs /tmp/backstop.jsonl
//
// Field mapping mirrors normTrack() in src/lib/spotify/resources.ts exactly (first
// artist only, middle album image, skip local/episode/artist-less tracks) so a
// backfilled row is byte-identical to what the sync would have written.
//
// Backfilled plays get ctx_orphan = NULL, which renders as non-orphan until the next
// orphan recompute gives them a real verdict — same as any play recorded before its
// playlist was cached. Home reads a materialized payload (meta.home_payload, db.ts) that
// this script does not write; the next sync tick that lands a play rebuilds it, so
// backfilled days appear on Home then rather than immediately.
//
// Pass --db <path-or-url> to target a scratch copy instead of the primary (how the
// known-answer test below is run):
//   node scripts/backfill-from-backstop.mjs /tmp/backstop.jsonl --db file:/tmp/scratch.db
import fs from "node:fs";
import { createClient } from "@libsql/client";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const dbUrl = dbFlag >= 0 ? args[dbFlag + 1] : process.env.TURSO_DATABASE_URL;
const input = args.find((a) => !a.startsWith("--") && a !== dbUrl);
if (!input || !dbUrl) {
  console.error("usage: backfill-from-backstop.mjs <backstop.jsonl> [--db <url>]");
  process.exit(2);
}

const client = createClient({
  url: dbUrl,
  authToken: dbUrl.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN,
  intMode: "number",
});

// Mirror of normTrack() in src/lib/spotify/resources.ts.
function normTrack(raw) {
  if (!raw || !raw.id || raw.is_local || raw.type === "episode") return null;
  const artist = raw.artists?.[0]?.name;
  if (!artist) return null;
  const images = raw.album?.images ?? [];
  return {
    id: raw.id,
    artist,
    title: raw.name,
    uri: raw.uri,
    album: raw.album?.name ?? null,
    albumImage: images[1]?.url ?? images[0]?.url ?? null,
    durationMs: raw.duration_ms ?? null,
  };
}

const items = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const existing = new Set(
  (
    await client.execute("SELECT track_id AS t, played_at AS p FROM plays")
  ).rows.map((r) => `${r.t}\n${r.p}`),
);

let inserted = 0;
const stmts = [];
const queuedTracks = new Set();
for (const it of items) {
  const t = normTrack(it.track);
  if (!t) continue;
  if (existing.has(`${t.id}\n${it.played_at}`)) continue;
  existing.add(`${t.id}\n${it.played_at}`);
  // OR IGNORE on tracks: never clobber a row the app may have enriched since.
  if (!queuedTracks.has(t.id)) {
    queuedTracks.add(t.id);
    stmts.push({
      sql: `INSERT OR IGNORE INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
            VALUES (?,?,?,?,?,?,?)`,
      args: [t.id, t.title, t.artist, t.uri, t.album, t.albumImage, t.durationMs],
    });
  }
  stmts.push({
    sql: `INSERT OR IGNORE INTO plays (track_id, played_at, context_type, context_uri)
          VALUES (?,?,?,?)`,
    args: [t.id, it.played_at, it.context?.type ?? null, it.context?.uri ?? null],
  });
  inserted++;
}

if (inserted > 0) {
  // The row immediately before the replayed window was skip-verdicted against a successor
  // that is no longer adjacent — re-open that one verdict so the next sync's recompute rules
  // it against the true neighbour (mirrors recordPlays' out-of-order reset, db.ts).
  const oldest = items.reduce((m, it) => (it.played_at < m ? it.played_at : m), items[0].played_at);
  stmts.push({
    sql: `UPDATE plays SET skipped = NULL WHERE id = (
            SELECT id FROM plays
            WHERE played_at < ? AND (context_type IS NULL OR context_type <> 'backfill')
            ORDER BY played_at DESC LIMIT 1)`,
    args: [oldest],
  });
  // One announcement for the whole batch — `plays` feeds cached reads and the client-side
  // history payload, and this bump is what invalidates both (same rule as every write in
  // db.ts; the day caches carry the marker in their keys, frozen days included).
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES ('write_seq', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`,
    args: [],
  });
  await client.batch(stmts, "write");
}
console.log(`backfill: ${items.length} captured, ${inserted} inserted (rest already present)`);
client.close();
