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
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const [LHOST, LPORT] = (process.env.LISTEN ?? "127.0.0.1:8090").split(":");
const [UHOST, UPORT] = (process.env.UPSTREAM ?? "127.0.0.1:8092").split(":");
const LOG_DIR = process.env.LOG_DIR ?? path.join(os.homedir(), "lazyboy-sqld", "querylog");
fs.mkdirSync(LOG_DIR, { recursive: true });

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

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  const ts = new Date().toISOString();
  const reqChunks = [];
  req.on("data", (c) => reqChunks.push(c));
  req.on("end", () => {
    const reqBuf = Buffer.concat(reqChunks);
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
server.listen(Number(LPORT), LHOST, () => console.log(`meter-proxy ${LHOST}:${LPORT} -> ${UHOST}:${UPORT}, log ${LOG_DIR}`));
