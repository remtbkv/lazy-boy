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

/** `search` — the two client-side search payloads, and the per-keystroke query they replaced.
 *  Against the PRIMARY (the shape production runs with LAZYBOY_NO_REPLICA=1). Three halves:
 *    TIMING    the old per-keystroke query (searchHistory's `LIKE '%q%'`, unindexable → scans
 *              `tracks`) against what the new path costs: each payload's build (once per
 *              version change, then cached) and the version reads (one indexed meta key each,
 *              per request). Interleaved round-robin.
 *    PAYLOAD   both bodies as served, raw / gzip / brotli — what the client downloads on a
 *              cold visit, and what a visit after listening re-downloads (the history half
 *              alone; the library half 304s).
 *    EQUALITY  the known-answer half, over the LIBRARY now rather than the history: every
 *              track the SQL search returns must also be matched by the client-side filter
 *              over the merged payloads, and every song SQL says has plays must come out
 *              played on the client's identity join (the id join, which is what an obvious
 *              implementation would do, is reported next to it and is expected to MISS).
 *              Exits non-zero on a miss.
 *  `node --env-file=.env.local scripts/bench-reads.mjs search` */
async function modeSearch() {
  // SQL copied from db.ts readLibraryIndex / readHistoryIndex.
  const LIB_MEMBERS = `SELECT pt.playlist_id AS pid, t.name AS name, t.artist AS artist,
              t.album AS album, t.album_image AS image
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id`;
  const LIB_SAVED = `SELECT t.name AS name, t.artist AS artist, t.album AS album, t.album_image AS image
       FROM saved_tracks s JOIN tracks t ON t.id = s.track_id`;
  const LIB_LISTS = "SELECT id, name FROM playlists";
  const HIST_INDEX = `SELECT t.name AS name, t.artist AS artist, t.album AS album, t.album_image AS image,
            t.duration_ms AS durationMs,
            p.played_at AS playedAt, ${sourceExpr("p", "c")} AS source
     FROM plays p JOIN tracks t ON t.id = p.track_id
       LEFT JOIN contexts c ON c.uri = p.context_uri
     ORDER BY p.played_at DESC`;
  const META = "SELECT value FROM meta WHERE key = ?";

  const client = mkPrimary();
  // The payload + equality halves read a SCRATCH COPY of the live replica: identical rows, but
  // the equality queries are correlated subqueries over 15,000 tracks and are minutes-scale
  // against remote Turso. Timing stays on the primary, where the build actually runs cold.
  const copyPath = path.join(SCRATCH_DIR, "replica-copy.db");
  for (const suffix of ["", "-wal"]) {
    if (fs.existsSync(LIVE_REPLICA + suffix)) fs.copyFileSync(LIVE_REPLICA + suffix, copyPath + suffix);
  }
  const local = createClient({ url: `file:${copyPath}`, intMode: "number" });
  const interner = () => {
    const values = [];
    const seen = new Map();
    return {
      values,
      put(v) {
        if (v == null || v === "") return -1;
        const s = String(v);
        const at = seen.get(s);
        if (at !== undefined) return at;
        seen.set(s, values.length);
        return values.push(s) - 1;
      },
    };
  };
  const key = (r) => `${String(r.artist).toLowerCase()}\n${String(r.name).toLowerCase()}`;

  // Both payloads, built exactly as db.ts builds them, so PAYLOAD below is the served body.
  const [members, saved, lists, hist] = [
    (await local.execute(LIB_MEMBERS)).rows,
    (await local.execute(LIB_SAVED)).rows,
    (await local.execute(LIB_LISTS)).rows,
    (await local.execute(HIST_INDEX)).rows,
  ];
  const li = { images: interner(), albums: interner(), playlists: interner() };
  const named = new Map(lists.map((r) => [String(r.id), li.playlists.put(r.name)]));
  const libTracks = [];
  const libAt = new Map();
  const libAdd = (r) => {
    const k = key(r);
    const hit = libAt.get(k);
    if (hit !== undefined) return hit;
    libAt.set(k, libTracks.length);
    return (
      libTracks.push([
        String(r.name),
        String(r.artist),
        li.images.put(r.image),
        li.albums.put(r.album),
        [],
      ]) - 1
    );
  };
  for (const r of members) {
    const m = libTracks[libAdd(r)][4];
    const pl = named.get(String(r.pid));
    if (pl !== undefined && !m.includes(pl)) m.push(pl);
  }
  for (const r of saved) libAdd(r);

  const hi = { images: interner(), albums: interner(), sources: interner() };
  const histTracks = [];
  const histAt = new Map();
  const plays = hist.map((r) => {
    const k = key(r);
    let i = histAt.get(k);
    if (i === undefined) {
      histAt.set(k, (i = histTracks.length));
      histTracks.push([
        String(r.name),
        String(r.artist),
        hi.images.put(r.image),
        hi.albums.put(r.album),
        Number(r.durationMs) || 0,
      ]);
    }
    return [i, Math.floor(Date.parse(String(r.playedAt)) / 60000), hi.sources.put(r.source)];
  });

  const { cells } = await runGroup(
    client,
    [
      // db.ts searchHistory, as the search box called it per keystroke (limit 500).
      { key: "oldLikeScan", run: (c) => c.execute({ sql: HIST("LEFT"), args: ["%the%", "%the%", 500] }) },
      { key: "libVersion", run: (c) => c.execute({ sql: META, args: ["library_seq"] }) },
      { key: "libMembers", run: (c) => c.execute(LIB_MEMBERS) },
      { key: "histVersion", run: (c) => c.execute({ sql: META, args: ["write_seq"] }) },
      { key: "histBuild", run: (c) => c.execute(HIST_INDEX) },
      SELECT1,
    ],
    5,
  );
  console.log("TIMING (primary)");
  for (const [k, v] of Object.entries(cells)) {
    console.log(`  ${k.padEnd(13)} ${v.median}ms (${v.min}-${v.max}, n=${v.n}) rows=${v.rows}`);
  }

  const sz = (b) =>
    `raw ${b.length}B, gzip ${zlib.gzipSync(b, { level: 6 }).length}B, brotli ${zlib.brotliCompressSync(b).length}B`;
  const libBody = Buffer.from(
    JSON.stringify({
      v: "x",
      images: li.images.values,
      albums: li.albums.values,
      playlists: li.playlists.values,
      tracks: libTracks,
    }),
  );
  const histBody = Buffer.from(
    JSON.stringify({
      v: "x",
      images: hi.images.values,
      albums: hi.albums.values,
      sources: hi.sources.values,
      tracks: histTracks,
      plays,
    }),
  );
  const totalTracks = Number((await local.execute("SELECT COUNT(*) AS n FROM tracks")).rows[0].n);
  console.log(
    `PAYLOAD   ${libTracks.length} library identities (from ${members.length} memberships + ` +
      `${saved.length} liked, ${totalTracks} rows in \`tracks\`), ` +
      `${histTracks.length} played identities, ${plays.length} plays`,
  );
  console.log(`  library  ${sz(libBody)}   ← 304s unless the library changed`);
  console.log(`  history  ${sz(histBody)}   ← re-fetched after any listening`);
  console.log(`  per library identity: ${(libBody.length / libTracks.length).toFixed(0)}B raw`);

  // EQUALITY. The client's searchable set = the two payloads merged on identity.
  const merged = new Map();
  for (const [name, artist] of libTracks) merged.set(`${artist.toLowerCase()}\n${name.toLowerCase()}`, { name, artist, plays: 0 });
  for (const [i, t] of histTracks.entries()) {
    const k = `${t[1].toLowerCase()}\n${t[0].toLowerCase()}`;
    if (!merged.has(k)) merged.set(k, { name: t[0], artist: t[1], plays: 0 });
    merged.get(k).idx = i;
  }
  for (const [track] of plays) {
    const t = histTracks[track];
    merged.get(`${t[1].toLowerCase()}\n${t[0].toLowerCase()}`).plays += 1;
  }
  const LIB_LIKE = `SELECT DISTINCT t.name AS name, t.artist AS artist,
        (SELECT COUNT(*) FROM plays p2 JOIN tracks t2 ON t2.id = p2.track_id
          WHERE lower(t2.artist) = lower(t.artist) AND lower(t2.name) = lower(t.name)) AS plays,
        (SELECT COUNT(*) FROM plays p3 WHERE p3.track_id = t.id) AS playsById
     FROM tracks t
     WHERE (t.name LIKE ? OR t.artist LIKE ?)
       AND (EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id)
         OR EXISTS (SELECT 1 FROM saved_tracks s WHERE s.track_id = t.id)
         OR EXISTS (SELECT 1 FROM plays p WHERE p.track_id = t.id))`;
  const QUERIES = ["love", "the", "night", "back", "we", "嘉宾"];
  let missing = 0;
  let idMisses = 0;
  for (const q of QUERIES) {
    const like = `%${q}%`;
    const rows = (await local.execute({ sql: LIB_LIKE, args: [like, like] })).rows;
    for (const mode of ["songs", "artists"]) {
      const sql = rows.filter((r) =>
        String(mode === "songs" ? r.name : r.artist)
          .toLowerCase()
          .includes(q),
      );
      const clientSide = new Set(
        [...merged.values()]
          .filter((e) => (mode === "songs" ? e.name : e.artist).toLowerCase().includes(q))
          .map((e) => `${e.artist.toLowerCase()}\n${e.name.toLowerCase()}`),
      );
      const missed = sql.filter((r) => !clientSide.has(`${String(r.artist).toLowerCase()}\n${String(r.name).toLowerCase()}`));
      missing += missed.length;
      // The played verdict, both ways of computing it.
      let playedWrong = 0;
      for (const r of sql) {
        const e = merged.get(`${String(r.artist).toLowerCase()}\n${String(r.name).toLowerCase()}`);
        if (!e) continue;
        if (e.plays > 0 !== Number(r.plays) > 0) playedWrong++;
        if (Number(r.plays) > 0 && Number(r.playsById) === 0) idMisses++;
      }
      missing += playedWrong;
      console.log(
        `EQUALITY  ${JSON.stringify(q).padEnd(9)} ${mode.padEnd(7)} sql=${sql.length} client=${clientSide.size}` +
          ` missed=${missed.length} playedVerdictWrong=${playedWrong}`,
      );
    }
  }
  console.log(`EQUALITY  ${missing} misses by the client-side filter (identity join)`);
  console.log(
    `EQUALITY  ${idMisses} rows a TRACK-ID join would have called never-played (identity says played)`,
  );
  // The same trap store-wide, independent of the sample queries: how many songs sit in a
  // playlist AND have plays, counted by identity vs. counted by track id.
  const byIdentity = Number(
    (
      await local.execute(
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT lower(t.artist) a, lower(t.name) n
           FROM plays p JOIN tracks t ON t.id = p.track_id) x
         WHERE EXISTS (SELECT 1 FROM playlist_tracks pt JOIN tracks t2 ON t2.id = pt.track_id
                       WHERE lower(t2.artist) = x.a AND lower(t2.name) = x.n)`,
      )
    ).rows[0].n,
  );
  const byId = Number(
    (
      await local.execute(
        `SELECT COUNT(DISTINCT p.track_id) AS n FROM plays p
         WHERE EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = p.track_id)`,
      )
    ).rows[0].n,
  );
  console.log(
    `EQUALITY  played-and-in-a-playlist: ${byIdentity} by identity, ${byId} by track id ` +
      `— ${byIdentity - byId} songs an id join gets wrong`,
  );
  if (missing > 0) process.exitCode = 1;
  local.close();
  client.close();
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
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
