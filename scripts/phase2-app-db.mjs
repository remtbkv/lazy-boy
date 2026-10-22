// Multi-user Phase 2, PLAN.md §11.4 step 1 and step 5's checks, from the Mac.
//
//   node scripts/phase2-app-db.mjs --dry-run         # say what step 1 would do; write nothing
//   node scripts/phase2-app-db.mjs                   # step 1: create lazyboy-app, apply APP_SCHEMA,
//                                                    #   insert the admin's users row
//   node scripts/phase2-app-db.mjs --snapshot-out F  # before step 2: lazyboy's seven counts,
//                                                    #   max(played_at) and meta key NAMES into F
//   node scripts/phase2-app-db.mjs --verify --snapshot F   # step 5's checks against F
//
// Needs OWNER_UID and SPOTIFY_OWNER_ID in the environment (or --owner-uid / --spotify-owner-id),
// and the Turso platform token in the macOS Keychain item `lazyboy-turso-platform`, which it
// reads into memory and never prints. With it the script mints a one-hour token per database it
// opens. It never reads or needs TOKEN_KEYS and refuses to run with it set: every operation
// that needs the token key happens in the runtime (PLAN.md §5.3, security R9), including the
// sentinel blobs and the copy of the admin's token, which --verify only checks for.
//
// Re-runnable: an existing lazyboy-app in group `default` is reused, the schema steps are
// `IF NOT EXISTS`, and the admin row is inserted only if no row with that uid exists.
//
// It reads only Rem's database and aggregates: counts, a max, meta key names (never values,
// since `spotify_tokens` holds his grant), and the app database's rows for the admin.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { APP_SCHEMA_VERSION, adminRowStatement, appSchemaBatches } from "../src/lib/app-schema.ts";
import { makeStoreFetch } from "../src/lib/store-fetch.ts";

const API = "https://api.turso.tech/v1";
const APP_DB = "lazyboy-app";
const USER_DB = "lazyboy";
const GROUP = "default";
const SEVEN = ["tracks", "plays", "contexts", "meta", "playlists", "playlist_tracks", "saved_tracks"];
const PHASE1_KEYS = ["owner_uid", "schema_version", "min_reader", "store_epoch"];
// Keys whose presence comes and goes with ordinary activity, so they are no check (migration 16).
const VOLATILE = /^(plsnap:|lock:)/;
const UID_RE = /^[a-z2-7]{12}$/;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const a = { dryRun: false, verify: false, snapshot: null, snapshotOut: null, org: "remtbkv", ownerUid: null, spotifyOwnerId: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--verify") a.verify = true;
    else if (k === "--snapshot") a.snapshot = argv[++i];
    else if (k === "--snapshot-out") a.snapshotOut = argv[++i];
    else if (k === "--org") a.org = argv[++i];
    else if (k === "--owner-uid") a.ownerUid = argv[++i];
    else if (k === "--spotify-owner-id") a.spotifyOwnerId = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

/** The real world: the Keychain, the Platform API over fetch, libSQL clients over the store
 *  fetch, verify-derived as a child process. Tests pass their own. */
export function realDeps() {
  return {
    platformToken: () =>
      execFileSync("security", ["find-generic-password", "-s", "lazyboy-turso-platform", "-w"], { encoding: "utf8" }).trim(),
    fetch: (url, init) => fetch(url, init),
    open: (url, authToken) => createClient({ url, authToken, intMode: "number", fetch: makeStoreFetch() }),
    verifyDerived: (url, authToken, uid) => {
      try {
        execFileSync(process.execPath, [path.join(REPO, "scripts/verify-derived.mjs"), "--user", uid], {
          env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken, OWNER_UID: uid },
          stdio: "inherit",
        });
        return true;
      } catch {
        return false;
      }
    },
    log: (s) => console.log(s),
    now: () => Date.now(),
  };
}

function platform(deps, org, token) {
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
    async token(name, authorization) {
      const r = await call("POST", `/databases/${name}/auth/tokens?expiration=1h&authorization=${authorization}`);
      if (r.status !== 200 || !r.json.jwt) throw new Error(`token for ${name}: ${r.status}`);
      return r.json.jwt;
    },
  };
}

const url = (db) => `https://${db.Hostname}`;

async function schemaState(c) {
  try {
    const r = await c.execute("SELECT key, value FROM app_meta WHERE key IN ('schema_version', 'min_reader')");
    const m = Object.fromEntries(r.rows.map((x) => [String(x.key), Number(x.value)]));
    return { version: m.schema_version ?? 0, minReader: m.min_reader ?? 0 };
  } catch (e) {
    if (/no such table/i.test(String(e))) return { version: 0, minReader: 0 };
    throw e;
  }
}

function owner(args, env) {
  const uid = args.ownerUid ?? env.OWNER_UID;
  const sid = args.spotifyOwnerId ?? env.SPOTIFY_OWNER_ID;
  if (!UID_RE.test(uid ?? "")) throw new Error("OWNER_UID is unset or not a uid (12 base32 characters)");
  if (!sid) throw new Error("SPOTIFY_OWNER_ID is unset");
  return { uid, sid };
}

/** Step 1. Returns the admin row as written. */
export async function stepOne(args, deps, env = process.env) {
  const { uid, sid } = owner(args, env);
  const api = platform(deps, args.org, deps.platformToken());
  let db = await api.database(APP_DB);
  if (db && db.group && db.group !== GROUP) throw new Error(`${APP_DB} exists in group ${db.group}, not ${GROUP}`);
  if (args.dryRun) {
    deps.log(`dry run: ${db ? `${APP_DB} exists (${db.Hostname}); would reuse it` : `would create ${APP_DB} in group ${GROUP}`}`);
    deps.log(`dry run: would apply APP_SCHEMA up to version ${APP_SCHEMA_VERSION}`);
    deps.log(`dry run: would insert users row uid=${uid} spotify_id=${sid} db_name=lazyboy status=active is_admin=1 session_epoch=0 account_id=NULL`);
    return null;
  }
  if (!db) {
    db = await api.create(APP_DB);
    deps.log(`created ${APP_DB} (${db.Hostname})`);
  } else deps.log(`${APP_DB} exists (${db.Hostname}); reusing it`);
  const c = deps.open(url(db), await api.token(APP_DB, "full-access"));
  try {
    const s = await schemaState(c);
    if (s.minReader > APP_SCHEMA_VERSION) throw new Error(`${APP_DB} needs newer code (min_reader ${s.minReader})`);
    for (const batch of appSchemaBatches(s.version, s.minReader)) await c.batch(batch, "write");
    deps.log(`schema at version ${APP_SCHEMA_VERSION} (was ${s.version})`);
    await c.execute(adminRowStatement(uid, sid, deps.now()));
    const r = await c.execute({
      sql: "SELECT uid, account_id, spotify_id, db_name, status, is_admin, session_epoch FROM users WHERE uid = ?",
      args: [uid],
    });
    const row = r.rows[0];
    if (!row || row.spotify_id !== sid || row.db_name !== "lazyboy" || Number(row.is_admin) !== 1) {
      throw new Error("the users row for OWNER_UID is not the admin row this step writes; stopping");
    }
    deps.log(`admin row: uid=${row.uid} db_name=${row.db_name} status=${row.status} is_admin=1 epoch=${row.session_epoch} account_id=${row.account_id ?? "NULL"}`);
    return { ...row };
  } finally {
    c.close();
  }
}

/** lazyboy's counts, newest play and meta key names (never values). `meta` is counted without
 *  the keys ordinary activity adds and removes. */
async function userDbState(c) {
  const counts = {};
  for (const t of SEVEN) {
    const sql = t === "meta" ? "SELECT count(*) AS n FROM meta WHERE key NOT LIKE 'plsnap:%' AND key NOT LIKE 'lock:%'" : `SELECT count(*) AS n FROM ${t}`;
    counts[t] = Number((await c.execute(sql)).rows[0].n);
  }
  const maxPlayedAt = (await c.execute("SELECT max(played_at) AS m FROM plays")).rows[0].m ?? null;
  const metaKeys = (await c.execute("SELECT key FROM meta ORDER BY key")).rows.map((r) => String(r.key));
  return { counts, maxPlayedAt: maxPlayedAt === null ? null : String(maxPlayedAt), metaKeys };
}

export async function snapshotOut(args, deps) {
  const api = platform(deps, args.org, deps.platformToken());
  const db = await api.database(USER_DB);
  if (!db) throw new Error(`${USER_DB} not found`);
  const c = deps.open(url(db), await api.token(USER_DB, "read-only"));
  try {
    const s = { at: new Date(deps.now()).toISOString(), ...(await userDbState(c)) };
    writeFileSync(args.snapshotOut, JSON.stringify(s, null, 2) + "\n");
    deps.log(`snapshot written: ${args.snapshotOut} (plays ${s.counts.plays}, max(played_at) ${s.maxPlayedAt})`);
    return s;
  } finally {
    c.close();
  }
}

/** Step 5's checks that the Mac can make. Returns { ok, results }. */
export async function verify(args, deps, env = process.env) {
  const { uid } = owner(args, env);
  const results = [];
  const check = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail });
  const api = platform(deps, args.org, deps.platformToken());

  const appDb = await api.database(APP_DB);
  check(`${APP_DB} exists in group ${GROUP}`, appDb && (!appDb.group || appDb.group === GROUP));
  if (appDb) {
    const c = deps.open(url(appDb), await api.token(APP_DB, "read-only"));
    try {
      const s = await schemaState(c);
      check("app schema at the code's version", s.version === APP_SCHEMA_VERSION, `version ${s.version}`);
      const admins = (await c.execute("SELECT uid, db_name, status, session_epoch, account_id FROM users WHERE is_admin = 1")).rows;
      const a = admins[0];
      check("exactly one admin row, OWNER_UID's", admins.length === 1 && a.uid === uid);
      check("admin row: db_name lazyboy, active, epoch 0", a && a.db_name === "lazyboy" && a.status === "active" && Number(a.session_epoch) === 0);
      // Not a check: his Phase 1 cookie stays valid, so the binding waits for his next sign-in.
      if (a) deps.log(`note: admin account_id ${a.account_id === null ? "not bound yet (binds at his next sign-in)" : "bound"}`);
      const tok = (await c.execute({ sql: "SELECT expires_at, granted_at, substr(blob, 1, 3) AS p FROM user_tokens WHERE uid = ?", args: [uid] })).rows[0];
      check("admin user_tokens row, encrypted (v<n>.)", tok && /^v\d\./.test(String(tok.p)));
      const meta = Object.fromEntries(
        (await c.execute("SELECT key, value FROM app_meta WHERE key = ? OR key LIKE 'sentinel:%'", [`token_copy:${uid}`])).rows.map((r) => [
          String(r.key),
          String(r.value),
        ]),
      );
      const copy = meta[`token_copy:${uid}`] ?? "";
      check("the runtime's copy ran and verified (token_copy marker)", /^(copied|row-present):/.test(copy), copy.split(":")[0]);
      check("a sentinel per token key, written by the runtime", Object.keys(meta).some((k) => k.startsWith("sentinel:")));
      const ev = Number((await c.execute("SELECT count(*) AS n FROM events")).rows[0].n);
      check("no events", ev === 0, `${ev} events`);
    } finally {
      c.close();
    }
  }

  const userDb = await api.database(USER_DB);
  check(`${USER_DB} exists`, userDb);
  if (userDb) {
    const token = await api.token(USER_DB, "read-only");
    const c = deps.open(url(userDb), token);
    let now;
    try {
      now = await userDbState(c);
    } finally {
      c.close();
    }
    const keys = new Set(now.metaKeys);
    for (const k of PHASE1_KEYS) check(`lazyboy.meta has ${k} (Phase 1)`, keys.has(k));
    check("lazyboy.meta still has spotify_tokens (until step 6)", keys.has("spotify_tokens"));
    if (args.snapshot) {
      const before = JSON.parse(readFileSync(args.snapshot, "utf8"));
      for (const t of SEVEN) check(`${t} count at or above the snapshot`, now.counts[t] >= before.counts[t], `${before.counts[t]} -> ${now.counts[t]}`);
      check("max(played_at) moved past the snapshot", now.maxPlayedAt !== null && now.maxPlayedAt > (before.maxPlayedAt ?? ""), `${before.maxPlayedAt} -> ${now.maxPlayedAt}`);
      const gone = before.metaKeys.filter((k) => !VOLATILE.test(k) && !keys.has(k));
      check("no meta key removed", gone.length === 0, gone.join(", "));
    } else {
      check("a snapshot to compare against (--snapshot)", false, "counts, max(played_at) and removed keys not checked");
    }
    check("verify-derived green", deps.verifyDerived(url(userDb), token, uid));
  }

  for (const r of results) deps.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  deps.log("by hand: Rem still signed in (a page view after the deploy); the recorder diff over the window empty");
  return { ok: results.every((r) => r.pass), results };
}

export async function main(argv, deps = realDeps(), env = process.env) {
  if (env.TOKEN_KEYS !== undefined) {
    deps.log("refusing: TOKEN_KEYS is set in this environment. This script never needs the token key; unset it.");
    return 2;
  }
  const args = parseArgs(argv);
  if (args.snapshotOut) return (await snapshotOut(args, deps), 0);
  if (args.verify) return (await verify(args, deps, env)).ok ? 0 : 1;
  await stepOne(args, deps, env);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`phase2-app-db: ${e.message}`);
      process.exit(1);
    },
  );
}
