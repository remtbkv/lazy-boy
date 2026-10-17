// The rehearsal's Node preload (docs/multi-user/REHEARSAL.md), loaded with
// `NODE_OPTIONS=--import <this file>` into `next start` and into the Mac scripts the rehearsal runs
// (invite.mjs, phase2-app-db.mjs). In that process it:
//   - answers api.spotify.com, accounts.spotify.com and api.turso.tech from the stand-in
//     (standin.mjs), recording every call with the person its token belongs to;
//   - opens every store as a throwaway file under REHEARSAL_STORES (libsql-shim.mjs);
//   - refuses every other non-loopback connection, at fetch, at DNS and at the socket, and records
//     the attempt (`blocked` in the call record);
//   - answers the Keychain read of the Turso platform token with a throwaway one, so no script
//     reaches the real Keychain item;
//   - shifts the clock (Date, Date.now, performance.timeOrigin) by an offset the harness sets,
//     never the machine's;
//   - with REHEARSAL_CONTROL_PORT, serves a loopback control API for the harness: the clock, the
//     stand-in's state, a quiet-wait, the statement log, and the planted egress self-test.
import childProcess from "node:child_process";
import dns from "node:dns";
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStandin, PLATFORM_TOKEN } from "./standin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.REHEARSAL_DIR;
if (!DIR) throw new Error("rehearsal preload: REHEARSAL_DIR is unset");
const NAME = process.env.REHEARSAL_NAME || `script-${process.pid}`;
mkdirSync(DIR, { recursive: true });
const CALLS = path.join(DIR, `calls-${process.env.REHEARSAL_SERVER || NAME}.jsonl`);
const plants = new Set((process.env.REHEARSAL_PLANT ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const R = (globalThis.__rehearsal ??= { inflight: 0, activity: 0, stmts: [], stmtSeq: 0 });

// ── The clock ─────────────────────────────────────────────────────────────────────────────
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
let offset = Number(process.env.REHEARSAL_CLOCK_OFFSET_MS || 0);
function ShiftedDate(...a) {
  if (!new.target) return new RealDate(realNow() + offset).toString();
  return a.length ? new RealDate(...a) : new RealDate(realNow() + offset);
}
ShiftedDate.prototype = RealDate.prototype;
ShiftedDate.now = () => realNow() + offset;
ShiftedDate.UTC = RealDate.UTC;
ShiftedDate.parse = RealDate.parse;
Object.defineProperty(ShiftedDate, Symbol.hasInstance, { value: (x) => x instanceof RealDate });
globalThis.Date = ShiftedDate;
const realOrigin = performance.timeOrigin;
Object.defineProperty(performance, "timeOrigin", { get: () => realOrigin + offset, configurable: true });

// ── The record ────────────────────────────────────────────────────────────────────────────
const note = (e) => {
  try {
    appendFileSync(CALLS, JSON.stringify({ at: Date.now(), proc: NAME, ...e }) + "\n");
  } catch {
    /* ignore */
  }
};
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const blocked = (where, host) => {
  note({ blocked: where, host });
  return Object.assign(new Error(`rehearsal guard: ${where} to ${host} refused (only loopback and the stand-ins)`), { code: "REHEARSAL_EGRESS" });
};

// ── The stand-ins on fetch ────────────────────────────────────────────────────────────────
const standin = createStandin({ callsFile: CALLS, stores: process.env.REHEARSAL_STORES ?? path.join(DIR, "stores"), plants });
const realFetch = globalThis.fetch;
const STANDIN_HOSTS = new Set(["api.spotify.com", "accounts.spotify.com", "api.turso.tech"]);
globalThis.fetch = async function rehearsalFetch(input, init) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (LOOPBACK.has(u.hostname)) return realFetch(input, init);
  if (!STANDIN_HOSTS.has(u.hostname)) throw blocked("fetch", u.hostname);
  R.inflight++;
  R.activity++;
  try {
    return await standin.handle(input, init);
  } finally {
    R.inflight--;
    R.activity++;
  }
};

// ── The guard below fetch: DNS and sockets ────────────────────────────────────────────────
const realLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!LOOPBACK.has(host) && !net.isIP(host)) {
    const cb = rest.find((x) => typeof x === "function");
    const e = blocked("dns", host);
    if (cb) process.nextTick(() => cb(e));
    return {};
  }
  return realLookup.call(this, host, ...rest);
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a0 = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = null;
  if (a0 && typeof a0 === "object") host = a0.path ? null : (a0.host ?? "localhost");
  else if (typeof a0 === "number" || (typeof a0 === "string" && /^\d+$/.test(a0))) host = typeof args[1] === "string" ? args[1] : "localhost";
  if (host !== null && !LOOPBACK.has(host)) {
    const e = blocked("socket", host);
    process.nextTick(() => this.destroy(e));
    return this;
  }
  return realConnect.apply(this, args);
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async (host, o) => {
  if (!LOOPBACK.has(host) && !net.isIP(host)) throw blocked("dns", host);
  return realPromiseLookup(host, o);
};

// ── The Keychain: the platform token the scripts read, never the real item ─────────────────
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, opts) {
  if (file === "security") {
    note({ keychain: (args ?? []).join(" ") });
    if ((args ?? []).includes("lazyboy-turso-platform")) return opts?.encoding ? `${PLATFORM_TOKEN}\n` : Buffer.from(`${PLATFORM_TOKEN}\n`);
    throw blocked("keychain", (args ?? []).join(" "));
  }
  return realExecFileSync.call(this, file, args, opts);
};
syncBuiltinESMExports();

// ── The stores: every import of @libsql/client gets the shim ──────────────────────────────
const SHIM = pathToFileURL(path.join(HERE, "libsql-shim.mjs")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (/^@libsql\/client(-[0-9a-f]+)?$/.test(specifier) && context.parentURL !== SHIM) {
      return { url: SHIM, format: "module", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// ── Activity: requests this process is serving ─────────────────────────────────────────────
let control = null;
const realEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === "request" && this !== control) {
    R.inflight++;
    R.activity++;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      R.inflight--;
      R.activity++;
    };
    res.on("finish", end);
    res.on("close", end);
  }
  return realEmit.apply(this, arguments);
};

// ── The control API (servers only) ─────────────────────────────────────────────────────────
const port = Number(process.env.REHEARSAL_CONTROL_PORT || 0);
if (port) {
  // Each reply closes its connection. The harness blocks for seconds at a time (spawnSync of the
  // scripts and backup_check.py), past this server's 5-s keep-alive timeout; its next call on the
  // pooled connection then read ECONNRESET (check 7's first call, right after check 9's backups).
  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify(body));
  };
  control = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    try {
      if (url.pathname === "/clock" && req.method === "POST") {
        if (typeof b.offsetMs !== "number" || b.offsetMs < offset) return send(res, 400, { error: "the clock only moves forward" });
        offset = b.offsetMs;
        return send(res, 200, { offset, now: Date.now() });
      }
      if (url.pathname === "/clock") return send(res, 200, { offset, now: Date.now() });
      if (url.pathname === "/quiet") {
        const ms = Number(url.searchParams.get("ms") ?? 300);
        const limit = realNow() + Number(url.searchParams.get("timeout") ?? 60_000);
        let last = R.activity;
        let since = realNow();
        while (realNow() < limit) {
          await new Promise((r) => setTimeout(r, 25));
          if (R.inflight > 0 || R.activity !== last) {
            last = R.activity;
            since = realNow();
          } else if (realNow() - since >= ms) return send(res, 200, { quiet: true });
        }
        return send(res, 504, { quiet: false, inflight: R.inflight });
      }
      if (url.pathname === "/standin" && req.method === "POST") {
        if (b.op === "expire") standin.expire(b.tags);
        else if (b.op === "deadRefresh") standin.setDeadRefresh(b.tag, b.dead !== false);
        else if (b.op === "notRegistered") standin.setNotRegistered(b.tag, b.on !== false);
        else return send(res, 400, { error: "op" });
        return send(res, 200, standin.state());
      }
      if (url.pathname === "/standin") return send(res, 200, standin.state());
      if (url.pathname === "/stmts") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return send(res, 200, { seq: R.stmtSeq, stmts: R.stmts.filter((s) => s.seq > since) });
      }
      if (url.pathname === "/plant-egress") {
        // The guard's self-test: the same calls app code would make, to a real host.
        const out = {};
        try {
          await fetch("https://example.com/");
          out.fetch = "REACHED";
        } catch (e) {
          out.fetch = e.code ?? String(e);
        }
        out.socket = await new Promise((r) => {
          const s = net.connect(443, "93.184.215.14");
          s.on("connect", () => (s.destroy(), r("REACHED")));
          s.on("error", (e) => r(e.code ?? String(e)));
        });
        out.dns = await new Promise((r) => dns.lookup("example.com", (e) => r(e ? e.code ?? String(e) : "REACHED")));
        out.store = await (async () => {
          try {
            const { createClient } = await import("@libsql/client");
            await createClient({ url: "https://lazyboy-remtbkv.aws-us-east-1.turso.io" }).execute("SELECT 1");
            return "REACHED";
          } catch (e) {
            return /refusing store URL/.test(String(e)) ? "REHEARSAL_STORE_REFUSED" : String(e);
          }
        })();
        return send(res, 200, out);
      }
      return send(res, 404, { error: "no such control" });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  });
  control.listen(port, "127.0.0.1");
  control.unref();
}
