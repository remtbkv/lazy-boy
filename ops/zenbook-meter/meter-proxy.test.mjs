// The meter's core fence (docs/STORE_MIGRATION.md §6.8). While FENCE_FILE exists, any hrana
// request carrying a statement that names a core table gets a 503 and never reaches sqld;
// telemetry statements pass. Run: node --test ops/zenbook-meter/meter-proxy.test.mjs
// (npm test runs it). Nothing here touches the Zenbook: the proxy runs on a loopback port in
// front of a stub upstream, with its fence file and log dir in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coreStatement, namesCoreTable } from "./meter-proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_TS = path.join(here, "..", "..", "src", "lib", "db.ts");

const CORE = ["tracks", "plays", "contexts", "meta", "playlists", "playlist_tracks", "saved_tracks"];
const TELEMETRY = ["api_log", "client_metrics", "usage_ledger", "cpu_meter", "budget_days"];

/** Every SQL statement in db.ts: each string or template literal that starts with a SQL verb,
 *  `${…}` interpolations replaced by a bare `x`, multi-statement strings (the schemas) split
 *  on `;`. */
function dbTsStatements() {
  const src = fs.readFileSync(DB_TS, "utf8");
  const out = [];
  const lit = /`((?:[^`\\]|\\.)*)`|"((?:[^"\\\n]|\\.)*)"/g;
  for (const m of src.matchAll(lit)) {
    const body = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "x");
    for (const part of body.split(";")) {
      const s = part.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
      if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA|WITH|REPLACE)\b/i.test(s)) out.push(s);
    }
  }
  return out;
}

const word = (names, s) => names.some((t) => new RegExp(`\\b${t}\\b`, "i").test(s));

test("db.ts: every core statement is fenced, every telemetry statement passes", () => {
  const stmts = dbTsStatements();
  assert.ok(stmts.length > 80, `extracted only ${stmts.length} statements`);
  let core = 0;
  let tel = 0;
  const neither = [];
  for (const s of stmts) {
    // The oracle, independent of the classifier: a statement that mentions a telemetry table
    // is telemetry (client_metrics has a `meta` COLUMN); otherwise one that mentions a core
    // table anywhere is core.
    if (word(TELEMETRY, s)) {
      tel++;
      assert.equal(namesCoreTable(s), null, `telemetry statement fenced: ${s}`);
    } else if (word(CORE, s)) {
      core++;
      assert.notEqual(namesCoreTable(s), null, `core statement passed: ${s}`);
    } else {
      neither.push(s);
    }
  }
  assert.ok(core > 60, `core ${core}`);
  assert.ok(tel >= 18, `telemetry ${tel}`);
  // What names no table at all: the bench's probe. Anything else here means the extraction
  // lost a table name to an interpolation and the oracle could not judge it.
  assert.deepEqual([...new Set(neither)], ["SELECT 1"]);
});

test("classifier known answers", () => {
  const fenced = [
    "SELECT value FROM meta WHERE key = ?",
    "select * from Plays",
    'INSERT OR IGNORE INTO "plays" (track_id) VALUES (?)',
    "UPDATE plays SET skipped = 0",
    "DELETE FROM playlist_tracks WHERE playlist_id = ?",
    "SELECT 1 FROM tracks t JOIN plays p ON p.track_id = t.id",
    "CREATE INDEX IF NOT EXISTS idx_plays_track ON plays (track_id)",
    "CREATE TABLE IF NOT EXISTS saved_tracks (track_id TEXT)",
    "ALTER TABLE contexts ADD COLUMN checked_at TEXT",
    "PRAGMA table_info(tracks)",
    "PRAGMA table_info( 'playlists' )",
    "SELECT * FROM main.meta",
  ];
  for (const s of fenced) assert.ok(namesCoreTable(s), `should fence: ${s}`);
  const passed = [
    "SELECT 1",
    "INSERT INTO client_metrics (ts, session, page, event, value, meta) VALUES (?, ?, ?, ?, ?, ?)",
    "SELECT id, ts, session, page, event, value, meta FROM client_metrics WHERE ts >= ?",
    "INSERT INTO usage_ledger (day, reader) VALUES (?, ?) ON CONFLICT(day, reader) DO UPDATE SET calls = calls + 1",
    "PRAGMA table_info(api_log)",
    "CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log (ts)",
    "SELECT * FROM metadata",
    "SELECT * FROM tracks_archive",
  ];
  for (const s of passed) assert.equal(namesCoreTable(s), null, `should pass: ${s}`);
});

test("request shapes: execute, batch with stored SQL, sequence, cursor", () => {
  const tel = "INSERT INTO api_log (ts) VALUES (?)";
  const core = "SELECT value FROM meta WHERE key = ?";
  const pipeline = (...requests) => ({ baton: null, requests });
  assert.equal(coreStatement(pipeline({ type: "execute", stmt: { sql: tel } }, { type: "close" })), null);
  assert.equal(coreStatement(pipeline({ type: "execute", stmt: { sql: core } })), core);
  // libsql's batch: the SQL is stored once and referenced by id.
  const stored = pipeline(
    { type: "store_sql", sql_id: 1, sql: tel },
    { type: "store_sql", sql_id: 2, sql: core },
    { type: "batch", batch: { steps: [{ stmt: { sql_id: 1 } }, { stmt: { sql_id: 2 } }] } },
    { type: "close" },
  );
  assert.equal(coreStatement(stored), core);
  const telOnly = pipeline(
    { type: "store_sql", sql_id: 1, sql: tel },
    { type: "batch", batch: { steps: [{ stmt: { sql_id: 1 } }, { stmt: { sql_id: 1 } }] } },
  );
  assert.equal(coreStatement(telOnly), null);
  // executeMultiple: the schema init of an old deployment.
  assert.ok(coreStatement(pipeline({ type: "sequence", sql: "CREATE TABLE IF NOT EXISTS tracks (id TEXT);" })));
  assert.equal(coreStatement(pipeline({ type: "sequence", sql: "CREATE TABLE IF NOT EXISTS api_log (id INTEGER);" })), null);
  assert.ok(coreStatement({ baton: null, batch: { steps: [{ stmt: { sql: core } }] } }));
  // A stored id this request never defined can't be read: fail closed.
  assert.ok(coreStatement(pipeline({ type: "execute", stmt: { sql_id: 9 } })));
  assert.equal(coreStatement(null), null);
});

// ── The running proxy ───────────────────────────────────────────────────────────────────

async function withProxy(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meter-fence-"));
  const fenceFile = path.join(dir, "FENCE_CORE");
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamHits.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ baton: null, base_url: null, results: [] }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const child = spawn(process.execPath, [path.join(here, "meter-proxy.mjs")], {
    env: {
      ...process.env,
      LISTEN: "127.0.0.1:0",
      UPSTREAM: `127.0.0.1:${upstream.address().port}`,
      LOG_DIR: path.join(dir, "log"),
      FENCE_FILE: fenceFile,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/meter-proxy 127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`proxy exited ${code}`)));
  });
  const post = (sql) =>
    fetch(`http://127.0.0.1:${port}/v2/pipeline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baton: null, requests: [{ type: "execute", stmt: { sql } }, { type: "close" }] }),
    });
  try {
    await fn({ post, fenceFile, upstreamHits });
  } finally {
    child.kill();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("proxy: fence off by default, 503 for core while the file exists, telemetry always passes", async () => {
  await withProxy(async ({ post, fenceFile, upstreamHits }) => {
    const core = "SELECT value FROM meta WHERE key = 'write_seq'";
    const tel = "INSERT INTO api_log (ts) VALUES (1)";

    assert.equal((await post(core)).status, 200);
    assert.equal(upstreamHits.length, 1);

    fs.writeFileSync(fenceFile, "");
    const fenced = await post(core);
    assert.equal(fenced.status, 503);
    assert.match(await fenced.text(), /fence/i);
    assert.equal(upstreamHits.length, 1, "a fenced request must not reach sqld");
    assert.equal((await post(tel)).status, 200);
    assert.equal(upstreamHits.length, 2);

    fs.rmSync(fenceFile);
    assert.equal((await post(core)).status, 200);
    assert.equal(upstreamHits.length, 3);
  });
});
