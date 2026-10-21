// lazyboy store meter: a pass-through proxy in front of sqld that logs, per request, the
// rows_read / rows_written / query_duration_ms sqld itself reports for every statement.
// These are libSQL's own counters — the exact numbers Turso bills on — so the read budget
// becomes a sum over this log instead of a model.
//
// Bytes are piped through untouched as they arrive; the meter only parses a COPY after the
// response ends, and any parse failure is logged and swallowed. A meter bug must never cost
// a query.
//
//   LISTEN (default 127.0.0.1:8090)  <- funnel + local scripts
//   UPSTREAM (default 127.0.0.1:8092) -> sqld
//   LOG_DIR  (default ~/lazyboy-sqld/querylog), one JSONL file per UTC day
//   FENCE_FILE (default ~/lazyboy-sqld/FENCE_CORE), the core fence's switch (below)
//
// THE CORE FENCE (docs/STORE_MIGRATION.md §6.8). Once production's core data lives on Turso,
// this sqld keeps only the telemetry tables (api_log, client_metrics, usage_ledger) plus a
// frozen copy of the old core tables. Anything still writing core rows here — an old
// deployment a pinned tab talks to, a dev server on an old .env.local, a forgotten script —
// would put plays, or a rotated Spotify token, where nobody reads them. So while FENCE_FILE
// exists, a request carrying any statement that names a core table (after FROM, JOIN, INTO,
// UPDATE, TABLE, ON or `table_info(`, stored SQL resolved) is answered 503 and never reaches
// sqld; it fails loudly instead. Off when the file is absent. `touch` it on, `rm` it off: the
// check is a stat per request, no restart. meter-proxy.test.mjs pins the classifier on every
// SQL statement in src/lib/db.ts.
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const [LHOST, LPORT] = (process.env.LISTEN ?? "127.0.0.1:8090").split(":");
const [UHOST, UPORT] = (process.env.UPSTREAM ?? "127.0.0.1:8092").split(":");
const LOG_DIR = process.env.LOG_DIR ?? path.join(os.homedir(), "lazyboy-sqld", "querylog");
const FENCE_FILE = process.env.FENCE_FILE ?? path.join(os.homedir(), "lazyboy-sqld", "FENCE_CORE");

const CORE_TABLES = ["tracks", "plays", "contexts", "meta", "playlists", "playlist_tracks", "saved_tracks"];
// A core table right after one of the fence's keywords (optionally `IF [NOT] EXISTS`, a
// `main.` schema and a quote), or inside `table_info(`. `\b` after the name keeps `metadata`
// and `tracks_archive` out; client_metrics' `meta` COLUMN never follows a keyword.
const CORE_RE = new RegExp(
  String.raw`(?:\b(?:FROM|JOIN|INTO|UPDATE|TABLE|ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?|\btable_info\(\s*)` +
    String.raw`(?:main\.)?["'\`\[]?(${CORE_TABLES.join("|")})\b`,
  "i",
);

/** The core table a statement names, or null. Comments are stripped first. */
export function namesCoreTable(sql) {
  const code = String(sql ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  return code.match(CORE_RE)?.[1] ?? null;
}

/** The first statement in a hrana request body that names a core table, or null. Covers
 *  execute, batch (and /v3/cursor) steps, sequence (executeMultiple) and describe, with
 *  store_sql ids resolved within the request, plus the legacy `{statements}` body. A sql_id
 *  the request never defined can't be read, so it counts as core: fail closed. */
export function coreStatement(body) {
  const stored = new Map();
  for (const r of body?.requests ?? []) if (r?.type === "store_sql") stored.set(r.sql_id, r.sql);
  const texts = [];
  const take = (x) => {
    if (!x) return;
    if (typeof x.sql === "string") texts.push(x.sql);
    else if (x.sql_id != null) texts.push(stored.has(x.sql_id) ? stored.get(x.sql_id) : null);
  };
  for (const r of body?.requests ?? []) {
    if (r?.type === "execute") take(r.stmt);
    else if (r?.type === "batch") for (const st of r.batch?.steps ?? []) take(st?.stmt);
    else if (r?.type === "sequence" || r?.type === "describe") take(r);
  }
  for (const st of body?.batch?.steps ?? []) take(st?.stmt);
  for (const st of Array.isArray(body?.statements) ? body.statements : []) {
    texts.push(typeof st === "string" ? st : String(st?.q ?? ""));
  }
  for (const t of texts) {
    if (t === null) return "(a sql_id this request did not store)";
    // A sequence is several statements in one string; a match anywhere in it fences it.
    if (namesCoreTable(t)) return t;
  }
  return null;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** Whitespace-collapsed SQL plus a short hash of it: the key a rollup groups by. */
function fingerprint(sql) {
  const norm = String(sql ?? "").replace(/\s+/g, " ").trim();
  const h = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 10);
  return { fp: h, sql: norm.slice(0, 160) };
}

/** The statements a hrana request carries, in result order. */
function requestStmts(body) {
  const stmts = [];
  const pushBatch = (b) => {
    for (const s of b?.steps ?? []) stmts.push(s?.stmt ?? null);
  };
  if (Array.isArray(body?.requests)) {
    for (const r of body.requests) {
      if (r?.type === "execute") stmts.push(r.stmt ?? null);
      else if (r?.type === "batch") pushBatch(r.batch);
      else stmts.push(undefined); // close / sequence / describe…: no per-statement result
    }
  } else if (body?.batch) {
    pushBatch(body.batch); // /v3/cursor
  }
  return stmts;
}

/** Pair each statement with the counters sqld reported for it. */
function measure(urlPath, reqBody, resText) {
  const out = [];
  // Batches (and transactions) send their SQL once as `store_sql` and then refer to it by id.
  const stored = new Map();
  for (const r of reqBody?.requests ?? []) if (r?.type === "store_sql") stored.set(r.sql_id, r.sql);
  const add = (stmt, res) => {
    if (!res) return;
    const text = stmt?.sql ?? (stmt?.sql_id != null ? (stored.get(stmt.sql_id) ?? `sql_id:${stmt.sql_id}`) : "");
    const { fp, sql } = fingerprint(text);
    out.push({ fp, sql, rr: res.rows_read ?? 0, rw: res.rows_written ?? 0, qms: res.query_duration_ms ?? null });
  };
  const stmts = requestStmts(reqBody);
  if (urlPath.endsWith("/cursor")) {
    // NDJSON: first line is the cursor header, then step_begin/row/step_end entries.
    let i = 0;
    const steps = reqBody?.batch?.steps ?? [];
    for (const line of resText.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "step_begin") i = e.step;
      if (e.type === "step_end") add(steps[i]?.stmt, e);
    }
    return out;
  }
  const json = JSON.parse(resText);
  let si = 0;
  for (const [k, r] of (json.results ?? []).entries()) {
    const reqItem = reqBody?.requests?.[k];
    const resp = r?.response;
    if (reqItem?.type === "execute") {
      add(stmts[si], resp?.result);
      si++;
    } else if (reqItem?.type === "batch") {
      const steps = reqItem.batch?.steps ?? [];
      const results = resp?.result?.step_results ?? [];
      steps.forEach((s, j) => add(s?.stmt, results[j]));
      si += steps.length;
    } else {
      si++;
    }
  }
  return out;
}

function logLine(entry) {
  const day = entry.ts.slice(0, 10);
  fs.appendFile(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify(entry) + "\n", () => {});
}

function decode(buf, enc) {
  if (enc === "gzip") return zlib.gunzipSync(buf);
  if (enc === "br") return zlib.brotliDecompressSync(buf);
  if (enc === "deflate") return zlib.inflateSync(buf);
  return buf;
}

function fenced(req, reqBuf) {
  if (req.method !== "POST" || !fs.existsSync(FENCE_FILE)) return null;
  let body;
  try {
    body = JSON.parse(reqBuf.toString("utf8"));
  } catch {
    return null; // not a statement; sqld answers it as it would anyway
  }
  return coreStatement(body);
}

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  const ts = new Date().toISOString();
  const reqChunks = [];
  req.on("data", (c) => reqChunks.push(c));
  req.on("end", () => {
    const reqBuf = Buffer.concat(reqChunks);
    const hit = fenced(req, reqBuf);
    if (hit) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end(
        `meter-proxy: core fence is on (${FENCE_FILE}). The app's core data lives on Turso now; ` +
          `this caller still points core statements at the Zenbook. docs/STORE_MIGRATION.md §6.8`,
      );
      const { fp, sql } = fingerprint(hit);
      logLine({ ts, path: req.url, status: 503, ms: Math.round(performance.now() - t0), fenced: { fp, sql } });
      return;
    }
    const up = http.request(
      { host: UHOST, port: UPORT, method: req.method, path: req.url, headers: req.headers, agent },
      (ures) => {
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        const resChunks = [];
        let firstByteMs = null;
        ures.on("data", (c) => {
          if (firstByteMs === null) firstByteMs = performance.now() - t0;
          resChunks.push(c);
          res.write(c);
        });
        ures.on("end", () => {
          res.end();
          const entry = {
            ts,
            path: req.url,
            status: ures.statusCode,
            ms: Math.round(performance.now() - t0),
            ttfb: firstByteMs === null ? null : Math.round(firstByteMs),
            bytes: resChunks.reduce((n, c) => n + c.length, 0),
            funnel: req.headers["tailscale-funnel-request"] ? 1 : 0,
          };
          try {
            if (req.method === "POST" && /\/v[23]\/(pipeline|cursor)$/.test(req.url ?? "")) {
              const body = reqBuf.length ? JSON.parse(reqBuf.toString("utf8")) : null;
              const text = decode(Buffer.concat(resChunks), ures.headers["content-encoding"]).toString("utf8");
              entry.stmts = measure(req.url, body, text);
            }
          } catch (e) {
            entry.meterError = String(e).slice(0, 200);
          }
          logLine(entry);
        });
        ures.on("error", () => res.destroy());
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`meter-proxy upstream error: ${e.message}`);
      logLine({ ts, path: req.url, status: 502, ms: Math.round(performance.now() - t0), meterError: String(e) });
    });
    up.end(reqBuf);
  });
});
server.keepAliveTimeout = 65_000;

// Run as a service, not when the test imports the classifier.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  server.listen(Number(LPORT), LHOST, () =>
    console.log(
      `meter-proxy ${LHOST}:${server.address().port} -> ${UHOST}:${UPORT}, log ${LOG_DIR}, fence ${FENCE_FILE}`,
    ),
  );
}
