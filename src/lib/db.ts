// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL so it persists on Vercel's serverless runtime, and falls back to
// a local SQLite file in dev when TURSO_DATABASE_URL is unset.
//
// A DATABASE PER USER (multi-user PLAN §4, §6.2 layer 3). A user's data is reached only through
// forUser(uid) (bottom of this file): every per-user function here takes that user's database
// as its first argument and none is exported, so nothing at module level can run against "the"
// database. Each user database is opened by one factory and one URL rule, and its first open in
// a process checks the database's `owner_uid` and schema version ("Clients" below). Rem's
// database, `lazyboy`, is TURSO_DATABASE_URL. The telemetry client (TELEMETRY_DATABASE_URL)
// carries the three log tables — api_log, client_metrics, usage_ledger — for everyone, rows
// tagged with their user; a user path never awaits it. With TELEMETRY_DATABASE_URL unset, or
// equal to Rem's URL, the log tables sit in Rem's database (docs/STORE_MIGRATION.md).
import "server-only";
import { cache } from "react";
import path from "node:path";
import fs from "node:fs";
import {
  createClient,
  type Client,
  type InStatement,
  type ResultSet,
  type Row,
  type TransactionMode,
} from "@libsql/client";
import { getAppMeta, setAppMeta } from "@/lib/app-db";
import { newUid, type Uid } from "@/lib/identity";
import { reportIsolation } from "@/lib/isolation";
import { userCache } from "@/lib/user-cache";
import type { Track } from "@/lib/spotify/types";
import { BACKUP_PREFIX, cleanedName } from "@/lib/clean/names";
import {
  allTimeStats,
  isSkip,
  listenedMs,
  playedAtConvention,
  type AllTimeStats,
} from "@/lib/skip-rule";
import type { ProbeState } from "@/lib/harvest-policy";
import { likedDiff, type LikedRow } from "@/lib/liked-diff";
import { makeStoreFetch } from "@/lib/store-fetch";
import { HISTORY_INDEX_SHAPE, LIBRARY_INDEX_SHAPE } from "@/lib/search-shape";
import { ALLTIME_GATE_MS, isMode, type Mode } from "@/lib/budget/modes";
import type { MeterSample } from "@/lib/budget/meter";
import {
  CALIBRATION,
  STEADY_SYNC_TICK_ROWS,
  allTimeListRebuildRows,
  contextsFullPassRows,
  dailyStatsRows,
  dayPlaysRows,
  historyPayloadRebuildRows,
  landedSyncTickRows,
  libraryPayloadRebuildRows,
  orphanFullPassRows,
  orphanPurgePassRows,
  playlistRewriteRows,
  searchHistoryLikeRows,
  uniqueSongCountRows,
} from "@/lib/read-costs";
import {
  tracksNeedingWrite,
  playKey,
  newPlays,
  diffPositions,
  diffPlaylistList,
  identityChanges,
  type PlaylistListRow,
  type TrackFields,
} from "@/lib/store-diff";

// ── Query conventions (remote stores — round trips and plan choice both matter) ──
// Every read and every write of a user's data goes through that user's database (u.client());
// the three log tables go through getTelemetryClient(), and no statement or batch mixes the two (the meter's core
// fence, ops/zenbook-meter, and its test hold the telemetry side to that). There is no second
// reader of the core data: the libSQL
// embedded replica that used to serve scanning reads was switched off in production on
// 2026-08-03 and deleted on 2026-08-11 (git history holds the code; docs/GOTCHAS.md keeps the
// post-mortem of why it could not work on serverless).
// The figures below are medians (min–max), n=15×2 interleaved / n=9 local, 2026-08-01,
// scripts/bench-reads.mjs — measured against TURSO CLOUD, which this store no longer runs on.
// The self-hosted sqld it moved to on 2026-08-08 answers the same scanning reads 5-8× faster
// and meters nothing (docs/quota-forensic/BRIDGE.md), so read them as the SHAPE of the cost,
// not as current constants. Follow these when adding queries:
//  • A scan is still the expensive kind of read, so no render path does one. Home reads a
//    materialized payload out of `meta` ("The Home payload"), and the day list + search filter
//    a payload the browser already holds ("The client-side search payloads"). A new render-path
//    read should join one of those rather than add a scan.
//  • Song-identity equality lookups — `WHERE lower(t.artist) = ?` (optionally `AND
//    lower(t.name) = ?`) — keep an INNER JOIN so the planner uses idx_tracks_artist_name:
//    INNER 22-24ms vs LEFT 82-510ms (max 3,475ms) remote, 0.045ms vs 5.6ms local.
//    Reproduced in both replicates; this one is a real rule.
//  • LEFT vs INNER on the plays-driven joins is measured INDISTINGUISHABLE, rows identical:
//    dailyStats window 66/104ms LEFT vs 68/47ms INNER; history search 71/57 vs 70/56.
//    LEFT stays the default style here — but it is no longer a performance rule.
//  • Cache whole-table aggregates in `meta` and recompute on write, not on read
//    (`unique_song_count`, `alltime_stats`; per-day stats fetch only their window): a live
//    recompute costs 0.2-3.4s against a remote store vs a ~20ms meta read. Every cached
//    derived value must be covered by scripts/verify-derived.mjs.
//  • A write that changed a table any cached read serves must BUMP THE WRITE MARKER in the
//    same batch (writeSeqStmt(); the marker note below owns the bump-or-not rule) and end with
//    dropWriteSeqCache(). Serial reads stack linearly — ~20ms each against Turso (a single-key
//    meta read cost the same as `SELECT 1`), 3 serial meta reads 65-72ms vs 23-26ms for the
//    same 3 via Promise.all, and the funnel's round trip is larger still — so dedupe or
//    parallelize them.
//  • NEVER encode a single-session timing against the remote store as a rule. State median
//    (min–max), n and date, and re-measure before trusting it. This file's own history is the
//    cautionary tale: three of the rules it used to state did not reproduce.

export type PlayRecord = {
  trackId: string;
  name: string;
  artist: string;
  uri: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
  playedAt: string; // ISO timestamp from Spotify
  contextType: string | null; // "playlist" | "album" | "artist" | null
  contextUri: string | null;
};

// `name: null` is a negative cache — the context is known-unresolvable (403/404), so it
// stops being re-fetched every sync; displays fall back to the type via COALESCE.
export type ContextRecord = { uri: string; name: string | null; type: string };

export type TrackStats = {
  id: string;
  name: string;
  artist: string;
  uri: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
  plays: number;
  lastPlayed: string;
  firstPlayed: string;
  source: string | null; // where it was played from on the MOST RECENT play
};

export type DayStats = {
  day: string; // YYYY-MM-DD in the user's local zone (see localDay / offsetMin)
  plays: number;
  uniqueTracks: number;
  durationMs: number;
};

// ── Clients: one factory, a database per user, the telemetry store ──────────────────────────
// Multi-user PLAN §4.2, §4.5, §6.2 layer 3. Every client is built by makeStoreClient, so each
// one rides makeStoreFetch (the gzip pin and the retry ladder two production incidents bought).
//
// A user's database is named by its `db_name` and reached through ONE rule, storeUrlFor():
// Rem's database, `lazyboy`, is TURSO_DATABASE_URL (the local file in dev and tests); every
// other name comes from STORE_URL_TEMPLATE with `{db}` replaced. No template, no URL: the
// open throws, and nothing ever falls back to Rem's URL. Which `db_name` a uid has is not
// decided here: the users row says, read by the identity read and the claim (forUser below).
//
// The first use of a database for a uid in this process reads its four `meta` keys in ONE
// statement, sent in the same batch as the request's first read (whose result is used only
// once the owner matches), or ahead of a first write. The verdict is cached per
// (uid, db_name), so a second uid mapped to a database already open is checked again:
//   - `owner_uid` not the uid → refused, and an isolation event recorded;
//   - `min_reader` above this code's schema version → refused ("updating"): a rebuild ran
//     that this build cannot read;
//   - `schema_version` behind by additive steps → applied, but only by production code
//     (VERCEL_ENV=production) or on a local file; a dev server, a test or a script pointed
//     at a remote database refuses, so a branch's schema never reaches Rem's database first;
//   - a local file with none of the keys (dev's data/listens.db, a test's throwaway file) is
//     provisioned for the uid that opens it; a remote database without them is refused
//     (scripts/phase1-meta-keys.mjs writes them into Rem's).
// `store_epoch` is a random value written at provisioning (and by a restore); it goes into
// every user cache key and both search ETags, so a restored database cannot meet entries
// cached under the versions it re-issues.
const PRIMARY_DB = "lazyboy";
// Local-file fallback for dev; production points at the store via env.
const FILE_URL = `file:${path.join(process.cwd(), "data", "listens.db")}`;
const url = process.env.TURSO_DATABASE_URL || FILE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
// The telemetry store: api_log, client_metrics, usage_ledger (docs/STORE_MIGRATION.md §5).
// Unset, or the same URL as Rem's database, means ONE store: the log tables sit beside Rem's
// data, as they did before the split (tests, dev).
const telemetryUrl = process.env.TELEMETRY_DATABASE_URL;
const telemetryAuthToken = process.env.TELEMETRY_AUTH_TOKEN;
const separateTelemetry = !!telemetryUrl && telemetryUrl !== url;

/** db_name → URL, the one rule (see the section note). */
function storeUrlFor(dbName: string): string {
  if (dbName === PRIMARY_DB) return url;
  const template = process.env.STORE_URL_TEMPLATE;
  if (!template || !template.includes("{db}")) {
    throw new Error(`no URL for database ${dbName}: STORE_URL_TEMPLATE is unset or has no {db}`);
  }
  return template.replaceAll("{db}", dbName);
}

// Every store query rides this fetch: it forces gzip (brotli on the Zenbook's CPU cost the
// history payload 26 SECONDS) and owns the retry ladder. store-fetch.ts holds the whole
// story and the measurements.
const retryingFetch = makeStoreFetch();
// The telemetry store's: one attempt, 4 s. The core ladder (3 × 15 s) would hold a log write
// for 45 s against a frozen host, and a log row is not worth a retry.
const telemetryFetch = makeStoreFetch(fetch, { attempts: 1, attemptTimeoutMs: 4_000 });

function makeStoreClient(u: string, token: string | undefined, f: typeof fetch): Client {
  if (u.startsWith("file:")) {
    fs.mkdirSync(path.dirname(u.slice("file:".length)), { recursive: true });
  }
  return createClient({ url: u, authToken: token, intMode: "number", fetch: f });
}

// Per process, kept on globalThis so a dev server's module reloads share them: one client per
// db_name, the owner verdict per (uid, db_name), and the telemetry client.
type Opened = { epoch: string };
type StoreGlobals = {
  __lbUserClients?: Map<string, Client>;
  __lbUserDbNames?: Map<string, string>;
  __lbOpened?: Map<string, Opened>;
  __lbSchemaRuns?: Map<string, Promise<void>>;
  __lbTelemetry?: Map<"telemetry", Promise<Client>>;
  __lbBudgetMode?: { at: number; mode: Mode | null };
};
const g = globalThis as unknown as StoreGlobals;
const userClients = (): Map<string, Client> => (g.__lbUserClients ??= new Map());
// uid → db_name, as the last identity read or claim in this process named it (forUser below).
const userDbNames = (): Map<string, string> => (g.__lbUserDbNames ??= new Map());
const openedDbs = (): Map<string, Opened> => (g.__lbOpened ??= new Map());
// One schema run (steps or provisioning) per database at a time in a process: two first
// requests racing the same ALTER would fail the second ("duplicate column").
const schemaRuns = (): Map<string, Promise<void>> => (g.__lbSchemaRuns ??= new Map());
const openKey = (uid: Uid, dbName: string) => `${uid} ${dbName}`;

function rawUserClient(dbName: string): Client {
  const clients = userClients();
  let c = clients.get(dbName);
  if (!c) {
    c = makeStoreClient(storeUrlFor(dbName), authToken, retryingFetch);
    clients.set(dbName, c);
  }
  return c;
}

/** The three log tables, and nothing else. A user path never awaits this client: its calls
 *  are fired with `void` (or after the response, /api/metrics), and its fetch gives up after
 *  one 4 s attempt, so a frozen telemetry host costs a log row, never a page. */
function getTelemetryClient(): Promise<Client> {
  const m = (g.__lbTelemetry ??= new Map());
  const cached = m.get("telemetry");
  if (cached) return cached;
  const p = initTelemetry();
  m.set("telemetry", p);
  // If init fails (a transient network blip on first use), drop the cached rejection so the
  // next call retries — otherwise every log write in this process fails until a restart.
  p.catch(() => {
    if (m.get("telemetry") === p) m.delete("telemetry");
  });
  return p;
}

async function initTelemetry(): Promise<Client> {
  const client = separateTelemetry
    ? makeStoreClient(telemetryUrl!, telemetryAuthToken, telemetryFetch)
    : makeStoreClient(url, authToken, retryingFetch);
  // Sharing Rem's database, the log tables' DDL is a schema step on it, and only production code
  // or a local file may apply one (the versioned open's rule, mayApplySchema).
  if (separateTelemetry || mayApplySchema(url)) {
    await client.executeMultiple(TELEMETRY_SCHEMA);
    await migrateTelemetry(client);
  }
  return client;
}

/** What the per-user functions below are handed: whose database, and its two accessors. */
type UserDb = {
  readonly uid: Uid;
  readonly dbName: string;
  client(): Promise<StoreClient>;
  /** The database's `store_epoch`, from the open's verdict. */
  epoch(): Promise<string>;
};

/** The statements a per-user function may run: the open's guard sits in front of both. */
export type StoreClient = {
  execute(stmt: InStatement): Promise<ResultSet>;
  batch(stmts: InStatement[], mode?: TransactionMode): Promise<ResultSet[]>;
};

/** Refused at open: the database belongs to someone else, needs a newer build, is behind a
 *  schema step this process may not apply, or was never provisioned. */
export class StoreRefusedError extends Error {
  constructor(
    readonly code: "owner-mismatch" | "too-new" | "schema-behind" | "unprovisioned",
    message: string,
  ) {
    super(message);
    this.name = "StoreRefusedError";
  }
}

/** This code's user-database schema, as additive or rebuild steps. Version 1 is the schema
 *  every database had before versions existed: CORE_SCHEMA and migrateCore, all idempotent
 *  and additive. A new additive step appends here with the next version; a rebuild also
 *  raises MIN_READER_WRITTEN, so the previous build refuses the database instead of
 *  misreading it (PLAN §4.5 item 6). */
export const USER_SCHEMA_VERSION = 1;
const MIN_READER_WRITTEN = 1;
const USER_SCHEMA: { version: number; kind: "additive" | "rebuild"; apply(c: Client): Promise<void> }[] = [
  {
    version: 1,
    kind: "additive",
    apply: async (c) => {
      await c.executeMultiple(CORE_SCHEMA);
      await migrateCore(c);
    },
  },
];

const OPEN_KEYS = ["owner_uid", "schema_version", "min_reader", "store_epoch"] as const;
type OpenKeys = Partial<Record<(typeof OPEN_KEYS)[number], string>>;
const OPEN_READ: InStatement = {
  sql: `SELECT key, value FROM meta
        WHERE key IN ('owner_uid', 'schema_version', 'min_reader', 'store_epoch')`,
  args: [],
};

/** Who may apply an additive step: production code, or anyone on a local file (dev's own
 *  databases, the tests'). Everything else waits for the production deploy. */
export function mayApplySchema(dbUrl: string, env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production" || dbUrl.startsWith("file:");
}

export type OpenVerdict =
  | { kind: "open"; epoch: string }
  | { kind: "apply"; from: number }
  | { kind: "provision" }
  | { kind: "refuse"; code: StoreRefusedError["code"]; message: string };

/** The open's decision over a database's four keys (pure; the rules in the section note). */
export function openVerdict(
  keys: OpenKeys,
  uid: string,
  opts: { local: boolean; mayApply: boolean; codeVersion?: number },
): OpenVerdict {
  const code = opts.codeVersion ?? USER_SCHEMA_VERSION;
  if (keys.owner_uid !== undefined && keys.owner_uid !== uid) {
    return { kind: "refuse", code: "owner-mismatch", message: "this database belongs to another user" };
  }
  if (keys.owner_uid === undefined || keys.store_epoch === undefined) {
    return opts.local
      ? { kind: "provision" }
      : { kind: "refuse", code: "unprovisioned", message: "the database has no owner_uid or store_epoch" };
  }
  const minReader = Number(keys.min_reader ?? "0") || 0;
  if (minReader > code) {
    return { kind: "refuse", code: "too-new", message: `updating: the database needs schema ${minReader}` };
  }
  const version = Number(keys.schema_version ?? "0") || 0;
  if (version < code) {
    return opts.mayApply
      ? { kind: "apply", from: version }
      : {
          kind: "refuse",
          code: "schema-behind",
          message: `the database is at schema ${version}; it waits for the production deploy`,
        };
  }
  return { kind: "open", epoch: keys.store_epoch };
}

function openKeysOf(rs: ResultSet): OpenKeys {
  const out: OpenKeys = {};
  for (const r of rs.rows) {
    const k = String(r.key) as (typeof OPEN_KEYS)[number];
    if ((OPEN_KEYS as readonly string[]).includes(k)) out[k] = String(r.value);
  }
  return out;
}

const metaUpsert = (key: string, value: string): InStatement => ({
  sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  args: [key, value],
});

/** A random store epoch: 12 base32 characters, like a uid. */
function newStoreEpoch(): string {
  return newUid();
}

/** Act on the verdict for (uid, db_name). Returns whether a schema step or provisioning ran,
 *  so a read sent with the open is re-run against the new schema. Throws StoreRefusedError. */
async function settleOpen(uid: Uid, dbName: string, c: Client, keys: OpenKeys | null): Promise<boolean> {
  const dbUrl = storeUrlFor(dbName);
  const local = dbUrl.startsWith("file:");
  const verdict: OpenVerdict = keys
    ? openVerdict(keys, uid, { local, mayApply: mayApplySchema(dbUrl) })
    : local
      ? { kind: "provision" }
      : { kind: "refuse", code: "unprovisioned", message: "the database has no meta table" };
  if (verdict.kind === "open") {
    openedDbs().set(openKey(uid, dbName), { epoch: verdict.epoch });
    return false;
  }
  if (verdict.kind === "refuse") {
    if (verdict.code === "owner-mismatch") await reportIsolation("owner-mismatch", uid);
    console.error(`[store] refused ${dbName} for ${uid}: ${verdict.message}`);
    throw new StoreRefusedError(verdict.code, verdict.message);
  }
  const from = verdict.kind === "apply" ? verdict.from : Number(keys?.schema_version ?? "0") || 0;
  const runs = schemaRuns();
  let run = runs.get(dbName);
  if (!run) {
    run = (async () => {
      for (const step of USER_SCHEMA) if (step.version > from) await step.apply(c);
      if (verdict.kind === "provision") {
        // A local file: claim it for this uid unless someone already has, then fill what is
        // missing.
        await c.batch(
          [
            { sql: `INSERT INTO meta (key, value) VALUES ('owner_uid', ?) ON CONFLICT(key) DO NOTHING`, args: [uid] },
            { sql: `INSERT INTO meta (key, value) VALUES ('store_epoch', ?) ON CONFLICT(key) DO NOTHING`, args: [newStoreEpoch()] },
            { sql: `INSERT INTO meta (key, value) VALUES ('min_reader', ?) ON CONFLICT(key) DO NOTHING`, args: [String(MIN_READER_WRITTEN)] },
          ],
          "write",
        );
      }
      await c.execute(metaUpsert("schema_version", String(USER_SCHEMA_VERSION)));
    })().finally(() => runs.delete(dbName));
    runs.set(dbName, run);
  }
  await run;
  // Decide again from what the database now says, with no second chance to provision.
  const after = openVerdict(openKeysOf(await c.execute(OPEN_READ)), uid, { local: false, mayApply: false });
  if (after.kind !== "open") {
    if (after.kind === "refuse" && after.code === "owner-mismatch") await reportIsolation("owner-mismatch", uid);
    throw new StoreRefusedError(after.kind === "refuse" ? after.code : "schema-behind", "the open did not settle");
  }
  openedDbs().set(openKey(uid, dbName), { epoch: after.epoch });
  return true;
}

const isNoMetaTable = (e: unknown) => /no such table:?\s*meta/i.test(String((e as Error)?.message ?? e));

/** The open on its own round trip: before a first write, or when an epoch is needed first. */
async function openAlone(uid: Uid, dbName: string, c: Client): Promise<void> {
  let keys: OpenKeys | null;
  try {
    keys = openKeysOf(await c.execute(OPEN_READ));
  } catch (e) {
    if (!isNoMetaTable(e)) throw e;
    keys = null;
  }
  await settleOpen(uid, dbName, c, keys);
}

// A statement that can only read: the open rides in front of it in one read batch. Anything
// else (a write, a CTE in front of a write) gets the open on its own round trip first.
const isPlainRead = (s: InStatement) => /^\s*SELECT\b/i.test(typeof s === "string" ? s : s.sql);

function guardedClient(uid: Uid, dbName: string): StoreClient {
  const key = openKey(uid, dbName);
  async function firstRead(c: Client, stmts: InStatement[]): Promise<ResultSet[]> {
    let results: ResultSet[];
    try {
      results = await c.batch([OPEN_READ, ...stmts], "read");
    } catch {
      // The batch failed as a whole: no meta table yet, a read of a column a pending schema
      // step adds, or the read itself. The open on its own settles the database (or throws),
      // and the read then runs again (and fails again, if the fault was the read's).
      await openAlone(uid, dbName, c);
      return c.batch(stmts, "read");
    }
    const changed = await settleOpen(uid, dbName, c, openKeysOf(results[0]));
    return changed ? c.batch(stmts, "read") : results.slice(1);
  }
  return {
    async execute(stmt) {
      const c = rawUserClient(dbName);
      if (openedDbs().has(key)) return c.execute(stmt);
      if (isPlainRead(stmt)) return (await firstRead(c, [stmt]))[0];
      await openAlone(uid, dbName, c);
      return c.execute(stmt);
    },
    async batch(stmts, mode) {
      const c = rawUserClient(dbName);
      if (openedDbs().has(key)) return c.batch(stmts, mode);
      if (mode === "read" && stmts.every(isPlainRead)) return firstRead(c, stmts);
      await openAlone(uid, dbName, c);
      return c.batch(stmts, mode);
    },
  };
}

function userDb(uid: Uid, dbName: string): UserDb {
  const client = guardedClient(uid, dbName);
  return {
    uid,
    dbName,
    client: async () => client,
    async epoch() {
      const hit = openedDbs().get(openKey(uid, dbName));
      if (hit) return hit.epoch;
      await openAlone(uid, dbName, rawUserClient(dbName));
      return openedDbs().get(openKey(uid, dbName))!.epoch;
    },
  };
}

const CORE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      uri TEXT NOT NULL,
      album TEXT,
      album_image TEXT,
      duration_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      played_at TEXT NOT NULL,
      context_type TEXT,
      context_uri TEXT,
      UNIQUE (track_id, played_at)
    );
    CREATE TABLE IF NOT EXISTS contexts (uri TEXT PRIMARY KEY, name TEXT, type TEXT);
    CREATE INDEX IF NOT EXISTS idx_plays_track ON plays (track_id);
    CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays (played_at);
    -- Song identity is (artist, title), case-insensitive: the listen-history lookups and
    -- Find searches all filter/group on lower(artist)[, lower(name)]. Without this they
    -- scan the whole tracks table on every call.
    CREATE INDEX IF NOT EXISTS idx_tracks_artist_name ON tracks (lower(artist), lower(name));
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT,
      image TEXT,
      track_count INTEGER,
      position INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      track_id TEXT NOT NULL,
      added_at TEXT,
      PRIMARY KEY (playlist_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_pltracks_pl ON playlist_tracks (playlist_id);
    -- Find "where does this song/artist live" looks up playlist_tracks BY track_id; without
    -- this the plan degrades from SEARCH-by-index to a full SCAN (local copy, same rows:
    -- 0.032ms indexed vs 0.683ms with the index dropped, n=9, 2026-08-01) — and a scan is
    -- far worse against a remote store, where it was seconds-scale on Turso.
    CREATE INDEX IF NOT EXISTS idx_pltracks_track ON playlist_tracks (track_id);
    CREATE TABLE IF NOT EXISTS saved_tracks (
      track_id TEXT PRIMARY KEY,
      added_at TEXT,
      position INTEGER
    );
`;

const TELEMETRY_SCHEMA = `
    CREATE TABLE IF NOT EXISTS api_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      retry_after INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log (ts);
    CREATE INDEX IF NOT EXISTS idx_api_log_path_ts ON api_log (path, ts);
    -- Per-reader modeled rows-read attribution, one row per (UTC day, reader). See "The
    -- read-cost ledger" near the bottom of this file. The primary key is (day, reader) so
    -- the upsert is an indexed probe and a day's rows are a range seek.
    CREATE TABLE IF NOT EXISTS usage_ledger (
      day TEXT NOT NULL,
      reader TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      modeled_rows INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, reader)
    );
    -- Append-only client performance log: one row per timing the browser reports. See
    -- "Client performance metrics" at the bottom of this file. Read only by the usage page's
    -- 7-day summary, which filters on ts.
    CREATE TABLE IF NOT EXISTS client_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      session TEXT,
      page TEXT,
      event TEXT,
      value REAL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_metrics_ts ON client_metrics (ts);
    -- The CPU meter (src/lib/budget/request-meter.ts): one row per (UTC day, route, user), each
    -- flush adding its counts. user_id is "-" for no user.
    CREATE TABLE IF NOT EXISTS cpu_meter (
      day TEXT NOT NULL,
      route TEXT NOT NULL,
      user_id TEXT NOT NULL,
      invocations INTEGER NOT NULL DEFAULT 0,
      cpu_us INTEGER NOT NULL DEFAULT 0,
      wall_ms INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (day, route, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cpu_meter_updated ON cpu_meter (updated_at);
    -- The daily budget record (src/lib/budget/daily.ts): each dimension's month-to-date, its
    -- projection and its mode, for /usage and for the next day's hysteresis.
    CREATE TABLE IF NOT EXISTS budget_days (
      day TEXT NOT NULL,
      dimension TEXT NOT NULL,
      used REAL,
      projected REAL,
      hard_limit REAL NOT NULL,
      mode TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (day, dimension)
    );
`;

async function migrateCore(client: Client): Promise<void> {
  // Migrate older DBs that predate the album/duration columns.
  const info = await client.execute("PRAGMA table_info(tracks)");
  const cols = new Set(info.rows.map((r) => String(r.name)));
  if (!cols.has("album")) await client.execute("ALTER TABLE tracks ADD COLUMN album TEXT");
  if (!cols.has("album_image")) await client.execute("ALTER TABLE tracks ADD COLUMN album_image TEXT");
  if (!cols.has("duration_ms")) await client.execute("ALTER TABLE tracks ADD COLUMN duration_ms INTEGER");
  // checked_at drives the negative-cache re-check (see unresolvedContextUris).
  const ctxInfo = await client.execute("PRAGMA table_info(contexts)");
  const ctxCols = new Set(ctxInfo.rows.map((r) => String(r.name)));
  if (!ctxCols.has("checked_at")) {
    await client.execute("ALTER TABLE contexts ADD COLUMN checked_at TEXT");
  }
  // ctx_orphan caches the playlist-membership verdict per play (see sourceExpr). NULL means
  // "not computed yet" — recomputeOrphanFlags() fills it, and until it does the read falls
  // back to treating the play as non-orphan, which is the same answer for ~91% of plays.
  const playsInfo = await client.execute("PRAGMA table_info(plays)");
  const playsCols = new Set(playsInfo.rows.map((r) => String(r.name)));
  if (!playsCols.has("ctx_orphan")) {
    await client.execute("ALTER TABLE plays ADD COLUMN ctx_orphan INTEGER");
  }
  // plays.skipped: the listened-fraction verdict per play (Rem, 2026-08-16 — a play with
  // less than 40% of the song actually listened is a SKIP: not listed, not counted).
  // NULL = pending: inserted (or re-opened by an out-of-order insert) and not yet ruled;
  // treated as not-skipped until recomputeSkipFlags() rules on it, which the same write does.
  if (!playsCols.has("skipped")) {
    await client.execute("ALTER TABLE plays ADD COLUMN skipped INTEGER");
    // Backfill imports are catalog rows, not listening — verdict them immediately so they
    // never sit in the pending set.
    await client.execute("UPDATE plays SET skipped = 0 WHERE context_type = 'backfill'");
  }
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_skip_null ON plays (played_at) WHERE skipped IS NULL",
  );
  // Every orphan recompute, and playedTracksInContext (Resume), select plays BY context_uri;
  // without this they scan the whole plays table.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_context ON plays (context_uri)",
  );
  // recomputeOrphanFlags(u, {newOnly}) filters on `ctx_orphan IS NULL`. Without this partial
  // index that is a full plays scan on every sync tick that lands a play — ~7.2K rows
  // scanned to find the handful of new ones. The index holds only the unverdicted rows
  // (normally ≈0), so the same UPDATE scans just those.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_orphan_null ON plays (id) WHERE ctx_orphan IS NULL",
  );
}

async function migrateTelemetry(client: Client): Promise<void> {
  // Which traffic source made each Spotify call (cron-sync, now-playing, an action…) —
  // added 2026-08-16 so a 429 is attributable to its CALLER, not just its endpoint.
  const apiLogInfo = await client.execute("PRAGMA table_info(api_log)");
  const apiLogCols = new Set(apiLogInfo.rows.map((r) => String(r.name)));
  if (!apiLogCols.has("source")) {
    await client.execute("ALTER TABLE api_log ADD COLUMN source TEXT");
  }
  // The user each row belongs to (multi-user PLAN §4.3): whose Spotify call, whose page
  // timing. Account deletion deletes by it (§12.3). Null for rows with no user (server
  // errors, rows written before Phase 1).
  if (!apiLogCols.has("user_id")) {
    await client.execute("ALTER TABLE api_log ADD COLUMN user_id TEXT");
  }
  // A 429's `reason` from its body (QUOTA_EXCEEDED, or none for a rate limit): how the quota is
  // counted is found from these rows (multi-user PLAN §4.3, §7.9).
  if (!apiLogCols.has("reason")) {
    await client.execute("ALTER TABLE api_log ADD COLUMN reason TEXT");
  }
  const metricsInfo = await client.execute("PRAGMA table_info(client_metrics)");
  if (!metricsInfo.rows.some((r) => String(r.name) === "user_id")) {
    await client.execute("ALTER TABLE client_metrics ADD COLUMN user_id TEXT");
  }
}

// ── One client, no replica ──────────────────────────────────────────────────────────────
// Scanning reads used to be served by a libSQL EMBEDDED REPLICA — a local SQLite copy of the
// store, pulled from the primary and handed out behind a per-request freshness gate. It is
// gone. Production ran with it switched off from 2026-08-03 (each cold serverless instance
// bootstrapped the whole ~17MB copy, which burned 77% of Turso's 3GB/mo syncs quota in three
// days), and on 2026-08-08 the store itself moved to self-hosted sqld, where reads are neither
// metered nor slow enough to be worth a copy. The code, its measurements, and the
// build-time-seed post-mortem (a bundled snapshot goes stale-generation at the primary's first
// replication rotation, which made the normal cold start 2-3× SLOWER) are in git history and
// summarised in docs/GOTCHAS.md.
//
// So a user's database is the whole story for that user's data: every read, every write, all
// of its `meta`. getTelemetryClient() carries only the log tables, and only off the awaited path
// of a user request (fired with `void`, or in after() at /api/metrics), on one 4 s attempt.

// ── The write marker (`meta.write_seq`) ─────────────────────────────────────────────────
// A counter bumped by every write that changes what a CACHED read serves. It is a content
// version, and two mechanisms are built on it:
//   • the LIVE cache keys ("Read caching" below) — the day strip, a day's plays, the all-time
//     list, the playlist grid all take it as an argument purely so it lands in the key, so a
//     write that changed their data produces a different key and the next read recomputes;
//   • the client-side history payload, via the slow marker (`meta.slow_seq_pub`, published at
//     most every 10 min) that getHistoryIndexVersion() serves as the payload's version and its
//     route's ETag.
// It is also how a write made OUTSIDE the app announces itself — scripts/backfill-from-
// backstop.mjs bumps it after replaying captured plays, and that bump is the only thing that
// stops every cached entry and every browser's payload from serving the pre-backfill answer.
// (It formerly gated an embedded replica's freshness; that job is gone with the replica.)
//
// WHICH WRITES BUMP IT — the rule, in one place:
//   BUMP when the write changes a table a cached read serves: plays (including ctx_orphan),
//   tracks, contexts, playlists, playlist_tracks, saved_tracks.
//   DO NOT BUMP for a write that only touches `meta`, `api_log`, `usage_ledger` or
//   `client_metrics`. Nothing cached is derived from them — every meta read goes through
//   getMeta() straight to the store, and the other three are read only by their own
//   diagnostics. That covers tokens, locks, the cooldown, the *_synced_at stamps, the Home
//   payload, and the derived caches (`alltime_stats`, `unique_song_count`). api_log matters
//   most: it is written on essentially every outgoing Spotify call (~6s apart while the app is
//   open), so bumping on it would invalidate every cached read continuously — the exact cost
//   the caching exists to avoid.
// An unnecessary bump is not a correctness bug, it just throws away cache entries and makes
// every browser re-download the history payload. A MISSING bump is a correctness bug: it
// serves rows that the write already replaced.
//
// The bump must be ATOMIC WITH (same batch as) or AFTER the data it announces, never before.
// Announcing late is safe — a reader in the gap simply recomputes one read early. Announcing
// early is not: a read could be cached under a key that claims to include a write the store
// does not have yet.
const WRITE_SEQ_KEY = "write_seq";

/** The bump, as a statement to append to a write batch. Starts the counter at 1 if absent. */
function writeSeqStmt(): InStatement {
  return {
    sql: `INSERT INTO meta (key, value) VALUES ('${WRITE_SEQ_KEY}', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`,
    args: [],
  };
}

/** Bump the marker on its own, for a write that isn't already batched. */
async function bumpWriteSeq(u: UserDb): Promise<void> {
  const client = await u.client();
  await client.execute(writeSeqStmt());
}

// ── The library marker (`meta.library_seq`) ─────────────────────────────────────────────
// A second counter, bumped by the writes that change WHICH TRACKS ARE IN THE LIBRARY —
// playlists, playlist_tracks, saved_tracks — and by nothing else. It versions the library
// search payload ("The client-side search payloads" below), which is the largest body this app
// serves and must therefore survive a listening session in the browser cache. write_seq cannot
// do that job: it bumps on every play, so the payload would be re-downloaded whole after every
// listen. It rides ALONGSIDE write_seq (never instead of it) — the same write still has to
// move the LIVE cache keys.
//
// Same discipline as write_seq: bump in the same batch as the data, and only when the batch
// actually changed something. A missing bump serves a stale library; an extra one costs a
// re-download.
const LIBRARY_SEQ_KEY = "library_seq";

/** The bump, as a statement to append to a write batch. Starts the counter at 1 if absent. */
function librarySeqStmt(): InStatement {
  return {
    sql: `INSERT INTO meta (key, value) VALUES ('${LIBRARY_SEQ_KEY}', '1')
          ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1`,
    args: [],
  };
}

/** The marker as stored (a TEXT column, so compare as strings), or null before the first
 *  bump. Cheap: an indexed single-key lookup — ~20-30ms against Turso (a round trip; the same
 *  cost as `SELECT 1`), and one round trip against the store it runs on now. */
async function readWriteSeq(client: StoreClient): Promise<string | null> {
  const res = await client.execute({
    sql: "SELECT value FROM meta WHERE key = ?",
    args: [WRITE_SEQ_KEY],
  });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

// The store's marker, read ONCE per request and shared: every cached read (see "Read
// caching") keys off it, and three serial single-key reads cost 65-72ms against 23-26ms for
// one (the round-trip note at the top of the file). Same per-request box as orderedRealPlays
// below and the token box in auth.ts — React cache() gives a per-request box; outside a
// request (the cron path) cache() has no dispatcher and is a pass-through, so each call reads
// again instead, which is correct, just not deduped. Keyed by (uid, db_name): two users'
// markers are small integers that collide, so a shared box would key one user's cache
// entries off the other's marker (multi-user PLAN §6.2 layer 4).
const seqBox = cache((_uid: Uid, _dbName: string) => ({ p: null as Promise<string | null> | null }));
function primaryWriteSeq(u: UserDb): Promise<string | null> {
  const box = seqBox(u.uid, u.dbName);
  box.p ??= u.client().then(readWriteSeq);
  return box.p;
}

/** Drop this request's shared copy of the marker. Called at the end of every write that bumped
 *  it: the cached reads below key off that copy, so leaving it in place would serve the
 *  PRE-write entry to the read that follows the write — exactly what refreshHistoryAction does
 *  (sync, then re-read the day). Same shape as publishTokens() in auth.ts: a write republishes
 *  what it just made true instead of leaving the request's snapshot stale. */
function dropWriteSeqCache(u: UserDb): void {
  seqBox(u.uid, u.dbName).p = null;
}

// libSQL Row objects aren't plain objects (they carry a prototype + indexed access), so
// React warns when a Server Component passes them straight to a Client Component. Spread
// each into a plain object so query results cross the RSC boundary cleanly.
function plainRows(rows: readonly unknown[]): unknown[] {
  return rows.map((r) => ({ ...(r as object) }));
}

// Cached track rows for a set of ids, chunked to stay under SQLite's bound-variable cap.
async function readCachedTracks(client: StoreClient, ids: string[]): Promise<Map<string, TrackFields>> {
  const cached = new Map<string, TrackFields>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const res = await client.execute({
      sql: `SELECT id, name, artist, uri, album, album_image AS albumImage,
              duration_ms AS durationMs
            FROM tracks WHERE id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const r of plainRows(res.rows) as unknown as TrackFields[]) cached.set(r.id, r);
  }
  return cached;
}

// The unconditional-upsert statement for a track row (used only for rows the diff says
// actually changed — an ON CONFLICT UPDATE writes a row even when the values are identical,
// which Turso billed and which is wasted work on any store).
function trackUpsertStmt(t: TrackFields): InStatement {
  return {
    sql: `INSERT INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
          VALUES (:id, :name, :artist, :uri, :album, :albumImage, :durationMs)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, artist = excluded.artist,
            album = excluded.album, album_image = excluded.album_image,
            duration_ms = excluded.duration_ms`,
    args: {
      id: t.id,
      name: t.name,
      artist: t.artist,
      uri: t.uri,
      album: t.album,
      albumImage: t.albumImage,
      durationMs: t.durationMs,
    },
  };
}

/** Insert plays, deduped on (track, played_at). Returns how many were new. */
async function recordPlays(u: UserDb, plays: PlayRecord[]): Promise<number> {
  if (plays.length === 0) return 0;
  const client = await u.client();
  // Diff before writing: the sync hands us the same ~50 recently-played rows every couple
  // of minutes, and blindly upserting them burned ~50 billed row writes per tick on
  // identical data. Two small indexed reads find what actually changed; a no-change tick
  // now writes only the last_sync stamp.
  const tracks: TrackFields[] = plays.map((r) => ({
    id: r.trackId,
    name: r.name,
    artist: r.artist,
    uri: r.uri,
    album: r.album,
    albumImage: r.albumImage,
    durationMs: r.durationMs,
  }));
  const cached = await readCachedTracks(client, [...new Set(tracks.map((t) => t.id))]);
  // Every incoming play is at least as recent as the batch's oldest, so one indexed range
  // read covers all the (track, played_at) pairs that could already exist.
  const minAt = plays.reduce((m, p) => (p.playedAt < m ? p.playedAt : m), plays[0].playedAt);
  const existingRes = await client.execute({
    sql: `SELECT track_id AS trackId, played_at AS playedAt FROM plays WHERE played_at >= ?`,
    args: [minAt],
  });
  const existingRows = plainRows(existingRes.rows) as unknown as {
    trackId: string;
    playedAt: string;
  }[];
  const existing = new Set(existingRows.map(playKey));
  // The newest play already in the store — the boundary that tells an ordinary tail append
  // (every new play newer than this) apart from an OUT-OF-ORDER insert (a gap-fill landing
  // between existing plays), which is the only case that needs verdicts re-opened.
  const newestExisting = existingRows.reduce((m, r) => (r.playedAt > m ? r.playedAt : m), "");

  const stmts: InStatement[] = tracksNeedingWrite(tracks, cached).map(trackUpsertStmt);
  const renamed = identityChanges(tracks, cached);
  const insertResultIdx: number[] = [];
  const inserted: string[] = [];
  for (const r of newPlays(plays, existing)) {
    inserted.push(r.playedAt);
    insertResultIdx.push(stmts.length);
    // Keep OR IGNORE as a race guard — a concurrent sync may have inserted the same play
    // between our read and this write.
    stmts.push({
      sql: `INSERT OR IGNORE INTO plays (track_id, played_at, context_type, context_uri)
            VALUES (:trackId, :playedAt, :contextType, :contextUri)`,
      args: {
        trackId: r.trackId,
        playedAt: r.playedAt,
        contextType: r.contextType,
        contextUri: r.contextUri,
      },
    });
  }
  // Only announce a change if there IS one. A tick that found nothing new writes just the
  // last_sync stamp below — a meta key, which nothing cached is derived from — and the sync
  // runs every couple of minutes, so bumping unconditionally would throw away every cached
  // read around the clock.
  const changed = stmts.length > 0;
  if (changed) stmts.push(writeSeqStmt());
  // Stamp last_sync atomically with the plays.
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES ('last_sync', :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { v: new Date().toISOString() },
  });
  const results = await client.batch(stmts, "write");
  // A renamed song can move the verdict of older plays, from any playlist.
  if (renamed.length > 0) await recomputeOrphanFlags(u, { identities: renamed });
  // A no-change tick (the steady-state cron every couple of minutes) wrote only last_sync —
  // nothing a cached read serves — so skip the orphan recompute (~0.2s UPDATE over zero rows)
  // it would otherwise pay each tick.
  if (insertResultIdx.length > 0) {
    // Give the plays we just inserted their membership verdict before anything reads them.
    await recomputeOrphanFlags(u, { newOnly: true });
    // An out-of-order insert (a gap-fill landing BETWEEN existing plays) makes the row
    // immediately AFTER it wrong: a verdict is measured from the previous play's end
    // (played_at is an END stamp, C1), and that row's previous play just changed. Re-open
    // the successor of each such insert — and ONLY those. (Under the old start-stamp rule
    // this re-opened the predecessor; a first cut used the whole batch's minAt and re-opened
    // a verdict ~50 rows deep on every landed tick — wave-2 adversarial review, finding A.)
    // Ordinary tail appends (every insert newer than everything stored) have no successor
    // and skip this entirely.
    // `<=`, and the reset covers TIE-MATES too: a play landing AT a timestamp already in
    // the store can become its tie-mate's predecessor, so the same three rows must not count
    // differently depending on delivery order (wave-3 independent adversarial suite, F2/F3).
    const outOfOrder = [...new Set(inserted.filter((at) => at <= newestExisting))];
    for (const at of outOfOrder) {
      await client.execute({
        sql: `UPDATE plays SET skipped = NULL
              WHERE (played_at = :at AND (context_type IS NULL OR context_type <> 'backfill'))
                 OR id = (
                SELECT p.id FROM plays p
                WHERE p.played_at > :at AND ${NOT_BACKFILL}
                ORDER BY p.played_at ASC, p.track_id ASC LIMIT 1)`,
        args: { at },
      });
    }
    // …and rule on skips: every pending play — the new ones and the re-opened successors —
    // has its predecessor in the store now.
    await recomputeSkipFlags(u);
  }
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  if (changed) dropWriteSeqCache(u);
  let added = 0;
  for (const i of insertResultIdx) added += Number(results[i].rowsAffected);
  // New plays landed → refresh the cached all-time totals so Home reads them instantly
  // (instead of running the expensive gap scan on render). Only on a real change, and at
  // most every 10 min (30 in economy and freeze, src/lib/budget/modes.ts): the recompute is
  // a full plays scan (~14K rows), and during a listening session plays land on many
  // consecutive ticks. The card can lag
  // the newest plays by ≤10 min mid-session; the end-of-session tail is healed by the
  // daily cron's unconditional recompute (cron/sync route).
  if (added > 0) await maybeRecomputeAllTimeStats(u);
  return added;
}

async function maybeRecomputeAllTimeStats(u: UserDb): Promise<void> {
  const v = await getMeta(u, "alltime_at");
  const gateMs = ALLTIME_GATE_MS[(await getBudgetMode().catch(() => null)) ?? "normal"];
  if (v && Date.now() - (Number(v) || 0) < gateMs) return;
  await recomputeAllTimeStats(u);
}

/** Cache resolved context (playlist/album/artist) names so "From" shows a name. */
async function recordContexts(u: UserDb, contexts: ContextRecord[]): Promise<void> {
  if (contexts.length === 0) return;
  const client = await u.client();
  const now = new Date().toISOString();
  await client.batch(
    [
      ...contexts.map((c) => ({
        sql: `INSERT INTO contexts (uri, name, type, checked_at)
              VALUES (:uri, :name, :type, :at)
              ON CONFLICT(uri) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at`,
        args: { uri: c.uri, name: c.name, type: c.type, at: now },
      })),
      writeSeqStmt(),
    ],
    "write",
  );
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

// Negative-cached (name IS NULL) contexts get re-checked this often. Keeps the cache
// self-healing — if the app ever leaves dev mode (403s lift) or a 404 was transient,
// names appear within a month with no manual cleanup, at ~a few extra calls/month.
const NEGATIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** The candidates from `cands` that have no `contexts` row yet. This is the per-sync
 *  resolution check: a never-seen context can only enter the store via a play in the
 *  incoming batch, so checking the batch's own URIs (≤50, indexed) answers the same
 *  question the full unresolvedContextUris() scan answered — that scan billed ~14K
 *  primary rows per sync call (plays scan + contexts probe per row) and ran ~1,000+
 *  times a day across the cron tick and the open-tab refresh. The negative-cache
 *  re-check that the full query also covers is not lost: the sync runs the full pass
 *  once a day (see syncRecentPlays). */
async function unseenContexts(u: UserDb, 
  cands: { uri: string; type: string }[],
): Promise<{ uri: string; type: string }[]> {
  if (cands.length === 0) return [];
  const client = await u.client();
  const uris = [...new Set(cands.map((c) => c.uri))];
  const res = await client.execute({
    sql: `SELECT uri FROM contexts WHERE uri IN (${uris.map(() => "?").join(",")})`,
    args: uris,
  });
  const seen = new Set(res.rows.map((r) => String(r.uri)));
  const out: { uri: string; type: string }[] = [];
  for (const c of cands) {
    if (!seen.has(c.uri)) {
      seen.add(c.uri); // dedupe within the batch too
      out.push(c);
    }
  }
  return out;
}

/** Context URIs worth resolving: never-seen ones first, then negative-cached ones whose
 *  re-check window has lapsed. Callers cap the batch, so the ordering keeps stale
 *  re-checks from starving genuinely new contexts.
 *
 *  A full plays scan (~14K rows) — the once-a-day pass only.
 *  Per-sync resolution goes through unseenContexts() above. */
async function unresolvedContextUris(u: UserDb): Promise<{ uri: string; type: string }[]> {
  const client = await u.client();
  const cutoff = new Date(Date.now() - NEGATIVE_RECHECK_MS).toISOString();
  const res = await client.execute({
    sql: `SELECT DISTINCT p.context_uri AS uri, p.context_type AS type,
            (c.uri IS NULL) AS isNew
          FROM plays p LEFT JOIN contexts c ON c.uri = p.context_uri
          WHERE p.context_uri IS NOT NULL
            AND (c.uri IS NULL
                 OR (c.name IS NULL AND (c.checked_at IS NULL OR c.checked_at < :cutoff)))
          ORDER BY isNew DESC`,
    args: { cutoff },
  });
  // Ledgered here, not at the call site: this is the once-a-day pass, and the sync route
  // cannot see whether the gate opened on this tick.
  ledgerAddLinear(u, "contexts_full_pass", (plays) =>
    contextsFullPassRows(plays, Math.round(plays * CONTEXTED_PLAY_FRACTION)),
  );
  return (plainRows(res.rows) as unknown as { uri: string; type: string }[]).map(
    ({ uri, type }) => ({ uri, type }),
  );
}

// The "From" (source) of a play. Normally the context's resolved name, falling back to its
// type. BUT: Spotify keeps reporting a playlist as the context even after the playlist ends
// and it auto-plays recommended "next" songs that were never in the playlist — so those
// reads are misleading. When a play's context is a playlist WE HAVE CACHED and the played
// song isn't a member, the source blanks to NULL (the UI renders "—"). Two guards keep that
// honest: (1) only blank when the playlist's tracks are cached, so an unsynced or foreign
// playlist we can't verify still shows its name instead of being wrongly blanked; (2) match
// membership by (artist, title) identity, not track id — Spotify hands the same song
// different ids in a playlist vs. recently-played, so an id match would drop real plays.
//
// That verdict is STORED, in `plays.ctx_orphan`, not recomputed per row. As a live expression
// it was two correlated `playlist_tracks` subqueries per OUTPUT row — the dominant cost of the
// all-time list when it was measured against a local SQLite copy (medians, n=5: 63ms →
// 8.9ms; history search 36ms → 5.7ms). Against Turso the same change was marginal (903ms →
// 705ms) and for one day's plays nothing (41ms either way) — that backend's variance swamped
// it.
// It is also a poor fit for live evaluation: the answer depends on playlist membership, which
// changes only when a playlist is synced, while the expression re-derived it on every render.
// recomputeOrphanFlags() refreshes it exactly when membership can have changed.
//
// `p` = the play row, `c` = its joined contexts row. NULL ctx_orphan (a play recorded before
// the column existed, or before its playlist was cached) reads as non-orphan — the same
// answer the guarded expression gave for an unverifiable playlist.
function sourceExpr(p: string, c: string): string {
  return `CASE WHEN ${p}.ctx_orphan = 1 THEN NULL
               ELSE COALESCE(${c}.name, ${p}.context_type) END`;
}

// The membership verdict, as SQL over the play row `p`. This is the ONLY place the rule
// lives; sourceExpr reads what this writes (scripts/verify-derived.mjs keeps a literal copy).
//
// The member search starts from the SONG (multi-user PLAN §8.2): the play's own `tracks` row
// `me`, the rows sharing its identity `tm` through idx_tracks_artist_name, then their
// memberships `plm` through idx_pltracks_track, filtered to the playlist. `CROSS JOIN` pins
// that loop order: left to itself SQLite walks the playlist's members and probes `tracks` for
// each, which costs ~2 × the playlist's size per play judged (379.9 rows a play on the Oct 14
// backup) against ~2.6 for this order. Same verdict as that member walk on every play
// (STORE_MIGRATION §3; tests/orphan-scope.test.ts pins it case by case).
export const ORPHAN_PREDICATE = `
  CASE WHEN p.context_type = 'playlist' AND p.context_uri IS NOT NULL
            AND EXISTS (SELECT 1 FROM playlist_tracks pl
                        WHERE pl.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
            AND NOT EXISTS (
              SELECT 1 FROM tracks me CROSS JOIN tracks tm CROSS JOIN playlist_tracks plm
              WHERE me.id = p.track_id
                AND lower(tm.artist) = lower(me.artist) AND lower(tm.name) = lower(me.name)
                AND plm.track_id = tm.id
                AND plm.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
       THEN 1 ELSE 0 END`;

/** Ids per scoped orphan statement: bounds the bound-argument count of one UPDATE. */
const ORPHAN_SCOPE_CHUNK = 100;

/** Refresh the stored `ctx_orphan` verdict, and return how many rows changed.
 *
 *  A verdict reads two things: the play's playlist's memberships, and the identity (name,
 *  artist) of the play's song and of those members. So it goes stale only when one of them is
 *  written, and each scope covers one kind of write:
 *    `{ newOnly }`     plays we just recorded have no verdict yet; nobody else's changed.
 *    `{ playlistIds }` those playlists' memberships changed (tracks stored or removed, a
 *                      playlist deleted, the library rewrite's purge), so only plays FROM them
 *                      can flip. Served by idx_plays_context.
 *    `{ identities }`  `tracks` rows were renamed (store-diff.ts identityChanges: each one's
 *                      old and new name/artist), so only plays whose song has one of those
 *                      identities can flip, from whichever playlist. Served by
 *                      idx_tracks_artist_name and idx_plays_track.
 *    `{}`              full pass: the one-time backfill and a manual repair. No write path
 *                      calls it (L10, STORE_MIGRATION §3).
 *  An EMPTY id or identity list means nothing changed and runs nothing; it never widens to
 *  the full pass.
 *
 *  Only rows whose verdict actually flips are written, so a steady-state sync that re-stores
 *  an unchanged playlist writes zero rows — a no-op UPDATE is still a written row (which Turso
 *  billed). Measured on the live DB: 0 rows and ~0.2-0.4s for the scoped modes. */
async function recomputeOrphanFlags(
  u: UserDb,
  opts: {
    playlistIds?: string[];
    identities?: { name: string; artist: string }[];
    newOnly?: boolean;
  } = {},
): Promise<number> {
  if (opts.playlistIds?.length === 0 || opts.identities?.length === 0) return 0;
  const client = await u.client();
  const stale = `(p.ctx_orphan IS NULL OR p.ctx_orphan <> (${ORPHAN_PREDICATE}))`;
  // One statement per chunk of the scope; the unscoped and newOnly forms are one statement.
  // newOnly deliberately does NOT evaluate the predicate in the WHERE clause: the point is to
  // avoid running it over every historical play just to learn nothing changed.
  const scoped: { where: string; args: string[] }[] = [];
  if (opts.newOnly) {
    scoped.push({ where: "p.ctx_orphan IS NULL", args: [] });
  } else if (opts.playlistIds) {
    for (let i = 0; i < opts.playlistIds.length; i += ORPHAN_SCOPE_CHUNK) {
      const ids = opts.playlistIds.slice(i, i + ORPHAN_SCOPE_CHUNK);
      scoped.push({
        where: `${stale} AND p.context_uri IN (${ids.map(() => "?").join(", ")})`,
        args: ids.map((id) => `spotify:playlist:${id}`),
      });
    }
  } else if (opts.identities) {
    for (let i = 0; i < opts.identities.length; i += ORPHAN_SCOPE_CHUNK) {
      const ids = opts.identities.slice(i, i + ORPHAN_SCOPE_CHUNK);
      scoped.push({
        where: `${stale} AND p.track_id IN (SELECT x.id FROM tracks x WHERE ${ids
          .map(() => "(lower(x.artist) = lower(?) AND lower(x.name) = lower(?))")
          .join(" OR ")})`,
        args: ids.flatMap((t) => [t.artist, t.name]),
      });
    }
  } else {
    // Only the UNSCOPED pass is ledgered here; the rewrite's purge pass is ledgered by its
    // caller, and the rest are bounded by construction (a ≤50-row partial index, one
    // playlist's plays, one renamed song's plays) and would be noise.
    ledgerAddLinear(u, "orphan_full_pass", orphanFullPassRows);
    scoped.push({ where: stale, args: [] });
  }
  let changed = 0;
  for (const { where, args } of scoped) {
    const res = await client.execute({
      sql: `UPDATE plays AS p SET ctx_orphan = (${ORPHAN_PREDICATE}) WHERE ${where}`,
      args,
    });
    changed += Number(res.rowsAffected);
  }
  // `plays` is served by cached reads and this ran AFTER its caller's batch already bumped,
  // so the flags need their own announcement or an entry cached in between holds rows whose
  // verdict is stale. Only when rows actually flipped: the common case is 0, and a bump there
  // would discard every cached read on every sync tick for nothing. The extra round trip is
  // paid only on a real change, and this is a background write path either way.
  if (changed > 0) await bumpWriteSeq(u);
  return changed;
}

// Backfilled plays (context_type = 'backfill') are catalog imports, not listening: songs
// from the pre-tracking era logged once (played_at = the 2026-05-30 sentinel, the day
// before tracking began) so they stay known and searchable after their playlists are
// deleted (Rem, 2026-08-15; scripts/backfill-scan.mjs writes them). They are EXCLUDED
// from every listening counter — all-time totals, the day strip, day rows — and INCLUDED
// wherever a song's history/existence is the point (the search payloads, per-play
// history, source labels, the all-time list).
const NOT_BACKFILL = `(p.context_type IS NULL OR p.context_type <> 'backfill')`;

// A play with less than 40% of the song actually listened is a SKIP (src/lib/skip-rule.ts
// owns the rule and the fraction). Listened time is estimated exactly as the hours are: the
// run from the PREVIOUS play's end to this play's end, capped at song length — Spotify's
// played_at is the END of a play (C1, burn lazyboy-review 2026-10-03). The verdict is
// materialized in plays.skipped by recomputeSkipFlags() (NULL = not yet ruled, shown until
// it is), and every list and counter filters on it.
const NOT_SKIPPED = `(p.skipped IS NULL OR p.skipped = 0)`;

/** Rule on every pending (skipped IS NULL) real play from its PREDECESSOR: ran =
 *  min(gap from the previous play, duration); skipped = ran < 40% of duration. No
 *  predecessor, unknown duration or a clock-weird negative gap counts as not-skipped (be
 *  permissive). A play is ruled the moment it lands — its predecessor is already stored.
 *  Runs after each sync that inserted plays; the pending set is tiny (idx_plays_skip_null).
 *
 *  TIES (two plays sharing one played_at) break on track_id, everywhere a gap chain is
 *  ordered — a verdict is a fact about the TIMELINE, and the rowid tie-break made it an
 *  arrival artifact: which of the pair got skipped depended on delivery order (wave-3
 *  independent adversarial suite, F1-F3). */
async function recomputeSkipFlags(u: UserDb): Promise<void> {
  const client = await u.client();
  // The window starts at the last real play BEFORE the oldest pending one, so that pending
  // play has its predecessor in hand (all its tie-mates come along; they're skipped below).
  const res = await client.execute(`
    WITH firstPending AS (
      SELECT MIN(p2.played_at) AS at FROM plays p2
      WHERE p2.skipped IS NULL
        AND (p2.context_type IS NULL OR p2.context_type <> 'backfill'))
    SELECT p.id AS id, p.played_at AS playedAt, p.skipped AS skipped,
           t.duration_ms AS durationMs
    FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
    WHERE ${NOT_BACKFILL}
      AND p.played_at >= COALESCE(
            (SELECT MAX(p3.played_at) FROM plays p3
             WHERE p3.played_at < (SELECT at FROM firstPending)
               AND (p3.context_type IS NULL OR p3.context_type <> 'backfill')),
            (SELECT at FROM firstPending),
            '9999')
    ORDER BY p.played_at ASC, p.track_id ASC`);
  const rows = plainRows(res.rows) as unknown as {
    id: number;
    playedAt: string;
    skipped: number | null;
    durationMs: number | null;
  }[];
  const updates: InStatement[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.skipped !== null) continue;
    const skipped = isSkip(i > 0 ? rows[i - 1].playedAt : null, r.playedAt, r.durationMs);
    updates.push({ sql: "UPDATE plays SET skipped = ? WHERE id = ?", args: [skipped, r.id] });
  }
  if (updates.length > 0) {
    await client.batch(updates, "write");
    // Same rule recomputeOrphanFlags follows: this ran AFTER the caller's batch already
    // bumped, and skipped is filtered by cached reads (day lists, counters, the history
    // payload) — without its own announcement, an entry cached between the insert-bump and
    // this write serves pre-verdict rows for its whole TTL (audit 2026-08-19, T1.4).
    await bumpWriteSeq(u);
    dropWriteSeqCache(u);
  }
}

// `source` is the context (playlist/album name, or type) of the MOST RECENT play
// only — not every context the track ever appeared in, which would be misleading
// (a one-off queue shouldn't read as "in this playlist").
const SELECT_TRACK = `
  SELECT t.id, t.name, t.artist, t.uri, t.album, t.album_image AS albumImage,
    t.duration_ms AS durationMs,
    COUNT(p.id) AS plays, MAX(p.played_at) AS lastPlayed, MIN(p.played_at) AS firstPlayed,
    (SELECT ${sourceExpr("p2", "c2")}
       FROM plays p2 LEFT JOIN contexts c2 ON c2.uri = p2.context_uri
       WHERE p2.track_id = t.id
       ORDER BY (p2.context_type = 'backfill') ASC, (p2.skipped = 1) ASC,
                p2.played_at DESC LIMIT 1) AS source
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id`;

// Estimated time *actually* listened per play (skip-rule.ts listenedMs): the run from the
// previous play's end, capped at the song's length. A skipped/partial play counts only the
// seconds it ran; a fully-played one counts ~its length; a play after an idle stretch is
// capped at the song length (not the idle gap). Under 5 s counts zero (so flicking through
// tracks never inflates listened time). 10-min fallback when a track's duration is unknown.
//
// Computed in JS, not SQL, as a style choice: the equivalent `LAG() OVER (ORDER BY
// played_at)` is NOT pathological — against a local SQLite copy it was ~1.5× a plain ordered
// fetch (15.0 vs 10.4ms median, n=9, 2026-08-01), and an earlier "~3s" figure here was a
// single-shot timing that did not reproduce. What matters is that this read is a FULL PLAYS
// SCAN, so nothing on a render path may call it: it is reached only from
// recomputeAllTimeStats, on the write path.
//
// Wrapped in React cache(): getDailyStats and getAllTimeStats both need this, and they run
// together (Home's history boundary, the history refresh action) — cache() dedupes the
// fetch to once per request instead of paying the plays scan twice.
// Keyed by (uid, db_name), so two users in one request can never share the scan.
const orderedRealPlaysFor = cache(async (uid: Uid, dbName: string) => {
  const client = await userDb(uid, dbName).client();
  const res = await client.execute(
    `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs,
            p.skipped AS skipped
     FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
     WHERE ${NOT_BACKFILL}
     ORDER BY p.played_at ASC, p.track_id ASC`,
  );
  return plainRows(res.rows) as unknown as {
    playedAt: string;
    trackId: string;
    durationMs: number | null;
    skipped: number | null;
  }[];
});
function orderedRealPlays(u: UserDb) {
  return orderedRealPlaysFor(u.uid, u.dbName);
}

// One row per individual play (no GROUP BY): each listen keeps its own timestamp and the
// context it was played from. `lastPlayed` carries that single play's time; `plays` is 1.
const SELECT_PLAY = `
  SELECT t.id, t.name, t.artist, t.uri, t.album, t.album_image AS albumImage,
    t.duration_ms AS durationMs, 1 AS plays,
    p.played_at AS lastPlayed, p.played_at AS firstPlayed,
    ${sourceExpr("p", "c")} AS source
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
    LEFT JOIN contexts c ON c.uri = p.context_uri`;

/** Search history by track name or artist; "" returns most recently played. Returns each
 *  play as its own row (not collapsed into a per-song count), newest first, so you see the
 *  actual time of every listen. */
async function searchHistory(u: UserDb, query: string, limit = 300): Promise<TrackStats[]> {
  const client = await u.client();
  const q = query.trim();
  if (!q) {
    const res = await client.execute({
      sql: `${SELECT_PLAY} WHERE ${NOT_SKIPPED} ORDER BY p.played_at DESC LIMIT ?`,
      args: [limit],
    });
    return plainRows(res.rows) as unknown as TrackStats[];
  }
  const like = `%${q}%`;
  const res = await client.execute({
    sql: `${SELECT_PLAY} WHERE (t.name LIKE ? OR t.artist LIKE ?) AND ${NOT_SKIPPED}
          ORDER BY p.played_at DESC LIMIT ?`,
    args: [like, like, limit],
  });
  // Only the LIKE branch is ledgered: the empty-query branch above is the bounded indexed
  // head/delta read the history refresh uses, and charging it this cost would be a lie.
  void ledgerAdd("search_fallback", searchHistoryLikeRows());
  return plainRows(res.rows) as unknown as TrackStats[];
}

// ── Read caching (Next's data cache, keyed on the write marker) ─────────────────────────────
// The render-path reads below answer the same question over and over — the day strip, one
// day's plays, the playlist grid — against a store that only ever grows at "now". Each one is a
// scan against a remote store, so a second visit to the same day re-ran the whole thing to
// produce a byte-identical answer (and on Turso, which billed rows SCANNED, re-paid for every
// row). Medians (min-max), n=7, 2026-08-05, 6,995 plays, straight at Turso's primary
// (`bench-reads.mjs day` re-runs the first two):
//   one day's plays, unbounded scan   722ms (170-1,023)      ~6,995 rows scanned
//   the same day, range-bounded       498ms (88-693)         ~90 rows scanned
//   the 14-day strip                  896ms (235-3,008)
//   the whole-history strip           1,405ms (1,047-4,474)  ← fired on EVERY Home mount
//   the playlist grid                 28ms (24-55)
//   one indexed meta key              21ms (20-115)
// Half an hour later the same box measured 136ms (113-418) / 58ms (42-174) for the first two —
// the absolute numbers are session weather, per the warning at the top of this file. What
// reproduced across both replicates is the SHAPE: the unbounded read costs ~2× the bounded one
// and scans ~75× the rows, and both are far above the ~20ms a cache hit replaces.
//
// So each goes through unstable_cache, in one of two shapes:
//   • FROZEN — a day at or older than today-2 in the USER'S zone. Its plays almost never
//     change (plays arrive at "now"; the sync reaches back only Spotify's last-50 window) —
//     but "almost" is the point: the backstop replay inserts into arbitrary past days, and
//     source/ctx_orphan/skipped rewrites touch old rows too. So frozen entries carry the
//     write marker in their key like everything else (audit 2026-08-19, T1.7); what makes
//     them "frozen" now is only the longer TTL on superseded keys.
//   • LIVE — today, yesterday, the strip, the all-time list, the playlist grid. Keyed on
//     `meta.write_seq`, so ANY write that changes what they read produces a different cache key
//     and the next read recomputes. That is what keeps TODAY honest on the existing ~2-min
//     cadence: recordPlays bumps the marker exactly when new plays land, and dropWriteSeqCache()
//     drops this request's copy of it, so the re-read that follows a sync cannot be served a
//     pre-sync entry. The TTL on these entries is a garbage bound on superseded keys, NOT the
//     freshness mechanism — the key is.
// A frozen entry still expires daily rather than taking `revalidate: false`, even though its
// plays are immutable: two of its columns are derived and can still be rewritten later — `source` resolves from `contexts`
// (a name that 403'd at play time can resolve a month on) and from `plays.ctx_orphan`, which
// flips when a playlist's membership changes. A day's expiry bounds that at one re-read, and
// with the range bound below that re-read scans ~90 rows, not ~7,000.
// If the marker can't be read, the call runs UNCACHED: without it there is no proof an entry
// is current, and fresh-but-slow beats stale.
//
// THE CACHE OUTLIVES THE DEPLOYMENT — so the key must identify the SHAPE, not just the data.
// Vercel's Data Cache is not cleared by a deploy. Every key above answers "is this entry's DATA
// current"; none of them answers "was this entry written by code that returned the same TYPE".
// A deploy that changes what a cached function RETURNS therefore reads its predecessor's
// entries and hands the new code an old-shaped value — which is exactly how the search index
// shipped broken on 2026-08-05 (details on SEARCH_INDEX_SHAPE below; the payload arrived with
// no tracks in it and every client silently lost its index).
// The rule, for all of these: CHANGING THE RETURN SHAPE OF A CACHED READ MEANS MOVING ITS CACHE
// KEY in the same commit — bump a shape token in the key parts (what the search payloads do) or
// rename the key array. `TrackStats`, `DayStats` and `StoredPlaylist` are the shapes the four
// entries below serve; add or remove a field on any of them and their keys must move with it.
// A stale-shaped entry cannot be detected at runtime and does not expire for a day.
const FROZEN_TTL_S = 86_400; // a frozen day re-reads at most once a day (see above)
const LIVE_TTL_S = 3_600; // garbage bound only; write_seq in the key is what keeps these fresh
// A day is frozen once it is today-2 or older in the user's zone.
const FROZEN_AFTER_DAYS = 2;

/** The cache-key component for a LIVE read: the primary's write marker, or null when it can't
 *  be read (→ the caller must skip the cache rather than guess). */
async function liveKey(u: UserDb): Promise<string | null> {
  try {
    return (await primaryWriteSeq(u)) ?? "0";
  } catch {
    return null;
  }
}

function isFrozenDay(day: string, offsetMin: number): boolean {
  const offMs = clampOffset(offsetMin) * 60_000;
  const cutoff = new Date(Date.now() + offMs - FROZEN_AFTER_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return day <= cutoff;
}

/** Most-played tracks all-time, capped so the list never balloons to thousands.
 *  Feeds the history table when the "All time" card is selected. `plays` is all-time. */
const allTimePlaysCached = userCache(
  "all-time-plays",
  (uid: Uid, dbName: string, limit: number, _seq: string) => readAllTimePlays(userDb(uid, dbName), limit),
  [],
  { revalidate: LIVE_TTL_S },
);
async function getAllTimePlays(u: UserDb, limit: number): Promise<TrackStats[]> {
  // Slow marker, not the live one: this read costs ~25K billed rows per rebuild (full
  // scan + a per-track source subquery), and per-play freshness on the all-time ranking
  // is not worth ~2M/hour of listening (see the slow-marker note).
  const seq = await slowSeq(u);
  return seq === null
    ? readAllTimePlays(u, limit)
    : allTimePlaysCached(u.uid, await u.epoch(), u.dbName, limit, seq);
}

async function readAllTimePlays(u: UserDb, limit: number): Promise<TrackStats[]> {
  const client = await u.client();
  const res = await client.execute({
    sql: `${SELECT_TRACK} WHERE ${NOT_SKIPPED} GROUP BY t.id
          ORDER BY plays DESC, lastPlayed DESC, t.name ASC LIMIT ?`,
    args: [limit],
  });
  // Inside the read, not in getAllTimePlays: a cache hit costs nothing and must not be
  // charged as a rebuild. Same rule for every instrumented read below.
  ledgerAddLinear(u, "alltime_list", allTimeListRebuildRows);
  return plainRows(res.rows) as unknown as TrackStats[];
}

/** All-time totals across every recorded play (for the history "All time" card). */
async function getAllTimeStats(u: UserDb): Promise<{
  plays: number;
  uniqueTracks: number;
  durationMs: number;
  since: string | null; // earliest recorded play (ISO), null if none
}> {
  // Read the cached value: the all-time listened total needs a gap scan over EVERY play,
  // which is multi-second against a remote store and shouldn't run on render. It's refreshed on write
  // (recordPlays, when new plays land). Cold (never cached) → compute once and cache.
  const v = await getMeta(u, "alltime_stats");
  if (v) {
    try {
      return JSON.parse(v) as AllTimeStats;
    } catch {
      /* fall through and recompute */
    }
  }
  return recomputeAllTimeStats(u);
}

/** Recompute and cache the all-time totals (the expensive gap scan over every play). Called
 *  on write when new plays are recorded, not on render. */
async function recomputeAllTimeStats(u: UserDb): Promise<AllTimeStats> {
  const stats = allTimeStats(await orderedRealPlays(u));
  await setMeta(u, "alltime_stats", JSON.stringify(stats));
  // The throttle stamp for maybeRecomputeAllTimeStats — set here so every compute path
  // (write-triggered, cold-cache, daily heal) resets the window.
  await setMeta(u, "alltime_at", String(Date.now()));
  return stats;
}

/** Daily self-check that Spotify still stamps played_at at the END of a play (skip-rule.ts
 *  playedAtConvention). If it flipped, every skip verdict is inverted, so log loudly and keep
 *  the last result in `meta.played_at_convention` for a capture-health surface to read. */
async function checkPlayedAtConvention(u: UserDb): Promise<ReturnType<typeof playedAtConvention>> {
  const client = await u.client();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const res = await client.execute({
    sql: `SELECT p.played_at AS playedAt, t.duration_ms AS durationMs
          FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE p.played_at >= :since AND ${NOT_BACKFILL}
          ORDER BY p.played_at ASC, p.track_id ASC`,
    args: { since },
  });
  const result = playedAtConvention(
    plainRows(res.rows) as unknown as { playedAt: string; durationMs: number | null }[],
  );
  if (result.inverted) {
    console.error(
      "[skip-rule] played_at no longer looks like an END stamp — skip verdicts are inverted",
      result,
    );
  }
  await setMeta(u, "played_at_convention", JSON.stringify({ ...result, at: new Date().toISOString() }));
  return result;
}

/** Per-day plays / unique songs / listening time, most recent first. */
// SQLite date() modifier that shifts UTC timestamps into the *user's* local day.
// `offsetMin` = minutes to ADD to UTC for the user's zone (+120 = UTC+2, −240 = UTC−4),
// sent from the browser (the store runs in UTC, so 'localtime' would mean UTC). It's
// client-supplied, so it's clamped to a valid tz range and integer-ized before inlining.
// One current offset is applied to all rows, so a play within ~1h of a *past* DST change
// can land a day off — acceptable for personal history.
function clampOffset(offsetMin: number): number {
  return Math.max(-720, Math.min(840, Math.round(offsetMin) || 0));
}
function localDay(col: string, offsetMin: number): string {
  const m = clampOffset(offsetMin);
  return `date(${col}, '${m >= 0 ? "+" : ""}${m} minutes')`;
}

const dailyStatsCached = userCache(
  "daily-stats",
  (uid: Uid, dbName: string, offsetMin: number, days: number, _seq: string) =>
    readDailyStats(userDb(uid, dbName), offsetMin, days),
  [],
  { revalidate: LIVE_TTL_S },
);
async function getDailyStats(u: UserDb, offsetMin = 0, days = 14): Promise<DayStats[]> {
  const seq = await liveKey(u);
  return seq === null
    ? readDailyStats(u, offsetMin, days)
    : dailyStatsCached(u.uid, await u.epoch(), u.dbName, offsetMin, days, seq);
}

async function readDailyStats(u: UserDb, offsetMin = 0, days = 14): Promise<DayStats[]> {
  const client = await u.client();
  // Only fetch the recent window we actually display (a couple extra days of buffer for the
  // tz day-edge), so this stays cheap as total history grows — not a full-table scan. Uses
  // idx_plays_played_at. Listened ms = the run from the previous play, capped at song length,
  // computed in JS (see orderedRealPlays for why the window function isn't used). The fetch
  // reaches back to the last play before the cutoff, so the window's first play has its
  // predecessor; that play itself is not counted.
  const cutoff = new Date(Date.now() - (days + 2) * 86_400_000).toISOString();
  const res = await client.execute({
    // LEFT and INNER measured indistinguishable here, rows identical (primary 66/104ms LEFT
    // vs 68/47ms INNER, medians n=15×2, 2026-08-01) — the old "INNER was 150ms-1.5s+" figure
    // did not reproduce. LEFT is kept as the default style, not for performance.
    sql: `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs,
                 p.skipped AS skipped
          FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE ${NOT_BACKFILL}
            AND p.played_at >= COALESCE(
                  (SELECT MAX(p3.played_at) FROM plays p3
                   WHERE p3.played_at < :cutoff
                     AND (p3.context_type IS NULL OR p3.context_type <> 'backfill')),
                  :cutoff)
          ORDER BY p.played_at ASC, p.track_id ASC`,
    args: { cutoff },
  });
  const rows = plainRows(res.rows) as unknown as {
    playedAt: string;
    trackId: string;
    durationMs: number | null;
    skipped: number | null;
  }[];
  // The window's real row count, so this one is modeled off what was actually scanned.
  void ledgerAdd("day_strip", dailyStatsRows(rows.length));
  // Minutes to add to UTC for the user's local day (clamped, integer), same convention as
  // localDay() — toISOString() formats in UTC, so shifting first gives the local calendar day.
  const offMs = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0)) * 60000;
  const byDay = new Map<string, { plays: number; tracks: Set<string>; ms: number }>();
  for (let i = 0; i < rows.length; i++) {
    // The predecessor fetched from before the window, and skips, stay in the gap chain (as
    // the previous play of the row after them) but never count as plays or time.
    if (rows[i].playedAt < cutoff || rows[i].skipped === 1) continue;
    const ms = listenedMs(i > 0 ? rows[i - 1].playedAt : null, rows[i].playedAt, rows[i].durationMs);
    const day = new Date(Date.parse(rows[i].playedAt) + offMs).toISOString().slice(0, 10);
    let acc = byDay.get(day);
    if (!acc) {
      acc = { plays: 0, tracks: new Set(), ms: 0 };
      byDay.set(day, acc);
    }
    acc.plays++;
    acc.tracks.add(rows[i].trackId);
    acc.ms += ms;
  }
  return [...byDay.entries()]
    .map(([day, a]) => ({ day, plays: a.plays, uniqueTracks: a.tracks.size, durationMs: a.ms }))
    .sort((x, y) => (x.day < y.day ? 1 : -1))
    .slice(0, days);
}

/** Whether any play exists strictly before the start of the given local day — lets the day
 *  strip decide if it can expand to show older days. Cheap existence check (idx_plays_played_at). */
async function hasPlaysBeforeDay(u: UserDb, day: string, offsetMin = 0): Promise<boolean> {
  const client = await u.client();
  const offMs = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0)) * 60000;
  // Start of `day` in the user's local zone, as a UTC instant.
  const cutoff = new Date(Date.parse(day + "T00:00:00.000Z") - offMs).toISOString();
  const res = await client.execute({
    sql: `SELECT EXISTS(SELECT 1 FROM plays p WHERE p.played_at < :cutoff AND ${NOT_BACKFILL} AND ${NOT_SKIPPED}) AS e`,
    args: { cutoff },
  });
  return !!(res.rows[0] && Number(res.rows[0].e));
}

/** Tracks played on a specific local day (YYYY-MM-DD), most-played first.
 *  `plays`/`lastPlayed`/`source` are scoped to that day, not all-time.
 *
 *  Two cache shapes, one per day-kind — see "Read caching" above for which and why. */
// Both day-kinds carry the write marker in the key now. The frozen shape used to key on
// (day, offset) alone — "its plays can no longer change" — but two writers rejected that
// premise in practice: the backstop replay (scripts/backfill-from-backstop.mjs) inserts
// plays into arbitrary past days and its write_seq bump couldn't reach a markerless key,
// and `source`/`ctx_orphan`/`skipped` rewrites always could change a frozen day's rows
// (audit 2026-08-19, T1.7). The store is self-hosted — a re-read after a bump costs ~90
// unmetered rows — so the longer TTL is the only remaining difference: a superseded
// frozen key lingers a day, a live one an hour.
const playsByDayFrozen = userCache(
  "plays-by-day-frozen",
  (uid: Uid, dbName: string, day: string, offsetMin: number, _seq: string) =>
    readPlaysByDay(userDb(uid, dbName), day, offsetMin),
  [],
  { revalidate: FROZEN_TTL_S },
);
const playsByDayLive = userCache(
  "plays-by-day-live",
  (uid: Uid, dbName: string, day: string, offsetMin: number, _seq: string) =>
    readPlaysByDay(userDb(uid, dbName), day, offsetMin),
  [],
  { revalidate: LIVE_TTL_S },
);
async function getPlaysByDay(u: UserDb, day: string, offsetMin = 0): Promise<TrackStats[]> {
  const seq = await liveKey(u);
  if (seq === null) return readPlaysByDay(u, day, offsetMin);
  const epoch = await u.epoch();
  if (isFrozenDay(day, offsetMin)) return playsByDayFrozen(u.uid, epoch, u.dbName, day, offsetMin, seq);
  return playsByDayLive(u.uid, epoch, u.dbName, day, offsetMin, seq);
}

async function readPlaysByDay(u: UserDb, day: string, offsetMin = 0): Promise<TrackStats[]> {
  const client = await u.client();
  // The date() equality is the AUTHORITY on which local day a play belongs to — it stays.
  // What it can't do is drive an index (a function of the column), so on its own this read
  // SCANNED THE WHOLE plays TABLE for the ~90 rows of one day: `SCAN p USING COVERING INDEX
  // sqlite_autoindex_plays_1`. The redundant range bound is the same window expressed in raw
  // UTC instants, which idx_plays_played_at can seek: `SEARCH p USING INDEX
  // idx_plays_played_at (played_at>? AND played_at<?)`. Interleaved medians against the primary,
  // n=7 each, 2026-08-05: 722ms → 498ms in one session and 136ms → 58ms in another — and
  // ~6,995 rows scanned → ~90, which is what the read quota actually counts.
  // Verified equal, not assumed: old vs new returned identical rows for all 67 days in the
  // store, and a deliberately 1h-off range made 29 of them disagree — the check can fail.
  // Both halves re-run with `node --env-file=.env.local scripts/bench-reads.mjs day`.
  const offMs = clampOffset(offsetMin) * 60_000;
  const start = Date.parse(day + "T00:00:00.000Z") - offMs;
  const res = await client.execute({
    sql: `${SELECT_TRACK}
          WHERE p.played_at >= :from AND p.played_at < :to
            AND ${NOT_BACKFILL} AND ${NOT_SKIPPED}
            AND ${localDay("p.played_at", offsetMin)} = :day
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
    args: {
      day,
      from: new Date(start).toISOString(),
      to: new Date(start + 86_400_000).toISOString(),
    },
  });
  // A frozen day served from the cache never reaches here and is correctly charged nothing.
  // The returned rows are grouped per song, so the day's typical play count models the scan
  // better than res.rows.length would.
  void ledgerAdd("day_plays", dayPlaysRows());
  return plainRows(res.rows) as unknown as TrackStats[];
}

// ── The Home payload (`meta.home_payload`) ──────────────────────────────────────────────
// Everything /home renders, materialized as ONE row at WRITE time, so a page load costs one
// indexed meta read instead of a query plan.
//
// What it replaces: the page ran two reads in parallel (the 14-day strip + the all-time
// totals) and then a third that could not start until the first answered, because which day
// Home opens on is `daily[0].day`. Two or three sequential waves, on every load. The primary
// is a self-hosted sqld reached over a Tailscale Funnel, where a round trip is ~70ms+ before
// any query runs, so the waves cost more than the work in them — and they recomputed an answer
// that cannot change between syncs. Plays only arrive through syncRecentPlays (the ~2-min
// pinger on /api/cron/sync, the open tab's POST /api/sync), so the write is the only moment
// the answer moves: build it there, read it here.
//
// The rebuild calls readDailyStats/readPlaysByDay directly rather than their unstable_cache
// wrappers: those exist to keep a RENDER fresh against write_seq, and the write path has no use
// for a cache entry it is in the middle of making redundant. What it writes is persisted and
// served to every later page load until something writes again, so it must read the store
// itself, never a cache.
//
// It does NOT bump write_seq. Per the write-marker rule above, a write that only touches
// `meta` must not bump: nothing cached is derived from `meta`, so there is nothing to announce
// this to, and an extra bump would discard every cached read for a write none of them serve.
//
// The row OUTLIVES A DEPLOY — the same hazard the Data Cache has — so it carries a shape
// token. A deploy that changes what the payload holds would otherwise hand new code the old
// deploy's object; instead the mismatch reads as absent, Home falls back to the live queries
// for that one load, and the next rebuild writes the new shape. Move HOME_PAYLOAD_SHAPE in the
// same commit as any change to HomePayload.
//
// Staleness bound: the rebuild is triggered by the sync, so the two columns that are DERIVED
// rather than recorded — `source` (a context name that 403'd can resolve later) and
// `ctx_orphan` (flips when a playlist's membership changes) — can sit stale in the payload
// until the next sync that lands a play rebuilds it. Same tradeoff the frozen-day cache
// entries take, and it self-heals on the next play.
export const HOME_PAYLOAD_SHAPE = "v1";
const HOME_PAYLOAD_KEY = "home_payload";
// The strip width Home renders on first paint; it extends on demand from dailyStatsAction.
const HOME_DAILY_DAYS = 14;
// The zone a user who has not published one yet is assumed to be in. The payload is built on
// the WRITE path, where there is no browser and therefore no `tzoffset` cookie —
// tzOffsetMinutes() returns 0 (UTC) in a cron context, which would bucket days wrong for every
// read of the payload. Each user's browser publishes its IANA zone (`user_tz`); until one has,
// New York, Rem's. The OFFSET is computed per rebuild below from the zone, never pinned to
// whichever of −240/−300 was true when this shipped.
const HOME_TZ = "America/New_York";

export type HomePayload = {
  shape: string;
  builtAt: string; // ISO, for debugging a payload that looks wrong
  tzOffsetMinutes: number; // the offset the day buckets below were computed with
  daily: DayStats[];
  allTime: AllTimeStats;
  initialDay: string;
  initialTracks: TrackStats[];
};

/** Minutes to ADD to UTC for `zone` at `at` — the same convention as tz.ts's
 *  tzOffsetMinutes(), read off the zone itself so it follows DST (−240 in EDT, −300 in EST).
 *  Intl formats the instant as the zone's wall clock; that clock read as if it were UTC,
 *  minus the real instant, is the offset. */
function zoneOffsetMinutes(zone: string, at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23", // without this midnight can format as hour 24
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // The parts have second resolution, so compare against a second-truncated instant.
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The offset the payload buckets with: the browser's last-published one, unless it differs
 *  from the home zone's current offset by exactly 60 min. That is a DST change no browser has
 *  reported yet (the stored −240 outlives Nov 1 until a tab posts −300), so the zone wins;
 *  any other difference means the user really is elsewhere (burn lazyboy-review, L1). */
export function payloadTzOffset(stored: number | null, zoneOffset: number): number {
  if (stored === null || Math.abs(stored - zoneOffset) === 60) return zoneOffset;
  return stored;
}

/** Recompute Home's whole first paint and store it. Called from the sync (see
 *  `syncRecentPlays`) whenever plays land, and by Home itself when the row is missing. */
async function rebuildHomePayload(u: UserDb): Promise<HomePayload> {
  // The browser's last-published offset when we have it (written through by /api/sync from
  // the tz cookie), the fixed home zone otherwise. The hardcoded zone alone meant the
  // payload's buckets and every cookie-driven read on the same page could disagree the
  // moment the user wasn't in NY (audit 2026-08-19, T2.20).
  const [storedOffset, zone] = await Promise.all([getUserTzOffset(u), getUserTz(u)]);
  const tzOffsetMinutes = payloadTzOffset(storedOffset, zoneOffsetMinutes(zone ?? HOME_TZ));
  const [daily, allTime] = await Promise.all([
    readDailyStats(u, tzOffsetMinutes, HOME_DAILY_DAYS),
    // Already a single meta read off the primary, refreshed on write by recordPlays.
    getAllTimeStats(u),
  ]);
  // Write-path time, not a render — the day the payload's `initialDay` falls back to.
  const todayLocal = new Date(Date.now() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
  // Serial by necessity: which day Home opens on depends on which days have plays. It costs
  // one extra round trip HERE, once per sync that landed something, instead of on every load.
  const initialDay = daily[0]?.day ?? todayLocal;
  const initialTracks = await readPlaysByDay(u, initialDay, tzOffsetMinutes);
  const payload: HomePayload = {
    shape: HOME_PAYLOAD_SHAPE,
    builtAt: new Date().toISOString(),
    tzOffsetMinutes,
    daily,
    allTime,
    initialDay,
    initialTracks,
  };
  await setMeta(u, HOME_PAYLOAD_KEY, JSON.stringify(payload));
  return payload;
}

/** The stored payload, or null when there is none to serve — absent (nothing has synced into
 *  this store yet), unparseable, or written by a deploy with a different shape. Null is the
 *  caller's cue to compute inline and trigger a rebuild, never to render nothing. */
async function getHomePayload(u: UserDb): Promise<HomePayload | null> {
  const v = await getMeta(u, HOME_PAYLOAD_KEY);
  if (!v) return null;
  try {
    const p = JSON.parse(v) as HomePayload;
    return p?.shape === HOME_PAYLOAD_SHAPE ? p : null;
  } catch {
    return null;
  }
}

/** Whether a payload of the current shape exists. Separate from getHomePayload() because the
 *  steady-state sync tick asks this every ~2 minutes and has no use for the body (~20KB over
 *  the funnel); json_extract answers it with the same one indexed meta row and a few bytes. */
async function hasHomePayload(u: UserDb): Promise<boolean> {
  const client = await u.client();
  const res = await client.execute({
    sql: `SELECT json_extract(value, '$.shape') AS shape FROM meta WHERE key = ?`,
    args: [HOME_PAYLOAD_KEY],
  });
  return !!res.rows[0] && String(res.rows[0].shape) === HOME_PAYLOAD_SHAPE;
}

// ── The client-side search payloads ─────────────────────────────────────────────────────
// Home's search box matches in the BROWSER, not here. It used to send every keystroke to
// searchHistory(), whose `LIKE '%q%'` cannot use an index by construction (the note under "If
// a query is slow, count the rows it SCANS"), so each character paid a round trip plus a scan
// of `tracks` against the remote primary. What ships instead is two payloads, each fetched
// once per visit and filtered in memory:
//
//   LIBRARY — every track that sits in a playlist or in Liked Songs, as
//             [name, artist, image, album, playlists]. This is what makes the box search the
//             LIBRARY: a song you have never played is in here, and so is where it lives.
//   HISTORY — every played song as [name, artist, image, album, durationMs], plus every
//             individual play as [track, minute, source]. The counts, the times and the
//             expanded per-play list all come out of this, so a result row needs no follow-up
//             request to finish.
//
// The history half is no longer only a SEARCH payload: Home's day list derives from it too
// (den-home.tsx, "Days from memory"). Every play carries the minute it happened, so grouping
// those minutes into local days in the browser reproduces getPlaysByDay's answer for every day
// the payload has fully seen — and a day slide stops being a server action against a primary
// that is a ~70ms round trip away before it runs a query. That is what `durationMs` is doing in
// the track tuple: search never renders a length, the day list does. Adding a field here is
// therefore a UI decision as much as a search one — the whole rendered row must be present, or
// the derivation has to fall back to the server for the one column it lacks.
//
// They are SPLIT because they change at completely different rates. The library changes when a
// playlist does (a sync, at most every 15 min); the history changes every time a song finishes.
// One payload would re-download the library — the big half — after every listen, which is
// exactly what the version key on the old single index was contorted to avoid.
//
// Each is self-contained (its own interned images/albums), so either one alone renders a
// complete row: if the library payload fails, search still answers over the history.
//
// IDENTITY, not track id. The client merges the two on lower(artist) + lower(name) — the same
// song identity `idx_tracks_artist_name` and the orphan rule use. Spotify hands the same song
// a different id in a playlist than in recently-played, so joining on id would report 338 of
// this store's 2,538 played-and-in-a-playlist songs as never played (counted 2026-08-06
// against data/replica.db, and it is why "is this played?" cannot be an id lookup).
//
// SIZES as served, measured 2026-08-06 by `bench-reads.mjs search` over 13,464 library
// identities (15,326 playlist memberships + 32 liked), 2,959 played identities and 7,050 plays:
//   library  raw 1,638,540 B, gzip 576,795 B, brotli 421,924 B  ← 304s on a repeat visit
//   history  raw   476,206 B, gzip 167,591 B, brotli 121,956 B  ← re-fetched after listening
// The `durationMs` slot (shape v2) is the only field added since: measured 2026-08-11 by
// rebuilding both variants of the history payload over a copy of data/replica.db (3,025 played
// identities, 7,330 plays), it costs +21,161 B raw (+4.3%), +11,870 B gzip (+7.0%) and
// +10,369 B brotli (+8.5%) — ~7 B per played song raw, and proportionally more compressed
// because six-digit durations are the highest-entropy thing in the body. That buys every day
// slide after the payload lands, so it is paid once per listening session against a round trip
// per day walked.
// So a cold visit downloads ~744 KB gzipped and a visit after a listening session ~168 KB —
// against 156,868 gzip for the played-only index this replaces, which also paid a round trip
// per query on top. The same bench times the builds against the primary: the library's member
// scan is 5,424.3ms median (4,773.8-6,646.2, n=5) and the history's 2,556.7ms (2,067.6-2,693.7)
// — both once per version change, and both a reason the client fetches on idle rather than on
// focus. The version reads are one indexed meta key each (42.9ms / 150.1ms, same run).
//
// The RAW figure is the one with a ceiling: a Vercel function response is capped at 4.5 MB, and
// at 122 B per identity the library payload has room for ~36,000 songs — 2.7x this store. The
// measured next lever is stripping the shared `https://i.scdn.co/image/` prefix off the
// interned art URLs (−16% raw, −1% gzip); deliberately not spent yet, because it bakes
// Spotify's CDN host into the payload format for bytes that are not yet scarce.
// Locally none of this is compressed at all — `next start` serves route handlers uncompressed
// (measured 2026-08-05); Vercel's edge compresses them, so gzip is the production number.
//
// Album art is in both payloads even though it is most of their weight, because WITHOUT it a
// result row paints as text against a grey square and reads as "still loading" no matter how
// fast the text was.

/** Interned string table — repeated art URLs, album names, playlist names and "From" labels
 *  are sent once and referenced by index. -1 means "none" (no art, no album, no source). */
function interner() {
  const values: string[] = [];
  const seen = new Map<string, number>();
  return {
    values,
    put(v: unknown): number {
      if (v == null || v === "") return -1;
      const s = String(v);
      const at = seen.get(s);
      if (at !== undefined) return at;
      seen.set(s, values.length);
      return values.push(s) - 1;
    },
  };
}

/** `image`/`album` index into the payload's interned tables; `playlists` holds indexes into
 *  LibraryIndex.playlists (empty for a track that is only in Liked Songs). */
export type LibraryTrack = [
  name: string,
  artist: string,
  image: number,
  album: number,
  playlists: number[],
];
export type LibraryIndex = {
  images: string[];
  albums: string[];
  playlists: string[];
  tracks: LibraryTrack[];
};

/** A played song. Same interning convention as LibraryTrack; newest play first.
 *
 *  `durationMs` is 0 when the store has no length for the track (the UI renders that as "—").
 *  It is NOT here for search — a result row never shows a length — but for Home's DAY list,
 *  which derives every day's rows from this payload in the browser and renders a Length
 *  column. Without it a derived day would have to leave that column empty, or fetch, which is
 *  the round trip the derivation exists to remove. It is one number per played SONG (not per
 *  play), so it is the cheapest field in the payload. */
export type HistoryTrack = [
  name: string,
  artist: string,
  image: number,
  album: number,
  durationMs: number,
];
/** One play: its HistoryIndex.tracks row, the UTC minute it happened (epoch minutes — the
 *  minute is all the UI ever renders), and its resolved "From" (index into
 *  HistoryIndex.sources, -1 when the play has none). */
export type HistoryPlay = [track: number, minute: number, source: number];
export type HistoryIndex = {
  images: string[];
  albums: string[];
  sources: string[];
  tracks: HistoryTrack[];
  plays: HistoryPlay[];
};

/** The payload FORMATS, and part of each cache key — BUMP ONE with any change to the types
 *  above.
 *
 *  This is not defensive style, it is a bug that already shipped. Vercel's Data Cache outlives
 *  a deployment, and the key was (the cache function's key parts + a content version), neither
 *  of which moves when the SHAPE changes. So the deploy that added album art asked for a key
 *  whose entry had been written that morning by the previous deploy, got a cache HIT, and
 *  served the OLD shape — which the new route destructured into undefineds and shipped a body
 *  with no tracks at all. Every client that fetched it lost its index and fell back to the
 *  server for every keystroke. The ETags carry the token too, for the same reason one layer up
 *  (a browser holding the old body), and so does the browser's IndexedDB copy (search-cache.ts).
 *  Defined in search-shape.ts, which the browser can import. */
export { LIBRARY_INDEX_SHAPE, HISTORY_INDEX_SHAPE };

/** The library payload's version: `meta.library_seq`, bumped by the writes that change which
 *  tracks are in the library and by nothing else (see the marker's note). NOT write_seq —
 *  that moves on every play, and this payload is the half that must survive a listening
 *  session in the browser cache.
 *
 *  STALENESS BOUND: it does not move for an in-place edit of a track's name, artist, album or
 *  art (a re-tag by Spotify, or a play sync refreshing a track's fields). Those are bounded to
 *  ~24h by the cache entry's own `revalidate` (the ETag's daily bucket only re-validates the
 *  browser; the body it re-validates against is this entry).
 *
 *  Returns null when the store can't be read — the caller must serve uncached rather than
 *  mint cache entries under a guessed version (audit 2026-08-19, T2.4: a transient failure
 *  used to read as "0" and poison the "0"-keyed entry for a day). */
async function getLibraryIndexVersion(u: UserDb): Promise<string | null> {
  try {
    return (await getMeta(u, LIBRARY_SEQ_KEY)) ?? "0";
  } catch {
    return null;
  }
}

// ── The slow marker (`meta.slow_seq_pub`) ───────────────────────────────────────────────
// A published, at-most-every-10-min copy of write_seq, for the reads whose rebuild is
// EXPENSIVE and whose freshness is worth trading: the history search payload (~22K billed
// rows per rebuild) and the all-time list (~25K). Keyed on live write_seq, a listening
// session rebuilt both once per play — measured 2026-08-07 at ~60K billed rows per landed
// play, ~2M/hour of listening, which at August's remaining headroom was days from the
// quota block. On this marker they rebuild at most every 10 minutes: a new play appears
// in search and the all-time list up to 10 min late mid-session (the same staleness the
// all-time totals already accept), while the day strip and day views stay on the live
// marker and remain instant.
// Publish rule: move the published seq only when write_seq moved AND the published copy is
// ≥10 min old. Two instances racing the publish both write a valid seq — the loser costs
// one extra rebuild, never a wrong answer. If the live marker can't be read, return null
// like liveKey() — the caller runs uncached rather than guessing.
const SLOW_SEQ_MIN_MS = 10 * 60 * 1000;

async function slowSeq(u: UserDb): Promise<string | null> {
  const seq = await liveKey(u);
  if (seq === null) return null;
  try {
    return await slowSeqInner(u, seq);
  } catch {
    // Any store failure past the liveKey read must ALSO resolve to null (serve uncached),
    // or the null-version contract's failure branch is unreachable on the very failures it
    // exists for (wave-2 adversarial review, finding J).
    return null;
  }
}

async function slowSeqInner(u: UserDb, seq: string): Promise<string | null> {
  const raw = await getMeta(u, "slow_seq_pub");
  if (raw) {
    try {
      const pub = JSON.parse(raw) as { seq: string; at: number };
      if (pub.seq === seq || Date.now() - pub.at < SLOW_SEQ_MIN_MS) return pub.seq;
    } catch {
      /* republish below */
    }
  }
  // Re-read just before publishing: two instances racing here used to let the LOSER land a
  // lower seq with a newer stamp, which then served the superseded key for the whole window
  // (audit 2026-08-19, T2.18). A newer published seq wins; never publish backwards.
  const raced = await getMeta(u, "slow_seq_pub").catch(() => null);
  if (raced) {
    try {
      const pub = JSON.parse(raced) as { seq: string; at: number };
      if (Number(pub.seq) >= Number(seq)) return pub.seq;
    } catch {
      /* fall through to publish */
    }
  }
  await setMeta(u, "slow_seq_pub", JSON.stringify({ seq, at: Date.now() }));
  return seq;
}

/** The history payload's version: the slow marker (write_seq, published at most every
 *  10 min) — the rebuild is a full plays scan, so it must not run once per play. Null when
 *  the store can't be read: serve uncached, never mint entries under a guessed version. */
async function getHistoryIndexVersion(u: UserDb): Promise<string | null> {
  return slowSeq(u);
}

// LIVE-shaped cache (the section above): keyed on a content version, with the daily TTL as a
// garbage bound. So the scan below runs once per real change and every other request is free.
const libraryIndexCached = userCache(
  "library-index",
  (uid: Uid, dbName: string, _version: string, _shape: string) => readLibraryIndex(userDb(uid, dbName)),
  [LIBRARY_INDEX_SHAPE],
  { revalidate: FROZEN_TTL_S },
);
async function getLibraryIndex(u: UserDb, version: string | null): Promise<LibraryIndex> {
  // The shape token goes in BOTH the key parts and the arguments: key parts are the documented
  // cache key, and passing it as an argument as well means the identity holds even if a Next
  // version ever treats key parts as a namespace rather than as key material.
  // Null version = the store couldn't say what's current. Read fresh and DON'T cache:
  // an entry minted under a guessed key would be served to every later request that also
  // fails the version read (audit 2026-08-19, T2.4).
  return version === null
    ? readLibraryIndex(u)
    : libraryIndexCached(u.uid, await u.epoch(), u.dbName, version, LIBRARY_INDEX_SHAPE);
}

const historyIndexCached = userCache(
  "history-index",
  (uid: Uid, dbName: string, _version: string, _shape: string) => readHistoryIndex(userDb(uid, dbName)),
  [HISTORY_INDEX_SHAPE],
  { revalidate: FROZEN_TTL_S },
);
async function getHistoryIndex(u: UserDb, version: string | null): Promise<HistoryIndex> {
  // Same null contract as getLibraryIndex: fresh and uncached when the version is unknown.
  return version === null
    ? readHistoryIndex(u)
    : historyIndexCached(u.uid, await u.epoch(), u.dbName, version, HISTORY_INDEX_SHAPE);
}

async function readLibraryIndex(u: UserDb): Promise<LibraryIndex> {
  const client = await u.client();
  // Driven from playlist_tracks (15k index entries, one seek per member) rather than from
  // `tracks` with an EXISTS filter, which makes the planner scan all 15,000 track rows and
  // then probe membership per row. Rows scanned is the cost — and was what Turso billed.
  const [memberRes, savedRes, listRes] = await Promise.all([
    client.execute(
      `SELECT pt.playlist_id AS pid, t.name AS name, t.artist AS artist,
              t.album AS album, t.album_image AS image
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id`,
    ),
    client.execute(
      `SELECT t.name AS name, t.artist AS artist, t.album AS album, t.album_image AS image
       FROM saved_tracks s JOIN tracks t ON t.id = s.track_id`,
    ),
    client.execute("SELECT id, name FROM playlists"),
  ]);

  const images = interner();
  const albums = interner();
  const playlists = interner();
  // Only playlists we can NAME: playlist_tracks can outlive its playlist row between a delete
  // and the purge, and a membership we cannot label is one the UI could not render anyway.
  const named = new Map<string, number>();
  for (const r of listRes.rows) named.set(String(r.id), playlists.put(r.name));

  const tracks: LibraryTrack[] = [];
  const at = new Map<string, number>();
  const add = (r: Row): number => {
    const key = `${String(r.artist).toLowerCase()}\n${String(r.name).toLowerCase()}`;
    const hit = at.get(key);
    if (hit !== undefined) return hit;
    at.set(key, tracks.length);
    return (
      tracks.push([
        String(r.name),
        String(r.artist),
        images.put(r.image),
        albums.put(r.album),
        [],
      ]) - 1
    );
  };
  for (const r of memberRes.rows) {
    const membership = tracks[add(r)][4];
    const pl = named.get(String(r.pid));
    // The same song can sit in a playlist under two ids (Spotify's re-issues), and in several
    // playlists — both collapse here, so a playlist is listed once per song.
    if (pl !== undefined && !membership.includes(pl)) membership.push(pl);
  }
  for (const r of savedRes.rows) add(r);
  // Membership rows are what this scan is driven from, so they size its cost directly.
  void ledgerAdd("library_payload", libraryPayloadRebuildRows(memberRes.rows.length));
  return {
    images: images.values,
    albums: albums.values,
    playlists: playlists.values,
    tracks,
  };
}

async function readHistoryIndex(u: UserDb): Promise<HistoryIndex> {
  const client = await u.client();
  // A full plays scan, so it is deliberately off every render path: it runs once per version
  // of the history payload and the browser filters that payload from then on.
  const res = await client.execute(
    `SELECT t.name AS name, t.artist AS artist, t.album AS album, t.album_image AS image,
            t.duration_ms AS durationMs,
            p.played_at AS playedAt, ${sourceExpr("p", "c")} AS source
     FROM plays p JOIN tracks t ON t.id = p.track_id
       LEFT JOIN contexts c ON c.uri = p.context_uri
     WHERE ${NOT_SKIPPED}
     ORDER BY p.played_at DESC`,
  );
  const images = interner();
  const albums = interner();
  const sources = interner();
  const tracks: HistoryTrack[] = [];
  const at = new Map<string, number>();
  const plays = res.rows.map((r): HistoryPlay => {
    const key = `${String(r.artist).toLowerCase()}\n${String(r.name).toLowerCase()}`;
    let i = at.get(key);
    if (i === undefined) {
      at.set(key, (i = tracks.length));
      // 0, not null, for an unknown length: the tuple stays all-numbers after the two names,
      // which is what keeps the JSON small (`0` is one byte, `null` is four).
      tracks.push([
        String(r.name),
        String(r.artist),
        images.put(r.image),
        albums.put(r.album),
        Number(r.durationMs) || 0,
      ]);
    }
    return [i, Math.floor(Date.parse(String(r.playedAt)) / 60000), sources.put(r.source)];
  });
  // One row per play came back, so this is the scanned count rather than a modeled one.
  void ledgerAdd("history_payload", historyPayloadRebuildRows(res.rows.length));
  return {
    images: images.values,
    albums: albums.values,
    sources: sources.values,
    tracks,
    plays,
  };
}

async function getLastSync(u: UserDb): Promise<string | null> {
  return getMeta(u, "last_sync");
}

// The hourly health check's own mark (multi-user PLAN §7.10), in the admin's database: the
// last Turso pace verdict the daily chores recorded (`quota_pace`, {at, ahead}). Meta only: no
// marker bump. Which isolation events a check has reported is the app database's
// `events.alarmed` (Phase 2); when the chores last finished is `app_meta.daily_at` (Phase 3),
// which a cron tick reads too.
export type HealthMark = "quota_pace";
async function getHealthMarks(u: UserDb): Promise<Record<HealthMark, string | null>> {
  return { quota_pace: await getMeta(u, "quota_pace") };
}
async function setHealthMark(u: UserDb, key: HealthMark, value: string): Promise<void> {
  await setMeta(u, key, value);
}

// The once-a-day full context pass (unresolvedContextUris) is gated on this stamp;
// every other sync call uses the batch-bounded unseenContexts(). Epoch ms, 0 = never.
async function getContextsFullCheckAt(u: UserDb): Promise<number> {
  const v = await getMeta(u, "contexts_full_check_at");
  return v ? Number(v) || 0 : 0;
}
async function setContextsFullCheckAt(u: UserDb): Promise<void> {
  await setMeta(u, "contexts_full_check_at", String(Date.now()));
}

// ---- playlists (persistent library cache; avoids re-scanning Spotify per load) ----
export type StoredPlaylist = {
  id: string;
  name: string;
  ownerId: string | null;
  image: string | null;
  trackCount: number;
};

/** Replace the stored library with a fresh full scan (kept in native order). */
async function storePlaylists(u: UserDb, rows: StoredPlaylist[], meId: string | null): Promise<void> {
  const client = await u.client();
  const now = new Date().toISOString();

  // Cheap change-probe (a read, never on a render path — this only runs in the background
  // library sync). Its verdict is three-way, not two-way (diffPlaylistList, store-diff.ts):
  // nothing moved / only artwork moved / the list itself moved. The two-way version — anything
  // but an exact match takes the full delete-all + reinsert — is what made this path the
  // dominant term of the whole quota crisis: rotating `mosaic.scdn.co` art meant "not an exact
  // match" nearly every hour.
  // (Per-playlist track changes are handled separately by the snapshot-gated loop in
  // syncLibrary; a song swap that leaves the count unchanged correctly doesn't rewrite the
  // list here.)
  const cached = plainRows(
    (
      await client.execute(
        "SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount FROM playlists ORDER BY position",
      )
    ).rows,
  ) as unknown as PlaylistListRow[];
  const diff = diffPlaylistList(rows, cached);

  // ONE line, before any write path, naming the field that actually differed. The whole fix
  // rests on a claim about WHICH field moves hourly (artwork), and the only way to keep that
  // claim honest in production is to have the probe say so every time it fires: Vercel
  // captures stdout (`vercel logs`, about an hour of history). First differing field only — a dump
  // of 180 rows an hour is not a diagnostic.
  if (diff.firstDiff) {
    console.log(
      JSON.stringify({
        tag: "storePlaylists-diff",
        firstDiff: diff.firstDiff,
        idSetChanged: diff.idSetChanged,
        count: rows.length,
      }),
    );
  }

  if (diff.tier === "unchanged") {
    // Meta only, so no marker bump: nothing a cached read serves moved.
    await setMeta(u, "playlists_synced_at", now);
    if (meId) await setMeta(u, "me_id", meId);
    return;
  }

  // The synced-at / me_id stamps, as batchable statements — both write tiers below end with
  // them, and no cached read is derived from either, so neither decides a marker bump.
  const stampStmts: InStatement[] = [
    {
      sql: `INSERT INTO meta (key, value) VALUES ('playlists_synced_at', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: { v: now },
    },
  ];
  if (meId) {
    stampStmts.push({
      sql: `INSERT INTO meta (key, value) VALUES ('me_id', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: { v: meId },
    });
  }

  if (diff.tier === "image-only") {
    // Same playlists, same names, same owners, same counts, same order — only artwork URLs
    // rotated. That is not a structural change and must not be treated as one: no delete-all,
    // no reinsert, no purge, no full orphan pass. Just the rows whose image moved.
    //   • NO library_seq. The library search payload reads `SELECT id, name FROM playlists`
    //     and takes its art from `tracks` — playlist artwork is not in it — so this cannot
    //     make it stale, and its ETag carries a daily date bucket that bounds an in-place
    //     re-tag to ~24h regardless (src/app/api/search/library/route.ts).
    //   • YES write_seq. The grid's cache entry (getStoredPlaylists) is keyed on the marker,
    //     and the rule at the top of this file is that any write to a table a cached read
    //     serves announces itself. An unannounced image update serves the old art until the
    //     entry's TTL expires.
    const stmts: InStatement[] = diff.imageChanges.map((c) => ({
      sql: "UPDATE playlists SET image = :image WHERE id = :id",
      args: { image: c.image, id: c.id },
    }));
    stmts.push(...stampStmts, writeSeqStmt());
    await client.batch(stmts, "write");
    // The write moved the marker; drop this request's copy so the read that follows re-keys.
    dropWriteSeqCache(u);
    return;
  }

  const stmts: InStatement[] = [{ sql: "DELETE FROM playlists", args: [] }];
  rows.forEach((r, i) =>
    stmts.push({
      sql: `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
            VALUES (:id, :name, :ownerId, :image, :trackCount, :position)`,
      args: {
        id: r.id,
        name: r.name,
        ownerId: r.ownerId,
        image: r.image,
        trackCount: r.trackCount,
        position: i,
      },
    }),
  );
  // Drop cached tracks for playlists that no longer exist (deleted/unfollowed), so a
  // stale playlist can't keep feeding the library union. Runs after the re-insert
  // above, so the subquery sees the fresh list. Its index in the batch is kept because the
  // playlist ids it RETURNs are the orphan pass's scope below. It also drops rows of a
  // playlist that was in neither the cached nor the new list (cached by URL, Resume's cold
  // fetch, a store racing the rewrite that removed it), which is why the scope is what it
  // deleted and not the list diff (lane 1910's counterexample).
  const purgeAt = stmts.length;
  stmts.push({
    sql: `DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists)
          RETURNING playlist_id`,
    args: [],
  });
  // And their snapshot/staleness markers — a leftover plsnap could make a playlist that
  // later reappears with the same snapshot_id skip its re-fetch against the purged cache.
  stmts.push({
    sql: `DELETE FROM meta WHERE key LIKE 'plsnap:%'
          AND substr(key, 8) NOT IN (SELECT id FROM playlists)`,
    args: [],
  });
  stmts.push({
    sql: `DELETE FROM meta WHERE key LIKE 'pltracks_at:%'
          AND substr(key, 13) NOT IN (SELECT id FROM playlists)`,
    args: [],
  });
  stmts.push(...stampStmts);
  // Reached only when the LIST really changed (the unchanged and image-only tiers above return
  // before this), so both bumps are unconditional here.
  stmts.push(writeSeqStmt(), librarySeqStmt());
  const results = await client.batch(stmts, "write");
  // ~640 rows_written and ~31K rows_read per rewrite; the ledger accounts reads, so that is
  // what the modeled figure carries (read-costs.ts states the write half).
  void ledgerAdd("playlist_rewrite", playlistRewriteRows());
  // The verdict reads memberships and never `playlists`, and the purge is the only membership
  // write in this branch, so the plays that can flip are exactly those from a playlist it
  // deleted rows of. Nothing purged (a rename, a reorder, an added playlist, a removed one that
  // was never cached) → no pass. This replaced an unscoped pass that read 5,102,733 rows at
  // 21,950 plays (STORE_MIGRATION §3). Count the RETURNING rows, never rowsAffected: the file
  // client reports 0 for any statement that returns rows (@libsql/client sqlite3.js).
  const purgedIds = [...new Set(results[purgeAt].rows.map((r) => String(r.playlist_id)))];
  if (purgedIds.length > 0) {
    // Priced at this user's store: their plays (ledgerAddLinear) over their playlists before the
    // rewrite, never fewer than it purged, so the model stays at or under the full pass. The
    // calibration's playlist count is one store's (Rem's), not every user's.
    const playlists = Math.max(cached.length, purgedIds.length);
    ledgerAddLinear(u, "orphan_purge_pass", (plays) => orphanPurgePassRows(purgedIds.length, plays, playlists));
    await recomputeOrphanFlags(u, { playlistIds: purgedIds });
  }
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

// LIVE-keyed (see "Read caching"): the grid and the dock's panels both read this on every
// visit, and the list only moves when storePlaylists writes to `playlists` — its rewrite
// branch or its image-only branch, both of which bump the marker, so the next read is a
// different cache key. Its unchanged tier writes meta and nothing else, and bumps nothing.
const storedPlaylistsCached = userCache(
  "stored-playlists",
  (uid: Uid, dbName: string, _seq: string) => readStoredPlaylists(userDb(uid, dbName)),
  [],
  { revalidate: LIVE_TTL_S },
);
async function getStoredPlaylists(u: UserDb): Promise<StoredPlaylist[]> {
  const seq = await liveKey(u);
  return seq === null ? readStoredPlaylists(u) : storedPlaylistsCached(u.uid, await u.epoch(), u.dbName, seq);
}

async function readStoredPlaylists(u: UserDb): Promise<StoredPlaylist[]> {
  const client = await u.client();
  const res = await client.execute(
    `SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount
     FROM playlists ORDER BY position`,
  );
  return plainRows(res.rows) as unknown as StoredPlaylist[];
}

/** Count of DISTINCT songs (by case-insensitive artist+title) across all cached playlist
 *  tracks — the "real" library size, collapsing the same song appearing in many playlists
 *  (or a playlist accidentally duplicated).
 *
 *  Read from a cached meta value: computing it live is a multi-second DISTINCT scan over
 *  playlist_tracks against the remote store, and it was blocking every Home render. It's refreshed
 *  by recomputeUniqueSongCount() at the end of each library sync (when the underlying data
 *  actually changes). 0 until first cached — Home falls back to the raw track-count sum. */
async function getUniqueSongCount(u: UserDb): Promise<number> {
  const v = await getMeta(u, "unique_song_count");
  if (!v) return 0;
  // Stored as {n, seq} where seq is library_seq at compute time. The old trigger — "end of
  // each library sync" — missed every other writer of playlist_tracks (playlist deletes,
  // single-track removes, out-of-band stores that also suppress the next sync's snapshot
  // diff; audit 2026-08-19, T2.3). Now: serve the cached number instantly, and when the
  // library marker has moved since it was computed, kick a background recompute so the next
  // render is right. Never blocks a render.
  try {
    const parsed = JSON.parse(v) as { n: number; seq: string | null };
    const cur = await getMeta(u, LIBRARY_SEQ_KEY).catch(() => null);
    if (parsed.seq !== cur) kickUniqueRecompute(u);
    return Number(parsed.n) || 0;
  } catch {
    // Legacy plain-number value: adopt it and refresh in the background.
    kickUniqueRecompute(u);
    return Number(v) || 0;
  }
}

// One background recompute per minute per instance: without a guard, a recompute whose
// setMeta the platform froze mid-flight left seq stale, and every later render kicked a
// fresh full DISTINCT scan (wave-2 adversarial review, finding C). A TIMESTAMP, not a
// boolean — a boolean frozen `true` by that same platform freeze would have silenced this
// path for the instance's whole lifetime (wave-3 adversarial review, M5); a timestamp
// self-heals after the window. Per (uid, db_name): one user's kick must not silence another's.
const uniqueRecomputeKickedAt = new Map<string, number>();
function kickUniqueRecompute(u: UserDb): void {
  const key = openKey(u.uid, u.dbName);
  if (Date.now() - (uniqueRecomputeKickedAt.get(key) ?? 0) < 60_000) return;
  uniqueRecomputeKickedAt.set(key, Date.now());
  void recomputeUniqueSongCount(u).catch(() => {});
}

/** Run the expensive distinct-song scan once and cache it in meta. Called at the end of a
 *  library sync, not on render. Returns the fresh count. */
async function recomputeUniqueSongCount(u: UserDb): Promise<number> {
  // The library sync that calls this has just written, so this request's copy of the marker is
  // stale before the scan below even runs.
  dropWriteSeqCache(u);
  const client = await u.client();
  // Marker BEFORE the scan: if a write lands mid-scan, the stored seq is older than the
  // data and the next read re-kicks — the safe direction. Read after, a mid-scan bump
  // would label a pre-bump count as current.
  const seq = await getMeta(u, LIBRARY_SEQ_KEY).catch(() => null);
  const res = await client.execute(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT lower(t.artist) AS a, lower(t.name) AS m
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     )`,
  );
  const n = res.rows[0] ? Number(res.rows[0].n) : 0;
  // The DISTINCT count returns one row, so the scan is modeled from the library's size, not
  // from what came back.
  void ledgerAdd("unique_song_count", uniqueSongCountRows());
  await setMeta(u, "unique_song_count", JSON.stringify({ n, seq }));
  return n;
}

/** One playlist's cached header row (name/owner/image/count) — used by the detail page so
 *  it doesn't load the entire library just to read a single row. */
async function getStoredPlaylist(u: UserDb, id: string): Promise<StoredPlaylist | null> {
  const client = await u.client();
  const res = await client.execute({
    sql: `SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount
          FROM playlists WHERE id = :id`,
    args: { id },
  });
  const rows = plainRows(res.rows) as unknown as StoredPlaylist[];
  return rows[0] ?? null;
}

/** Insert one playlist row right after creating it on Spotify, so the grid shows it
 *  immediately instead of waiting for the next full library sync. position -1 sorts it
 *  first (Spotify also puts new playlists on top); the next full scan replaces the row
 *  with real data (mosaic image, true position). */
async function upsertStoredPlaylist(u: UserDb, p: StoredPlaylist): Promise<void> {
  const client = await u.client();
  // Batched with the marker bump so the row and its announcement land together.
  await client.batch(
    [
      {
        sql: `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
              VALUES (:id, :name, :ownerId, :image, :trackCount, -1)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                track_count = excluded.track_count`,
        args: { id: p.id, name: p.name, ownerId: p.ownerId, image: p.image, trackCount: p.trackCount },
      },
      writeSeqStmt(),
      librarySeqStmt(),
    ],
    "write",
  );
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

async function getPlaylistsSyncedAt(u: UserDb): Promise<string | null> {
  return getMeta(u, "playlists_synced_at");
}

async function getMeId(u: UserDb): Promise<string | null> {
  return getMeta(u, "me_id");
}

// ---- playlist tracks (cached per playlist so detail pages load instantly) ----
/** Replace a playlist's cached track list (kept in playlist order). `snapshot` is the
 *  playlist's Spotify snapshot_id, stored so we can skip re-fetching when unchanged. */
async function storePlaylistTracks(u: UserDb, 
  playlistId: string,
  tracks: Track[],
  snapshot?: string,
): Promise<void> {
  const client = await u.client();
  // Diff against the cache instead of delete-all + reinsert: the old full rewrite billed
  // ~3N row writes (N deletes + N track upserts + N inserts) every time a snapshot
  // changed, even for a one-song edit to a large playlist. Now an append writes only the
  // new tail, and only tracks whose fields actually changed get re-upserted.
  const cachedPosRes = await client.execute({
    sql: `SELECT track_id AS trackId, added_at AS addedAt
          FROM playlist_tracks WHERE playlist_id = :pid ORDER BY position`,
    args: { pid: playlistId },
  });
  const cachedPos = plainRows(cachedPosRes.rows) as unknown as {
    trackId: string;
    addedAt: string | null;
  }[];
  const incoming: TrackFields[] = tracks.map((t) => ({
    id: t.id,
    name: t.title,
    artist: t.artist,
    uri: t.uri,
    album: t.album ?? null,
    albumImage: t.albumImage ?? null,
    durationMs: t.durationMs ?? null,
  }));
  const cachedTracks = await readCachedTracks(client, [...new Set(incoming.map((t) => t.id))]);

  const stmts: InStatement[] = tracksNeedingWrite(incoming, cachedTracks).map(trackUpsertStmt);
  const renamed = identityChanges(incoming, cachedTracks);
  const { changed, deleteFrom } = diffPositions(
    tracks.map((t) => ({ trackId: t.id, addedAt: t.addedAt ?? null })),
    cachedPos,
  );
  for (const pos of changed) {
    const t = tracks[pos];
    stmts.push({
      sql: `INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at)
            VALUES (:pid, :pos, :tid, :added)
            ON CONFLICT(playlist_id, position) DO UPDATE SET track_id = excluded.track_id,
              added_at = excluded.added_at`,
      args: { pid: playlistId, pos, tid: t.id, added: t.addedAt ?? null },
    });
  }
  if (deleteFrom !== null) {
    stmts.push({
      sql: "DELETE FROM playlist_tracks WHERE playlist_id = :pid AND position >= :from",
      args: { pid: playlistId, from: deleteFrom },
    });
  }
  // Everything queued so far is playlist_tracks/tracks; nothing cached is derived from the two
  // meta stamps below, so a call that diffed to no changes announces nothing.
  if (stmts.length > 0) stmts.push(writeSeqStmt(), librarySeqStmt());
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES (:k, :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { k: `pltracks_at:${playlistId}`, v: new Date().toISOString() },
  });
  if (snapshot) {
    stmts.push({
      sql: `INSERT INTO meta (key, value) VALUES (:k, :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: { k: `plsnap:${playlistId}`, v: snapshot },
    });
  }
  await client.batch(stmts, "write");
  // Membership for THIS playlist changed, so plays from it may flip orphan either way; a
  // renamed song can flip plays from any playlist.
  await recomputeOrphanFlags(u, { playlistIds: [playlistId] });
  if (renamed.length > 0) await recomputeOrphanFlags(u, { identities: renamed });
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

/** The Spotify snapshot_id of the cached tracks, if known. */
async function getPlaylistSnapshot(u: UserDb, playlistId: string): Promise<string | null> {
  return getMeta(u, `plsnap:${playlistId}`);
}

/** Every playlist's stored snapshot_id, in one statement over the `plsnap:` keys: the rescan
 *  reads them once instead of one getMeta per playlist (multi-user PLAN §7.7; ~110 serial
 *  reads for Rem's library, about half of a day's `meta` reads). */
async function getPlaylistSnapshots(u: UserDb): Promise<Map<string, string>> {
  const client = await u.client();
  const r = await client.execute("SELECT key, value FROM meta WHERE key LIKE 'plsnap:%'");
  return new Map(r.rows.map((x) => [String(x.key).slice("plsnap:".length), String(x.value)]));
}

/** A playlist's cached tracks in playlist order (empty if never cached). */
async function getPlaylistTracks(u: UserDb, playlistId: string): Promise<Track[]> {
  const client = await u.client();
  const res = await client.execute({
    sql: `SELECT t.id, t.name AS title, t.artist, t.uri, t.album,
            t.album_image AS albumImage, t.duration_ms AS durationMs, pt.added_at AS addedAt
          FROM playlist_tracks pt LEFT JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = :pid ORDER BY pt.position`,
    args: { pid: playlistId },
  });
  return plainRows(res.rows) as unknown as Track[];
}

// Just the ordered id/uri/name/artist — all Resume needs to map plays → positions and pick
// the offset track. Skips the album/image/duration/added-at columns `getPlaylistTracks`
// carries, which roughly halves the payload on large playlists (the read sits on Resume's
// critical path, right before the play command).
export type PlaylistTrackRef = { id: string; uri: string; title: string; artist: string; durationMs?: number | null };
async function getPlaylistTrackOrder(u: UserDb, playlistId: string): Promise<PlaylistTrackRef[]> {
  const client = await u.client();
  const res = await client.execute({
    sql: `SELECT t.id, t.uri, t.name AS title, t.artist, t.duration_ms AS durationMs
          FROM playlist_tracks pt LEFT JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = :pid ORDER BY pt.position`,
    args: { pid: playlistId },
  });
  return plainRows(res.rows) as unknown as PlaylistTrackRef[];
}

/** Drop one track from a playlist's cache (after a remove) so it doesn't reappear on
 *  the next render before the background refresh. With `position`, only that row goes
 *  (one copy of a repeated track); without it, every row of the uri. */
async function removeCachedPlaylistTrack(u: UserDb, 
  playlistId: string,
  uri: string,
  position?: number,
): Promise<void> {
  const client = await u.client();
  await client.batch(
    [
      {
        sql: `DELETE FROM playlist_tracks
              WHERE playlist_id = :pid AND track_id IN (SELECT id FROM tracks WHERE uri = :uri)
              ${position === undefined ? "" : "AND position = :pos"}`,
        args: position === undefined ? { pid: playlistId, uri } : { pid: playlistId, uri, pos: position },
      },
      {
        // COMPACT the positions after the delete. diffPositions treats the cached array's
        // INDEX as the position value, so a gap left by this delete made the next store
        // overwrite the wrong slot (a track silently vanished from the cache) or trim a
        // live row (audit 2026-08-19 wave 2, B1). One correlated-subquery renumber keeps
        // index === position, which is the invariant every diff consumer assumes.
        sql: `UPDATE playlist_tracks
              SET position = (SELECT COUNT(*) FROM playlist_tracks q
                              WHERE q.playlist_id = :pid AND q.position < playlist_tracks.position)
              WHERE playlist_id = :pid`,
        args: { pid: playlistId },
      },
      writeSeqStmt(),
      librarySeqStmt(),
    ],
    "write",
  );
  // The removed song's plays from this playlist lose their match (or, with the cache now
  // empty, the playlist becomes unverifiable): re-rule them now rather than at the next store.
  await recomputeOrphanFlags(u, { playlistIds: [playlistId] });
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

/** Remove a playlist and all its cached tracks/snapshot from the store (after the
 *  user deletes/unfollows it on Spotify). */
async function deletePlaylistFromDb(u: UserDb, playlistId: string): Promise<void> {
  const client = await u.client();
  await client.batch(
    [
      { sql: "DELETE FROM playlists WHERE id = :id", args: { id: playlistId } },
      { sql: "DELETE FROM playlist_tracks WHERE playlist_id = :id", args: { id: playlistId } },
      { sql: "DELETE FROM meta WHERE key IN (:a, :b)", args: { a: `plsnap:${playlistId}`, b: `pltracks_at:${playlistId}` } },
      writeSeqStmt(),
      librarySeqStmt(),
    ],
    "write",
  );
  // Its cached tracks are gone, so plays from it are no longer verifiable and stop being
  // blanked — the same fallback an unsynced playlist gets.
  await recomputeOrphanFlags(u, { playlistIds: [playlistId] });
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
}

// ---- saved tracks (Liked Songs index; the other half of "the library") ----
/** The stored Liked Songs as (track, added_at) pairs: what the scan's head read compares the
 *  newest page against (liked-diff.ts likedHead). */
async function readSavedRows(u: UserDb): Promise<LikedRow[]> {
  const client = await u.client();
  const r = await client.execute("SELECT track_id AS trackId, added_at AS addedAt FROM saved_tracks");
  return plainRows(r.rows) as unknown as LikedRow[];
}

/** Replace the stored Liked Songs with a fresh full list, newest first, and stamp the cheap
 *  change-signals (count + newest added_at) used to skip future re-fetches. Keyed by track and
 *  diffed without `position` (liked-diff.ts likedDiff): Spotify lists Liked newest first, so
 *  one like used to move every row's position and rewrite all N of them, though nothing reads
 *  `position` (multi-user PLAN §7.7, scale 3). Returns the saved_tracks rows written. */
async function storeSavedTracks(u: UserDb, tracks: Track[]): Promise<number> {
  const { upserts, deletes } = likedDiff(
    tracks.map((t) => ({ trackId: t.id, addedAt: t.addedAt ?? null })),
    await readSavedRows(u),
  );
  const changed = new Set(upserts.map((r) => r.trackId));
  return storeSavedDiff(u, tracks.filter((t) => changed.has(t.id)), deletes, tracks.length, tracks[0]?.addedAt ?? null);
}

/** Write a Liked Songs diff the scan already worked out: `upserts` (new likes, or a moved
 *  added_at) and `deletes` (unliked track ids), with the list's count and newest added_at as
 *  Spotify reported them. Returns the saved_tracks rows written. */
async function storeSavedDiff(
  u: UserDb,
  upserts: Track[],
  deletes: string[],
  total: number,
  topAddedAt: string | null,
): Promise<number> {
  const client = await u.client();
  const incoming: TrackFields[] = upserts.map((t) => ({
    id: t.id,
    name: t.title,
    artist: t.artist,
    uri: t.uri,
    album: t.album ?? null,
    albumImage: t.albumImage ?? null,
    durationMs: t.durationMs ?? null,
  }));
  const cachedTracks = await readCachedTracks(client, [...new Set(incoming.map((t) => t.id))]);
  const stmts: InStatement[] = tracksNeedingWrite(incoming, cachedTracks).map(trackUpsertStmt);
  const renamed = identityChanges(incoming, cachedTracks);
  // `position` keeps its column and nothing reads it: a new row takes its index among this
  // write's rows, an existing one keeps whatever it had.
  upserts.forEach((t, i) => {
    stmts.push({
      sql: `INSERT INTO saved_tracks (track_id, added_at, position) VALUES (:tid, :added, :pos)
            ON CONFLICT(track_id) DO UPDATE SET added_at = excluded.added_at`,
      args: { tid: t.id, added: t.addedAt ?? null, pos: i },
    });
  });
  for (let i = 0; i < deletes.length; i += 500) {
    const chunk = deletes.slice(i, i + 500);
    stmts.push({
      sql: `DELETE FROM saved_tracks WHERE track_id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
  }
  // As in storePlaylistTracks: only the saved_tracks/tracks writes above feed a cached read,
  // so a diff that came back empty writes the three stamps below and announces nothing.
  if (stmts.length > 0) stmts.push(writeSeqStmt(), librarySeqStmt());
  stmts.push(metaStmt("liked_total", String(total)));
  stmts.push(metaStmt("liked_top_added_at", topAddedAt ?? ""));
  stmts.push(metaStmt("saved_synced_at", new Date().toISOString()));
  await client.batch(stmts, "write");
  // saved_tracks is not read by the orphan verdict, but a renamed song is.
  if (renamed.length > 0) await recomputeOrphanFlags(u, { identities: renamed });
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache(u);
  return upserts.length + deletes.length;
}

/** The cheap Liked-Songs change-signals (count + newest added_at). */
async function getLikedSignals(u: UserDb): Promise<{ total: number; topAddedAt: string | null }> {
  const total = await getMeta(u, "liked_total");
  const top = await getMeta(u, "liked_top_added_at");
  return { total: total ? Number(total) : 0, topAddedAt: top || null };
}

async function getSavedSyncedAt(u: UserDb): Promise<string | null> {
  return getMeta(u, "saved_synced_at");
}

// ---- the library union (for clean): Liked Songs + every OWNED playlist's tracks ----
/** Every track you "own" — Liked Songs plus all tracks in playlists you own — as a
 *  flat list (deduping is left to the pure domain layer, which keys on artist+title).
 *  `exceptPlaylistId` excludes the clean target itself.
 *
 *  Other `Cleaned: …` playlists DO count as library: they're real playlists you listen to,
 *  so a song already kept in one cleaned playlist gets purged from later cleans (first clean
 *  wins). The single exception is the target's OWN output, `Cleaned: <exceptName>` — it holds
 *  exactly the songs this clean keeps, so counting it would make the reconcile pass treat
 *  those as "saved elsewhere" and empty the playlist it just made. Backups (`Dupes removed
 *  from: …`) are discard piles and never count. Reads entirely from the store. */
async function getLibraryTracks(u: UserDb, 
  exceptPlaylistId?: string,
  exceptName?: string,
  /** The target's own cleaned/backup playlist IDS, when the caller knows them (Phase 2).
   *  Exclusion by id is what actually holds: the name-based exclusion below breaks the
   *  moment the stored name and the derived name diverge — a rename between phases, or a
   *  Spotify-side length clamp — and the reconcile then reads its own output as "library"
   *  and empties the playlist it just made (audit 2026-08-19 wave 2, A1/A2). */
  exceptIds: string[] = [],
): Promise<Track[]> {
  const client = await u.client();
  const meId = await getMeId(u);
  const ex = [exceptPlaylistId ?? "", ...exceptIds.filter(Boolean)];
  const res = await client.execute({
    sql: `
      SELECT t.id, t.name AS title, t.artist, t.uri, t.album,
        t.album_image AS albumImage, t.duration_ms AS durationMs
      FROM saved_tracks st JOIN tracks t ON t.id = st.track_id
      UNION
      SELECT t.id, t.name AS title, t.artist, t.uri, t.album,
        t.album_image AS albumImage, t.duration_ms AS durationMs
      FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        JOIN playlists p ON p.id = pt.playlist_id
      WHERE p.owner_id = :meId AND pt.playlist_id NOT IN (${ex.map((_, i) => `:ex${i}`).join(", ")})
        AND p.name <> :ownCleaned
        AND p.name NOT LIKE :backupLike`,
    args: {
      meId,
      ...Object.fromEntries(ex.map((id, i) => [`ex${i}`, id])),
      // The target's own cleaned output, excluded by exact name — the Phase-1 fallback for
      // the run where the cleaned playlist doesn't exist yet. With no target name there's
      // nothing to exclude → a sentinel no real playlist matches.
      // Derived through cleanedName so the clamp matches what Spotify stores (wave-3, P1).
      ownCleaned: exceptName ? cleanedName(exceptName) : "",
      backupLike: BACKUP_PREFIX + "%",
    },
  });
  return plainRows(res.rows) as unknown as Track[];
}

async function getLibrarySyncedAt(u: UserDb): Promise<string | null> {
  return getMeta(u, "library_synced_at");
}
async function setLibrarySyncedAt(u: UserDb): Promise<void> {
  await setMeta(u, "library_synced_at", new Date().toISOString());
}
/** The browser's last-published tz offset (minutes to add to UTC), written through from the
 *  tzoffset cookie by /api/sync. Read by tzOffsetMinutes() as the no-cookie fallback and by
 *  rebuildHomePayload so write-path day buckets match the reader's. */
async function getUserTzOffset(u: UserDb): Promise<number | null> {
  const v = await getMeta(u, "user_tz_offset").catch(() => null);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? Math.max(-720, Math.min(840, Math.round(n))) : null;
}
/** Written only when it changes (multi-user PLAN §4.3): /api/sync publishes it on every call,
 *  and an unchanged value writes no row. True when it wrote. */
async function setUserTzOffset(u: UserDb, offsetMin: number): Promise<boolean> {
  return setMetaIfChanged(u, "user_tz_offset", String(Math.round(offsetMin)));
}

/** The browser's IANA zone (`user_tz`, PLAN §4.3, design C §3.3), published beside the offset:
 *  the Home payload buckets days in it and runs its DST check against it, so a friend in
 *  Chicago is not read as New York an hour off. Null until a browser has published one. */
async function getUserTz(u: UserDb): Promise<string | null> {
  const v = await getMeta(u, "user_tz").catch(() => null);
  return v && isZone(v) ? v : null;
}
/** Written only when it changes; a zone this runtime does not know is never stored. */
async function setUserTz(u: UserDb, zone: string): Promise<boolean> {
  return isZone(zone) && setMetaIfChanged(u, "user_tz", zone);
}
function isZone(z: string): boolean {
  if (z.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

// What the cron's /me/player probe last saw (multi-user PLAN §7.3, harvest-policy.ts), written
// only when the track or the play state changes, so a probe that changes nothing writes nothing.
// It replaces the single-user harvest gate's two stamps (`player_last_active`,
// `rp_last_harvest`), which nothing reads from Phase 3. Unreadable = none.
async function readProbe(u: UserDb): Promise<ProbeState | null> {
  const v = await getMeta(u, "probe");
  if (!v) return null;
  try {
    const p = JSON.parse(v) as ProbeState;
    return p?.v === 1 ? p : null;
  } catch {
    return null;
  }
}
async function writeProbe(u: UserDb, p: ProbeState): Promise<void> {
  await setMeta(u, "probe", JSON.stringify(p));
}

// The app-wide budget mode (src/lib/budget/, CAPACITY §6), in the app database's app_meta
// beside the cooldowns (multi-user PLAN §4.2: app-wide state is the app's, not a user's). The
// daily chores write it; the hot paths read it through a per-process memo of at
// most 10 minutes, so a change reaches every instance within 10 minutes for one meta read per
// instance per 10 minutes. Meta only: no marker bump.
const BUDGET_MODE_KEY = "budget_mode";
const BUDGET_MODE_MEMO_MS = 10 * 60_000;

/** null = never written (or not a mode). `maxAgeMs` 0 reads the store (the health check). A
 *  failed read answers the memo's value for another 10 minutes if there is one, else throws. */
export async function getBudgetMode(maxAgeMs = BUDGET_MODE_MEMO_MS): Promise<Mode | null> {
  const memo = g.__lbBudgetMode;
  if (memo && maxAgeMs > 0 && Date.now() - memo.at < maxAgeMs) return memo.mode;
  try {
    const v = await getAppMeta(BUDGET_MODE_KEY);
    const mode = isMode(v) ? v : null;
    g.__lbBudgetMode = { at: Date.now(), mode };
    return mode;
  } catch (e) {
    if (!memo || maxAgeMs === 0) throw e;
    g.__lbBudgetMode = { at: Date.now(), mode: memo.mode };
    return memo.mode;
  }
}
export async function setBudgetMode(mode: Mode): Promise<void> {
  await setAppMeta(BUDGET_MODE_KEY, mode);
  g.__lbBudgetMode = { at: Date.now(), mode };
}

// ---- preferences / background-job bookkeeping (meta-backed) ----
/** Whether "Clean" backs removed songs up to a separate playlist. Persisted globally
 *  (DB, so it follows the user across devices), defaulting to on. */
async function getCleanBackupPref(u: UserDb): Promise<boolean> {
  const v = await getMeta(u, "clean_backup_pref");
  return v === null ? true : v === "1";
}
/** Every play from a given playback context (e.g. a playlist URI), with its timestamp,
 *  oldest→newest. Resume uses the timestamps to scope to the most recent listening
 *  session, so an older/deeper run can't push the resume point past where you actually
 *  stopped this time. */
async function playedTracksInContext(u: UserDb, 
  contextUri: string,
): Promise<{ trackId: string; name: string | null; artist: string | null; playedAt: string }[]> {
  const client = await u.client();
  // Also return name/artist so callers can fall back to a name+artist match when the play's
  // track id doesn't line up with the playlist's stored id — Spotify hands the same song
  // different ids across a playlist vs. recently-played (track relinking / duplicate
  // releases), and an id-only match silently drops those plays.
  const res = await client.execute({
    sql: `SELECT p.track_id AS trackId, t.name AS name, t.artist AS artist, p.played_at AS playedAt
          FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE p.context_uri = :uri ORDER BY p.played_at ASC`,
    args: { uri: contextUri },
  });
  return plainRows(res.rows) as unknown as {
    trackId: string;
    name: string | null;
    artist: string | null;
    playedAt: string;
  }[];
}

/** A track row by song identity — lower(artist), lower(name), the same identity the
 *  orphan rule and the client-side search merge use — plus every named playlist any
 *  id-variant of the song sits in (Spotify hands the same song different ids across
 *  contexts). Feeds the search-row context menu, which has name+artist but no uri.
 *  All indexed: idx_tracks_artist_name for the row, idx_pltracks_track per id. */
async function findTrackWithPlaylists(u: UserDb, 
  name: string,
  artist: string,
): Promise<{
  track: {
    id: string;
    title: string;
    artist: string;
    uri: string;
    album: string | null;
    albumImage: string | null;
    durationMs: number | null;
  } | null;
  playlists: { id: string; name: string }[];
}> {
  const client = await u.client();
  // INNER JOIN convention from the file header: equality on the identity index.
  const trackRes = await client.execute({
    sql: `SELECT id, name AS title, artist, uri, album, album_image AS albumImage,
            duration_ms AS durationMs
          FROM tracks WHERE lower(artist) = lower(:artist) AND lower(name) = lower(:name)
          ORDER BY id LIMIT 8`,
    args: { artist, name },
  });
  const rows = plainRows(trackRes.rows) as unknown as {
    id: string;
    title: string;
    artist: string;
    uri: string;
    album: string | null;
    albumImage: string | null;
    durationMs: number | null;
  }[];
  if (rows.length === 0) return { track: null, playlists: [] };
  const ids = rows.map((r) => r.id);
  const plRes = await client.execute({
    sql: `SELECT DISTINCT p.id, p.name, p.position
          FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
          WHERE pt.track_id IN (${ids.map(() => "?").join(",")})
          ORDER BY p.position`,
    args: ids,
  });
  return {
    track: rows[0],
    playlists: (plainRows(plRes.rows) as unknown as { id: string; name: string }[]).map(
      ({ id, name: n }) => ({ id, name: n }),
    ),
  };
}

/** Cached name for a playback context uri, tri-state: `undefined` = never cached (worth
 *  resolving), `null` = negative-cached (known-unresolvable — don't re-hit Spotify), string =
 *  the name. The distinction matters: collapsing NULL rows into a string made this return the
 *  literal "null" (String(null)), which the now-playing chip then displayed as a name. */
async function getContextName(u: UserDb, uri: string): Promise<string | null | undefined> {
  const client = await u.client();
  const res = await client.execute({
    sql: "SELECT name FROM contexts WHERE uri = ?",
    args: [uri],
  });
  if (!res.rows[0]) return undefined;
  return res.rows[0].name == null ? null : String(res.rows[0].name);
}

// ---- Spotify tokens (server-side source of truth) ----
// Stored here (not just in the JWT cookie) so a single refresh is shared across
// concurrent requests AND across serverless instances. Spotify's PKCE refresh
// token rotates on each use; reading the latest from here, plus the cross-instance
// lock below (used by auth.ts), avoids the "concurrent refresh with a stale token →
// invalid_grant → forced re-login" race.
export type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

// The Spotify OAuth token is a SINGLE global row, but local dev and the deployed prod app
// (plus the every-2-min cron) share ONE database. Spotify rotates the refresh token
// on every refresh, so if dev and prod use the same row they keep rotating each other's
// token out from under one another → `invalid_grant` → forced re-login (and the occasional
// Configuration error when it happens mid-callback). Namespacing the key by environment
// gives dev its own independent Spotify session while keeping the shared data DB, so a
// dev-server restart no longer logs you out. Prod keeps the canonical `spotify_tokens` key.
const SPOTIFY_TOKENS_KEY =
  process.env.NODE_ENV === "production" ? "spotify_tokens" : "spotify_tokens_dev";

async function setSpotifyTokens(u: UserDb, t: SpotifyTokens): Promise<void> {
  await setMeta(u, SPOTIFY_TOKENS_KEY, JSON.stringify(t));
}

async function getSpotifyTokens(u: UserDb): Promise<SpotifyTokens | null> {
  const raw = await getMeta(u, SPOTIFY_TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

async function clearSpotifyTokens(u: UserDb): Promise<void> {
  const client = await u.client();
  await client.execute({ sql: "DELETE FROM meta WHERE key = ?", args: [SPOTIFY_TOKENS_KEY] });
}

// ---- cross-instance lock (meta-table mutex with TTL) ----
// Serverless has no shared process memory, so an in-process lock can't coordinate
// refreshes across instances. This is a best-effort distributed lock: an atomic
// compare-and-set on a `lock:<name>` row that only an expired/absent lock can win.
/** Try to acquire `name` for `ttlMs`. Returns true iff acquired. */
/** Try to take a short-lived cross-instance lock. Returns an owner token (pass it to
 *  releaseLock) on success, null if the lock is held. The owner check stops a holder
 *  that overran its TTL from releasing the lock someone else has since acquired. */
async function acquireLock(u: UserDb, name: string, ttlMs: number): Promise<string | null> {
  const client = await u.client();
  const now = Date.now();
  // Owner token = expiry + a nonce. A pure-expiry token is a function of (now, ttl), so
  // two acquisitions in the same millisecond minted the SAME token and one holder's
  // release could free the other's lock (wave-2 audit, B1). SQLite's CAST parses the
  // leading digits, so the expiry comparison below still works on the combined string.
  const exp = String(now + ttlMs);
  const owner = `${exp}:${Math.random().toString(36).slice(2, 10)}`;
  const res = await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (:k, :owner)
          ON CONFLICT(key) DO UPDATE SET value = :owner
          WHERE CAST(meta.value AS INTEGER) < :now`,
    args: { k: `lock:${name}`, owner, now },
  });
  return res.rowsAffected > 0 ? owner : null;
}

async function releaseLock(u: UserDb, name: string, owner: string): Promise<void> {
  const client = await u.client();
  await client.execute({
    sql: "DELETE FROM meta WHERE key = ? AND value = ?",
    args: [`lock:${name}`, owner],
  });
}

/** Build an upsert statement for a single meta key (for batching). */
function metaStmt(key: string, value: string): InStatement {
  return {
    sql: `INSERT INTO meta (key, value) VALUES (:k, :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { k: key, v: value },
  };
}

/** setMeta that writes no row when the value is already there. True when it wrote. */
async function setMetaIfChanged(u: UserDb, key: string, value: string): Promise<boolean> {
  const client = await u.client();
  const r = await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE meta.value IS NOT excluded.value`,
    args: [key, value],
  });
  return r.rowsAffected > 0;
}

// No write marker here: nothing cached is derived from `meta` (write-marker note).
async function setMeta(u: UserDb, key: string, value: string): Promise<void> {
  const client = await u.client();
  await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

async function getMeta(u: UserDb, key: string): Promise<string | null> {
  const client = await u.client();
  const res = await client.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

// ---- Spotify API request log ----------------------------------------------------------
// Every outgoing Spotify call is recorded here (fire-and-forget from the HTTP client, so
// it never slows a request), so a 429 can be analysed after the fact: how many calls we
// made, from which SOURCE, over what window, and what wait Spotify demanded. Thirty days
// are kept: the quota-window table exists to compare a new ban against every PAST
// exhaustion point, and a 7-day TTL was quietly deleting that history (audit 2026-08-19,
// T2.17). Store is self-hosted — rows cost nothing. Retention is enforced by the daily
// cron tick (cron/sync route), not just the best-effort write-path counter below, which
// resets with every serverless instance.
const API_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let apiLogWrites = 0;

export async function logSpotifyRequest(entry: {
  method: string;
  path: string;
  status: number;
  retryAfter: number | null;
  source?: string;
  /** The user whose token made the call (the Spotify client's owner). */
  uid?: string | null;
  /** A 429's `reason` (QUOTA_EXCEEDED); null otherwise. */
  reason?: string | null;
}): Promise<void> {
  const client = await getTelemetryClient();
  // Store just the endpoint path (no host, no query string) — enough to see which calls
  // dominate, without bloating rows or storing query params.
  let p = entry.path;
  try {
    p = entry.path.startsWith("http") ? new URL(entry.path).pathname : entry.path.split("?")[0];
  } catch {
    /* keep the raw path */
  }
  // Successful now-playing polls ARE logged now (they used to be skipped to save Turso
  // row-writes): they are the app's dominant Spotify traffic, and a rate-limit analysis
  // that can't see the dominant source is blind (Rem, 2026-08-16). Self-hosted store —
  // the writes cost nothing.
  await client.execute({
    sql: `INSERT INTO api_log (ts, method, path, status, retry_after, source, user_id, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [Date.now(), entry.method, p, entry.status, entry.retryAfter, entry.source ?? null, entry.uid ?? null, entry.reason ?? null],
  });
  // Prune occasionally rather than on every write.
  if (++apiLogWrites % 256 === 0) await pruneApiLog();
}

/** Per-source Spotify traffic over the trailing window — the interpretable rollup /usage
 *  renders: who is calling, how much, and how much of it Spotify refused. */
export type SpotifyCallSource = {
  source: string;
  calls: number;
  errors: number;
  rateLimited: number;
  lastTs: number;
};
export async function getSpotifyCallBreakdown(hours = 24): Promise<SpotifyCallSource[]> {
  const client = await getTelemetryClient();
  const res = await client.execute({
    sql: `SELECT COALESCE(source, 'untagged') AS source, COUNT(*) AS calls,
                 SUM((status >= 400 OR status = 0) AND status <> 429) AS errors,
                 SUM(status = 429) AS rateLimited, MAX(ts) AS lastTs
          FROM api_log WHERE ts > ? GROUP BY COALESCE(source, 'untagged')
          ORDER BY calls DESC`,
    args: [Date.now() - hours * 3600_000],
  });
  return plainRows(res.rows) as unknown as SpotifyCallSource[];
}

// ── The recently-played daily quota ──────────────────────────────────────────────────────
// Spotify runs a per-endpoint DAILY budget on /me/player/recently-played for this app.
// Pinned from api_log on 2026-08-17: six penalty episodes (Aug 12–17), onset anywhere from
// 11 PM to 8 AM, but every one LIFTING at 10:46–10:51 AM ET — a daily reset (drifting about
// a minute later each day) — while the burst window was never close (peak 18 calls/30s
// against a per-30s limit). So the thing to track is calls per QUOTA DAY, not per minute:
// each window below is one reset-to-reset day; when a window contains a 429 on the endpoint,
// `callsBeforeBan` is that day's measured budget (observed 2026-08-12..17: bans landed in
// the ~400–700-calls range). Expectation under the harvest gate (cron/sync/route.ts):
// ~24 hourly backstops + ~30/hr while actually listening. A ban in a window where calls sat
// far below past `callsBeforeBan` values means the model is wrong, not the traffic — and
// `bySource` names whoever overran.
const RP_QUOTA_PATH = "/me/player/recently-played";
// The observed reset, expressed as a UTC anchor: 14:51 UTC = 10:51 AM EDT on 2026-08-17.
// It drifts ~+1 min/day, so window edges are approximate to a few minutes — fine for
// bucketing calls that arrive hours apart.
const RP_QUOTA_ANCHOR_MS = Date.UTC(2026, 0, 1, 14, 51);
const RP_QUOTA_DAY_MS = 24 * 3600_000;

export type QuotaWindow = {
  windowStart: number; // ms epoch of the window's (approximate) reset
  calls: number;
  rateLimited: number;
  bySource: { source: string; calls: number }[];
  banTs: number | null; // first 429 in the window, if any
  banRetryAfterS: number | null;
  callsBeforeBan: number | null; // the day's measured budget, when it was hit
};

export async function getRecentlyPlayedQuotaWindows(): Promise<QuotaWindow[]> {
  const client = await getTelemetryClient();
  // Bounded to the retention window and served by idx_api_log_path_ts — this used to be an
  // unbounded scan on an unindexed predicate, on the page whose subject is read cost.
  const res = await client.execute({
    sql: `SELECT ts, status, retry_after, COALESCE(source, 'untagged') AS source
          FROM api_log WHERE path = ? AND ts > ? ORDER BY ts`,
    args: [RP_QUOTA_PATH, Date.now() - API_LOG_TTL_MS],
  });
  const rows = plainRows(res.rows) as {
    ts: number;
    status: number;
    retry_after: number | null;
    source: string;
  }[];
  const windows = new Map<number, QuotaWindow & { sourceMap: Map<string, number> }>();
  for (const r of rows) {
    const ts = Number(r.ts);
    const idx = Math.floor((ts - RP_QUOTA_ANCHOR_MS) / RP_QUOTA_DAY_MS);
    let w = windows.get(idx);
    if (!w) {
      w = {
        windowStart: RP_QUOTA_ANCHOR_MS + idx * RP_QUOTA_DAY_MS,
        calls: 0,
        rateLimited: 0,
        bySource: [],
        banTs: null,
        banRetryAfterS: null,
        callsBeforeBan: null,
        sourceMap: new Map(),
      };
      windows.set(idx, w);
    }
    w.calls++;
    w.sourceMap.set(r.source, (w.sourceMap.get(r.source) ?? 0) + 1);
    if (Number(r.status) === 429) {
      w.rateLimited++;
      if (w.banTs === null) {
        w.banTs = ts;
        w.banRetryAfterS = r.retry_after == null ? null : Number(r.retry_after);
        w.callsBeforeBan = w.calls - 1; // everything sent before the wall
      }
    }
  }
  return [...windows.values()]
    .sort((a, b) => b.windowStart - a.windowStart)
    .map(({ sourceMap, ...w }) => ({
      ...w,
      bySource: [...sourceMap.entries()]
        .map(([source, calls]) => ({ source, calls }))
        .sort((a, b) => b.calls - a.calls),
    }));
}

export async function pruneApiLog(): Promise<void> {
  const client = await getTelemetryClient();
  await client.execute({
    sql: `DELETE FROM api_log WHERE ts < ?`,
    args: [Date.now() - API_LOG_TTL_MS],
  });
}

/** client_metrics had NO prune at all — unbounded growth with only the last 7 days ever
 *  read (audit 2026-08-19, T2.16). 30 days kept for post-hoc digging; the daily cron tick
 *  calls this alongside pruneApiLog. ISO-TEXT ts, so the cutoff is the same format. */
export async function pruneClientMetrics(): Promise<void> {
  const client = await getTelemetryClient();
  await client.execute({
    sql: `DELETE FROM client_metrics WHERE ts < ?`,
    args: [new Date(Date.now() - 30 * 86_400_000).toISOString()],
  });
}

/** Spotify-call counts (and how many were 429s) within recent windows, for understanding a
 *  throttle. `seconds` = how far back the window reaches. Reads the last minute of the log. */
export async function getApiLogSummary(): Promise<{
  windows: { seconds: number; calls: number; rateLimited: number }[];
}> {
  const client = await getTelemetryClient();
  const now = Date.now();
  const res = await client.execute({
    sql: `SELECT ts, status FROM api_log WHERE ts > ? ORDER BY ts DESC`,
    args: [now - 60_000],
  });
  const rows = res.rows.map((r) => ({ ts: Number(r.ts), status: Number(r.status) }));
  const windows = [1, 5, 10, 30, 60].map((seconds) => {
    const cutoff = now - seconds * 1000;
    const inWin = rows.filter((r) => r.ts >= cutoff);
    return {
      seconds,
      calls: inWin.length,
      rateLimited: inWin.filter((r) => r.status === 429).length,
    };
  });
  return { windows };
}

// ── The read-cost ledger (`usage_ledger`) ───────────────────────────────────────────────
// Continuous attribution for read cost. It was built against a metered quota — Turso reports
// ONE counter per organization and cannot say which read path spent it, which is how a month of
// burn went unattributed (docs/READ_QUOTA.md). The self-hosted store meters nothing, so the
// ledger is now an efficiency instrument rather than a quota defence: it is the only thing that
// says which path a regression came from, and it is what the Turso fallback would need on day
// one. So every named read path records what it MODELS itself
// to cost as it runs — src/lib/read-costs.ts owns the model — and /api/cron/usage-check
// diffs a day's total against the platform counter, writing the platform number and the
// unexplained residual back into this same table.
//
// META-CLASS DATA, so the marker rules at the top of the file apply the way they do to
// api_log: it MUST NOT bump write_seq. Nothing cached is derived from usage_ledger, and this is
// written on essentially every request — a bump here would discard every cached read
// continuously, which is the exact cost the marker exists to avoid.
//
// IT MUST NEVER BREAK OR SLOW THE THING IT MEASURES. ledgerAdd swallows every error and
// every call site fires it with `void`, off the awaited path (the same contract as
// logSpotifyRequest). A missing attribution row is a hole in a diagnostic; an attribution
// row that throws, or that adds a round trip to a render, is an outage caused by the
// instrument. Where a call site already runs a `client.batch` write the ledger deliberately
// stays OUT of that batch: saving one round trip is not worth a ledger failure being able
// to fail a real write.
//
// Reader names are stable and few (see docs/READ_QUOTA.md "Continuous attribution" for the
// list). Two are reserved: `_platform_total` and `_residual` are written by the
// reconciliation, not by a read path, and `_platform_error` records a day the platform API
// could not be reached. The leading underscore is what distinguishes them, so a real reader
// must never start with one.

export type LedgerRow = { day: string; reader: string; calls: number; modeledRows: number };

/** The UTC calendar day — the ledger's bucket, and the day Turso's quota accounting used. */
function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Charge one call of `reader` its modeled row cost against today (UTC). Fire-and-forget:
 *  callers use `void ledgerAdd(...)`, and this never rejects. */
export async function ledgerAdd(reader: string, modeledRows: number): Promise<void> {
  try {
    const client = await getTelemetryClient();
    await client.execute({
      sql: `INSERT INTO usage_ledger (day, reader, calls, modeled_rows)
            VALUES (:day, :reader, 1, :rows)
            ON CONFLICT(day, reader) DO UPDATE SET
              calls = calls + 1,
              modeled_rows = modeled_rows + excluded.modeled_rows`,
      // `|| 0` also normalises a NaN cost — a broken model term must not write a NULL-ish
      // row that then poisons the day's SUM.
      args: { day: utcDay(), reader, rows: Math.round(modeledRows) || 0 },
    });
  } catch {
    /* attribution must never break its caller */
  }
}

/** Record an ABSOLUTE figure for a named day, replacing whatever was there. The
 *  reconciliation uses this rather than ledgerAdd: it writes a measured total for a day that
 *  is already closed, so a second run of the daily cron must overwrite the number, not add
 *  to it. `calls` still increments, so a re-run is visible. Never rejects. */
export async function ledgerSet(day: string, reader: string, modeledRows: number): Promise<void> {
  try {
    const client = await getTelemetryClient();
    await client.execute({
      sql: `INSERT INTO usage_ledger (day, reader, calls, modeled_rows)
            VALUES (:day, :reader, 1, :rows)
            ON CONFLICT(day, reader) DO UPDATE SET
              calls = calls + 1,
              modeled_rows = excluded.modeled_rows`,
      args: { day, reader, rows: Math.round(modeledRows) || 0 },
    });
  } catch {
    /* attribution must never break its caller */
  }
}

/** The last `days` days of the ledger, newest day first. A range seek on the primary key
 *  over a table with one row per (day, reader) — tens of rows, not a scan. */
export async function readLedger(days: number): Promise<LedgerRow[]> {
  const client = await getTelemetryClient();
  const cutoff = utcDay(Date.now() - Math.max(0, days - 1) * 86_400_000);
  const res = await client.execute({
    sql: `SELECT day, reader, calls, modeled_rows AS modeledRows FROM usage_ledger
          WHERE day >= :cutoff ORDER BY day DESC, reader ASC`,
    args: { cutoff },
  });
  return plainRows(res.rows) as unknown as LedgerRow[];
}

/** What the model says one day cost, across the real read paths only — the reserved
 *  `_`-prefixed rows are the reconciliation's own output and would otherwise be counted as
 *  spend. This is the left-hand side of the residual. */
export async function ledgerDayModeledTotal(day: string): Promise<number> {
  const client = await getTelemetryClient();
  const res = await client.execute({
    sql: `SELECT COALESCE(SUM(modeled_rows), 0) AS total FROM usage_ledger
          WHERE day = :day AND substr(reader, 1, 1) <> '_'`,
    args: { day },
  });
  return res.rows[0] ? Number(res.rows[0].total) || 0 : 0;
}

// ── The CPU meter and the daily budget record (src/lib/budget/, CAPACITY §6) ──────────────
// Telemetry like the ledger: meta-class, no marker bump. meterFlush is awaited only inside
// after() (request-meter.ts) and REJECTS on failure, so the meter keeps the counts for its
// next flush; the reads are the daily chores', /usage's and the health check's.

/** One flush: every pending (day, route, user) added to what is stored, in one batch. */
export async function meterFlush(rows: MeterSample[]): Promise<void> {
  const client = await getTelemetryClient();
  const at = Date.now();
  await client.batch(
    rows.map((r) => ({
      sql: `INSERT INTO cpu_meter (day, route, user_id, invocations, cpu_us, wall_ms, bytes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(day, route, user_id) DO UPDATE SET
              invocations = invocations + excluded.invocations,
              cpu_us = cpu_us + excluded.cpu_us,
              wall_ms = wall_ms + excluded.wall_ms,
              bytes = bytes + excluded.bytes,
              updated_at = excluded.updated_at`,
      args: [r.day, r.route, r.uid, r.invocations, Math.round(r.cpuUs), Math.round(r.wallMs), Math.round(r.bytes), at],
    })),
    "write",
  );
}

/** The meter's sums from `fromDay` (a UTC day) on, and when it last wrote anything at all. */
export async function readMeter(
  fromDay: string,
): Promise<{ cpuUs: number; invocations: number; bytes: number; lastAt: number | null }> {
  const client = await getTelemetryClient();
  const res = await client.execute({
    sql: `SELECT COALESCE(SUM(cpu_us), 0) AS cpu, COALESCE(SUM(invocations), 0) AS inv,
                 COALESCE(SUM(bytes), 0) AS bytes, (SELECT MAX(updated_at) FROM cpu_meter) AS last
          FROM cpu_meter WHERE day >= ?`,
    args: [fromDay],
  });
  const r = res.rows[0];
  return {
    cpuUs: Number(r?.cpu) || 0,
    invocations: Number(r?.inv) || 0,
    bytes: Number(r?.bytes) || 0,
    lastAt: r?.last == null ? null : Number(r.last),
  };
}

export type BudgetDayRow = {
  day: string;
  dimension: string;
  used: number | null;
  projected: number | null;
  limit: number;
  mode: string;
  at: number;
};

/** A day's record, replacing any earlier run's for the same day. */
export async function recordBudgetDay(rows: BudgetDayRow[]): Promise<void> {
  const client = await getTelemetryClient();
  await client.batch(
    rows.map((r) => ({
      sql: `INSERT OR REPLACE INTO budget_days (day, dimension, used, projected, hard_limit, mode, at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [r.day, r.dimension, r.used, r.projected, r.limit, r.mode, r.at],
    })),
    "write",
  );
}

/** The latest day's record (empty before the first). */
export async function readBudgetDay(): Promise<BudgetDayRow[]> {
  const client = await getTelemetryClient();
  const res = await client.execute(
    `SELECT day, dimension, used, projected, hard_limit AS "limit", mode, at FROM budget_days
     WHERE day = (SELECT MAX(day) FROM budget_days) ORDER BY dimension`,
  );
  return plainRows(res.rows) as unknown as BudgetDayRow[];
}

// The linear terms in the cost model need the store's size. It comes from the cached
// all-time stats (one indexed meta key), memoized briefly so attribution doesn't add a round
// trip to every instrumented call, and falling back to read-costs.ts's calibration size when
// the cache is cold — a modeled cost must never block on a scan to learn how big a table is.
const STORE_SIZE_MEMO_MS = 60_000;
// Per (uid, db_name): each user's history has its own size.
const storeSizeMemo = new Map<string, { at: number; plays: number }>();

async function modeledPlaysCount(u: UserDb): Promise<number> {
  const key = openKey(u.uid, u.dbName);
  const memo = storeSizeMemo.get(key);
  if (memo && Date.now() - memo.at < STORE_SIZE_MEMO_MS) {
    return memo.plays;
  }
  let plays: number = CALIBRATION.plays;
  try {
    const v = await getMeta(u, "alltime_stats");
    if (v) {
      const n = Number((JSON.parse(v) as AllTimeStats).plays);
      if (n > 0) plays = n;
    }
  } catch {
    /* keep the calibration default */
  }
  storeSizeMemo.set(key, { at: Date.now(), plays });
  return plays;
}

/** Share of plays carrying a playback context, from the calibration store (6,951 / 7,194).
 *  Used to size the `contexts` probe half of the daily full pass. */
const CONTEXTED_PLAY_FRACTION = CALIBRATION.contextedPlays / CALIBRATION.plays;

/** Ledger a cost that is LINEAR in history size, resolving the size off the awaited path so
 *  the caller pays nothing for it. Not async on purpose: the whole chain, including the
 *  size lookup, hangs off the returned-and-discarded promise. */
function ledgerAddLinear(u: UserDb, reader: string, cost: (plays: number) => number): void {
  void modeledPlaysCount(u)
    .then((plays) => ledgerAdd(reader, cost(plays)))
    .catch(() => {
      /* attribution must never break its caller */
    });
}

/** Ledger one whole sync call under `reader`, picking the steady or landed-play cost from
 *  what the sync actually inserted. Async only because the landed cost is linear in history
 *  size; every call site fires it with `void`, and it never rejects.
 *
 *  `extraRows` is for a caller that does bounded reads of its own on top of the sync
 *  (refreshHistoryAction's head/delta check). Reads that have their OWN reader — the strip,
 *  a day, the all-time list — must not be passed here; they are already counted. */
async function ledgerSyncCall(u: UserDb, 
  reader: string,
  added: number,
  extraRows = 0,
): Promise<void> {
  try {
    const rows =
      added > 0 ? landedSyncTickRows(await modeledPlaysCount(u)) : STEADY_SYNC_TICK_ROWS;
    await ledgerAdd(reader, rows + extraRows);
  } catch {
    /* attribution must never break its caller */
  }
}

// ── Client performance metrics (`client_metrics`) ───────────────────────────────────────
// What the BROWSER measured, per real page load: ttfb/fcp/lcp, the app's own
// `performance.mark("lb:…")` marks, and how long the visit stayed visible. Append-only, one
// row per timing, posted in batches by /api/metrics (src/lib/metrics-client.ts collects
// them). It exists so "the home page feels slow" becomes a query instead of a memory.
//
// FENCED EXACTLY LIKE api_log: it MUST NOT bump write_seq. Nothing user-facing is versioned
// by this table, so a bump would only churn the LIVE cache keys and the history payload's
// ETag on every page view — the exact failure the marker rule at the top of the file exists
// to prevent.
//
// Volume is a handful of rows per page view on a single-user app, so the 7-day read below
// pulls its window ONCE and does everything in JS rather than carrying window functions — and
// one scan answers both shapes the usage page needs, which is the point: the page that watches
// the read budget must not scan this table twice to draw itself.
//
// TWO SHAPES, ONE SCAN. Per page: the p50/p95 of each timing, which says what the page usually
// is. Per OPEN: one row per time a page was opened, with each part's ms across the columns,
// which says whether THAT open at 3:41pm was slow. The percentile hides the bad one; the open
// list is where you see it.

export type ClientMetricInput = {
  session: string;
  page: string;
  event: string;
  value?: number | null;
  meta?: string | null;
  /** Browser-side observation time (ms epoch). Optional — old clients don't send it. */
  at?: number | null;
};

/** One event's distribution over the summary window. */
export type MetricStat = { n: number; p50: number; p95: number };

export type ClientMetricsPage = {
  page: string;
  views: number;
  avgVisitMs: number | null;
  /** `js-error` reports on this page in the window. A count, not a distribution: one throw is
   *  already the whole signal, and the message rides along in the row's `meta`. */
  errors: number;
  /** Keyed by event name; an event with no samples on this page is absent. */
  stats: Record<string, MetricStat>;
};

/** One page open: every part of it that reported, keyed by event name. This is the shape the
 *  usage page reads across — a row per open, a column per part. */
export type PageOpen = {
  page: string;
  /** The beacon's arrival, so within ~10s of the open itself (metrics-client.ts flushes on a
   *  timer and on pagehide). Exact enough to find "the slow one at 3:41pm", which is its job. */
  at: string;
  /** `load` = the browser fetched the document; `nav` = an in-app link. Decided by whether the
   *  web vitals filed against it, which only happens for the view the document loaded. */
  kind: "load" | "nav";
  /** The page a `nav` open came FROM, when the click was seen. */
  from: string | null;
  errors: number;
  /** Event name → ms (unitless for `cls`). A part that didn't report is simply absent, which
   *  the page draws as `—` rather than as a zero. */
  parts: Record<string, number>;
};

/** One thrown error, verbatim: what the browser said, where, when. An error count alone is
 *  not interpretable — the message is the whole diagnosis. */
export type ClientError = { at: string; page: string; message: string };

export type ClientLoadSpeed = { pages: ClientMetricsPage[]; opens: PageOpen[]; errors: ClientError[] };

/** The timing events the usage page charts. Anything else (a new `lb:` mark) still lands in
 *  the table — it just isn't summarised until it is named here. `inp` and `cls` are the two
 *  vitals that measure what LCP can't: how long the app took to answer a tap, and how much it
 *  moved under the reader; the rest are the app's own marks, one per visible part that has a
 *  timing of its own (src/lib/metrics-client.ts lists where each is made). */
export const SUMMARY_EVENTS = [
  "ttfb",
  "fcp",
  "lcp",
  "inp",
  "cls",
  "data-rendered",
  "history-ready",
  "index-idb",
  "dock-ready",
  "playlists-rendered",
  "now-playing-ready",
] as const;

const CLIENT_METRICS_WINDOW_MS = 7 * 86_400_000;
/** Per page, in the open list. Ten is what fits on screen and covers a sitting. */
const OPENS_PER_PAGE = 10;
/** How metrics-client.ts stamps the view an event belongs to, on the front of `meta`. */
const PV_TAG = "pv:";

/** Split a stored `meta` into the view id that owns the row and whatever the event itself put
 *  there. Rows written before the tag existed have no view — they still count in the
 *  percentiles, they just can't be grouped into an open. */
function splitMeta(raw: string | null): { pv: string; meta: string | null } {
  if (!raw || !raw.startsWith(PV_TAG)) return { pv: "", meta: raw };
  const bar = raw.indexOf("|");
  if (bar === -1) return { pv: raw.slice(PV_TAG.length), meta: null };
  return { pv: raw.slice(PV_TAG.length, bar), meta: raw.slice(bar + 1) };
}

/** Append a batch of reported timings. `ts` is the browser's OBSERVATION time when the event
 *  carries one — beacons only flush every so often (and always at pagehide), so arrival time
 *  stamped a whole sitting's opens and errors at the moment the tab closed (audit 2026-08-19,
 *  T1.8). The client clock is clamped to [now - 7d, now]: a skewed tab can neither file rows
 *  into next week nor before the read window. Events with no `at` keep the arrival stamp.
 *  No write_seq bump (see the section note). */
export async function recordClientMetrics(rows: ClientMetricInput[], uid: string | null = null): Promise<void> {
  if (rows.length === 0) return;
  const client = await getTelemetryClient();
  const now = Date.now();
  const arrival = new Date(now).toISOString();
  const stamp = (at: number | null | undefined): string => {
    if (typeof at !== "number" || !Number.isFinite(at)) return arrival;
    return new Date(Math.min(now, Math.max(now - CLIENT_METRICS_WINDOW_MS, at))).toISOString();
  };
  await client.batch(
    rows.map((r) => ({
      sql: `INSERT INTO client_metrics (ts, session, page, event, value, meta, user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [stamp(r.at), r.session, r.page, r.event, r.value ?? null, r.meta ?? null, uid],
    })),
    "write",
  );
}

/** Nearest-rank percentile over an unsorted sample (p as a fraction, e.g. 0.95). */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** The last 7 days of what the browser measured, in the two shapes the usage page draws (see
 *  the section note): `pages` = per-page percentiles, busiest first; `opens` = the most recent
 *  OPENS_PER_PAGE opens of each page, newest first, each with the ms of every part that
 *  reported. One scan of the window serves both. */
export async function getClientLoadSpeed(): Promise<ClientLoadSpeed> {
  const client = await getTelemetryClient();
  const cutoff = new Date(Date.now() - CLIENT_METRICS_WINDOW_MS).toISOString();
  const res = await client.execute({
    sql: `SELECT id, ts, session, page, event, value, meta FROM client_metrics
          WHERE ts >= :cutoff ORDER BY id`,
    args: { cutoff },
  });

  const pages = new Map<
    string,
    { views: number; errors: number; visits: number[]; samples: Map<string, number[]> }
  >();
  // One entry per view, keyed by session + the view id metrics-client.ts stamped on every row
  // of that view. `seq` is the row id it was last seen at — the only reliable ordering, since
  // every row of one beacon shares a `ts`.
  const opens = new Map<string, PageOpen & { seq: number }>();
  const errors: ClientError[] = [];
  for (const row of res.rows) {
    const page = String(row.page ?? "");
    const event = String(row.event ?? "");
    const { pv, meta } = splitMeta(row.meta === null ? null : String(row.meta));
    if ((event === "js-error" || event === "server-error") && meta) {
      // server-error rows (instrumentation.ts) were written and surfaced NOWHERE — the
      // digest-decoding they exist for never reached /usage (audit 2026-08-19, T2.16).
      errors.push({ at: String(row.ts ?? ""), page, message: meta });
    }
    // Server rows carry raw request paths and no view id; letting them fall through minted
    // blank all-dashes page rows in the per-page table. They exist for the errors list only.
    if (event === "server-error") continue;
    const value = row.value === null ? null : Number(row.value);
    const finite = value !== null && Number.isFinite(value);

    const entry =
      pages.get(page) ??
      { views: 0, errors: 0, visits: [], samples: new Map<string, number[]>() };
    pages.set(page, entry);

    // ---- the open this row belongs to ----
    if (pv) {
      const key = `${String(row.session ?? "")}|${pv}`;
      const open = opens.get(key) ?? {
        // Filled in by the view's own `pageview` row; a group that never gets one is dropped
        // below, because without it nothing says which page was opened.
        page: "",
        at: String(row.ts ?? ""),
        kind: "nav" as const,
        from: null,
        errors: 0,
        parts: {} as Record<string, number>,
        seq: 0,
      };
      opens.set(key, open);
      open.seq = Number(row.id) || open.seq;
      if (event === "pageview") open.page = page;
      // The vitals are filed only against the view the DOCUMENT loaded, so their presence is
      // what distinguishes a real load from an in-app navigation.
      else if (event === "ttfb" || event === "fcp" || event === "lcp") open.kind = "load";
      // nav-ms rides in the arriving view's group but carries the page it was clicked ON.
      if (event === "nav-ms") open.from = page;
      if (event === "js-error") open.errors += 1;
      else if (finite) open.parts[event] = value;
    }

    // ---- the page's 7-day distribution ----
    if (event === "pageview") {
      entry.views += 1;
      continue;
    }
    // Counted, not sampled — and counted before the value check, because a js-error row
    // carries its message in `meta` and may have no numeric value at all.
    if (event === "js-error") {
      entry.errors += 1;
      continue;
    }
    if (!finite) continue;
    if (event === "visit-ms") entry.visits.push(value);
    else {
      const bucket = entry.samples.get(event) ?? [];
      bucket.push(value);
      entry.samples.set(event, bucket);
    }
  }

  // Newest first, then capped per page rather than globally: ten Home opens must not push
  // Playlists off the list entirely on a day spent on Home.
  const perPage = new Map<string, number>();
  const recent: PageOpen[] = [];
  for (const open of [...opens.values()].sort((a, b) => b.seq - a.seq)) {
    if (!open.page) continue;
    const n = perPage.get(open.page) ?? 0;
    if (n >= OPENS_PER_PAGE) continue;
    perPage.set(open.page, n + 1);
    recent.push({
      page: open.page,
      at: open.at,
      kind: open.kind,
      from: open.from,
      errors: open.errors,
      parts: open.parts,
    });
  }

  const summary = [...pages.entries()]
    .map(([page, e]) => {
      const stats: Record<string, MetricStat> = {};
      for (const event of SUMMARY_EVENTS) {
        const values = e.samples.get(event);
        if (!values?.length) continue;
        stats[event] = {
          n: values.length,
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
        };
      }
      return {
        page,
        views: e.views,
        errors: e.errors,
        avgVisitMs: e.visits.length
          ? e.visits.reduce((n, v) => n + v, 0) / e.visits.length
          : null,
        stats,
      };
    })
    .sort((a, b) => b.views - a.views || a.page.localeCompare(b.page));

  // Newest first, a handful — enough to read what broke without the page becoming a log
  // viewer. The full history stays queryable in the table.
  return { pages: summary, opens: recent, errors: errors.reverse().slice(0, 5) };
}

// ── Store bench (/api/cron/store-bench) ─────────────────────────────────────────────────
// Round trips from wherever this code runs, for docs/STORE_MIGRATION.md's R1 (a production
// function against each store). Serial on purpose: each sample is one round trip, not a share
// of a parallel burst. A failed probe counts as a failure and adds no sample.

export type BenchProbe = { n: number; p50: number; p95: number; max: number; failures: number };
export type BenchResult = { store: "core" | "telemetry"; host: string; probes: Record<string, BenchProbe> };

async function benchProbe(n: number, run: () => Promise<unknown>): Promise<BenchProbe> {
  const ms: number[] = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      await run();
      ms.push(Math.round((performance.now() - t0) * 10) / 10);
    } catch {
      failures++;
    }
  }
  return ms.length
    ? { n, p50: percentile(ms, 0.5), p95: percentile(ms, 0.95), max: Math.max(...ms), failures }
    : { n, p50: 0, p95: 0, max: 0, failures };
}

/** The store's host for the bench report: never the token, never a path on disk. */
function storeHost(u: string): string {
  return u.startsWith("file:") ? "file" : new URL(u).host;
}

async function benchStore(u: UserDb, store: "core" | "telemetry"): Promise<BenchResult> {
  if (store === "telemetry") {
    return {
      store,
      host: storeHost(separateTelemetry ? telemetryUrl! : url),
      probes: {
        // Each under the telemetry fetch's own 4 s single attempt.
        select1: await benchProbe(10, async () => (await getTelemetryClient()).execute("SELECT 1")),
      },
    };
  }
  return {
    store,
    host: storeHost(url),
    probes: {
      select1: await benchProbe(30, async () => (await u.client()).execute("SELECT 1")),
      metaRead: await benchProbe(10, () => getMeta(u, WRITE_SEQ_KEY)),
      // Null version = read fresh, never from the data cache.
      historyIndex: await benchProbe(2, () => getHistoryIndex(u, null)),
    },
  };
}

// ── forUser: the only way to a user's data (multi-user PLAN §6.2 layer 3) ──────────────────
// Every per-user function above takes the user's database as its first argument and none is
// exported: a caller gets them from forUser(uid), bound to that user's database, so a call
// that forgets the user does not compile, and nothing at module level can run against "the"
// database (static check S3 holds the module's exports to the list in
// tests/isolation/static.test.ts). Which database a uid has is its `users` row's db_name
// (PLAN §4.2), never a constant: the identity read every request makes, and the claim, call
// forUserAt with the db_name they read, and forUser(uid) resolves to the last name named in
// this process. A name that changed (a restore moved the user) is rebuilt before use: the old
// client and the old open verdict are dropped, so the next statement opens the new database
// and checks its owner. A uid nothing has named in this process throws.
const USER_FNS = {
  acquireLock,
  benchStore,
  checkPlayedAtConvention,
  clearSpotifyTokens,
  deletePlaylistFromDb,
  findTrackWithPlaylists,
  getAllTimePlays,
  getAllTimeStats,
  getHealthMarks,
  getCleanBackupPref,
  getContextName,
  getContextsFullCheckAt,
  getDailyStats,
  getHistoryIndex,
  getHistoryIndexVersion,
  getHomePayload,
  getLastSync,
  getLibraryIndex,
  getLibraryIndexVersion,
  getLibrarySyncedAt,
  getLibraryTracks,
  getLikedSignals,
  getMeId,
  getPlaylistSnapshot,
  getPlaylistSnapshots,
  getPlaylistsSyncedAt,
  getPlaylistTrackOrder,
  getPlaylistTracks,
  getPlaysByDay,
  getSavedSyncedAt,
  getSpotifyTokens,
  getStoredPlaylist,
  getStoredPlaylists,
  getUniqueSongCount,
  getUserTz,
  getUserTzOffset,
  hasHomePayload,
  hasPlaysBeforeDay,
  ledgerSyncCall,
  maybeRecomputeAllTimeStats,
  playedTracksInContext,
  readProbe,
  readSavedRows,
  rebuildHomePayload,
  recomputeAllTimeStats,
  recomputeUniqueSongCount,
  recordContexts,
  recordPlays,
  releaseLock,
  removeCachedPlaylistTrack,
  searchHistory,
  setContextsFullCheckAt,
  setHealthMark,
  setLibrarySyncedAt,
  setSpotifyTokens,
  setUserTz,
  setUserTzOffset,
  storePlaylists,
  storePlaylistTracks,
  storeSavedDiff,
  storeSavedTracks,
  unresolvedContextUris,
  unseenContexts,
  upsertStoredPlaylist,
  writeProbe,
};

type Bound<F> = F extends (u: UserDb, ...args: infer A) => infer R ? (...args: A) => R : never;
export type UserStore = {
  readonly uid: Uid;
  readonly dbName: string;
  /** The database's `store_epoch` (PLAN §4.5): part of every cache key and search ETag. */
  storeEpoch(): Promise<string>;
} & { readonly [K in keyof typeof USER_FNS]: Bound<(typeof USER_FNS)[K]> };

/** A user's data, bound to the database their `users` row names, as this request's identity
 *  read (or the claim) read it. Throws for a uid nothing has named in this process. */
export function forUser(uid: Uid): UserStore {
  const dbName = userDbNames().get(uid);
  if (!dbName) throw new Error(`no database is named for user ${uid}: the identity read or the claim names it`);
  return forUserAt(uid, dbName);
}

/** The same, at a named database: what the identity read and the claim call with the user's
 *  db_name, and what the tests use for their per-user files. It records the name for forUser,
 *  rebuilding the entry when the name changed. The open's owner check is what stands between a
 *  wrong name and someone else's data. */
export function forUserAt(uid: Uid, dbName: string): UserStore {
  const names = userDbNames();
  const was = names.get(uid);
  if (was !== dbName) {
    if (was !== undefined) {
      openedDbs().delete(openKey(uid, was));
      userClients().delete(was);
    }
    names.set(uid, dbName);
  }
  const u = userDb(uid, dbName);
  const store: Record<string, unknown> = { uid, dbName, storeEpoch: () => u.epoch() };
  for (const [name, fn] of Object.entries(USER_FNS)) {
    store[name] = (...args: unknown[]) => (fn as (u: UserDb, ...a: unknown[]) => unknown)(u, ...args);
  }
  return Object.freeze(store) as unknown as UserStore;
}
