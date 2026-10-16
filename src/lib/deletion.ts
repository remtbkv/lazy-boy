// The deletion job (docs/multi-user/PLAN.md §12.3; decisions 21-24 as ruled). One module, run in
// the runtime for a friend's Disconnect and for the daily triggers (deletion-runtime.ts), and from
// the Mac for `user.mjs --remove`, so it imports nothing: the statements are data here, and each
// caller runs them over its own client (`exec`). Every step is idempotent, so a run cut off
// anywhere is finished by the next (the daily chores retry every `deleting` user).
//
// Before it touches anything it refuses the admin (nothing ever deletes Rem's data), any row whose
// database is not `lb-u-<uid>`, and any database whose `owner_uid` is not that uid.
//   1. status `deleting` and session_epoch + 1 (every session dies at its next request); the queue
//      row, the token row, the refresh lock and the request (it holds the e-mail) go. Token writes
//      land only for a live owner (app-db.ts LIVE), so a refresh in flight stores nothing after this.
//   2. `lb-u-<uid>` destroyed through Turso's Platform API.
//   3. the user's telemetry rows deleted, and one line appended to the lifecycle log (§12.5 re-applies
//      it after an app-database restore).
//   4. backups: none to wait for. Friends' databases are never dumped and the backup copies keep only
//      the admin's rows (RULINGS Oct 15 6:21 PM; the backup script's own check, ops/zenbook-backup).
//   5. after the 50-second lease window, the token, queue and lock rows deleted again and checked
//      gone; the users row becomes `deleted`, keeping only uid, account_id, status and status_at, so a
//      returning sign-in within five days is told the account was deleted and when (§5.1). The daily
//      chores delete the row after five days.
//   6. (the page) the person is told to remove Lazy Boy at spotify.com/account/apps.

export type Stmt = { sql: string; args: Record<string, string | number | null> };
export type ExecResult = { rows: Record<string, unknown>[]; rowsAffected: number };

export type DeletionDeps = {
  /** Run statements on the app database as one write batch (a transaction). */
  exec: (stmts: Stmt[]) => Promise<ExecResult[]>;
  /** The `owner_uid` in a user database's `meta`; null when the database does not exist. */
  ownerOf: (dbName: string) => Promise<string | null>;
  /** Destroy a user database; resolves when it is gone (already absent counts). */
  destroy: (dbName: string) => Promise<void>;
  telemetry: {
    deleteUser: (uid: string) => Promise<void>;
    appendLifecycle: (e: LifecycleEntry) => Promise<void>;
  };
  now: () => number;
  /** Who ran it, for the lifecycle log: "runtime" or "user.mjs". */
  by: string;
};

export type LifecycleEntry = { at: number; uid: string; action: string; by: string };

export type DeletionRefusal = "unknown" | "admin" | "name" | "owner-mismatch" | "status";
export type DeletionOutcome =
  | { kind: "refused"; reason: DeletionRefusal }
  | { kind: "pending"; step: "destroy" | "telemetry" | "window" }
  | { kind: "done" };

/** The lease window (app-db.ts LEASE_MS): a step that leased the user before step 1 has finished
 *  writing, or been refused, by then. */
export const LEASE_WINDOW_MS = 50_000;
/** A `deleted` row is kept this long, then the daily chores delete it (§12.3 step 5). */
export const DELETED_ROW_TTL_MS = 5 * 86_400_000;

// Every status a deletion may start from. Not provisioning or invited (an unclaimed invite is
// withdrawn: `withdrawInvite`), and never the admin, whatever his status.
const DELETABLE = ["active", "needs_reconnect", "revoked", "disabled", "removed", "deleting"];

const userDb = (uid: string) => `lb-u-${uid}`;
const lockKey = (uid: string) => `lock:spotify_refresh:${uid}`;
const telemetryMark = (uid: string) => `deleted_telemetry:${uid}`;
const IF_DELETING = "EXISTS (SELECT 1 FROM users WHERE uid = :uid AND status = 'deleting')";

export const DELETION_SQL = {
  readUser: "SELECT uid, db_name, is_admin, status, status_at, account_id FROM users WHERE uid = :uid",
  markDeleting: `UPDATE users SET status = 'deleting', status_at = :now, session_epoch = session_epoch + 1
                 WHERE uid = :uid AND status = :from AND is_admin = 0`,
  dropQueue: `DELETE FROM sync_state WHERE uid = :uid AND ${IF_DELETING}`,
  dropTokens: `DELETE FROM user_tokens WHERE uid = :uid AND ${IF_DELETING}`,
  dropLock: `DELETE FROM app_meta WHERE key = :lock AND ${IF_DELETING}`,
  dropRequest: `DELETE FROM requests WHERE uid = :uid AND ${IF_DELETING}`,
  readMark: "SELECT value FROM app_meta WHERE key = :mark",
  setMark: "INSERT INTO app_meta (key, value) VALUES (:mark, '1') ON CONFLICT(key) DO NOTHING",
  remaining: `SELECT (SELECT count(*) FROM user_tokens WHERE uid = :uid)
                   + (SELECT count(*) FROM sync_state WHERE uid = :uid)
                   + (SELECT count(*) FROM app_meta WHERE key = :lock) AS n`,
  markDeleted: `UPDATE users SET status = 'deleted', status_at = :now, spotify_id = '', db_name = 'deleted:' || uid,
                       terms_version = NULL, terms_accepted_at = NULL, claimed_at = NULL, last_sign_in = NULL
                WHERE uid = :uid AND status = 'deleting'`,
  dropMark: "DELETE FROM app_meta WHERE key = :mark",
  withdraw: `DELETE FROM users WHERE uid = :uid AND status IN ('provisioning', 'invited') AND account_id IS NULL AND is_admin = 0`,
  withdrawRequest: `DELETE FROM requests WHERE uid = :uid AND status IN ('pending', 'approved')`,
} as const;

// The telemetry store's statements (§4.1, §12.3 step 3, §12.5). `api_log` and `client_metrics`
// carry `user_id` once Phases 1 and 3's turns add it; a table without the column holds no row of
// anyone's, so the delete skips it.
export const TELEMETRY_SQL = {
  columns: (table: "api_log" | "client_metrics") => `SELECT name FROM pragma_table_info('${table}')`,
  deleteRows: (table: "api_log" | "client_metrics") => `DELETE FROM ${table} WHERE user_id = :uid`,
  lifecycleTable: `CREATE TABLE IF NOT EXISTS lifecycle_log (
                     id INTEGER PRIMARY KEY, at INTEGER NOT NULL, uid TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL)`,
  appendLifecycle: "INSERT INTO lifecycle_log (at, uid, action, by) VALUES (:at, :uid, :action, :by)",
} as const;

const s = (sql: string, args: Stmt["args"]): Stmt => ({ sql, args });

type Row = { db: string; admin: boolean; status: string; statusAt: number };
async function readRow(deps: DeletionDeps, uid: string): Promise<Row | null> {
  const [r] = await deps.exec([s(DELETION_SQL.readUser, { uid })]);
  const x = r.rows[0];
  return x ? { db: String(x.db_name), admin: Number(x.is_admin) === 1, status: String(x.status), statusAt: Number(x.status_at) } : null;
}

/** The refusals every path shares: the admin, a database the row does not name as `lb-u-<uid>`,
 *  a database whose `owner_uid` is someone else's. Returns whether the database still exists. */
async function guard(deps: DeletionDeps, uid: string, row: Row): Promise<{ refused: DeletionRefusal } | { exists: boolean }> {
  if (row.admin) return { refused: "admin" };
  if (row.db !== userDb(uid)) return { refused: "name" };
  const owner = await deps.ownerOf(row.db);
  if (owner !== null && owner !== uid) return { refused: "owner-mismatch" };
  return { exists: owner !== null };
}

/** Delete one user's account and data (§12.3). Resumable: call again until it answers done. */
export async function runDeletion(uid: string, deps: DeletionDeps): Promise<DeletionOutcome> {
  let row = await readRow(deps, uid);
  if (!row) return { kind: "refused", reason: "unknown" };
  if (row.admin) return { kind: "refused", reason: "admin" };
  if (row.status === "deleted") return { kind: "done" };
  if (!DELETABLE.includes(row.status)) return { kind: "refused", reason: "status" };
  let g: Awaited<ReturnType<typeof guard>>;
  try {
    g = await guard(deps, uid, row);
  } catch {
    return { kind: "pending", step: "destroy" };
  }
  if ("refused" in g) return { kind: "refused", reason: g.refused };

  // Step 1, by compare-and-set from the status read: a sign-in that moved the row first wins. A
  // retry finds the row already `deleting` and leaves its clock alone.
  if (row.status !== "deleting") {
    const now = deps.now();
    const args = { uid, now, from: row.status, lock: lockKey(uid) };
    const [moved] = await deps.exec([
      s(DELETION_SQL.markDeleting, args),
      s(DELETION_SQL.dropQueue, args),
      s(DELETION_SQL.dropTokens, args),
      s(DELETION_SQL.dropLock, args),
      s(DELETION_SQL.dropRequest, args),
    ]);
    if (moved.rowsAffected !== 1) return { kind: "refused", reason: "status" };
    row = { ...row, status: "deleting", statusAt: now };
  }

  // Step 2.
  if (g.exists) {
    try {
      await deps.destroy(row.db);
    } catch {
      return { kind: "pending", step: "destroy" };
    }
  }

  // Step 3, once.
  const mark = telemetryMark(uid);
  const [m] = await deps.exec([s(DELETION_SQL.readMark, { mark })]);
  if (!m.rows[0]) {
    try {
      await deps.telemetry.deleteUser(uid);
      await deps.telemetry.appendLifecycle({ at: deps.now(), uid, action: "deleted", by: deps.by });
    } catch {
      return { kind: "pending", step: "telemetry" };
    }
    await deps.exec([s(DELETION_SQL.setMark, { mark })]);
  }

  // Step 5, after the lease window.
  const t = deps.now();
  if (t - row.statusAt < LEASE_WINDOW_MS) return { kind: "pending", step: "window" };
  const a5 = { uid, now: t, lock: lockKey(uid), mark };
  const [, , , left] = await deps.exec([
    s(DELETION_SQL.dropQueue, a5),
    s(DELETION_SQL.dropTokens, a5),
    s(DELETION_SQL.dropLock, a5),
    s(DELETION_SQL.remaining, a5),
  ]);
  if (Number(left.rows[0].n) !== 0) throw new Error(`deletion ${uid}: rows remain after the lease window`);
  await deps.exec([s(DELETION_SQL.markDeleted, a5), s(DELETION_SQL.dropMark, a5)]);
  return { kind: "done" };
}

/** An unclaimed invite withdrawn (`invite.mjs --revoke`, the 14-day expiry, §12.1): its empty
 *  database destroyed and its row and request gone. The same refusals as a deletion. */
export async function withdrawInvite(uid: string, deps: DeletionDeps): Promise<DeletionOutcome> {
  const row = await readRow(deps, uid);
  if (!row) return { kind: "done" };
  if (row.admin) return { kind: "refused", reason: "admin" };
  if (row.status !== "provisioning" && row.status !== "invited") return { kind: "refused", reason: "status" };
  let g: Awaited<ReturnType<typeof guard>>;
  try {
    g = await guard(deps, uid, row);
    if ("refused" in g) return { kind: "refused", reason: g.refused };
    if (g.exists) await deps.destroy(row.db);
  } catch {
    return { kind: "pending", step: "destroy" };
  }
  await deps.exec([s(DELETION_SQL.withdrawRequest, { uid }), s(DELETION_SQL.withdraw, { uid })]);
  return { kind: "done" };
}
