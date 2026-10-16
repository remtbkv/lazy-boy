// Write the four keys the app's versioned open checks (multi-user PLAN §4.5, §11.4) into a user
// database's `meta`: owner_uid (OWNER_UID), schema_version and min_reader (1: the schema every
// database had before versions existed), and a random store_epoch. Phase 1's deploy runs it on
// Rem's `lazyboy` BEFORE the code that checks them, or every request is refused ("no owner_uid").
// Those four keys are the only writes Phase 1 makes to Rem's data.
//
// Idempotent: a key already present is kept (a second run writes nothing), and an owner_uid that
// names someone else is never overwritten (exit 2). It first checks the database really is at
// schema 1 (every table, column and index CORE_SCHEMA and migrateCore make), since the app skips
// its schema steps for a database that says it is current.
//
//   node --env-file=.env.local scripts/phase1-meta-keys.mjs --user <OWNER_UID> --dry-run
//   node --env-file=.env.local scripts/phase1-meta-keys.mjs --user <OWNER_UID> --apply
//   ... [--db <url>]   another database (a scratch copy); default TURSO_DATABASE_URL
//
// Prints what it found and what it wrote; never a token, never more of the URL than its host.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { scriptUserOrExit, withoutUser } from "./script-user.mjs";

// Must equal USER_SCHEMA_VERSION in src/lib/db.ts (pinned by tests/phase1-meta-keys.test.ts).
export const SCHEMA_VERSION = 1;
const MIN_READER = 1;

// What schema 1 is: CORE_SCHEMA plus migrateCore (src/lib/db.ts).
const COLUMNS = {
  tracks: ["id", "name", "artist", "uri", "album", "album_image", "duration_ms"],
  plays: ["id", "track_id", "played_at", "context_type", "context_uri", "ctx_orphan", "skipped"],
  contexts: ["uri", "name", "type", "checked_at"],
  meta: ["key", "value"],
  playlists: ["id", "name", "owner_id", "image", "track_count", "position"],
  playlist_tracks: ["playlist_id", "position", "track_id", "added_at"],
  saved_tracks: ["track_id", "added_at", "position"],
};
const INDEXES = [
  "idx_plays_track",
  "idx_plays_played_at",
  "idx_tracks_artist_name",
  "idx_pltracks_pl",
  "idx_pltracks_track",
  "idx_plays_skip_null",
  "idx_plays_context",
  "idx_plays_orphan_null",
];
const KEYS = ["owner_uid", "schema_version", "min_reader", "store_epoch"];

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function newEpoch() {
  let out = "";
  for (const b of randomBytes(12)) out += B32[b & 31];
  return out;
}

function hostOf(url) {
  return url.startsWith("file:") ? "file" : new URL(url.replace(/^libsql:/, "https:")).host;
}

async function main() {
  const user = scriptUserOrExit(process.argv.slice(2), { adminOnly: true });
  const args = withoutUser(process.argv.slice(2));
  const apply = args.includes("--apply");
  const dry = args.includes("--dry-run");
  const at = args.indexOf("--db");
  const url = at >= 0 ? args[at + 1] : process.env.TURSO_DATABASE_URL;
  if (apply === dry || !url) {
    console.error("usage: phase1-meta-keys.mjs --user <uid> (--dry-run | --apply) [--db <url>]");
    process.exit(2);
  }
  const client = createClient({
    url,
    authToken: url.startsWith("file:") ? undefined : process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });

  // Schema 1, checked before anything is written.
  const missing = [];
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    const have = new Set(info.rows.map((r) => String(r.name)));
    if (have.size === 0) missing.push(`table ${table}`);
    else for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  const idx = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index'");
  const haveIdx = new Set(idx.rows.map((r) => String(r.name)));
  for (const i of INDEXES) if (!haveIdx.has(i)) missing.push(`index ${i}`);
  if (missing.length > 0) {
    console.error(`not at schema ${SCHEMA_VERSION}; missing: ${missing.join(", ")}`);
    process.exit(2);
  }

  const read = async () => {
    const r = await client.execute({
      sql: `SELECT key, value FROM meta WHERE key IN (${KEYS.map(() => "?").join(", ")})`,
      args: KEYS,
    });
    return Object.fromEntries(r.rows.map((x) => [String(x.key), String(x.value)]));
  };
  const found = await read();
  if (found.owner_uid !== undefined && found.owner_uid !== user.uid) {
    console.error(`owner_uid is ${found.owner_uid}, not ${user.uid}: refusing to change a database's owner`);
    process.exit(2);
  }
  const want = {
    owner_uid: user.uid,
    schema_version: String(SCHEMA_VERSION),
    min_reader: String(MIN_READER),
    store_epoch: newEpoch(),
  };
  const toWrite = KEYS.filter((k) => found[k] === undefined).map((k) => [k, want[k]]);
  const report = { host: hostOf(url), found, write: Object.fromEntries(toWrite), applied: false };
  if (apply && toWrite.length > 0) {
    await client.batch(
      toWrite.map(([key, value]) => ({
        sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
        args: [key, value],
      })),
      "write",
    );
    report.applied = true;
    report.now = await read();
  }
  console.log(JSON.stringify(report, null, 2));
  client.close();
}

// Run as a script; imported (by its test, for SCHEMA_VERSION), do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
