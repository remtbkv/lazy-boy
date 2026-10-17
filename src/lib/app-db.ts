// Every statement the runtime runs on the app database, `lazyboy-app` (docs/multi-user/PLAN.md
// §4.2, §5.1-5.3, §6.2 layer 7): identity, encrypted tokens, locks, global keys and events, no
// listening data. A short list on purpose, so a reviewer can read it in one sitting; the
// schema itself is src/lib/app-schema.ts. The statements that take no uid (the sign-in lookup
// by account_id, the admin's first binding, the global keys) are cross-user by design and each
// has a test (tests/isolation/app-db.test.ts, T6).
//
// The client is built here and nowhere else, over makeStoreFetch (the gzip pin, the retry
// ladder, the Request rebuilt per attempt), with `https://` URLs only: @libsql/client sends
// `libsql://` over WebSockets, where the fetch override does not apply (PLAN.md §4.2).
// APP_DATABASE_URL unset means dev: a local file beside the dev store, its own app database
// with its own key (§5.5). Dev never holds production's URL, and a deployment never runs
// without one.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { APP_SCHEMA, APP_SCHEMA_VERSION, appSchemaBatches, USER_STATUSES, type UserStatus } from "@/lib/app-schema";
import type { IdentityRow } from "@/lib/identity";
import { makeStoreFetch } from "@/lib/store-fetch";

export { APP_SCHEMA, APP_SCHEMA_VERSION, USER_STATUSES, type UserStatus };

type Env = Record<string, string | undefined>;

/** Where the app database is, by environment. Throws rather than fall back on a deployment. */
export function appDatabaseUrl(env: Env = process.env): string {
  const deployed = env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
  const url = env.APP_DATABASE_URL?.trim();
  if (url) {
    if (url.startsWith("https://")) {
      if (env.VERCEL_ENV !== "production") {
        throw new Error("APP_DATABASE_URL: a remote app database is production's; dev runs its own file");
      }
      return url;
    }
    if (url.startsWith("file:") && !deployed) return url;
    throw new Error("APP_DATABASE_URL must be https:// (libsql:// rides WebSockets, outside the store fetch)");
  }
  if (deployed) throw new Error("APP_DATABASE_URL is unset");
  // Beside the dev store's file (data/ in dev, the throwaway directory under npm test).
  const dev = env.TURSO_DATABASE_URL?.startsWith("file:") ? env.TURSO_DATABASE_URL.slice(5) : null;
  const dir = dev ? path.dirname(dev) : path.join(process.cwd(), "data");
  return `file:${path.join(dir, "app.db")}`;
}

// One client per process, rebuilt if the URL changes (which only tests do).
const g = globalThis as unknown as { __lbAppDb?: { url: string; ready: Promise<Client> } };

function appClient(): Promise<Client> {
  const url = appDatabaseUrl();
  if (g.__lbAppDb?.url === url) return g.__lbAppDb.ready;
  const ready = openApp(url);
  g.__lbAppDb = { url, ready };
  ready.catch(() => {
    if (g.__lbAppDb?.ready === ready) g.__lbAppDb = undefined;
  });
  return ready;
}

async function openApp(url: string): Promise<Client> {
  const local = url.startsWith("file:");
  if (local) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });
  const client = createClient({
    url,
    authToken: local ? undefined : process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
    fetch: makeStoreFetch(),
  });
  // Production code alone applies additive steps to a remote database; dev applies them to
  // its own file. Anything else refuses and waits for the production deploy (§4.5).
  await ensureAppSchema(client, local || process.env.VERCEL_ENV === "production");
  return client;
}

/** Bring the database to the code's version, or refuse (PLAN.md §4.5). One read when current. */
export async function ensureAppSchema(client: Client, mayApply: boolean): Promise<void> {
  let version = 0;
  let minReader = 0;
  try {
    const r = await client.execute(
      "SELECT key, value FROM app_meta WHERE key IN ('schema_version', 'min_reader')",
    );
    for (const row of r.rows) {
      if (row.key === "schema_version") version = Number(row.value);
      if (row.key === "min_reader") minReader = Number(row.value);
    }
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
  }
  if (minReader > APP_SCHEMA_VERSION) throw new Error("app database: needs newer code (min_reader)");
  if (version >= APP_SCHEMA_VERSION) return;
  if (APP_SCHEMA.some((s) => s.version > version && s.kind === "rebuild")) {
    throw new Error("app database: waiting for the migrate script");
  }
  if (!mayApply) throw new Error("app database: behind the code; waiting for the production deploy");
  for (const batch of appSchemaBatches(version, minReader)) await client.batch(batch, "write");
}

const one = async (stmt: InStatement) => (await appClient()).execute(stmt);

// ── users ───────────────────────────────────────────────────────────────────────────────

export type UserRow = {
  uid: string;
  accountId: string | null;
  spotifyId: string;
  dbName: string;
  status: UserStatus;
  statusAt: number;
  isAdmin: boolean;
  sessionEpoch: number;
};
const USER_COLS = "uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch";
const toUser = (r: Record<string, unknown>): UserRow => ({
  uid: String(r.uid),
  accountId: r.account_id == null ? null : String(r.account_id),
  spotifyId: String(r.spotify_id),
  dbName: String(r.db_name),
  status: String(r.status) as UserStatus,
  statusAt: Number(r.status_at),
  isAdmin: Number(r.is_admin) === 1,
  sessionEpoch: Number(r.session_epoch),
});

/** The identity read every later request makes (PLAN.md §5.1): identity, token, capture health
 *  and the cooldown in one statement of primary-key probes. */
export type AppIdentityRow = IdentityRow & {
  dbName: string;
  blob: string | null;
  expiresAt: number | null;
  syncState: string | null;
  lastOkAt: number | null;
  lastHarvestAt: number | null;
  rpCooldown: string | null;
};
const num = (v: unknown) => (v == null ? null : Number(v));

export async function readIdentityRow(uid: string): Promise<AppIdentityRow | null> {
  const r = await one({
    sql: `SELECT u.status, u.session_epoch, u.is_admin, u.db_name,
                 t.blob, t.expires_at, s.state, s.last_ok_at, s.last_harvest_at,
                 (SELECT value FROM app_meta WHERE key = 'cooldown:recently-played') AS rp_cooldown
          FROM users u
          LEFT JOIN user_tokens t ON t.uid = u.uid
          LEFT JOIN sync_state  s ON s.uid = u.uid
          WHERE u.uid = :uid`,
    args: { uid },
  });
  const x = r.rows[0];
  if (!x) return null;
  return {
    status: String(x.status),
    sessionEpoch: Number(x.session_epoch),
    isAdmin: Number(x.is_admin) === 1,
    dbName: String(x.db_name),
    blob: x.blob == null ? null : String(x.blob),
    expiresAt: num(x.expires_at),
    syncState: x.state == null ? null : String(x.state),
    lastOkAt: num(x.last_ok_at),
    lastHarvestAt: num(x.last_harvest_at),
    rpCooldown: x.rp_cooldown == null ? null : String(x.rp_cooldown),
  };
}

/** Sign-in's lookup (cross-user by design): the row Spotify's stable account_id links to. */
export async function findUserByAccountId(accountId: string): Promise<UserRow | null> {
  const r = await one({ sql: `SELECT ${USER_COLS} FROM users WHERE account_id = :aid`, args: { aid: accountId } });
  return r.rows[0] ? toUser(r.rows[0]) : null;
}

/** The admin's first Phase 2 sign-in binds his account_id (PLAN.md §11.4 step 1), once, and
 *  only on the admin row naming that Spotify id (cross-user by design: no uid yet). */
export async function bindAdminAccount(accountId: string, spotifyId: string, now: number): Promise<UserRow | null> {
  const r = await one({
    sql: `UPDATE users SET account_id = :aid, last_sign_in = :now
          WHERE is_admin = 1 AND account_id IS NULL AND spotify_id = :sid
          RETURNING ${USER_COLS}`,
    args: { aid: accountId, sid: spotifyId, now },
  });
  return r.rows[0] ? toUser(r.rows[0]) : null;
}

/** A returning sign-in: stamp it, and follow a changed Spotify id (account_id is the link). */
export async function recordSignIn(uid: string, spotifyId: string, now: number): Promise<void> {
  await one({
    sql: "UPDATE users SET last_sign_in = :now, spotify_id = :sid WHERE uid = :uid",
    args: { uid, sid: spotifyId, now },
  });
}

/** The one writer of `users.status` (PLAN.md §4.2): a compare-and-set from the status the
 *  caller read, stamping `status_at`. True when this call moved the row; false when someone
 *  else moved it first, so a returning sign-in and the deletion job cannot both win. */
export async function moveStatus(uid: string, from: UserStatus, to: UserStatus, now: number): Promise<boolean> {
  for (const s of [from, to]) if (!USER_STATUSES.includes(s)) throw new Error(`unknown status ${s}`);
  const r = await one({
    sql: "UPDATE users SET status = :to, status_at = :now WHERE uid = :uid AND status = :from",
    args: { uid, from, to, now },
  });
  return r.rowsAffected === 1;
}

// ── user_tokens ─────────────────────────────────────────────────────────────────────────
// A token row may be written only while its owner is live, and a refresh writes only over the
// blob it read (PLAN.md §5.2): a write landing after the deletion job's first step stores
// nothing (security R3), and a refresh that read the old grant before a sign-in cannot
// overwrite the new one (security R4).

// PLAN.md's list minus `dormant` (RULINGS Oct 15 12:26 PM).
const LIVE = `EXISTS (SELECT 1 FROM users WHERE uid = :uid AND status IN ('active', 'needs_reconnect', 'revoked'))`;

export type TokenRow = { blob: string; expiresAt: number; grantedAt: number };

export async function readTokenRow(uid: string): Promise<TokenRow | null> {
  const r = await one({ sql: "SELECT blob, expires_at, granted_at FROM user_tokens WHERE uid = :uid", args: { uid } });
  const x = r.rows[0];
  return x ? { blob: String(x.blob), expiresAt: Number(x.expires_at), grantedAt: Number(x.granted_at) } : null;
}

/** A sign-in's write: insert or replace, only while the user is live. True when it landed. */
export async function writeSignInTokens(uid: string, row: TokenRow): Promise<boolean> {
  const r = await one({
    sql: `INSERT INTO user_tokens (uid, blob, expires_at, granted_at)
          SELECT :uid, :blob, :exp, :granted WHERE ${LIVE}
          ON CONFLICT(uid) DO UPDATE SET blob = excluded.blob, expires_at = excluded.expires_at,
                                         granted_at = excluded.granted_at`,
    args: { uid, blob: row.blob, exp: row.expiresAt, granted: row.grantedAt },
  });
  return r.rowsAffected === 1;
}

/** The runtime's copy of a plaintext row (PLAN.md §11.4 step 3): only where no row exists. */
export async function insertTokensIfAbsent(uid: string, row: TokenRow): Promise<boolean> {
  const r = await one({
    sql: `INSERT INTO user_tokens (uid, blob, expires_at, granted_at)
          SELECT :uid, :blob, :exp, :granted WHERE ${LIVE}
          ON CONFLICT(uid) DO NOTHING`,
    args: { uid, blob: row.blob, exp: row.expiresAt, granted: row.grantedAt },
  });
  return r.rowsAffected === 1;
}

/** A refresh's write, only over the blob it read. `granted_at` moves only when the refresh
 *  token changed (Spotify's six-month clock runs from the grant). False: the row moved on. */
export async function updateTokensIfUnchanged(
  uid: string,
  readBlob: string,
  next: { blob: string; expiresAt: number; rotated: boolean; now: number },
): Promise<boolean> {
  const r = await one({
    sql: `UPDATE user_tokens SET blob = :blob, expires_at = :exp,
                 granted_at = CASE WHEN :rotated = 1 THEN :now ELSE granted_at END
          WHERE uid = :uid AND blob = :read`,
    args: { uid, read: readBlob, blob: next.blob, exp: next.expiresAt, rotated: next.rotated ? 1 : 0, now: next.now },
  });
  return r.rowsAffected === 1;
}

/** Clear only the row that was read, so a dead grant's clear cannot take a newer sign-in's. */
export async function deleteTokensIfUnchanged(uid: string, readBlob: string): Promise<void> {
  await one({ sql: "DELETE FROM user_tokens WHERE uid = :uid AND blob = :read", args: { uid, read: readBlob } });
}

/** Log out's clear: the user's row, whatever it holds. A refresh in flight then lands nothing
 *  (its write names the blob it read), and only a new sign-in writes a row again. */
export async function deleteTokens(uid: string): Promise<void> {
  await one({ sql: "DELETE FROM user_tokens WHERE uid = :uid", args: { uid } });
}

// ── app_meta: the listed global keys only (T6) ──────────────────────────────────────────

const GLOBAL_KEYS = [
  /^schema_version$/,
  /^min_reader$/,
  /^cooldown:[a-z-]+$/,
  /^played_at_convention$/,
  /^lock:spotify_refresh:[a-z2-7]{12}$/,
  /^tick_at$/,
  /^daily_at$/,
  /^lock:daily$/,
  /^sentinel:v[0-9]+$/, // one encrypted sentinel per TOKEN_KEYS key (§5.3)
  /^token_copy:[a-z2-7]{12}$/, // the runtime's copy of a plaintext token row ran (§11.4 step 3)
];
function listed(key: string): string {
  if (!GLOBAL_KEYS.some((re) => re.test(key))) throw new Error(`app_meta: ${key} is not a listed key`);
  return key;
}

export async function getAppMeta(key: string): Promise<string | null> {
  const r = await one({ sql: "SELECT value FROM app_meta WHERE key = :k", args: { k: listed(key) } });
  return r.rows[0]?.value == null ? null : String(r.rows[0].value);
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  await one({
    sql: "INSERT INTO app_meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: { k: listed(key), v: value },
  });
}

/** True when this call wrote the key; false when it already had a value. */
export async function setAppMetaIfAbsent(key: string, value: string): Promise<boolean> {
  const r = await one({
    sql: "INSERT INTO app_meta (key, value) VALUES (:k, :v) ON CONFLICT(key) DO NOTHING",
    args: { k: listed(key), v: value },
  });
  return r.rowsAffected === 1;
}

/** A cross-instance lease in app_meta (db.ts acquireLock's compare-and-set): an owner string,
 *  or null while someone else holds it. */
export async function acquireAppLock(name: string, ttlMs: number): Promise<string | null> {
  const now = Date.now();
  const owner = `${now + ttlMs}:${Math.random().toString(36).slice(2, 10)}`;
  const r = await one({
    sql: `INSERT INTO app_meta (key, value) VALUES (:k, :owner)
          ON CONFLICT(key) DO UPDATE SET value = :owner WHERE CAST(app_meta.value AS INTEGER) < :now`,
    args: { k: listed(name), owner, now },
  });
  return r.rowsAffected > 0 ? owner : null;
}

export async function releaseAppLock(name: string, owner: string): Promise<void> {
  await one({ sql: "DELETE FROM app_meta WHERE key = :k AND value = :owner", args: { k: listed(name), owner } });
}

// ── events (PLAN.md §6.5) ───────────────────────────────────────────────────────────────

/** An event a person must see: the uid and a code, never data. */
export async function recordAppEvent(code: string, uid: string | null, at = Date.now()): Promise<void> {
  await one({ sql: "INSERT INTO events (at, uid, code) VALUES (:at, :uid, :code)", args: { at, uid, code } });
}

/** The health check's read (PLAN.md §7.10, cross-user by design, a count): how many events no
 *  check has reported yet, and the newest one's id. */
export async function unreportedEvents(): Promise<{ count: number; newest: number | null }> {
  const r = await one("SELECT count(*) AS n, max(id) AS newest FROM events WHERE alarmed = 0");
  return { count: Number(r.rows[0]?.n ?? 0), newest: num(r.rows[0]?.newest) };
}

/** Mark the events a check reported, up to the newest it counted, so each e-mails once. */
export async function markEventsAlarmed(throughId: number): Promise<void> {
  await one({ sql: "UPDATE events SET alarmed = 1 WHERE alarmed = 0 AND id <= :id", args: { id: throughId } });
}
