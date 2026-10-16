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
import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client";
import { APP_SCHEMA, APP_SCHEMA_VERSION, appSchemaBatches, USER_STATUSES, type UserStatus } from "@/lib/app-schema";
import { quotaDay } from "@/lib/brake";
import { DELETION_SQL, type ExecResult as DeletionExecResult, type Stmt as DeletionStmt } from "@/lib/deletion";
import type { AppHealth } from "@/lib/health";
import { mintUid, newUid, signupsMode, type IdentityRow, type Uid } from "@/lib/identity";
import { makeStoreFetch, type FetchLike } from "@/lib/store-fetch";
import { TERMS_VERSION } from "@/lib/terms";

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

// One client per process, rebuilt if the URL changes (which only tests do). `ok` once its
// schema check has passed, so the tick's own statements skip theirs.
const g = globalThis as unknown as { __lbAppDb?: { url: string; ready: Promise<Client>; ok?: boolean } };

function appClient(): Promise<Client> {
  const url = appDatabaseUrl();
  if (g.__lbAppDb?.url === url) return g.__lbAppDb.ready;
  const ready = openApp(url);
  const entry: { url: string; ready: Promise<Client>; ok?: boolean } = { url, ready };
  g.__lbAppDb = entry;
  ready.then(
    () => {
      entry.ok = true;
    },
    () => {
      if (g.__lbAppDb === entry) g.__lbAppDb = undefined;
    },
  );
  return ready;
}

function buildClient(url: string, fetchImpl: FetchLike): Client {
  const local = url.startsWith("file:");
  if (local) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });
  return createClient({
    url,
    authToken: local ? undefined : process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
    fetch: fetchImpl,
  });
}

// Production code alone applies additive steps to a remote database; dev applies them to its own
// file. Anything else refuses and waits for the production deploy (§4.5).
const appliesSteps = (url: string) => url.startsWith("file:") || process.env.VERCEL_ENV === "production";

async function openApp(url: string): Promise<Client> {
  const client = buildClient(url, makeStoreFetch());
  await ensureAppSchema(client, appliesSteps(url));
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

// ── requests and invites (Phase 4a; RULINGS Oct 15 12:46 PM, PLAN.md §12.1) ────────────────
// The form's insert is the one statement a stranger can reach, so it is bounded in SQL: shut
// under SIGNUPS=owner, at most JOIN_PER_HOUR new requests an hour app-wide, at most
// JOIN_PENDING_CAP waiting, none once SEATS people hold places, one open request per address.
// It never creates a database; `invite.mjs --approve` provisions on the Mac (§12.1).

export const JOIN_PER_HOUR = 5;
export const JOIN_PENDING_CAP = 8;
/** Spotify's User Management allows five accounts, Rem's included: four friends at most. */
export const SEATS = 5;
export const INVITE_TTL_MS = 14 * 86_400_000;
const NAME_MAX = 80;
const NAME_FILLER = "A friend";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Control and format characters (C0, DEL, C1, bidi overrides, line separators): both fields reach
// Rem's terminal through `invite.mjs --list`, so a stranger's escape sequence is never stored.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export type JoinRefusal = "closed" | "terms" | "email" | "name" | "duplicate" | "busy" | "full";
export type JoinResult = { ok: true; id: string } | { ok: false; reason: JoinRefusal };

export async function createJoinRequest(o: { email: string; name: string; agreed: boolean; now: number }): Promise<JoinResult> {
  if (signupsMode() !== "invite") return { ok: false, reason: "closed" };
  if (!o.agreed) return { ok: false, reason: "terms" };
  const email = o.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email) || email.search(UNPRINTABLE) >= 0) return { ok: false, reason: "email" };
  const name = o.name.replace(UNPRINTABLE, "").trim();
  if (name.length > NAME_MAX) return { ok: false, reason: "name" };
  const args = {
    id: newUid(),
    email,
    name: name || NAME_FILLER,
    now: o.now,
    tv: TERMS_VERSION,
    hour: o.now - 3_600_000,
    perHour: JOIN_PER_HOUR,
    cap: JOIN_PENDING_CAP,
    seats: SEATS,
  };
  const [state, ins] = await (await appClient()).batch(
    [
      {
        sql: `SELECT (SELECT count(*) FROM users WHERE status <> 'deleted') AS held,
                     (SELECT count(*) FROM requests WHERE status = 'pending') AS pending,
                     (SELECT count(*) FROM requests WHERE created_at > :hour) AS recent,
                     (SELECT count(*) FROM requests WHERE email = :email AND status IN ('pending', 'approved')) AS dup`,
        args,
      },
      {
        sql: `INSERT INTO requests (id, email, name, status, created_at, status_at, terms_version)
              SELECT :id, :email, :name, 'pending', :now, :now, :tv
              WHERE (SELECT count(*) FROM users WHERE status <> 'deleted') < :seats
                AND (SELECT count(*) FROM requests WHERE status = 'pending') < :cap
                AND (SELECT count(*) FROM requests WHERE created_at > :hour) < :perHour
              ON CONFLICT DO NOTHING`,
        args,
      },
    ],
    "write",
  );
  if (ins.rowsAffected === 1) return { ok: true, id: args.id };
  const s = state.rows[0];
  if (Number(s.dup) > 0) return { ok: false, reason: "duplicate" };
  if (Number(s.held) >= SEATS || Number(s.pending) >= JOIN_PENDING_CAP) return { ok: false, reason: "full" };
  return { ok: false, reason: "busy" };
}

export type RequestState = "pending" | "approved" | "claimed" | null;

/** What /join shows the holder of a request cookie: where their request stands, nothing else. */
export async function requestState(id: string): Promise<RequestState> {
  const r = await one({ sql: "SELECT status FROM requests WHERE id = :id", args: { id } });
  const s = r.rows[0]?.status;
  return s === "pending" || s === "approved" || s === "claimed" ? s : null;
}

/** The join link (`/api/join/link?t=…`): the request whose approved invite its token opens, while
 *  the invite is unclaimed and under 14 days old. The database holds only the token's hash. */
export async function requestForJoinToken(tokenHash: string, now: number): Promise<string | null> {
  const r = await one({
    sql: `SELECT r.id FROM requests r JOIN users u ON u.uid = r.uid
          WHERE r.join_hash = :h AND r.status = 'approved' AND u.status = 'invited' AND u.invited_at > :expiry`,
    args: { h: tokenHash, expiry: now - INVITE_TTL_MS },
  });
  return r.rows[0] ? String(r.rows[0].id) : null;
}

/** The claim (PLAN.md §5.1's compare-and-set, keyed on the request the cookie names): binds this
 *  account_id to that request's `invited` row, once, while it is unclaimed and under 14 days old,
 *  copying the terms the request accepted; and marks the request claimed. Cross-user by design (no
 *  uid yet). Null when there is nothing to claim. */
export async function claimInvite(requestId: string, accountId: string, spotifyId: string, now: number): Promise<UserRow | null> {
  const args = { rid: requestId, aid: accountId, sid: spotifyId, now, expiry: now - INVITE_TTL_MS };
  const [claimed] = await (await appClient()).batch(
    [
      {
        sql: `UPDATE users SET account_id = :aid, spotify_id = :sid, status = 'active', status_at = :now,
                     claimed_at = :now, last_sign_in = :now,
                     terms_version = (SELECT terms_version FROM requests WHERE id = :rid),
                     terms_accepted_at = (SELECT created_at FROM requests WHERE id = :rid)
              WHERE status = 'invited' AND account_id IS NULL AND is_admin = 0 AND invited_at > :expiry
                AND uid = (SELECT uid FROM requests WHERE id = :rid AND status = 'approved')
              RETURNING ${USER_COLS}`,
        args,
      },
      {
        sql: `UPDATE requests SET status = 'claimed', status_at = :now, join_hash = NULL
              WHERE id = :rid AND status = 'approved' AND uid IN (SELECT uid FROM users WHERE account_id = :aid)`,
        args,
      },
    ],
    "write",
  );
  return claimed.rows[0] ? toUser(claimed.rows[0]) : null;
}

/** Log out (RULINGS Oct 15 1:33 PM): every browser signed out (session_epoch + 1, so every cookie
 *  fails the identity read at its next request) and capture stopped (the token row gone, so the
 *  tick's step for this user makes no Spotify call until a sign-in writes a new one). Nothing
 *  else of the user's is touched, and the admin's data no more than anyone's. */
export async function endSessionsAndCapture(uid: Uid): Promise<void> {
  await (await appClient()).batch(
    [
      { sql: "UPDATE users SET session_epoch = session_epoch + 1 WHERE uid = :uid", args: { uid } },
      { sql: "DELETE FROM user_tokens WHERE uid = :uid", args: { uid } },
    ],
    "write",
  );
}

// ── the health check (PLAN.md §7.10, Phase 4a) ──────────────────────────────────────────────

/** The health check's read of the app database: events not yet reported, by code, marked
 *  reported in the same batch so each e-mails once; the users stuck in a state someone must act on
 *  (counts, friends only for the reconnect, backoff and removed clocks); and `daily_at`. */
export async function readHealth(now: number): Promise<{ app: AppHealth; dailyAt: number | null }> {
  const args = { day: now - 24 * 3_600_000, six: now - 6 * 3_600_000, week: now - 7 * 24 * 3_600_000 };
  const [ev, , st] = await (await appClient()).batch(
    [
      "SELECT code, count(*) AS n FROM events WHERE alarmed = 0 GROUP BY code",
      "UPDATE events SET alarmed = 1 WHERE alarmed = 0",
      {
        sql: `SELECT
                (SELECT count(*) FROM users WHERE status IN ('revoked', 'deleting') AND status_at < :day) AS stuck,
                (SELECT count(*) FROM users WHERE is_admin = 0 AND status = 'needs_reconnect' AND status_at < :six) AS reconnect,
                (SELECT count(*) FROM sync_state s JOIN users u ON u.uid = s.uid
                   WHERE u.is_admin = 0 AND u.status = 'active' AND s.state = 'backoff'
                     AND COALESCE(s.last_ok_at, 0) < :six) AS backoff,
                (SELECT count(*) FROM users WHERE is_admin = 0 AND status = 'removed' AND status_at < :week) AS removed,
                (SELECT value FROM app_meta WHERE key = 'daily_at') AS daily_at`,
        args,
      },
    ],
    "write",
  );
  const x = st.rows[0];
  return {
    app: {
      events: Object.fromEntries(ev.rows.map((r) => [String(r.code), Number(r.n)])),
      stuckDeletions: Number(x.stuck),
      reconnect: Number(x.reconnect),
      backoff: Number(x.backoff),
      removed: Number(x.removed),
    },
    dailyAt: x.daily_at == null ? null : Number(x.daily_at),
  };
}

/** How many events of one code name this uid: the planted probe's reply (one more after it ran). */
export async function countEvents(uid: string, code: string): Promise<number> {
  const r = await one({ sql: "SELECT count(*) AS n FROM events WHERE uid = :uid AND code = :code", args: { uid, code } });
  return Number(r.rows[0].n);
}

/** The record of a red verdict the health check answered (time and reasons): what lanes 28 and 29
 *  read to prove the planted probe's alarm went out. Pruned after 30 days by the daily sweeps. */
export async function recordHealthRed(now: number, reasons: string[]): Promise<void> {
  await setAppMeta(`health_red:${now}`, reasons.join(","));
}

// ── the daily chores Phase 4a adds (PLAN.md §7.11 as RULINGS change it) ─────────────────────
// No dormant move and no twelve-month deletion (Oct 15 12:26 PM). Cross-user by design: they read
// uids and times, never data, and each uid they name goes to the deletion job, which refuses the
// admin itself.

export type DailyCandidates = {
  deleting: string[];
  revokedDue: string[];
  /** Due, but another user (or the admin) also got invalid_grant within the window of this one's
   *  first failure, or a `grant-wide` event fell in it: the same app-wide event (§5.4 step 3),
   *  however the failures were ordered, so these are unscheduled rather than deleted. */
  revokedWide: string[];
  invitesExpired: string[];
  grantWideRecent: number;
};

export async function dailyCandidates(
  now: number,
  o: { revokedAfterMs: number; grantWideHoldMs: number; grantWindowMs: number },
): Promise<DailyCandidates> {
  const args = { revoked: now - o.revokedAfterMs, invites: now - INVITE_TTL_MS, wide: now - o.grantWideHoldMs, window: o.grantWindowMs };
  const [del, rev, inv, wide] = await (await appClient()).batch(
    [
      "SELECT uid FROM users WHERE status = 'deleting' AND is_admin = 0 ORDER BY uid",
      {
        sql: `SELECT u.uid, EXISTS (SELECT 1 FROM events e
                                    WHERE e.at BETWEEN u.status_at - :window AND u.status_at + :window
                                      AND (e.code = 'grant-wide' OR (e.code = 'invalid-grant' AND e.uid <> u.uid))) AS wide
              FROM users u WHERE u.status = 'revoked' AND u.is_admin = 0 AND u.status_at <= :revoked ORDER BY u.uid`,
        args,
      },
      {
        sql: `SELECT uid FROM users WHERE status IN ('provisioning', 'invited') AND account_id IS NULL AND is_admin = 0
                AND invited_at <= :invites ORDER BY uid`,
        args,
      },
      { sql: "SELECT count(*) AS n FROM events WHERE code = 'grant-wide' AND at >= :wide", args },
    ],
    "read",
  );
  const uids = (r: ResultSet) => r.rows.map((x) => String(x.uid));
  return {
    deleting: uids(del),
    revokedDue: rev.rows.filter((x) => Number(x.wide) === 0).map((x) => String(x.uid)),
    revokedWide: rev.rows.filter((x) => Number(x.wide) !== 0).map((x) => String(x.uid)),
    invitesExpired: uids(inv),
    grantWideRecent: Number(wide.rows[0].n),
  };
}

/** The sweeps, one write batch: `deleted` rows past five days; token and queue rows (and refresh
 *  locks) whose uid has no users row (security R3); requests still pending after 14 days (they hold
 *  an e-mail); the health check's red records past 30 days. Counts per sweep. */
export async function dailySweeps(now: number, deletedRowTtlMs: number): Promise<Record<string, number>> {
  const args = { deleted: now - deletedRowTtlMs, pending: now - INVITE_TTL_MS, reds: `health_red:${now - 30 * 86_400_000}` };
  const names = ["deletedRows", "orphanTokens", "orphanQueue", "orphanLocks", "pendingRequests", "healthRecords"];
  const rs = await (await appClient()).batch(
    [
      { sql: "DELETE FROM users WHERE status = 'deleted' AND is_admin = 0 AND status_at <= :deleted", args },
      "DELETE FROM user_tokens WHERE uid NOT IN (SELECT uid FROM users)",
      "DELETE FROM sync_state WHERE uid NOT IN (SELECT uid FROM users)",
      `DELETE FROM app_meta WHERE key LIKE 'lock:spotify_refresh:%'
         AND substr(key, length('lock:spotify_refresh:') + 1) NOT IN (SELECT uid FROM users)`,
      { sql: "DELETE FROM requests WHERE status = 'pending' AND created_at <= :pending", args },
      { sql: "DELETE FROM app_meta WHERE key LIKE 'health_red:%' AND key < :reds", args },
    ],
    "write",
  );
  return Object.fromEntries(names.map((n, i) => [n, rs[i].rowsAffected]));
}

// ── the deletion job's statements (Phase 4a, PLAN.md §12.3) ────────────────────────────────
// deletion.ts holds them as data, so `user.mjs --remove` on the Mac runs the very same SQL; the
// runtime runs them here, and only them.

const LISTED_DELETION_SQL = new Set<string>(Object.values(DELETION_SQL));

/** One write batch of deletion.ts's statements; anything else is refused before it is sent. */
export async function execDeletionStatements(stmts: DeletionStmt[]): Promise<DeletionExecResult[]> {
  for (const st of stmts) if (!LISTED_DELETION_SQL.has(st.sql)) throw new Error("app-db: not a deletion statement");
  const rs = await (await appClient()).batch(stmts, "write");
  return rs.map((r) => ({ rows: r.rows as unknown as Record<string, unknown>[], rowsAffected: r.rowsAffected }));
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
  /^budget_mode$/, // the app-wide budget mode the daily chores record (src/lib/budget/, CAPACITY §6)
  /^sentinel:v[0-9]+$/, // one encrypted sentinel per TOKEN_KEYS key (§5.3)
  /^token_copy:[a-z2-7]{12}$/, // the runtime's copy of a plaintext token row ran (§11.4 step 3)
  /^health_red:[0-9]{13}$/, // each red verdict the health check answered, with its reasons (§7.10)
  /^deleted_telemetry:[a-z2-7]{12}$/, // the deletion job's telemetry step ran (deletion.ts)
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

// ── the sync queue (Phase 3, PLAN.md §7.2, §7.5-7.8) ──────────────────────────────────────
// `sync_state` holds times, counters and leases only (§4.2); what the probe saw lives in each
// user's own database. The statements that read or write every user's row (the claim, the owner
// alarm's read, the tick's view) are cross-user by design: they schedule and never carry data.
//
// The tick's first statements (the owner alarm's read, the stamp, the claim) are also its store
// health check: each request rides one attempt with a 5-second timeout, so a store that does not
// answer ends the tick instead of waiting out the store fetch's three 15-second attempts. The gzip
// pin and the Request rebuild still come from makeStoreFetch; a second attempt is refused before
// it is sent.

export const TICK_STATEMENT_TIMEOUT_MS = 5_000;
const LEASE_MS = 50_000;
const DUE_EARLY_MS = 30_000;
const CONFIRM_AFTER_MS = 10 * 60_000;
const OK_RECENT_MS = 10 * 60_000;

/** The fetch under one request of a tick statement: one attempt, `timeoutMs` long. */
export function oneAttemptFetch(doFetch: FetchLike = fetch, timeoutMs = TICK_STATEMENT_TIMEOUT_MS): FetchLike {
  let sent = false;
  return (input, init) => {
    if (sent) return Promise.reject(new Error("tick statement: one attempt"));
    sent = true;
    return doFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
}

async function onTickClient<T>(run: (c: Client) => Promise<T>): Promise<T> {
  const url = appDatabaseUrl();
  // A local file has no network to time out (dev, tests): the process's client serves.
  if (url.startsWith("file:")) return run(await appClient());
  const c = buildClient(url, (input, init) => makeStoreFetch(oneAttemptFetch())(input, init));
  try {
    if (!(g.__lbAppDb?.url === url && g.__lbAppDb.ok)) await ensureAppSchema(c, appliesSteps(url));
    return await run(c);
  } finally {
    c.close();
  }
}

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

export type OwnerAlarmRow = { adminStatus: string | null; adminHasToken: boolean; decryptUsers: number; adminDecrypt: boolean };

/** What the owner alarm answers the Zenbook's caller from (§7.2 step 0, §5.3), read before
 *  anything else: the admin's status and token row, and the users whose token failed to decrypt
 *  since the last tick's stamp (or in the last 10 minutes, before any tick). */
export async function readOwnerAlarm(now: number): Promise<OwnerAlarmRow> {
  const r = await onTickClient((c) =>
    c.execute({
      sql: `SELECT
              (SELECT status FROM users WHERE is_admin = 1 ORDER BY uid LIMIT 1) AS admin_status,
              (SELECT count(*) FROM users u JOIN user_tokens t ON t.uid = u.uid WHERE u.is_admin = 1) AS admin_tokens,
              (SELECT count(DISTINCT e.uid) FROM events e WHERE e.code = 'decrypt' AND e.at >= w.since) AS decrypt_users,
              (SELECT count(*) FROM events e JOIN users u ON u.uid = e.uid
                 WHERE u.is_admin = 1 AND e.code = 'decrypt' AND e.at >= w.since) AS admin_decrypts
            FROM (SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'tick_at'),
                                  :now - 600000) AS since) w`,
      args: { now },
    }),
  );
  const x = r.rows[0];
  return {
    adminStatus: x.admin_status == null ? null : String(x.admin_status),
    adminHasToken: Number(x.admin_tokens) > 0,
    decryptUsers: Number(x.decrypt_users),
    adminDecrypt: Number(x.admin_decrypts) > 0,
  };
}

/** The stamp (§7.2 step 1): true when this call may tick; false when another tick ran within
 *  `windowMs` (45 s from Phase 3, 90 s for the interim pinger, §7.9). Inserted if absent. */
export async function stampTick(now: number, windowMs: number): Promise<boolean> {
  const r = await onTickClient((c) =>
    c.execute({
      sql: `INSERT INTO app_meta (key, value) VALUES ('tick_at', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            WHERE CAST(app_meta.value AS INTEGER) < :now - :window`,
      args: { v: String(now), now, window: windowMs },
    }),
  );
  return r.rowsAffected === 1;
}

/** A user the claim leased, joined to where their data lives and their token row. */
export type ClaimedUser = {
  uid: Uid;
  dbName: string;
  /** Their Spotify id, refreshed at sign-in: the rescan's owned-playlist filter, so it makes no
   *  `/me` call (§7.7). */
  spotifyId: string;
  isAdmin: boolean;
  blob: string | null;
  expiresAt: number | null;
  state: string;
  nextProbeAt: number;
  nextRescanAt: number | null;
  failures: number;
  /** The last step's error code (`sync_state.last_error`); null after a success. */
  lastError: string | null;
  lastHarvestAt: number | null;
  quotaDay: string | null;
  rpCalls: number;
};

/** The claim's answer: the leased users and what the tick needs once for everyone. */
export type Claim = {
  users: ClaimedUser[];
  /** Recently-played calls counted toward this quota day, over every user (the brake, §7.5). */
  rpTotal: number;
  /** N for the share: the users the claim can lease. */
  activeUsers: number;
  dailyAt: number | null;
  /** `cooldown:<bucket>` → until (epoch ms). */
  cooldowns: Record<string, number>;
  /** At most one `needs_reconnect` user whose invalid_grant is due its confirming refresh (§5.4). */
  confirmUid: Uid | null;
  /** Users whose last success is within 10 minutes, and when it was: a 403 "not registered"
   *  removes a friend only when someone else's calls worked after that friend's previous refusal
   *  (§7.8), whichever tick served them. */
  okRecent: { uid: Uid; at: number }[];
};

const ACTIVE_LEASABLE = `u.status = 'active' AND (:signups = 'invite' OR u.is_admin = 1)`;
const CLAIMED_COLS = `s.uid, u.db_name, u.spotify_id, u.is_admin, t.blob, t.expires_at, s.state, s.next_probe_at, s.next_rescan_at,
                      s.failures, s.last_error, s.last_harvest_at, s.quota_day, s.rp_calls`;
const toClaimed = (r: Record<string, unknown>): ClaimedUser => ({
  uid: mintUid(String(r.uid)),
  dbName: String(r.db_name),
  spotifyId: String(r.spotify_id),
  isAdmin: Number(r.is_admin) === 1,
  blob: r.blob == null ? null : String(r.blob),
  expiresAt: numOrNull(r.expires_at),
  state: String(r.state),
  nextProbeAt: Number(r.next_probe_at),
  nextRescanAt: numOrNull(r.next_rescan_at),
  failures: Number(r.failures),
  lastError: r.last_error == null ? null : String(r.last_error),
  lastHarvestAt: numOrNull(r.last_harvest_at),
  quotaDay: r.quota_day == null ? null : String(r.quota_day),
  rpCalls: Number(r.rp_calls),
});

type ClaimArgs = { tick: string; now: number; signups: "owner" | "invite"; until: number; day: string; confirm: number; recent: number };
const claimArgs = (o: { tick: string; now: number; signups: "owner" | "invite"; quotaDay?: string }): ClaimArgs => ({
  tick: o.tick,
  now: o.now,
  signups: o.signups,
  until: o.now + LEASE_MS,
  day: o.quotaDay ?? quotaDay(o.now),
  confirm: o.now - CONFIRM_AFTER_MS,
  recent: o.now - OK_RECENT_MS,
});

// The tick's view, read in the claim's batch: app-wide scalars and uids, never a user's data.
// Each statement of the claim gets exactly the names its SQL uses: Turso refuses an arg a
// statement does not name, which a local file accepts (docs/GOTCHAS.md, lane 23).
const viewStatements = ({ day, signups, confirm, recent }: ClaimArgs): InStatement[] => [
  {
    sql: `SELECT
            (SELECT COALESCE(SUM(rp_calls), 0) FROM sync_state WHERE quota_day = :day) AS rp_total,
            (SELECT count(*) FROM users u WHERE ${ACTIVE_LEASABLE}) AS active_users,
            (SELECT value FROM app_meta WHERE key = 'daily_at') AS daily_at,
            (SELECT u.uid FROM users u JOIN sync_state s ON s.uid = u.uid
               WHERE u.status = 'needs_reconnect' AND (:signups = 'invite' OR u.is_admin = 1)
                 AND s.last_error = 'invalid_grant' AND u.status_at <= :confirm
               ORDER BY u.status_at LIMIT 1) AS confirm_uid`,
    args: { day, signups, confirm },
  },
  "SELECT key, value FROM app_meta WHERE key LIKE 'cooldown:%'",
  { sql: "SELECT uid, last_ok_at FROM sync_state WHERE last_ok_at >= :recent", args: { recent } },
];

function toClaim(leased: ResultSet, [view, cooldowns, ok]: ResultSet[]): Claim {
  const v = view.rows[0];
  return {
    users: leased.rows.map(toClaimed),
    rpTotal: Number(v.rp_total),
    activeUsers: Number(v.active_users),
    dailyAt: numOrNull(v.daily_at),
    cooldowns: Object.fromEntries(cooldowns.rows.map((r) => [String(r.key).slice("cooldown:".length), Number(r.value)])),
    confirmUid: v.confirm_uid == null ? null : mintUid(String(v.confirm_uid)),
    okRecent: ok.rows.map((r) => ({ uid: mintUid(String(r.uid)), at: Number(r.last_ok_at) })),
  };
}

/** The claim (§7.2 step 2, security R2): one write batch, one round trip. Gives every active user
 *  without a queue row one, due now; leases every due `active` user (only the admin under
 *  `SIGNUPS=owner`) for 50 s; returns them joined to `db_name` and their token row; and reads the
 *  tick's view. A leased user is not due, so two ticks, or a tick and an open tab, never work on
 *  one user at once. */
export async function claimDueUsers(o: { tick: string; now: number; signups: "owner" | "invite"; quotaDay?: string }): Promise<Claim> {
  const args = claimArgs(o);
  const { tick, now, signups, until } = args;
  const due = now + DUE_EARLY_MS;
  const rs = await onTickClient((c) =>
    c.batch(
      [
        {
          sql: `INSERT INTO sync_state (uid, state, next_probe_at)
                SELECT u.uid, 'idle', :now FROM users u
                WHERE ${ACTIVE_LEASABLE} AND NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.uid = u.uid)`,
          args: { now, signups },
        },
        {
          sql: `UPDATE sync_state SET lease_owner = :tick, lease_until = :until
                WHERE uid IN (SELECT s.uid FROM sync_state s JOIN users u ON u.uid = s.uid
                              WHERE ${ACTIVE_LEASABLE} AND s.state <> 'paused' AND s.next_probe_at <= :due
                                AND (s.lease_until IS NULL OR s.lease_until < :now))`,
          args: { tick, until, signups, due, now },
        },
        {
          sql: `SELECT ${CLAIMED_COLS} FROM sync_state s JOIN users u ON u.uid = s.uid
                LEFT JOIN user_tokens t ON t.uid = s.uid
                WHERE s.lease_owner = :tick AND s.lease_until = :until`,
          args: { tick, until },
        },
        ...viewStatements(args),
      ],
      "write",
    ),
  );
  return toClaim(rs[2], rs.slice(3));
}

/** One user's claim, for the open app (§7.6): the same lease, so an open tab and the cron never
 *  harvest one user at once, and the same view. `dueOnly` for the tab's own timer, which makes a
 *  user due only when no tick has run in 5 minutes; a load or a return to the tab leases whether
 *  or not they are due. `users` is empty when the user is leased, paused, not due, or not
 *  `active` (or not the admin under `SIGNUPS=owner`). */
export async function claimUser(o: {
  uid: Uid;
  tick: string;
  now: number;
  dueOnly: boolean;
  signups: "owner" | "invite";
}): Promise<Claim> {
  const args = claimArgs(o);
  const { tick, now, signups, until } = args;
  const uid = o.uid;
  const due = o.dueOnly ? now + DUE_EARLY_MS : null;
  const live = `EXISTS (SELECT 1 FROM users u WHERE u.uid = :uid AND ${ACTIVE_LEASABLE})`;
  const rs = await (await appClient()).batch(
    [
      {
        sql: `INSERT INTO sync_state (uid, state, next_probe_at) SELECT :uid, 'idle', :now WHERE ${live}
              ON CONFLICT(uid) DO NOTHING`,
        args: { uid, now, signups },
      },
      {
        sql: `UPDATE sync_state SET lease_owner = :tick, lease_until = :until
              WHERE uid = :uid AND state <> 'paused' AND (lease_until IS NULL OR lease_until < :now)
                AND (:due IS NULL OR next_probe_at <= :due) AND ${live}`,
        args: { tick, until, uid, now, due, signups },
      },
      {
        sql: `SELECT ${CLAIMED_COLS} FROM sync_state s JOIN users u ON u.uid = s.uid
              LEFT JOIN user_tokens t ON t.uid = s.uid
              WHERE s.uid = :uid AND s.lease_owner = :tick AND s.lease_until = :until`,
        args: { uid, tick, until },
      },
      ...viewStatements(args),
    ],
    "write",
  );
  return toClaim(rs[2], rs.slice(3));
}

/** What a step's release writes: the next due time and the outcome's counters. Null keeps the
 *  stored value (a step that harvested nothing keeps `last_harvest_at`). */
export type Release = {
  state: "active" | "idle" | "backoff";
  nextProbeAt: number;
  failures: number;
  lastError: string | null;
  lastOkAt: number | null;
  lastHarvestAt: number | null;
};

/** Release by compare-and-set on the lease owner (§7.2 step 3): a step that outlived its lease
 *  writes nothing, whether or not another tick has taken the user since. True when it landed. */
export async function releaseLease(uid: Uid | string, tick: string, now: number, w: Release): Promise<boolean> {
  const r = await one({
    sql: `UPDATE sync_state SET state = :state, next_probe_at = :next, failures = :failures, last_error = :err,
                 last_ok_at = COALESCE(:ok, last_ok_at), last_harvest_at = COALESCE(:harvest, last_harvest_at),
                 lease_owner = NULL, lease_until = NULL
          WHERE uid = :uid AND lease_owner = :tick AND lease_until >= :now`,
    args: {
      uid,
      tick,
      now,
      state: w.state,
      next: w.nextProbeAt,
      failures: w.failures,
      err: w.lastError,
      ok: w.lastOkAt,
      harvest: w.lastHarvestAt,
    },
  });
  return r.rowsAffected === 1;
}

/** The brake's counter (§7.5 item 1), awaited before each recently-played or /me call: this
 *  user's calls in the quota day, after this one. A re-sent increment overcounts, the safe side. */
export async function countRpCall(uid: Uid | string, day: string): Promise<number> {
  const r = await one({
    sql: `UPDATE sync_state SET rp_calls = CASE WHEN quota_day = :day THEN rp_calls + 1 ELSE 1 END, quota_day = :day
          WHERE uid = :uid RETURNING rp_calls`,
    args: { uid, day },
  });
  if (!r.rows[0]) throw new Error("countRpCall: no queue row");
  return Number(r.rows[0].rp_calls);
}

/** A bucket's cooldown (`cooldown:<bucket>`, §7.8), only ever extended: a later, shorter ban
 *  never shortens a longer one (audit 2026-08-19, T1.10). Epoch ms, whole. */
export async function extendCooldown(bucket: string, until: number): Promise<void> {
  await one({
    sql: `INSERT INTO app_meta (key, value) VALUES (:k, :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
          WHERE CAST(app_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
    args: { k: listed(`cooldown:${bucket}`), v: String(Math.floor(until)) },
  });
}

/** Take a due library rescan (§7.7) by moving its due time to `retryAt`, so two ticks never run
 *  one user's rescan at once and a rescan that fails waits for `retryAt`. */
export async function claimRescan(uid: Uid | string, now: number, retryAt: number): Promise<boolean> {
  const r = await one({
    sql: `UPDATE sync_state SET next_rescan_at = :retry
          WHERE uid = :uid AND (next_rescan_at IS NULL OR next_rescan_at <= :now)`,
    args: { uid, now, retry: retryAt },
  });
  return r.rowsAffected === 1;
}

export async function scheduleRescan(uid: Uid | string, at: number): Promise<void> {
  await one({ sql: "UPDATE sync_state SET next_rescan_at = :at WHERE uid = :uid", args: { uid, at } });
}

/** §5.4 step 2: take a due confirmation, so two ticks never send it twice. */
export async function startGrantConfirm(uid: Uid | string): Promise<boolean> {
  const r = await one({
    sql: "UPDATE sync_state SET last_error = 'invalid_grant:confirming' WHERE uid = :uid AND last_error = 'invalid_grant'",
    args: { uid },
  });
  return r.rowsAffected === 1;
}

/** The confirmation's outcome: `ok` clears the error and makes the user due now (the caller
 *  moves the status back to `active`); `dead` records that it was confirmed; `unknown` (the
 *  refresh could not tell) leaves it for a later tick. */
export async function finishGrantConfirm(uid: Uid | string, outcome: "ok" | "dead" | "unknown", now: number): Promise<void> {
  const set =
    outcome === "ok"
      ? "last_error = NULL, failures = 0, next_probe_at = :now"
      : outcome === "dead"
        ? "last_error = 'invalid_grant:confirmed'"
        : "last_error = 'invalid_grant'";
  await one({
    sql: `UPDATE sync_state SET ${set} WHERE uid = :uid AND last_error = 'invalid_grant:confirming'`,
    // Only `ok`'s SET names :now.
    args: outcome === "ok" ? { uid, now } : { uid },
  });
}

/** §5.4 step 1 on the request path (Phase 4a): a refresh answered invalid_grant during a page or
 *  route, so the user stops, keeping their data and blob, exactly as the tick does: active →
 *  needs_reconnect by compare-and-set, and only if that landed, the queue row's error (what the
 *  confirmation looks for) and an `invalid-grant` event. */
export async function markGrantDead(uid: Uid | string, now: number): Promise<void> {
  // changes() is the previous statement's count on this connection: each later statement runs only
  // when the compare-and-set before it moved the row, so a second failure writes nothing.
  await (await appClient()).batch(
    [
      { sql: "UPDATE users SET status = 'needs_reconnect', status_at = :now WHERE uid = :uid AND status = 'active'", args: { uid, now } },
      { sql: "INSERT INTO events (at, uid, code) SELECT :now, :uid, 'invalid-grant' WHERE changes() = 1", args: { uid, now } },
      {
        sql: `INSERT INTO sync_state (uid, state, next_probe_at, last_error) SELECT :uid, 'idle', :now, 'invalid_grant' WHERE changes() = 1
              ON CONFLICT(uid) DO UPDATE SET last_error = 'invalid_grant'`,
        args: { uid, now },
      },
    ],
    "write",
  );
}

/** What §5.4 steps 3-5 decide a confirmed dead grant from: whether it is the admin's, when the
 *  stored refresh token was granted (epoch s), and the app-wide picture: users hit by invalid_grant
 *  in the last 24 hours, and `grant-wide` events since `wideSince`. */
export async function readGrantCase(
  uid: Uid | string,
  now: number,
  wideSince: number,
): Promise<{ isAdmin: boolean; grantedAt: number | null; users24h: number; admin24h: boolean; grantWide: number }> {
  const r = await one({
    sql: `SELECT (SELECT is_admin FROM users WHERE uid = :uid) AS is_admin,
                 (SELECT granted_at FROM user_tokens WHERE uid = :uid) AS granted_at,
                 (SELECT count(DISTINCT e.uid) FROM events e WHERE e.code = 'invalid-grant' AND e.at >= :day) AS users24h,
                 (SELECT count(*) FROM events e JOIN users u ON u.uid = e.uid
                    WHERE u.is_admin = 1 AND e.code = 'invalid-grant' AND e.at >= :day) AS admin24h,
                 (SELECT count(*) FROM events WHERE code = 'grant-wide' AND at >= :wide) AS wide`,
    args: { uid, day: now - 24 * 3_600_000, wide: wideSince },
  });
  const x = r.rows[0];
  return {
    isAdmin: Number(x.is_admin) === 1,
    grantedAt: x.granted_at == null ? null : Number(x.granted_at),
    users24h: Number(x.users24h),
    admin24h: Number(x.admin24h) > 0,
    grantWide: Number(x.wide),
  };
}

/** §5.4 step 5: a friend's confirmed revocation. `revoked` keeps the status_at needs_reconnect
 *  stamped at the first failure, so status_at is the day-4 clock; never the admin. An alarm
 *  (`revoked` event) goes to Rem. True when it landed. */
export async function markRevoked(uid: Uid | string, now: number): Promise<boolean> {
  const [r] = await (await appClient()).batch(
    [
      { sql: "UPDATE users SET status = 'revoked' WHERE uid = :uid AND status = 'needs_reconnect' AND is_admin = 0", args: { uid } },
      {
        sql: "INSERT INTO events (at, uid, code) SELECT :now, :uid, 'revoked' WHERE EXISTS (SELECT 1 FROM users WHERE uid = :uid AND status = 'revoked')",
        args: { uid, now },
      },
    ],
    "write",
  );
  return r.rowsAffected === 1;
}

/** §5.4 step 3: how many users got invalid_grant since `since`, and whether the admin did. */
export async function grantFailuresSince(since: number): Promise<{ users: number; admin: boolean }> {
  const r = await one({
    sql: `SELECT count(DISTINCT e.uid) AS n, COALESCE(MAX(u.is_admin), 0) AS admin
          FROM events e LEFT JOIN users u ON u.uid = e.uid
          WHERE e.code = 'invalid-grant' AND e.at >= :since`,
    args: { since },
  });
  return { users: Number(r.rows[0].n), admin: Number(r.rows[0].admin) === 1 };
}
