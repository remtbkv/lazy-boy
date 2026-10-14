// Refill capture gaps from Spotify's Extended Streaming History export.
//
// Every capture path (the 2-min pinger, the backstop recorder) and the store itself live on
// the Zenbook, so a Zenbook outage loses every play past the API's 50-item recently-played
// window. Three such gaps exist (lazyboy-review D2, 2026-10-03); Spotify's privacy export is
// the only source that still has those plays. Request it at
// https://www.spotify.com/account/privacy/ ("Extended streaming history"); it arrives as a zip
// of Streaming_History_Audio_*.json files.
//
// Usage (dry-run on a snapshot copy first, then against the primary):
//   node scripts/import-extended-history.mjs "<unzipped export dir>" --db file:/tmp/copy.db
//   node --env-file=.env.local scripts/import-extended-history.mjs "<unzipped export dir>"
// Arguments are export files or directories (a directory contributes its
// Streaming_History_Audio_*.json files). `--window <start>/<end>` (repeatable, ISO instants)
// replaces the default gap windows below — add one for any other span neither the store nor
// the recorder captured. Re-running is a no-op. Run it AFTER the C1 fix (skips ruled from
// the previous play) lands, like backfill-from-backstop.mjs.
//
// Mapping:
// - Only rows with a spotify_track_uri (podcast episodes have none) and ms_played >= 30 s,
//   the threshold Spotify's recently-played applies.
// - played_at = `ts` unchanged. The export's ts is when the stream ENDED, and so is the API's
//   played_at the store holds (C1), so no conversion; only the format moves to the API's
//   millisecond form (…T…​.000Z).
// - A row within ±5 s of a stored play of the same track is that play (the export has second
//   resolution, the API milliseconds) and is skipped.
// - Tracks get minimal rows — name/artist/album from master_metadata_*, uri, NULL art and
//   duration — with INSERT OR IGNORE, so a row the app already has is never touched; the next
//   library sync enriches the new ones. context_type/context_uri are NULL (the export has none).
// - The batch closes with import-tail.mjs (verdicts re-opened per run, write_seq bumped,
//   Home's payload dropped for a rebuild).
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { importTailStmts, insertedRuns } from "./import-tail.mjs";

// The gaps neither store captured (journald on the Zenbook, lazyboy-review D2): bounded by
// the last play before each outage and the first play after it.
const DEFAULT_WINDOWS = [
  "2026-08-30T12:01:00Z/2026-09-01T19:09:00Z",
  "2026-09-02T23:02:00Z/2026-09-08T23:02:00Z",
  "2026-09-25T08:11:00Z/2026-09-25T17:01:00Z",
];
const MIN_MS_PLAYED = 30_000;
const SAME_PLAY_MS = 5_000;

const args = process.argv.slice(2);
let dbUrl = process.env.TURSO_DATABASE_URL;
const windowArgs = [];
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db") dbUrl = args[++i];
  else if (args[i] === "--window") windowArgs.push(args[++i]);
  else inputs.push(args[i]);
}
const windows = (windowArgs.length ? windowArgs : DEFAULT_WINDOWS).map((w) => {
  const [start, end] = w.split("/").map((s) => Date.parse(s));
  if (!(start < end)) {
    console.error(`bad --window ${w} (want <start>/<end>, ISO instants)`);
    process.exit(2);
  }
  return { start, end };
});
if (inputs.length === 0 || !dbUrl) {
  console.error(
    "usage: import-extended-history.mjs <export dir or file>... [--window <start>/<end>]... [--db <url>]",
  );
  process.exit(2);
}

const files = inputs.flatMap((p) =>
  fs.statSync(p).isDirectory()
    ? fs
        .readdirSync(p)
        .filter((f) => /^Streaming_History_Audio_.*\.json$/.test(f))
        .sort()
        .map((f) => path.join(p, f))
    : [p],
);
const rows = files.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")));

const inWindow = (ms) => windows.some((w) => ms > w.start && ms < w.end);
const candidates = [];
for (const r of rows) {
  const uri = r.spotify_track_uri;
  if (!uri?.startsWith("spotify:track:") || !(r.ms_played >= MIN_MS_PLAYED)) continue;
  const ms = Date.parse(r.ts);
  if (!inWindow(ms)) continue;
  candidates.push({
    id: uri.slice("spotify:track:".length),
    uri,
    name: r.master_metadata_track_name ?? "",
    artist: r.master_metadata_album_artist_name ?? "",
    album: r.master_metadata_album_album_name ?? null,
    ms,
  });
}

const client = createClient({
  url: dbUrl,
  authToken: dbUrl.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN,
  intMode: "number",
});

// Read only the plays the windows (plus the dedupe margin) can touch, not the whole table.
const lo = new Date(Math.min(...windows.map((w) => w.start)) - SAME_PLAY_MS).toISOString();
const hi = new Date(Math.max(...windows.map((w) => w.end)) + SAME_PLAY_MS).toISOString();
const stored = (
  await client.execute({
    sql: `SELECT track_id AS t, played_at AS p, context_type AS c FROM plays
          WHERE played_at >= ? AND played_at <= ?`,
    args: [lo, hi],
  })
).rows;
const seen = new Map(); // track id → play instants (ms), stored plus queued
const remember = (id, ms) => {
  if (!seen.has(id)) seen.set(id, []);
  seen.get(id).push(ms);
};
for (const r of stored) remember(String(r.t), Date.parse(String(r.p)));

const stmts = [];
const insertedAts = [];
const queuedTracks = new Set();
for (const c of candidates) {
  if ((seen.get(c.id) ?? []).some((ms) => Math.abs(ms - c.ms) <= SAME_PLAY_MS)) continue;
  remember(c.id, c.ms);
  if (!queuedTracks.has(c.id)) {
    queuedTracks.add(c.id);
    stmts.push({
      sql: `INSERT OR IGNORE INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
            VALUES (?,?,?,?,?,NULL,NULL)`,
      args: [c.id, c.name, c.artist, c.uri, c.album],
    });
  }
  const playedAt = new Date(c.ms).toISOString();
  stmts.push({
    sql: `INSERT OR IGNORE INTO plays (track_id, played_at, context_type, context_uri)
          VALUES (?,?,NULL,NULL)`,
    args: [c.id, playedAt],
  });
  insertedAts.push(playedAt);
}

if (insertedAts.length > 0) {
  const verdicted = stored.filter((r) => r.c !== "backfill").map((r) => String(r.p));
  stmts.push(...importTailStmts(insertedRuns(verdicted, insertedAts)));
  await client.batch(stmts, "write");
}
console.log(
  `extended-history: ${rows.length} rows in ${files.length} files, ${candidates.length} in the gap windows, ` +
    `${insertedAts.length} inserted (rest already present)`,
);
client.close();
