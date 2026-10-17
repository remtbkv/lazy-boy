// What scripts/invite.mjs and scripts/user.mjs share on the Mac (docs/multi-user/PLAN.md §5.5,
// §12.1): the Turso platform token read from the Keychain item `lazyboy-turso-platform` into
// memory (never printed, never in .env.local), the Platform API, one-hour tokens per database
// opened, the app database `lazyboy-app`, the telemetry store for the lifecycle log, and the
// deletion job's dependencies over all of them. Every dependency is a parameter so the tests run
// the scripts against a scripted Platform API and local files.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { TELEMETRY_SQL, TELEMETRY_USER_TABLES } from "../src/lib/deletion.ts";
import { makeStoreFetch } from "../src/lib/store-fetch.ts";

export const API = "https://api.turso.tech/v1";
export const APP_DB = "lazyboy-app";
export const GROUP = "default";
export const ORG = "remtbkv";
export const UID_RE = /^[a-z2-7]{12}$/;

/** The real world. Tests pass their own. */
export function realDeps(env = process.env) {
  return {
    env,
    platformToken: () =>
      execFileSync("security", ["find-generic-password", "-s", "lazyboy-turso-platform", "-w"], { encoding: "utf8" }).trim(),
    fetch: (url, init) => fetch(url, init),
    open: (url, authToken) => createClient({ url, authToken, intMode: "number", fetch: makeStoreFetch() }),
    log: (s) => console.log(s),
    now: () => Date.now(),
    randomBytes: (n) => randomBytes(n),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function platform(deps, org = deps.env.TURSO_ORG || ORG) {
  const token = deps.platformToken();
  const call = async (method, p, body) => {
    const res = await deps.fetch(`${API}/organizations/${org}${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  return {
    async database(name) {
      const r = await call("GET", `/databases/${name}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`GET database ${name}: ${r.status} ${r.json.error ?? ""}`);
      return r.json.database;
    },
    async create(name) {
      const r = await call("POST", "/databases", { name, group: GROUP });
      if (r.status !== 200) throw new Error(`create ${name}: ${r.status} ${r.json.error ?? ""}`);
      return r.json.database;
    },
    async destroy(name) {
      if (!/^lb-u-[a-z2-7]{12}$/.test(name)) throw new Error(`refusing to destroy ${name}: only a friend's lb-u-<uid>`);
      const r = await call("DELETE", `/databases/${name}`);
      if (r.status !== 200 && r.status !== 404) throw new Error(`destroy ${name}: ${r.status}`);
    },
    async token(name, authorization = "full-access") {
      const r = await call("POST", `/databases/${name}/auth/tokens?expiration=1h&authorization=${authorization}`);
      if (r.status !== 200 || !r.json.jwt) throw new Error(`token for ${name}: ${r.status}`);
      return r.json.jwt;
    },
  };
}

/** A client on one database by name, on a one-hour token; null when Turso has no such database. */
export async function openByName(deps, plat, name, authorization = "full-access") {
  const db = await plat.database(name);
  if (!db) return null;
  return deps.open(`https://${db.Hostname}`, await plat.token(name, authorization));
}

export async function openApp(deps, plat) {
  const c = await openByName(deps, plat, APP_DB);
  if (!c) throw new Error(`${APP_DB} does not exist (scripts/phase2-app-db.mjs creates it)`);
  return c;
}

/** The telemetry store, for the lifecycle log (§12.2, §12.5): TELEMETRY_DATABASE_URL and
 *  TELEMETRY_AUTH_TOKEN from the shell. Null when unset; the scripts then refuse to change anything. */
export function openTelemetry(deps) {
  const url = deps.env.TELEMETRY_DATABASE_URL;
  return url ? deps.open(url, deps.env.TELEMETRY_AUTH_TOKEN) : null;
}

export async function appendLifecycle(tele, e) {
  await tele.execute(TELEMETRY_SQL.lifecycleTable);
  await tele.execute({ sql: TELEMETRY_SQL.appendLifecycle, args: e });
}

/** deletion.ts's dependencies from the Mac: the same statements, the Mac's clients. */
export function macDeletionDeps(deps, plat, app, tele, by) {
  return {
    exec: async (stmts) => (await app.batch(stmts, "write")).map((r) => ({ rows: r.rows, rowsAffected: r.rowsAffected })),
    ownerOf: async (name) => {
      const c = await openByName(deps, plat, name);
      if (!c) return null;
      try {
        const r = await c.execute("SELECT value FROM meta WHERE key = 'owner_uid'");
        return r.rows[0] ? String(r.rows[0].value) : "";
      } catch {
        return "";
      } finally {
        c.close();
      }
    },
    destroy: (name) => plat.destroy(name),
    telemetry: {
      deleteUser: async (uid) => {
        for (const table of TELEMETRY_USER_TABLES) {
          const cols = await tele.execute(TELEMETRY_SQL.columns(table));
          if (cols.rows.some((r) => r.name === "user_id")) await tele.execute({ sql: TELEMETRY_SQL.deleteRows(table), args: { uid } });
        }
      },
      appendLifecycle: (e) => appendLifecycle(tele, e),
    },
    now: deps.now,
    by,
  };
}
