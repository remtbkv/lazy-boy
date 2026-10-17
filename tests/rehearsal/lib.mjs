// The rehearsal harness's plumbing (docs/multi-user/REHEARSAL.md): the run directory and its
// throwaway secrets, servers started and stopped by pid, the control API, HTTP with a cookie jar,
// the Mac scripts under the preload, and read-only looks at the throwaway stores.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
const PRELOAD = pathToFileURL(path.join(HERE, "preload.mjs")).href;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export const newUid = () => [...randomBytes(12)].map((b) => B32[b & 31]).join("");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep ≥ 4 GB free before a build, a server or a browser (lane RULES 5): ~/.claude/coord. */
export function waitForRam(gb = 4) {
  const coord = path.join(os.homedir(), ".claude/coord");
  if (!existsSync(coord)) return;
  const r = spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(coord)}); import coord; coord.wait_for_ram(${gb})`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("coord.wait_for_ram failed");
}

/** The run's secrets, generated here and never a production value: a mode-600 file in the run
 *  directory, deleted by `cleanup()`. */
export function makeSecrets(dir) {
  const s = {
    AUTH_SECRET: randomBytes(33).toString("base64"),
    AUTH_SECRET_PREVIEW: randomBytes(33).toString("base64"),
    CRON_SECRET: randomBytes(24).toString("hex"),
    CRON_SECRET_EXT: randomBytes(24).toString("hex"),
    TOKEN_KEYS: `v1:${randomBytes(32).toString("base64")}`,
    SPOTIFY_CLIENT_ID: "rehearsal-client-id",
    SPOTIFY_CLIENT_SECRET: randomBytes(16).toString("hex"),
    OWNER_UID: newUid(),
    SPOTIFY_OWNER_ID: "ADMINxspotify",
  };
  const file = path.join(dir, "secrets.env");
  writeFileSync(file, Object.entries(s).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { ...s, file };
}

/** One `next start` from the worktree's build, with the preload, on 127.0.0.1:port; its control
 *  API on port + 1000. Returns once both answer. */
export async function startServer(o) {
  waitForRam(4);
  const stores = o.stores ?? path.join(o.dir, o.name, "stores");
  mkdirSync(stores, { recursive: true });
  const logFile = path.join(o.dir, `server-${o.name}-${Date.now()}.log`);
  const out = openSync(logFile, "a");
  const origin = `http://127.0.0.1:${o.port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--import ${PRELOAD}`,
    REHEARSAL_DIR: o.dir,
    REHEARSAL_NAME: o.name,
    REHEARSAL_SERVER: o.name,
    REHEARSAL_STORES: stores,
    REHEARSAL_CONTROL_PORT: String(o.port + 1000),
    REHEARSAL_CLOCK_OFFSET_MS: String(o.offset ?? 0),
    REHEARSAL_PLANT: (o.plants ?? []).join(","),
    AUTH_URL: origin,
    TURSO_DATABASE_URL: "https://lazyboy.rehearsal.invalid",
    TURSO_AUTH_TOKEN: "rehearsal-group-token",
    APP_DATABASE_URL: "https://lazyboy-app.rehearsal.invalid",
    STORE_URL_TEMPLATE: "https://{db}.rehearsal.invalid",
    TELEMETRY_DATABASE_URL: "https://telemetry.rehearsal.invalid",
    TELEMETRY_AUTH_TOKEN: "rehearsal-telemetry-token",
    TURSO_PLATFORM_TOKEN: "rehearsal-platform-token",
    TURSO_ORG: "rehearsal",
    ...o.env,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined || v === null) delete env[k];
  const project = o.project ?? REPO;
  const child = spawn(process.execPath, [path.join(REPO, "node_modules/next/dist/bin/next"), "start", project, "-H", "127.0.0.1", "-p", String(o.port)], {
    cwd: project,
    env,
    stdio: ["ignore", out, out],
    detached: false,
  });
  const srv = { name: o.name, port: o.port, origin, pid: child.pid, child, stores, logFile, env, exited: null };
  child.on("exit", (code, sig) => (srv.exited = { code, sig }));
  const t0 = Date.now();
  for (;;) {
    if (srv.exited) throw new Error(`server ${o.name} exited ${JSON.stringify(srv.exited)}; see ${logFile}`);
    try {
      const r = await fetch(`${origin}/api/build`);
      const c = await fetch(`http://127.0.0.1:${o.port + 1000}/clock`);
      if (r.ok && c.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 120_000) throw new Error(`server ${o.name} not ready in 120 s; see ${logFile}`);
    await sleep(200);
  }
  return srv;
}

export async function stopServer(srv) {
  if (!srv || srv.exited) return;
  process.kill(srv.pid, "SIGTERM");
  const t0 = Date.now();
  while (!srv.exited && Date.now() - t0 < 15_000) await sleep(100);
  if (!srv.exited) process.kill(srv.pid, "SIGKILL");
  while (!srv.exited) await sleep(50);
}

export async function ctl(srv, p, body) {
  const r = await fetch(`http://127.0.0.1:${srv.port + 1000}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok && !p.startsWith("/quiet")) throw new Error(`control ${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

/** Wait until the server has served nothing and run no statement or stand-in call for `ms`. */
export async function quiet(srv, ms = 400, timeout = 90_000) {
  const j = await ctl(srv, `/quiet?ms=${ms}&timeout=${timeout}`);
  if (!j.quiet) throw new Error(`server ${srv.name} not quiet after ${timeout} ms (inflight ${j.inflight})`);
}

/** A cookie jar for one person in one "browser". */
export class Jar {
  constructor() {
    this.c = new Map();
  }
  header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv, ...attrs] = sc.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (!v || expired) this.c.delete(k);
      else this.c.set(k, v);
    }
  }
  set(k, v) {
    this.c.set(k, v);
  }
}

export async function req(srv, p, o = {}) {
  const headers = { ...(o.headers ?? {}) };
  if (o.jar) headers.cookie = o.jar.header();
  const res = await fetch(`${srv.origin}${p}`, { method: o.method ?? "GET", headers, body: o.body, redirect: "manual" });
  o.jar?.take(res);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, location: res.headers.get("location") };
}

/** A Mac script (invite.mjs, phase2-app-db.mjs) under the preload, against `stores`. */
export function runScript(dir, stores, script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_OPTIONS: `--import ${PRELOAD}`,
      REHEARSAL_DIR: dir,
      REHEARSAL_NAME: path.basename(script),
      REHEARSAL_SERVER: "scripts",
      REHEARSAL_STORES: stores,
      ...env,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** A read-only look at a throwaway store (synthetic users only). */
export function look(file, sql, ...args) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    d.exec("PRAGMA busy_timeout = 15000");
    return d.prepare(sql).all(...args);
  } finally {
    d.close();
  }
}

/** Write to a throwaway store (the harness's own plants and provisioning). */
export function write(file, statements) {
  const d = new DatabaseSync(file);
  try {
    d.exec("PRAGMA busy_timeout = 15000");
    for (const s of statements) {
      if (typeof s === "string") d.exec(s);
      else d.prepare(s.sql).run(...(Array.isArray(s.args) ? s.args : [s.args ?? {}]).map((a) => a));
    }
  } finally {
    d.close();
  }
}

/** The call record from where the last read stopped (a long run reads only what is new). */
export function callsTail(dir, server) {
  const f = path.join(dir, `calls-${server}.jsonl`);
  let pos = 0;
  let rest = "";
  return () => {
    if (!existsSync(f)) return [];
    const size = statSync(f).size;
    if (size <= pos) return [];
    const fd = openSync(f, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    return lines.filter(Boolean).map((l) => JSON.parse(l));
  };
}

export function readCalls(dir, server) {
  const f = path.join(dir, `calls-${server}.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** A copy of the build (its own .next/cache, an APFS clone) and of a server's stores, for a server
 *  whose plant must not reach the real build's cache or stores. */
export function shadow(dir, name, from) {
  const proj = path.join(dir, `${name}-project`);
  const stores = path.join(dir, name, "stores");
  rmSync(proj, { recursive: true, force: true });
  rmSync(path.dirname(stores), { recursive: true, force: true });
  mkdirSync(proj, { recursive: true });
  mkdirSync(path.dirname(stores), { recursive: true });
  for (const f of ["package.json", "next.config.ts", "node_modules", "public", "tsconfig.json"]) {
    if (existsSync(path.join(REPO, f))) spawnSync("ln", ["-s", path.join(REPO, f), path.join(proj, f)]);
  }
  const cp = (a, b) => {
    const r = spawnSync("cp", ["-cR", a, b]);
    if (r.status !== 0) throw new Error(`cp -cR ${a} ${b}: ${r.stderr}`);
  };
  cp(path.join(REPO, ".next"), path.join(proj, ".next"));
  if (from) cp(from, stores);
  else mkdirSync(stores, { recursive: true });
  return { project: proj, stores };
}

export function cleanupSecrets(secrets) {
  rmSync(secrets.file, { force: true });
}
