// Read-benchmark harness for the src/lib/db.ts query-conventions block.
// READ-ONLY against the primary and the live replica file (local file measurements run on a
// COPY of data/replica.db in os.tmpdir()). Modes: main | cold | sync | idx | day | search
import { createClient } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const MODE = process.argv[2] || "main";
const URL_PRIMARY = process.env.TURSO_DATABASE_URL;
const AUTH = process.env.TURSO_AUTH_TOKEN;
if (!URL_PRIMARY) throw new Error("TURSO_DATABASE_URL missing");

const REPO = "/Users/remtbkv/projects/lazyboy";
const LIVE_REPLICA = path.join(REPO, "data", "replica.db");
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lazyboy-bench-"));

// ── SQL, copied verbatim from src/lib/db.ts where named ────────────────────────────────
const sourceExpr = (p, c) =>
  `CASE WHEN ${p}.ctx_orphan = 1 THEN NULL
               ELSE COALESCE(${c}.name, ${p}.context_type) END`;

const SELECT_TRACK = (join) => `
  SELECT t.id, t.name, t.artist, t.uri, t.album, t.album_image AS albumImage,
    t.duration_ms AS durationMs,
    COUNT(p.id) AS plays, MAX(p.played_at) AS lastPlayed, MIN(p.played_at) AS firstPlayed,
    (SELECT ${sourceExpr("p2", "c2")}
       FROM plays p2 LEFT JOIN contexts c2 ON c2.uri = p2.context_uri
       WHERE p2.track_id = t.id ORDER BY p2.played_at DESC LIMIT 1) AS source
  FROM plays p ${join} JOIN tracks t ON t.id = p.track_id`;

const SELECT_PLAY = (join) => `
  SELECT t.id, t.name, t.artist, t.uri, t.album, t.album_image AS albumImage,
    t.duration_ms AS durationMs, 1 AS plays,
    p.played_at AS lastPlayed, p.played_at AS firstPlayed,
    ${sourceExpr("p", "c")} AS source
  FROM plays p ${join} JOIN tracks t ON t.id = p.track_id
    LEFT JOIN contexts c ON c.uri = p.context_uri`;

const HIST = (join) =>
  `${SELECT_PLAY(join)} WHERE t.name LIKE ? OR t.artist LIKE ?
          ORDER BY p.played_at DESC LIMIT ?`;
const HIST_ARGS = ["%the%", "%the%", 300];

const DAILY = (join) =>
  `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs
          FROM plays p ${join} JOIN tracks t ON t.id = p.track_id
          WHERE p.played_at >= :cutoff
          ORDER BY p.played_at ASC`;
// getDailyStats(offsetMin, days=14) → cutoff = now - (14+2) days
const dailyArgs = () => ({ cutoff: new Date(Date.now() - 16 * 86_400_000).toISOString() });

const PLAYS_PLAIN = `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs
     FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
     ORDER BY p.played_at ASC`;
const PLAYS_LEAD = `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs,
       LEAD(p.played_at) OVER (ORDER BY p.played_at) AS nextPlayedAt
     FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
     ORDER BY p.played_at ASC`;

const ALLTIME = `${SELECT_TRACK("LEFT")} GROUP BY t.id
          ORDER BY plays DESC, lastPlayed DESC, t.name ASC LIMIT ?`;

const UNIQUE_DISTINCT = `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT lower(t.artist) AS a, lower(t.name) AS m
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     )`;

const META_ONE = "SELECT value FROM meta WHERE key = ?";

// Measurement 8: the conventions block (db.ts:28-29) describes this shape; no named query
// in db.ts uses it, so the SQL is as given in the measurement spec.
const IDENT = (join) =>
  `SELECT pt.playlist_id, pt.position, t.id, t.name, t.artist
   FROM playlist_tracks pt ${join} JOIN tracks t ON t.id = pt.track_id
   WHERE lower(t.artist) = ? AND lower(t.name) = ?
   ORDER BY pt.playlist_id, pt.position`;

const PLTRACKS_BY_TRACK = `SELECT pt.playlist_id, pt.position, pt.added_at
   FROM playlist_tracks pt WHERE pt.track_id = ? ORDER BY pt.playlist_id, pt.position`;

// ── helpers ────────────────────────────────────────────────────────────────────────────
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    median: r1(s[(s.length - 1) >> 1]),
    min: r1(s[0]),
    max: r1(s[s.length - 1]),
    median3: r3(s[(s.length - 1) >> 1]),
    min3: r3(s[0]),
    max3: r3(s[s.length - 1]),
    sorted: s.map(r3),
    ordered: samples.map(r3), // temporal order, as measured
  };
}
const ser = (rows) => JSON.stringify(rows.map((r) => ({ ...r })));

async function timed(client, stmt) {
  const t0 = performance.now();
  const res = await client.execute(stmt);
  const ms = performance.now() - t0;
  return { ms, res };
}

/** Round-robin (A,B,A,B,…) over variants; 3 warmups discarded, then n counted. */
async function runGroup(client, variants, n, warmup = 3) {
  const acc = Object.fromEntries(variants.map((v) => [v.key, []]));
  const rowCounts = {};
  const lastRows = {};
  for (let i = 0; i < warmup + n; i++) {
    for (const v of variants) {
      const t0 = performance.now();
      const out = await v.run(client);
      const ms = performance.now() - t0;
      if (i >= warmup) acc[v.key].push(ms);
      if (out && out.rows) {
        rowCounts[v.key] = out.rows.length;
        if (v.keepRows) lastRows[v.key] = out.rows;
      }
    }
  }
  const cells = {};
  for (const v of variants) cells[v.key] = { ...stats(acc[v.key]), rows: rowCounts[v.key] ?? null };
  return { cells, lastRows };
}

// variants return the result set directly
const q = (sql, args) => async (client) =>
  args === undefined ? await client.execute(sql) : await client.execute({ sql, args });

const SELECT1 = { key: "select1", run: q("SELECT 1") };

/** 10. playlist_tracks BY track_id, index present vs dropped. TWO scratch copies of identical
 *  bytes with one connection each: libSQL returns SQLITE_LOCKED for DDL on a connection that
 *  has already run reads, so the DROP happens as the first statement on its own copy. The two
 *  variants are still interleaved round-robin. */
async function idxDropTest(mkCopy, trackId, n = 9, warmup = 3) {
  const withPath = mkCopy("idx-with.db");
  const noPath = path.join(path.dirname(withPath), "idx-dropped.db");
  for (const s of ["", "-wal"]) if (fs.existsSync(withPath + s)) fs.copyFileSync(withPath + s, noPath + s);
  const cWith = createClient({ url: `file:${withPath}`, intMode: "number" });
  const cNo = createClient({ url: `file:${noPath}`, intMode: "number" });
  await cNo.execute("DROP INDEX idx_pltracks_track"); // scratch copy only, first statement
  const stmt = { sql: PLTRACKS_BY_TRACK, args: [trackId] };
  const planOf = async (c) =>
    (await c.execute({ sql: `EXPLAIN QUERY PLAN ${PLTRACKS_BY_TRACK}`, args: [trackId] })).rows.map((r) =>
      String(r.detail),
    );
  const planWith = await planOf(cWith);
  const planNo = await planOf(cNo);
  const acc = { select1: [], withIndex: [], afterDropIndex: [] };
  let rowsWith = [];
  let rowsNo = [];
  for (let i = 0; i < warmup + n; i++) {
    const a = await timed(cWith, "SELECT 1");
    const b = await timed(cWith, stmt);
    const c = await timed(cNo, stmt);
    if (i >= warmup) {
      acc.select1.push(a.ms);
      acc.withIndex.push(b.ms);
      acc.afterDropIndex.push(c.ms);
    }
    rowsWith = b.res.rows;
    rowsNo = c.res.rows;
  }
  cWith.close();
  cNo.close();
  return {
    note: "scratch copies of data/replica.db; local SQLite plan-shape evidence, not remote cost",
    select1: stats(acc.select1),
    withIndex: { ...stats(acc.withIndex), rows: rowsWith.length },
    afterDropIndex: { ...stats(acc.afterDropIndex), rows: rowsNo.length },
    planWithIndex: planWith,
    planAfterDrop: planNo,
    rowsIdentical: ser(rowsWith) === ser(rowsNo),
  };
}

function mkPrimary() {
  return createClient({ url: URL_PRIMARY, authToken: AUTH, intMode: "number" });
}

// ── modes ──────────────────────────────────────────────────────────────────────────────
async function modeCold() {
  const client = mkPrimary();
  const a = await timed(client, "SELECT 1");
  const b = await timed(client, { sql: HIST("LEFT"), args: HIST_ARGS });
  console.log(
    JSON.stringify({ select1Ms: r1(a.ms), historyLeftMs: r1(b.ms), historyRows: b.res.rows.length }),
  );
  client.close();
}

async function modeSync() {
  const p = path.join(SCRATCH_DIR, `sync-${process.pid}-${Date.now()}.db`);
  const c = createClient({
    url: `file:${p}`,
    syncUrl: URL_PRIMARY,
    authToken: AUTH,
    intMode: "number",
  });
  const t0 = performance.now();
  await c.sync();
  const ms = performance.now() - t0;
  const size = fs.statSync(p).size;
  c.close();
  console.log(JSON.stringify({ syncMs: r1(ms), bytes: size, path: p }));
  for (const suffix of ["", "-wal", "-shm", "-info"]) {
    try {
      fs.rmSync(p + suffix);
    } catch {}
  }
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

async function modeMain() {
  const out = { startedAt: new Date().toISOString(), protocol: { nPrimary: 15, nLocal: 9, warmup: 3 } };

  // Scratch copy of the live replica (never opened in place). The -shm is NOT copied — it is
  // rebuilt from the -wal, and copying its lock bytes made the scratch copy report
  // SQLITE_LOCKED on DDL.
  const mkCopy = (name) => {
    const p = path.join(SCRATCH_DIR, name);
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(LIVE_REPLICA + suffix)) fs.copyFileSync(LIVE_REPLICA + suffix, p + suffix);
    }
    return p;
  };
  const copyPath = mkCopy("replica-copy.db");
  out.scratch = { copyPath, bytes: fs.statSync(copyPath).size };
  // Every completed run is kept: the primary's timings swing, so replicates are evidence.
  const RESULTS = path.join(REPO, "scripts", "bench-reads-results.json");
  const prior = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : null;
  const runs = prior ? (prior.runs ? prior.runs : [prior]) : [];
  const save = () => fs.writeFileSync(RESULTS, JSON.stringify({ runs: [...runs, out] }, null, 2));

  const primary = mkPrimary();
  const local = createClient({ url: `file:${copyPath}`, intMode: "number" });

  // Row counts (informational) + fixtures, from the primary and the copy.
  const counts = {};
  for (const t of ["plays", "tracks", "playlist_tracks"]) {
    counts[t] = {
      primary: Number((await primary.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n),
      localCopy: Number((await local.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n),
    };
  }
  out.rowCounts = counts;

  // Fixture: a real track_id in playlist_tracks (the most-referenced one) + its identity.
  const fx = (
    await local.execute(`SELECT pt.track_id AS trackId, COUNT(*) AS n, lower(t.artist) AS artist,
                                lower(t.name) AS name
                         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                         GROUP BY pt.track_id ORDER BY n DESC, pt.track_id LIMIT 1`)
  ).rows[0];
  out.fixture = {
    trackId: String(fx.trackId),
    playlistTracksRowsForTrackId: Number(fx.n),
    artistLower: String(fx.artist),
    nameLower: String(fx.name),
  };
  const IDENT_ARGS = [out.fixture.artistLower, out.fixture.nameLower];

  const groups = {
    // 2. getDailyStats window
    dailyStats: [
      SELECT1,
      { key: "left", keepRows: true, run: (c) => c.execute({ sql: DAILY("LEFT"), args: dailyArgs() }) },
      { key: "inner", keepRows: true, run: (c) => c.execute({ sql: DAILY("INNER"), args: dailyArgs() }) },
    ],
    // 3. history search
    historySearch: [
      SELECT1,
      { key: "left", keepRows: true, run: q(HIST("LEFT"), HIST_ARGS) },
      { key: "inner", keepRows: true, run: q(HIST("INNER"), HIST_ARGS) },
    ],
    // 4. listened-time shapes over ALL plays
    listenedShapes: [
      SELECT1,
      { key: "plain", keepRows: true, run: q(PLAYS_PLAIN) },
      { key: "sqlLead", keepRows: true, run: q(PLAYS_LEAD) },
    ],
    // 5. all-time list (reference point)
    allTimeList: [SELECT1, { key: "current", keepRows: true, run: q(ALLTIME, [300]) }],
    // 6. unique_song_count DISTINCT scan
    uniqueSongScan: [SELECT1, { key: "distinctScan", run: q(UNIQUE_DISTINCT) }],
    // 7. single meta read
    metaSingle: [SELECT1, { key: "alltimeStats", run: q(META_ONE, ["alltime_stats"]) }],
    // 8. song-identity lookup
    songIdentity: [
      SELECT1,
      { key: "inner", keepRows: true, run: q(IDENT("INNER"), IDENT_ARGS) },
      { key: "left", keepRows: true, run: q(IDENT("LEFT"), IDENT_ARGS) },
    ],
  };

  const equality = {};
  function assertEqual(name, a, b) {
    equality[name] = {
      identical: ser(a) === ser(b),
      rowsA: a.length,
      rowsB: b.length,
    };
  }

  for (const client of [
    { label: "primary", c: primary, n: 15 },
    { label: "localCopy", c: local, n: 9 },
  ]) {
    out[client.label] = {};
    for (const [gname, variants] of Object.entries(groups)) {
      const t0 = new Date().toISOString();
      const { cells, lastRows } = await runGroup(client.c, variants, client.n);
      out[client.label][gname] = { at: t0, ...cells };
      if (gname === "dailyStats") assertEqual(`${client.label}/dailyStats left↔inner`, lastRows.left, lastRows.inner);
      if (gname === "historySearch") assertEqual(`${client.label}/historySearch left↔inner`, lastRows.left, lastRows.inner);
      if (gname === "songIdentity") assertEqual(`${client.label}/songIdentity inner↔left`, lastRows.inner, lastRows.left);
      if (gname === "listenedShapes") {
        // gap from the plain fetch (JS) vs the SQL LEAD column, row for row
        const plain = lastRows.plain.map((r) => ({ ...r }));
        const lead = lastRows.sqlLead.map((r) => ({ ...r }));
        const jsGaps = plain.map((r, i) =>
          plain[i + 1] ? Date.parse(plain[i + 1].playedAt) - Date.parse(r.playedAt) : null,
        );
        const sqlGaps = lead.map((r) =>
          r.nextPlayedAt == null ? null : Date.parse(r.nextPlayedAt) - Date.parse(r.playedAt),
        );
        let firstMismatch = null;
        for (let i = 0; i < Math.max(jsGaps.length, sqlGaps.length); i++) {
          if (jsGaps[i] !== sqlGaps[i]) {
            firstMismatch = { i, js: jsGaps[i] ?? null, sql: sqlGaps[i] ?? null };
            break;
          }
        }
        equality[`${client.label}/listenedGaps JS↔SQL-LEAD`] = {
          identical: firstMismatch === null && jsGaps.length === sqlGaps.length,
          rowsA: jsGaps.length,
          rowsB: sqlGaps.length,
          firstMismatch,
        };
      }
      out.equality = equality;
      save();
    }
  }

  // 9. Home meta-serial composite — primary only.
  const METAS = ["alltime_stats", "unique_song_count", "last_sync"];
  const serialRun = async (c) => {
    for (const k of METAS) await c.execute({ sql: META_ONE, args: [k] });
    return null;
  };
  const concurrentRun = async (c) => {
    await Promise.all(METAS.map((k) => c.execute({ sql: META_ONE, args: [k] })));
    return null;
  };
  {
    const { cells } = await runGroup(
      primary,
      [SELECT1, { key: "serial3", run: serialRun }, { key: "concurrent3", run: concurrentRun }],
      15,
    );
    out.primary.metaComposite = { at: new Date().toISOString(), ...cells };
    save();
  }

  // 10. playlist_tracks BY track_id, with vs without idx_pltracks_track — scratch copy ONLY.
  local.close();
  out.indexDropScratch = await idxDropTest(mkCopy, out.fixture.trackId);
  save();

  out.equality = equality;
  primary.close();

  // 11. Five fresh Node processes: first SELECT 1 + first history search (LEFT).
  const self = new URL(import.meta.url).pathname;
  out.cold = [];
  for (let i = 0; i < 5; i++) {
    const s = execFileSync(process.execPath, [self, "cold"], { encoding: "utf8" });
    out.cold.push(JSON.parse(s.trim().split("\n").pop()));
    save();
  }

  // 12. Three fresh replica syncs to a NEW scratch path each.
  out.replicaSync = [];
  for (let i = 0; i < 3; i++) {
    const s = execFileSync(process.execPath, [self, "sync"], { encoding: "utf8" });
    out.replicaSync.push(JSON.parse(s.trim().split("\n").pop()));
    save();
  }

  out.finishedAt = new Date().toISOString();
  save();
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  console.log("WROTE scripts/bench-reads-results.json");
}

/** `day` — getPlaysByDay's two formulations, against the PRIMARY (the shape production runs
 *  with LAZYBOY_NO_REPLICA=1). Both halves matter and both print:
 *    TIMING    the `date()` equality alone (no index can serve it → full plays scan) vs the
 *              same query with the redundant raw-UTC range bound that idx_plays_played_at can
 *              seek. Interleaved round-robin, so a session-wide slowdown hits both equally.
 *    EQUALITY  every local day in the store, old rows vs new rows, byte-compared. This is the
 *              known-answer half — the range bound is only allowed to exist because it changes
 *              nothing. Exits non-zero on any mismatch.
 *  `node --env-file=.env.local scripts/bench-reads.mjs day [offsetMin]` (default −240, NY summer). */
async function modeDay() {
  const offsetMin = Number(process.argv[3] ?? -240);
  const m = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0));
  const localDay = (col) => `date(${col}, '${m >= 0 ? "+" : ""}${m} minutes')`;
  // db.ts getPlaysByDay, before and after.
  const OLD = (day) => ({
    sql: `${SELECT_TRACK("LEFT")} WHERE ${localDay("p.played_at")} = :day
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
    args: { day },
  });
  const NEW = (day) => {
    const start = Date.parse(day + "T00:00:00.000Z") - m * 60_000;
    return {
      sql: `${SELECT_TRACK("LEFT")}
            WHERE p.played_at >= :from AND p.played_at < :to
              AND ${localDay("p.played_at")} = :day
            GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
      args: {
        day,
        from: new Date(start).toISOString(),
        to: new Date(start + 86_400_000).toISOString(),
      },
    };
  };

  const client = mkPrimary();
  const days = (
    await client.execute(`SELECT DISTINCT ${localDay("played_at")} AS d FROM plays ORDER BY d`)
  ).rows.map((r) => String(r.d));
  // Time a day in the middle of the history, not the newest (today is still filling up).
  const sample = days[Math.max(0, days.length - 3)];
  const { cells } = await runGroup(
    client,
    [
      { key: "unbounded", run: (c) => c.execute(OLD(sample)) },
      { key: "rangeBound", run: (c) => c.execute(NEW(sample)) },
      SELECT1,
    ],
    7,
  );
  console.log(`TIMING day=${sample} offsetMin=${m}`);
  for (const [k, v] of Object.entries(cells)) {
    console.log(`  ${k.padEnd(11)} ${v.median}ms (${v.min}-${v.max}, n=${v.n}) rows=${v.rows}`);
  }

  let bad = 0;
  for (const d of days) {
    const [a, b] = await Promise.all([client.execute(OLD(d)), client.execute(NEW(d))]);
    if (ser(a.rows) !== ser(b.rows)) {
      bad++;
      console.log(`  MISMATCH ${d}: ${a.rows.length} rows vs ${b.rows.length}`);
    }
  }
  console.log(`EQUALITY  ${days.length} days, ${bad} mismatches`);
  if (bad > 0) process.exitCode = 1;
}

/** `search` — the history search, before and after it moved into the browser. Against the
 *  PRIMARY (the shape production runs with LAZYBOY_NO_REPLICA=1). Three halves:
 *    TIMING    the old per-keystroke query (searchHistory's `LIKE '%q%'`, unindexable → scans
 *              `tracks`) against what the new path costs: the version check (one rowid seek,
 *              per index request), the index build (once per version change, then cached), and
 *              one hydration of the matched ids. Interleaved round-robin.
 *    PAYLOAD   the served index body, raw / gzip / brotli — the number the client downloads.
 *    EQUALITY  the known-answer half: for each sample query, every track the SQL search returns
 *              must also be matched by the client-side substring filter over the index. The
 *              client is allowed to find MORE (the SQL path is capped at 500 play rows, so a
 *              song whose plays fall outside that window never came back); it is not allowed to
 *              miss any. Exits non-zero on a miss.
 *  `node --env-file=.env.local scripts/bench-reads.mjs search` */
async function modeSearch() {
  const SEARCH_INDEX = `SELECT t.id AS id, t.name AS name, t.artist AS artist
     FROM plays p JOIN tracks t ON t.id = p.track_id
     GROUP BY p.track_id
     ORDER BY MAX(p.played_at) DESC`;
  const VERSION = "SELECT MAX(rowid) AS v FROM tracks";
  const hydrate = (n) =>
    `${SELECT_PLAY("LEFT")} WHERE p.track_id IN (${Array(n).fill("?").join(",")})
     ORDER BY p.played_at DESC LIMIT ?`;

  const client = mkPrimary();
  const index = (await client.execute(SEARCH_INDEX)).rows.map((r) => [
    String(r.id),
    String(r.name),
    String(r.artist),
  ]);
  const sampleIds = index.slice(0, 50).map((e) => e[0]);

  const { cells } = await runGroup(
    client,
    [
      // db.ts searchHistory, as the search box called it per keystroke (limit 500).
      { key: "oldLikeScan", run: (c) => c.execute({ sql: HIST("LEFT"), args: ["%the%", "%the%", 500] }) },
      { key: "versionCheck", run: (c) => c.execute(VERSION) },
      { key: "indexBuild", run: (c) => c.execute(SEARCH_INDEX) },
      {
        key: "hydrate50",
        run: (c) => c.execute({ sql: hydrate(sampleIds.length), args: [...sampleIds, 3000] }),
      },
      SELECT1,
    ],
    7,
  );
  console.log("TIMING (primary)");
  for (const [k, v] of Object.entries(cells)) {
    console.log(`  ${k.padEnd(13)} ${v.median}ms (${v.min}-${v.max}, n=${v.n}) rows=${v.rows}`);
  }

  const body = Buffer.from(JSON.stringify(index));
  const totalTracks = Number((await client.execute("SELECT COUNT(*) AS n FROM tracks")).rows[0].n);
  console.log(
    `PAYLOAD   ${index.length} played tracks of ${totalTracks} in the table — ` +
      `raw ${body.length}B, gzip ${zlib.gzipSync(body, { level: 6 }).length}B, ` +
      `brotli ${zlib.brotliCompressSync(body).length}B`,
  );

  // EQUALITY. Two query shapes on purpose: narrow ones, where the 500-row cap can't bite and
  // the two answers should be identical, and a broad one that exercises the cap.
  const QUERIES = ["love", "the", "a", "night", "back", "we"];
  let missing = 0;
  for (const q of QUERIES) {
    const like = `%${q}%`;
    const rows = (await client.execute({ sql: HIST("LEFT"), args: [like, like, 500] })).rows;
    for (const mode of ["songs", "artists"]) {
      const sql = new Set(
        rows
          .filter((r) => String(mode === "songs" ? r.name : r.artist).toLowerCase().includes(q))
          .map((r) => String(r.id)),
      );
      const clientSide = new Set(
        index.filter((e) => e[mode === "songs" ? 1 : 2].toLowerCase().includes(q)).map((e) => e[0]),
      );
      const missed = [...sql].filter((id) => !clientSide.has(id));
      missing += missed.length;
      console.log(
        `EQUALITY  ${JSON.stringify(q).padEnd(9)} ${mode.padEnd(7)} sql=${sql.size} client=${clientSide.size}` +
          ` missed=${missed.length}${missed.length ? ` ${missed.slice(0, 3).join(",")}` : ""}`,
      );
    }
  }
  console.log(`EQUALITY  ${missing} tracks missed by the client-side filter`);
  if (missing > 0) process.exitCode = 1;
  client.close();
}

/** Re-run measurement 10 alone and merge it into the existing results JSON. */
async function modeIdx() {
  const RESULTS = path.join(REPO, "scripts", "bench-reads-results.json");
  const all = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const out = all.runs ? all.runs[all.runs.length - 1] : all;
  const mkCopy = (name) => {
    const p = path.join(SCRATCH_DIR, name);
    for (const s of ["", "-wal"]) if (fs.existsSync(LIVE_REPLICA + s)) fs.copyFileSync(LIVE_REPLICA + s, p + s);
    return p;
  };
  out.indexDropScratch = await idxDropTest(mkCopy, out.fixture.trackId);
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 2));
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  console.log(JSON.stringify(out.indexDropScratch, null, 1));
}

if (MODE === "cold") await modeCold();
else if (MODE === "sync") await modeSync();
else if (MODE === "idx") await modeIdx();
else if (MODE === "day") await modeDay();
else if (MODE === "search") await modeSearch();
else await modeMain();
