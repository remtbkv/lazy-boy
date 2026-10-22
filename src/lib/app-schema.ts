// The app database's schema as versioned steps (docs/multi-user/PLAN.md §4.2, §4.5).
//
// `lazyboy-app` holds identity, ciphertext and scheduling and no listening data. This file
// is data only and imports nothing, so `scripts/phase2-app-db.mjs` can import it by path under
// plain Node; src/lib/app-db.ts holds every statement the runtime runs on the database.
//
// A step is additive (old code still reads the database: `min_reader` stays) or a rebuild
// (`min_reader` rises to the step's version, so an older build refuses the database instead of
// misreading it). `schema_version` and `min_reader` live in `app_meta`.

export type SchemaStep = { version: number; kind: "additive" | "rebuild"; statements: string[] };

// Statuses as PLAN.md §4.2 lists them, minus `dormant`: RULINGS Oct 15 12:26 PM keeps friends'
// history while they stay connected, with no idle pause.
export const USER_STATUSES = [
  "provisioning",
  "invited",
  "active",
  "needs_reconnect",
  "removed",
  "revoked",
  "disabled",
  "deleting",
  "deleted",
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const APP_SCHEMA: readonly SchemaStep[] = [
  {
    version: 1,
    kind: "additive",
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        uid               TEXT PRIMARY KEY,
        account_id        TEXT UNIQUE,
        spotify_id        TEXT NOT NULL,
        db_name           TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL,
        status_at         INTEGER NOT NULL,
        is_admin          INTEGER NOT NULL DEFAULT 0,
        session_epoch     INTEGER NOT NULL DEFAULT 0,
        terms_version     TEXT,
        terms_accepted_at INTEGER,
        invited_at        INTEGER NOT NULL,
        claimed_at        INTEGER,
        last_sign_in      INTEGER
      )`,
      // One open invite per Spotify id, so a claim can never match two rows.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_open_invite ON users (spotify_id) WHERE status = 'invited'`,
      `CREATE TABLE IF NOT EXISTS user_tokens (
        uid        TEXT PRIMARY KEY,
        blob       TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        granted_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        uid             TEXT PRIMARY KEY,
        state           TEXT NOT NULL,
        next_probe_at   INTEGER NOT NULL,
        next_rescan_at  INTEGER,
        lease_owner     TEXT,
        lease_until     INTEGER,
        failures        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        last_ok_at      INTEGER,
        last_harvest_at INTEGER,
        quota_day       TEXT,
        rp_calls        INTEGER NOT NULL DEFAULT 0,
        lag_p50_s       INTEGER,
        lag_p95_s       INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY,
        at      INTEGER NOT NULL,
        uid     TEXT,
        code    TEXT NOT NULL,
        alarmed INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`,
    ],
  },
];

export const APP_SCHEMA_VERSION = APP_SCHEMA[APP_SCHEMA.length - 1].version;

/** The statements that bring a database from `fromVersion` (0 = empty) to the code's version,
 *  one list per step, each to run as one write batch. The version keys ride in each step's
 *  batch, so a crash between steps leaves a database at a version it really has. */
export function appSchemaBatches(fromVersion: number, minReader: number): string[][] {
  let reader = minReader;
  return APP_SCHEMA.filter((s) => s.version > fromVersion).map((s) => {
    if (s.kind === "rebuild" || reader === 0) reader = s.version;
    return [
      ...s.statements,
      `INSERT INTO app_meta (key, value) VALUES ('schema_version', '${s.version}')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `INSERT INTO app_meta (key, value) VALUES ('min_reader', '${reader}')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ];
  });
}

/** The admin's `users` row (PLAN.md §11.4 step 1): `account_id` NULL until his next sign-in
 *  binds it, `db_name` 'lazyboy', active, admin, epoch 0, the same uid and epoch Phase 1's
 *  cookies carry, so he stays signed in. Inserts nothing if a row with that uid exists. */
export function adminRowStatement(uid: string, spotifyId: string, now: number) {
  return {
    sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin,
                             session_epoch, invited_at)
          VALUES (:uid, NULL, :sid, 'lazyboy', 'active', :now, 1, 0, :now)
          ON CONFLICT(uid) DO NOTHING`,
    args: { uid, sid: spotifyId, now },
  };
}
