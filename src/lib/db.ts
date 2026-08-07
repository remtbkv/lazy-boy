// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL (Turso) so it persists on Vercel's serverless
// runtime; falls back to a local SQLite file in dev when TURSO_DATABASE_URL is unset.
import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import type { Track } from "@/lib/spotify/types";
import { CLEANED_PREFIX, BACKUP_PREFIX } from "@/lib/clean/names";
import {
  tracksNeedingWrite,
  playKey,
  newPlays,
  diffPositions,
  diffKeyed,
  type TrackFields,
} from "@/lib/store-diff";

// ── Query conventions (a remote primary + a local replica — round trips and plan choice
// both matter) ──
// All figures below: medians (min–max), n=15×2 interleaved runs primary / n=9 local,
// 2026-08-01, scripts/bench-reads.mjs. Follow these when adding queries:
//  • Anything that SCANS rows reads from getReader() (the replica). Primary-side scans are
//    seconds-scale AND unstable session to session: the full plays scan (~6,660 rows)
//    measured ~105ms one morning and 1,369-2,243ms (216-7,854ms) that afternoon, same query,
//    same data. The replica does it in ~10ms, stably.
//  • Song-identity equality lookups — `WHERE lower(t.artist) = ?` (optionally `AND
//    lower(t.name) = ?`) — keep an INNER JOIN so the planner uses idx_tracks_artist_name:
//    INNER 22-24ms vs LEFT 82-510ms (max 3,475ms) on the primary, 0.045ms vs 5.6ms local.
//    Reproduced in both replicates; this one is a real rule.
//  • LEFT vs INNER on the plays-driven joins is measured INDISTINGUISHABLE, rows identical:
//    dailyStats window 66/104ms LEFT vs 68/47ms INNER; history search 71/57 vs 70/56.
//    LEFT stays the default style here — but it is no longer a performance rule.
//  • Window functions are fine on the replica (LEAD over the full plays scan is ~1.5× a plain
//    fetch: 15.0 vs 10.4ms). The rule that actually holds: NO full-table scan against the
//    PRIMARY on any render path.
//  • Cache whole-table aggregates in `meta` and recompute on write, not on read
//    (`unique_song_count`, `alltime_stats`; per-day stats fetch only their window). The
//    justification is the replica-less path — on a cold instance a live recompute costs
//    0.2-3.4s against the primary vs a ~20ms meta read. Every cached derived value must be
//    covered by scripts/verify-derived.mjs.
//  • Writes, and ALL meta coordination keys (tokens, locks), use getClient() (the primary);
//    a new write must end with `await syncReader()`, and — if it changed a table getReader()
//    serves — must BUMP THE WRITE MARKER in the same batch (writeSeqStmt(); see the marker
//    note below, which owns the bump-or-not rule). Serial primary reads stack linearly —
//    ~20ms each (a single-key meta read costs the same as `SELECT 1`), 3 serial meta reads
//    65-72ms vs 23-26ms for the same 3 via Promise.all — so dedupe or parallelize them.
//  • NEVER encode a single-session primary timing as a rule. State median (min–max), n and
//    date, and re-measure before trusting it. This file's own history is the cautionary
//    tale: three of the rules it used to state did not reproduce.

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

// Local-file fallback for dev; production points at Turso via env.
const FILE_URL = `file:${path.join(process.cwd(), "data", "listens.db")}`;
const url = process.env.TURSO_DATABASE_URL || FILE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

// One client + one-time schema init per server process, shared via a promise so
// concurrent callers don't race the CREATE TABLEs.
const g = globalThis as unknown as { __listenDbReady?: Promise<Client> };

function getClient(): Promise<Client> {
  if (g.__listenDbReady) return g.__listenDbReady;
  const ready = init();
  g.__listenDbReady = ready;
  // If init fails (a transient Turso/network blip on first use), drop the cached
  // rejection so the next call retries — otherwise every DB call in this process
  // fails forever until a restart.
  ready.catch(() => {
    if (g.__listenDbReady === ready) g.__listenDbReady = undefined;
  });
  return ready;
}

async function init(): Promise<Client> {
  if (url.startsWith("file:")) {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  }
  const client = createClient({ url, authToken, intMode: "number" });
  await client.executeMultiple(`
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
    -- far worse against the remote primary, where scans are seconds-scale.
    CREATE INDEX IF NOT EXISTS idx_pltracks_track ON playlist_tracks (track_id);
    CREATE TABLE IF NOT EXISTS saved_tracks (
      track_id TEXT PRIMARY KEY,
      added_at TEXT,
      position INTEGER
    );
    CREATE TABLE IF NOT EXISTS api_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      retry_after INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_log (ts);
  `);
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
  // Every orphan recompute, and playedTracksInContext (Resume), select plays BY context_uri;
  // without this they scan the whole plays table.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_context ON plays (context_uri)",
  );
  // recomputeOrphanFlags({newOnly}) filters on `ctx_orphan IS NULL`. Without this partial
  // index that is a full plays scan on every sync tick that lands a play — ~7.2K billed
  // rows against a replica-less primary to find the handful of new rows. The index holds
  // only the unverdicted rows (normally ≈0), so the same UPDATE scans just those.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_orphan_null ON plays (id) WHERE ctx_orphan IS NULL",
  );
  return client;
}

// ── Read replica ────────────────────────────────────────────────────────────────────────
// Turso's remote instance is slow at anything that SCANS rows, and it is not the network:
// the round trip to the primary is ~47ms (median, n=8; 20-29ms in later sessions — the bare
// round trip itself drifts 20-47ms across sessions), but `SELECT COUNT(*) FROM tracks`
// (15k rows, nothing returned) is ~312ms there and ~0.02ms against the same data in local
// SQLite. The cost is per row scanned, so every scanning read paid for the whole table.
//
// NUMBERS HERE ARE MEDIANS OVER REPEATED RUNS, and they have to be: this primary's timings
// swing wildly (`SELECT 1` alone measured 37–440ms within one run, and the same history
// search measured 2.9s early in a session and 344ms later, unchanged). A single-shot timing
// against it is not a measurement. Re-measure with repetition before trusting any figure in
// this file, including these.
//
// So scanning reads run against a libSQL EMBEDDED REPLICA: a local SQLite copy of the same
// database that the client keeps current by pulling frames from the primary. Same SQL, same
// rows (medians, n=5): history search 344ms → 5.7ms, all-time list 705ms → 8.9ms, one day's
// plays 41ms → 0.9ms, the day-strip mount scan 105ms → 13ms.
//
// Writes deliberately do NOT go through it. A write via a replica forwards to the primary
// and then pulls back, which is ~5× slower than writing to the primary directly, and the
// token/lock rows in `meta` must never be read from a copy that another instance's refresh
// hasn't reached yet (that's the invalid_grant race the token code exists to avoid). So:
// getClient() = the primary, for every write plus all of meta; getReader() = the replica,
// for the row-scanning reads.
//
// The replica is never on the critical path: getReader() hands back the primary until the
// first sync has landed, so a cold serverless instance is exactly as fast as it is today and
// gets fast the moment the copy is there. If the replica can't be built at all, everything
// silently keeps using the primary.
const REPLICA_ENABLED =
  !!process.env.TURSO_DATABASE_URL && process.env.LAZYBOY_NO_REPLICA !== "1";
// Vercel's only writable directory is /tmp (per warm instance). Locally it sits beside the
// dev DB so it survives dev-server restarts and re-syncs incrementally, not from scratch.
const REPLICA_PATH = process.env.VERCEL
  ? "/tmp/lazyboy-replica.db"
  : path.join(process.cwd(), "data", "replica.db");
// There is deliberately NO syncInterval. A background poll every 30s was 2,880 pulls/day per
// instance whether or not anything had been written, and it still left a 30s window where
// another process's write was invisible. The freshness gate in getReader() replaces both
// halves: it pulls only when the marker says there is something to pull, and never serves a
// copy that is behind. Our own writes stay synchronous via syncReader().

// A BUILD-TIME SEED DOES NOT WORK — measured 2026-08-01, don't rebuild it. The idea: ship a
// synced replica snapshot in the deployment and copy it to REPLICA_PATH so a cold instance
// resumes incrementally instead of pulling ~18MB. Mechanically it works, and when the snapshot
// is minutes old it is a big win (medians, interleaved n=4: 934ms seeded vs 5,944ms full).
// It collapses because THIS PRIMARY ROTATES ITS REPLICATION GENERATION on a schedule we don't
// control, at a VARIABLE cadence — 2026-08-01, one sample/min: 4470 → 4471 → 4472 → 4473 in 25
// minutes (~7min apart) in the morning, then a single generation held for 32+ minutes later
// the same day. So "every N minutes" is not a property to lean on; what holds is that a
// rotation lands somewhere inside a normal deploy's lifetime. A snapshot from an older
// generation doesn't resume — it costs MORE than starting empty:
//   same generation, <1min old   934ms   (785-1,000, n=4)   vs full 5,944ms (5,469-7,465)
//   1 generation behind        6,114ms   (6,077-6,115, n=3) vs full 2,150ms (1,978-6,578)
//   2 generations behind      13,700ms   (13,383-15,644, n=3) vs full 4,845ms (4,317-5,008)
// A deploy-time snapshot is stale-generation from the first rotation onward — unpredictable
// when, certain to happen inside the deploy's lifetime — i.e. for every cold start except the
// ones shortly after a deploy, so the bundled seed makes the normal case 2-3× SLOWER.
// There is no cheap way to check the primary's current generation before opening the replica,
// so it can't be gated either. (For the record, the minimal resumable file set is
// `.db` + `-info` + `-wal`: `.db` alone makes createClient throw InvalidLocalState, and
// `.db` + `-info` without the WAL silently drops the rows still in it — 6,667 of 6,670 plays.)
const REPLICA_SIDECARS = ["-info", "-wal", "-shm"];

const gr = globalThis as unknown as {
  __listenReader?: Client;
  __listenReplicaBoot?: Promise<void>;
  __listenReplicaSyncing?: boolean;
};

function removeReplicaFiles(): void {
  for (const suffix of ["", ...REPLICA_SIDECARS]) {
    fs.rmSync(REPLICA_PATH + suffix, { force: true });
  }
}

/** Open the replica at REPLICA_PATH, sync it, and prove it can answer a query. Throws (after
 *  closing the client) if any of that fails, so the caller can wipe and retry. */
async function openReplica(): Promise<Client> {
  // createClient itself throws on an inconsistent local state, so it belongs inside the try.
  let replica: Client | undefined;
  try {
    replica = createClient({
      url: `file:${REPLICA_PATH}`,
      syncUrl: process.env.TURSO_DATABASE_URL,
      authToken,
      intMode: "number",
      // No syncInterval on purpose — see the note where it used to live. Every pull is
      // deliberate: this boot sync, syncReader() after our own writes, and the gate's
      // catch-up pull when the marker says another process wrote.
    });
    await replica.sync();
    // sync() SUCCEEDS against a corrupt local file — measured: a truncated replica synced in
    // 461ms and only failed on the FIRST QUERY (SQLITE_CORRUPT). Without a read here, an
    // instance that inherited a damaged file (a sync killed mid-write, a half-written /tmp)
    // would hand that client to every scanning read for the life of the instance. Two indexed
    // counts, 0.3ms together, catch it. `PRAGMA quick_check` catches more but costs 57ms and
    // scales with the DB, so it stays off the boot path.
    await replica.execute("SELECT count(*) AS n FROM plays");
    await replica.execute("SELECT count(*) AS n FROM tracks");
    return replica;
  } catch (err) {
    replica?.close();
    throw err;
  }
}

function bootReplica(): void {
  if (gr.__listenReplicaBoot) return;
  gr.__listenReplicaBoot = (async () => {
    // The primary owns the schema; make sure init() has run before copying it down.
    await getClient();
    fs.mkdirSync(path.dirname(REPLICA_PATH), { recursive: true });
    // A file already there is one this process didn't write: the dev copy from an earlier run,
    // or a warm Vercel instance's /tmp. It's the only thing that can be damaged, so it's the
    // only case worth retrying — throw it away and build from scratch, once.
    const inherited = fs.existsSync(REPLICA_PATH);
    try {
      gr.__listenReader = await openReplica();
    } catch (err) {
      if (!inherited) throw err;
      removeReplicaFiles();
      gr.__listenReader = await openReplica();
    }
  })().catch(() => {
    // A replica is an optimisation, never a requirement — drop the cached failure so a
    // later call retries, and keep serving from the primary in the meantime.
    gr.__listenReplicaBoot = undefined;
  });
}

// There is deliberately NO eager instance-start warm (src/instrumentation.ts used to call
// one). Every cold instance pulled the full ~17MB replica whether or not it would ever scan —
// and the cron tick every ~2 min means most instances exist only to write and exit. Against
// Turso's free-plan 3GB/mo syncs quota that was ~12-17 bootstraps/day of pure waste (77% of
// the August quota burned in 3 days, 2026-08-03). The replica now boots lazily from
// getReader() on the first scanning read; until it lands those reads use the primary, which
// was always the designed fallback.

// ── The write marker (`meta.write_seq`) ─────────────────────────────────────────────────
// A counter the primary bumps on every write THE REPLICA SERVES. It exists so a read can
// tell, cheaply, whether the local copy is complete: the gate below compares the primary's
// value with the replica's own copy of the same row. Equal → the copy holds every committed
// write and can be trusted. Different → it is behind, and this request reads the primary.
// (libSQL gives nothing usable for this: sync() reports frames_synced: 1 whether or not it
// pulled anything, and PRAGMAs on a replica handle forward to the primary and error.)
//
// WHICH WRITES BUMP IT — the rule, in one place:
//   BUMP when the write changes a table getReader() hands out: plays (including ctx_orphan),
//   tracks, contexts, playlists, playlist_tracks, saved_tracks.
//   DO NOT BUMP for a write that only touches `meta` or `api_log`. Nothing reads either from
//   the replica — every meta read goes through getMeta() → getClient(), which is the
//   token/lock rule at the top of this section, and getApiLogSummary() reads the primary too.
//   That covers tokens, locks, the cooldown, the *_synced_at stamps, and the derived caches
//   (`alltime_stats`, `unique_song_count`). api_log matters most: it is written on essentially
//   every outgoing Spotify call (~6s apart while the app is open), so bumping on it would put
//   the gate permanently in the "behind" state and route everything to the primary — the exact
//   thing this replaces.
// An unnecessary bump is not a correctness bug, it just costs other instances a primary-routed
// request plus a catch-up pull. A MISSING bump is a correctness bug: it serves stale rows.
//
// The bump must be ATOMIC WITH (same batch as) or AFTER the data it announces, never before.
// Announcing late is safe — a reader that syncs in the gap simply gets the rows early and
// re-checks next request. Announcing early is not: a reader could mark itself fresh against a
// copy that doesn't have the write yet.
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
async function bumpWriteSeq(): Promise<void> {
  const client = await getClient();
  await client.execute(writeSeqStmt());
}

// ── The library marker (`meta.library_seq`) ─────────────────────────────────────────────
// A second counter, bumped by the writes that change WHICH TRACKS ARE IN THE LIBRARY —
// playlists, playlist_tracks, saved_tracks — and by nothing else. It versions the library
// search payload ("The client-side search payloads" below), which is the largest body this app
// serves and must therefore survive a listening session in the browser cache. write_seq cannot
// do that job: it bumps on every play, so the payload would be re-downloaded whole after every
// listen. It rides ALONGSIDE write_seq (never instead of it) — the replica gate still needs
// the write announced.
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
 *  bump. Cheap on both sides: an indexed single-key lookup — ~20-30ms on the primary (a
 *  round trip; the same cost as `SELECT 1`), ~0.01ms on the replica's local file. */
async function readWriteSeq(client: Client): Promise<string | null> {
  const res = await client.execute({
    sql: "SELECT value FROM meta WHERE key = ?",
    args: [WRITE_SEQ_KEY],
  });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

// The primary's marker, read ONCE per request and shared: the freshness gate below and every
// cached read (see "Read caching") both key off it, and three serial single-key primary reads
// cost 65-72ms against 23-26ms for one (the round-trip note at the top of the file). Same
// per-request box as readerBox/tokenBox; outside a request it's a plain read.
const seqBox = cache(() => ({ p: null as Promise<string | null> | null }));
function primaryWriteSeq(): Promise<string | null> {
  const box = seqBox();
  box.p ??= getClient().then(readWriteSeq);
  return box.p;
}

// One freshness verdict per REQUEST, not per query: a page runs several scanning reads and
// they must not each pay a primary round trip. Same shape as playsWithListened below and the
// token box in auth.ts — React cache() gives a per-request box; outside a request (the cron
// path) cache() has no dispatcher and is a pass-through, so each call re-checks instead,
// which is correct, just not deduped.
const readerBox = cache(() => ({ p: null as Promise<Client> | null }));

/** Decide, once per request, whether the replica may answer: it may exactly when it has
 *  every write the primary has committed. When it doesn't, this request reads the PRIMARY —
 *  slower for scans, but never stale — and the copy is pulled up in the background so the
 *  next request is local again. */
async function chooseReader(replica: Client): Promise<Client> {
  const primary = await getClient();
  let primarySeq: string | null;
  try {
    primarySeq = await primaryWriteSeq();
  } catch {
    // The marker read is the ONE thing standing between a read and its data, so it must not
    // be able to take reads down. If the primary is unreachable, serve the local copy and say
    // nothing: during a primary outage the replica is the only thing that can answer at all,
    // and the staleness is bounded by the outage. Availability wins here, freshness elsewhere.
    return replica;
  }
  try {
    if ((await readWriteSeq(replica)) === primarySeq) return replica;
  } catch {
    // A copy that can't answer a single-key lookup is not a copy worth reading from.
    return primary;
  }
  backgroundSync(replica);
  return primary;
}

/** Client for reads that scan rows: the local replica when the gate says it is current, the
 *  primary otherwise (not yet built, behind, or broken). Never blocks on a sync. Not for
 *  `meta` — see the note above. */
function getReader(): Promise<Client> {
  if (!REPLICA_ENABLED) return getClient();
  const replica = gr.__listenReader;
  if (!replica) {
    bootReplica();
    return getClient();
  }
  const box = readerBox();
  box.p ??= chooseReader(replica);
  return box.p;
}

/** Catch the copy up without making this request wait for it — the request it belongs to is
 *  already being served from the primary. Fire-and-forget, one at a time: concurrent requests
 *  all see the same stale marker, and N parallel pulls of the same frames is pure egress. */
function backgroundSync(replica: Client): void {
  if (gr.__listenReplicaSyncing) return;
  gr.__listenReplicaSyncing = true;
  void replica
    .sync()
    .catch(() => {
      /* the next request's gate sees the marker still behind and retries the pull */
    })
    .finally(() => {
      gr.__listenReplicaSyncing = false;
    });
}

/** Pull the replica up to date. Called at the end of every write so the read that follows
 *  sees what was just written — the gate would route that read to the primary otherwise, and
 *  read-after-own-write shouldn't have to pay for a scan against it. */
async function syncReader(): Promise<void> {
  // Every caller of this just bumped the marker, so this request's shared copy of it is now
  // one behind — and the cached reads below key off that copy, so leaving it in place would
  // serve the PRE-write entry to the read that follows the write (exactly what
  // refreshHistoryAction does: sync, then re-read the day). Dropped before the replica check
  // on purpose: with LAZYBOY_NO_REPLICA=1 there is no replica and the rest of this is a no-op,
  // but the cache keys still have to move.
  seqBox().p = null;
  const r = gr.__listenReader;
  if (!r) return;
  try {
    await r.sync();
    // The copy is current as of this pull, so a "behind" verdict this request formed earlier
    // — the cron writes every ~2 min, so a request can easily start behind — is now wrong in
    // the slow direction: it would keep the rest of the request on the primary, including
    // recomputeUniqueSongCount's multi-second DISTINCT scan. Drop it and let the next read
    // re-gate (one marker round trip). Same shape as publishTokens() in auth.ts: a write
    // republishes what it just made true instead of leaving the request's snapshot stale.
    readerBox().p = null;
  } catch {
    /* the next read's gate catches the copy up; a failed sync must not fail its write */
  }
}

// libSQL Row objects aren't plain objects (they carry a prototype + indexed access), so
// React warns when a Server Component passes them straight to a Client Component. Spread
// each into a plain object so query results cross the RSC boundary cleanly.
function plainRows(rows: readonly unknown[]): unknown[] {
  return rows.map((r) => ({ ...(r as object) }));
}

// Cached track rows for a set of ids, chunked to stay under SQLite's bound-variable cap.
async function readCachedTracks(client: Client, ids: string[]): Promise<Map<string, TrackFields>> {
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
// actually changed — Turso counts every ON CONFLICT UPDATE as a billed row write, even
// when the values are identical).
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
export async function recordPlays(plays: PlayRecord[]): Promise<number> {
  if (plays.length === 0) return 0;
  const client = await getClient();
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
  const existing = new Set(
    (plainRows(existingRes.rows) as unknown as { trackId: string; playedAt: string }[]).map(
      playKey,
    ),
  );

  const stmts: InStatement[] = tracksNeedingWrite(tracks, cached).map(trackUpsertStmt);
  const insertResultIdx: number[] = [];
  for (const r of newPlays(plays, existing)) {
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
  // last_sync stamp below — a meta key, never read from the replica — and the sync runs every
  // couple of minutes, so bumping unconditionally would leave every other instance gate-failed
  // around the clock.
  const changed = stmts.length > 0;
  if (changed) stmts.push(writeSeqStmt());
  // Stamp last_sync atomically with the plays.
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES ('last_sync', :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { v: new Date().toISOString() },
  });
  const results = await client.batch(stmts, "write");
  // A no-change tick (the steady-state cron every couple of minutes) wrote only last_sync —
  // nothing the reader serves — so skip the orphan recompute (~0.2s primary UPDATE over zero
  // rows) and the replica pull (~0.13s no-op sync) it would otherwise pay each tick.
  if (insertResultIdx.length > 0) {
    // Give the plays we just inserted their membership verdict before anything reads them.
    await recomputeOrphanFlags({ newOnly: true });
  }
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  if (changed) await syncReader();
  let added = 0;
  for (const i of insertResultIdx) added += Number(results[i].rowsAffected);
  // New plays landed → refresh the cached all-time totals so Home reads them instantly
  // (instead of running the expensive gap scan on render). Only on a real change, and at
  // most every 10 min: the recompute is a full plays scan (~14K billed rows replica-less),
  // and during a listening session plays land on many consecutive ticks. The card can lag
  // the newest plays by ≤10 min mid-session; the end-of-session tail is healed by the
  // daily cron's unconditional recompute (cron/sync route).
  if (added > 0) await maybeRecomputeAllTimeStats();
  return added;
}

const ALLTIME_RECOMPUTE_MIN_MS = 10 * 60 * 1000;

async function maybeRecomputeAllTimeStats(): Promise<void> {
  const v = await getMeta("alltime_at");
  if (v && Date.now() - (Number(v) || 0) < ALLTIME_RECOMPUTE_MIN_MS) return;
  await recomputeAllTimeStats();
}

/** Cache resolved context (playlist/album/artist) names so "From" shows a name. */
export async function recordContexts(contexts: ContextRecord[]): Promise<void> {
  if (contexts.length === 0) return;
  const client = await getClient();
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
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
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
export async function unseenContexts(
  cands: { uri: string; type: string }[],
): Promise<{ uri: string; type: string }[]> {
  if (cands.length === 0) return [];
  const client = await getReader();
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
 *  A full plays scan (~14K billed rows replica-less) — the once-a-day pass only.
 *  Per-sync resolution goes through unseenContexts() above. */
export async function unresolvedContextUris(): Promise<{ uri: string; type: string }[]> {
  const client = await getReader();
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
// all-time list on the replica (medians, n=5: 63ms → 8.9ms; history search 36ms → 5.7ms).
// Against the remote primary the same change is marginal (903ms → 705ms) and for one day's
// plays it is nothing (41ms either way) — that backend's variance swamps it.
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
// lives; sourceExpr reads what this writes. Kept identical to the expression it replaced so
// the stored flag and a live evaluation can be diffed against each other.
const ORPHAN_PREDICATE = `
  CASE WHEN p.context_type = 'playlist' AND p.context_uri IS NOT NULL
            AND EXISTS (SELECT 1 FROM playlist_tracks pl
                        WHERE pl.playlist_id = replace(p.context_uri, 'spotify:playlist:', ''))
            AND NOT EXISTS (
              SELECT 1 FROM playlist_tracks plm JOIN tracks tm ON tm.id = plm.track_id
              WHERE plm.playlist_id = replace(p.context_uri, 'spotify:playlist:', '')
                AND lower(tm.artist) = (SELECT lower(artist) FROM tracks WHERE id = p.track_id)
                AND lower(tm.name) = (SELECT lower(name) FROM tracks WHERE id = p.track_id))
       THEN 1 ELSE 0 END`;

/** Refresh the stored `ctx_orphan` verdict, and return how many rows changed.
 *
 *  Three scopes, matching the three ways the verdict can go stale — each does the least work
 *  that is still correct:
 *    `{ newOnly }`    plays we just recorded have no verdict yet; nobody else's changed.
 *    `{ playlistId }` that playlist's membership changed (tracks added/removed, cache
 *                     populated, playlist deleted), so only plays FROM it can flip.
 *    `{}`             full pass — the one-time backfill, and after a change that can touch
 *                     many playlists at once (the library list being rewritten).
 *
 *  Only rows whose verdict actually flips are written, so a steady-state sync that re-stores
 *  an unchanged playlist writes zero rows — Turso bills every row write, including a
 *  no-op UPDATE. Measured on the live DB: 0 rows and ~0.2-0.4s for the two scoped modes.
 *
 *  Writes to the primary only; the caller is responsible for the syncReader() that follows
 *  (all four call sites already make one for their own write, so there is no second pull). */
async function recomputeOrphanFlags(
  opts: { playlistId?: string; newOnly?: boolean } = {},
): Promise<number> {
  const client = await getClient();
  // newOnly deliberately does NOT evaluate the predicate in the WHERE clause: the point is to
  // avoid running it over every historical play just to learn nothing changed.
  const where = opts.newOnly
    ? "p.ctx_orphan IS NULL"
    : `(p.ctx_orphan IS NULL OR p.ctx_orphan <> (${ORPHAN_PREDICATE}))${
        opts.playlistId ? " AND p.context_uri = :uri" : ""
      }`;
  const res = await client.execute({
    sql: `UPDATE plays AS p SET ctx_orphan = (${ORPHAN_PREDICATE}) WHERE ${where}`,
    args: opts.playlistId && !opts.newOnly ? { uri: `spotify:playlist:${opts.playlistId}` } : {},
  });
  const changed = Number(res.rowsAffected);
  // `plays` is replica-served and this ran AFTER its caller's batch already bumped, so the
  // flags need their own announcement or a copy synced in between serves rows whose verdict
  // is stale. Only when rows actually flipped: the common case is 0, and a bump there would
  // re-route every other instance on every sync tick for nothing. The extra round trip is
  // paid only on a real change, and this is a background write path either way.
  if (changed > 0) await bumpWriteSeq();
  return changed;
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
       WHERE p2.track_id = t.id ORDER BY p2.played_at DESC LIMIT 1) AS source
  FROM plays p LEFT JOIN tracks t ON t.id = p.track_id`;

// Estimated time *actually* listened per play: the gap until the next play, capped at the
// song's length. A skipped/partial play counts only the seconds it ran; a fully-played one
// counts ~its length; stopping then resuming hours later is capped at the song length (not
// the idle gap). A play that ran under LISTEN_MIN_MS is a skip, not a listen, and counts
// zero (so flicking through tracks never inflates listened time). 10-min fallback when a
// track's duration is unknown.
//
// Computed in JS, not SQL, as a style choice plus one hard constraint. The equivalent
// `LEAD() OVER (ORDER BY played_at)` is NOT pathological — on the replica it is ~1.5× a plain
// ordered fetch (15.0 vs 10.4ms median, n=9, 2026-08-01); an earlier "~3s" figure here was a
// single-shot primary timing and did not reproduce. What matters is that this read is a full
// plays scan, so it must stay on the replica: the same scan against the PRIMARY is
// seconds-scale and unpredictable (1.4-2.2s median, up to 7.9s, n=15×2).
const LISTEN_FALLBACK_MS = 600000;
// A play whose actual run time (gap to the next play) is under this counts as a skip, not a
// listen, and adds 0 to listened-time totals. Plays are still counted as plays.
const LISTEN_MIN_MS = 5000;
type ListenRow = { playedAt: string; trackId: string; listenedMs: number };

// Wrapped in React cache(): getDailyStats and getAllTimeStats both need this, and they run
// together (Home's history boundary, the history refresh action) — cache() dedupes the
// fetch to once per request instead of paying the plays scan twice.
const playsWithListened = cache(async (): Promise<ListenRow[]> => {
  const client = await getReader();
  const res = await client.execute(
    `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs
     FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
     ORDER BY p.played_at ASC`,
  );
  const rows = plainRows(res.rows) as unknown as {
    playedAt: string;
    trackId: string;
    durationMs: number | null;
  }[];
  return rows.map((r, i) => {
    const dur = r.durationMs ?? LISTEN_FALLBACK_MS;
    const next = rows[i + 1];
    const gap = next ? Date.parse(next.playedAt) - Date.parse(r.playedAt) : null;
    const ran = gap != null && gap >= 0 ? Math.min(dur, gap) : dur;
    return {
      playedAt: r.playedAt,
      trackId: r.trackId,
      listenedMs: ran < LISTEN_MIN_MS ? 0 : ran,
    };
  });
});

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
export async function searchHistory(query: string, limit = 300): Promise<TrackStats[]> {
  const client = await getReader();
  const q = query.trim();
  if (!q) {
    const res = await client.execute({
      sql: `${SELECT_PLAY} ORDER BY p.played_at DESC LIMIT ?`,
      args: [limit],
    });
    return plainRows(res.rows) as unknown as TrackStats[];
  }
  const like = `%${q}%`;
  const res = await client.execute({
    sql: `${SELECT_PLAY} WHERE t.name LIKE ? OR t.artist LIKE ?
          ORDER BY p.played_at DESC LIMIT ?`,
    args: [like, like, limit],
  });
  return plainRows(res.rows) as unknown as TrackStats[];
}

// ── Read caching (Next's data cache, keyed on the write marker) ─────────────────────────────
// The render-path reads below answer the same question over and over — the day strip, one
// day's plays, the playlist grid — against a store that only ever grows at "now". With the
// replica off (LAZYBOY_NO_REPLICA=1, the note above) every one of them is a scan against the
// primary, and Turso bills rows SCANNED, not returned, so a second visit to the same day
// re-read the whole plays table to produce a byte-identical answer. Medians (min-max), n=7,
// 2026-08-05, 6,995 plays, straight at the primary (`bench-reads.mjs day` re-runs the first two):
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
//   • FROZEN — a day at or older than today-2 in the USER'S zone. Its plays can no longer
//     change:
//     plays only arrive at "now", and the furthest back a resumed sync can reach is Spotify's
//     last-50-plays window. Two days of slack because that window is the bound, not the clock.
//     Keyed on (day, offset) only, so every later visit — any tab, any instance, any day —
//     is a cache hit and costs ZERO DB reads.
//   • LIVE — today, yesterday, the strip, the all-time list, the playlist grid. Keyed on
//     `meta.write_seq` (the same marker the replica gate uses), so ANY write that changes what
//     they read produces a different cache key and the next read recomputes. That is what
//     keeps TODAY honest on the existing ~2-min cadence: recordPlays bumps the marker exactly
//     when new plays land, and syncReader() drops this request's copy of it, so the re-read
//     that follows a sync cannot be served a pre-sync entry. The TTL on these entries is a
//     garbage bound on superseded keys, NOT the freshness mechanism — the key is.
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
async function liveKey(): Promise<string | null> {
  try {
    return (await primaryWriteSeq()) ?? "0";
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
const allTimePlaysCached = unstable_cache(
  (limit: number, _seq: string) => readAllTimePlays(limit),
  ["all-time-plays"],
  { revalidate: LIVE_TTL_S },
);
export async function getAllTimePlays(limit: number): Promise<TrackStats[]> {
  // Slow marker, not the live one: this read costs ~25K billed rows per rebuild (full
  // scan + a per-track source subquery), and per-play freshness on the all-time ranking
  // is not worth ~2M/hour of listening (see the slow-marker note).
  const seq = await slowSeq();
  return seq === null ? readAllTimePlays(limit) : allTimePlaysCached(limit, seq);
}

async function readAllTimePlays(limit: number): Promise<TrackStats[]> {
  const client = await getReader();
  const res = await client.execute({
    sql: `${SELECT_TRACK} GROUP BY t.id
          ORDER BY plays DESC, lastPlayed DESC, t.name ASC LIMIT ?`,
    args: [limit],
  });
  return plainRows(res.rows) as unknown as TrackStats[];
}

/** All-time totals across every recorded play (for the history "All time" card). */
export async function getAllTimeStats(): Promise<{
  plays: number;
  uniqueTracks: number;
  durationMs: number;
  since: string | null; // earliest recorded play (ISO), null if none
}> {
  // Read the cached value: the all-time listened total needs a gap scan over EVERY play,
  // which is multi-second on Turso and shouldn't run on render. It's refreshed on write
  // (recordPlays, when new plays land). Cold (never cached) → compute once and cache.
  const v = await getMeta("alltime_stats");
  if (v) {
    try {
      return JSON.parse(v) as AllTimeStats;
    } catch {
      /* fall through and recompute */
    }
  }
  return recomputeAllTimeStats();
}

type AllTimeStats = { plays: number; uniqueTracks: number; durationMs: number; since: string | null };

/** Recompute and cache the all-time totals (the expensive gap scan over every play). Called
 *  on write when new plays are recorded, not on render. */
export async function recomputeAllTimeStats(): Promise<AllTimeStats> {
  const plays = await playsWithListened();
  let stats: AllTimeStats;
  if (plays.length === 0) {
    stats = { plays: 0, uniqueTracks: 0, durationMs: 0, since: null };
  } else {
    const tracks = new Set<string>();
    let durationMs = 0;
    for (const p of plays) {
      tracks.add(p.trackId);
      durationMs += p.listenedMs;
    }
    // plays come back ascending, so the first is the earliest recorded play.
    stats = { plays: plays.length, uniqueTracks: tracks.size, durationMs, since: plays[0].playedAt };
  }
  await setMeta("alltime_stats", JSON.stringify(stats));
  // The throttle stamp for maybeRecomputeAllTimeStats — set here so every compute path
  // (write-triggered, cold-cache, daily heal) resets the window.
  await setMeta("alltime_at", String(Date.now()));
  return stats;
}

/** Per-day plays / unique songs / listening time, most recent first. */
// SQLite date() modifier that shifts UTC timestamps into the *user's* local day.
// `offsetMin` = minutes to ADD to UTC for the user's zone (+120 = UTC+2, −240 = UTC−4),
// sent from the browser (Turso itself runs in UTC, so 'localtime' would mean UTC). It's
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

const dailyStatsCached = unstable_cache(
  (offsetMin: number, days: number, _seq: string) => readDailyStats(offsetMin, days),
  ["daily-stats"],
  { revalidate: LIVE_TTL_S },
);
export async function getDailyStats(offsetMin = 0, days = 14): Promise<DayStats[]> {
  const seq = await liveKey();
  return seq === null ? readDailyStats(offsetMin, days) : dailyStatsCached(offsetMin, days, seq);
}

async function readDailyStats(offsetMin = 0, days = 14): Promise<DayStats[]> {
  const client = await getReader();
  // Only fetch the recent window we actually display (a couple extra days of buffer for the
  // tz day-edge), so this stays cheap as total history grows — not a full-table scan. Uses
  // idx_plays_played_at. Listened ms = gap to the next play, capped at song length, computed
  // in JS (see playsWithListened for why the window function isn't used).
  const cutoff = new Date(Date.now() - (days + 2) * 86_400_000).toISOString();
  const res = await client.execute({
    // LEFT and INNER measured indistinguishable here, rows identical (primary 66/104ms LEFT
    // vs 68/47ms INNER, medians n=15×2, 2026-08-01) — the old "INNER was 150ms-1.5s+" figure
    // did not reproduce. LEFT is kept as the default style, not for performance.
    sql: `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs
          FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE p.played_at >= :cutoff
          ORDER BY p.played_at ASC`,
    args: { cutoff },
  });
  const rows = plainRows(res.rows) as unknown as {
    playedAt: string;
    trackId: string;
    durationMs: number | null;
  }[];
  // Minutes to add to UTC for the user's local day (clamped, integer), same convention as
  // localDay() — toISOString() formats in UTC, so shifting first gives the local calendar day.
  const offMs = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0)) * 60000;
  const byDay = new Map<string, { plays: number; tracks: Set<string>; ms: number }>();
  for (let i = 0; i < rows.length; i++) {
    const dur = rows[i].durationMs ?? LISTEN_FALLBACK_MS;
    const next = rows[i + 1];
    const gap = next ? Date.parse(next.playedAt) - Date.parse(rows[i].playedAt) : null;
    const ran = gap != null && gap >= 0 ? Math.min(dur, gap) : dur;
    const listenedMs = ran < LISTEN_MIN_MS ? 0 : ran;
    const day = new Date(Date.parse(rows[i].playedAt) + offMs).toISOString().slice(0, 10);
    let acc = byDay.get(day);
    if (!acc) {
      acc = { plays: 0, tracks: new Set(), ms: 0 };
      byDay.set(day, acc);
    }
    acc.plays++;
    acc.tracks.add(rows[i].trackId);
    acc.ms += listenedMs;
  }
  return [...byDay.entries()]
    .map(([day, a]) => ({ day, plays: a.plays, uniqueTracks: a.tracks.size, durationMs: a.ms }))
    .sort((x, y) => (x.day < y.day ? 1 : -1))
    .slice(0, days);
}

/** Whether any play exists strictly before the start of the given local day — lets the day
 *  strip decide if it can expand to show older days. Cheap existence check (idx_plays_played_at). */
export async function hasPlaysBeforeDay(day: string, offsetMin = 0): Promise<boolean> {
  const client = await getReader();
  const offMs = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0)) * 60000;
  // Start of `day` in the user's local zone, as a UTC instant.
  const cutoff = new Date(Date.parse(day + "T00:00:00.000Z") - offMs).toISOString();
  const res = await client.execute({
    sql: `SELECT EXISTS(SELECT 1 FROM plays WHERE played_at < :cutoff) AS e`,
    args: { cutoff },
  });
  return !!(res.rows[0] && Number(res.rows[0].e));
}

/** Tracks played on a specific local day (YYYY-MM-DD), most-played first.
 *  `plays`/`lastPlayed`/`source` are scoped to that day, not all-time.
 *
 *  Two cache shapes, one per day-kind — see "Read caching" above for which and why. */
const playsByDayFrozen = unstable_cache(
  (day: string, offsetMin: number) => readPlaysByDay(day, offsetMin),
  ["plays-by-day-frozen"],
  { revalidate: FROZEN_TTL_S },
);
const playsByDayLive = unstable_cache(
  (day: string, offsetMin: number, _seq: string) => readPlaysByDay(day, offsetMin),
  ["plays-by-day-live"],
  { revalidate: LIVE_TTL_S },
);
export async function getPlaysByDay(day: string, offsetMin = 0): Promise<TrackStats[]> {
  if (isFrozenDay(day, offsetMin)) return playsByDayFrozen(day, offsetMin);
  const seq = await liveKey();
  return seq === null ? readPlaysByDay(day, offsetMin) : playsByDayLive(day, offsetMin, seq);
}

async function readPlaysByDay(day: string, offsetMin = 0): Promise<TrackStats[]> {
  const client = await getReader();
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
            AND ${localDay("p.played_at", offsetMin)} = :day
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
    args: {
      day,
      from: new Date(start).toISOString(),
      to: new Date(start + 86_400_000).toISOString(),
    },
  });
  return plainRows(res.rows) as unknown as TrackStats[];
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
//   HISTORY — every played song, plus every individual play as [track, minute, source]. The
//             counts, the times and the expanded per-play list all come out of this, so a
//             result row needs no follow-up request to finish.
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

/** A played song. Same interning convention as LibraryTrack; newest play first. */
export type HistoryTrack = [name: string, artist: string, image: number, album: number];
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
 *  (a browser holding the old body). */
export const LIBRARY_INDEX_SHAPE = "v1";
export const HISTORY_INDEX_SHAPE = "v1";

/** The library payload's version: `meta.library_seq`, bumped by the writes that change which
 *  tracks are in the library and by nothing else (see the marker's note). NOT write_seq —
 *  that moves on every play, and this payload is the half that must survive a listening
 *  session in the browser cache.
 *
 *  STALENESS BOUND: it does not move for an in-place edit of a track's name, artist, album or
 *  art (a re-tag by Spotify, or a play sync refreshing a track's fields). Those are bounded to
 *  ~24h by the daily bucket in the route's ETag. */
export async function getLibraryIndexVersion(): Promise<string> {
  return (await getMeta(LIBRARY_SEQ_KEY)) ?? "0";
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

async function slowSeq(): Promise<string | null> {
  const seq = await liveKey();
  if (seq === null) return null;
  const raw = await getMeta("slow_seq_pub");
  if (raw) {
    try {
      const pub = JSON.parse(raw) as { seq: string; at: number };
      if (pub.seq === seq || Date.now() - pub.at < SLOW_SEQ_MIN_MS) return pub.seq;
    } catch {
      /* republish below */
    }
  }
  await setMeta("slow_seq_pub", JSON.stringify({ seq, at: Date.now() }));
  return seq;
}

/** The history payload's version: the slow marker (write_seq, published at most every
 *  10 min) — the rebuild is a full plays scan, so it must not run once per play. */
export async function getHistoryIndexVersion(): Promise<string> {
  return (await slowSeq()) ?? "0";
}

// LIVE-shaped cache (the section above): keyed on a content version, with the daily TTL as a
// garbage bound. So the scan below runs once per real change and every other request is free.
const libraryIndexCached = unstable_cache(
  (_version: string, _shape: string) => readLibraryIndex(),
  ["library-index", LIBRARY_INDEX_SHAPE],
  { revalidate: FROZEN_TTL_S },
);
export async function getLibraryIndex(version: string): Promise<LibraryIndex> {
  // The shape token goes in BOTH the key parts and the arguments: key parts are the documented
  // cache key, and passing it as an argument as well means the identity holds even if a Next
  // version ever treats key parts as a namespace rather than as key material.
  return libraryIndexCached(version, LIBRARY_INDEX_SHAPE);
}

const historyIndexCached = unstable_cache(
  (_version: string, _shape: string) => readHistoryIndex(),
  ["history-index", HISTORY_INDEX_SHAPE],
  { revalidate: FROZEN_TTL_S },
);
export async function getHistoryIndex(version: string): Promise<HistoryIndex> {
  return historyIndexCached(version, HISTORY_INDEX_SHAPE);
}

async function readLibraryIndex(): Promise<LibraryIndex> {
  const client = await getReader();
  // Driven from playlist_tracks (15k index entries, one seek per member) rather than from
  // `tracks` with an EXISTS filter, which makes the planner scan all 15,000 track rows and
  // then probe membership per row. Rows scanned is what Turso bills.
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
  return {
    images: images.values,
    albums: albums.values,
    playlists: playlists.values,
    tracks,
  };
}

async function readHistoryIndex(): Promise<HistoryIndex> {
  const client = await getReader();
  // A full plays scan, so it must stay on the replica — the same scan against the PRIMARY is
  // seconds-scale (the note on playsWithListened).
  const res = await client.execute(
    `SELECT t.name AS name, t.artist AS artist, t.album AS album, t.album_image AS image,
            p.played_at AS playedAt, ${sourceExpr("p", "c")} AS source
     FROM plays p JOIN tracks t ON t.id = p.track_id
       LEFT JOIN contexts c ON c.uri = p.context_uri
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
      tracks.push([String(r.name), String(r.artist), images.put(r.image), albums.put(r.album)]);
    }
    return [i, Math.floor(Date.parse(String(r.playedAt)) / 60000), sources.put(r.source)];
  });
  return {
    images: images.values,
    albums: albums.values,
    sources: sources.values,
    tracks,
    plays,
  };
}

export async function getLastSync(): Promise<string | null> {
  return getMeta("last_sync");
}

// The once-a-day full context pass (unresolvedContextUris) is gated on this stamp;
// every other sync call uses the batch-bounded unseenContexts(). Epoch ms, 0 = never.
export async function getContextsFullCheckAt(): Promise<number> {
  const v = await getMeta("contexts_full_check_at");
  return v ? Number(v) || 0 : 0;
}
export async function setContextsFullCheckAt(): Promise<void> {
  await setMeta("contexts_full_check_at", String(Date.now()));
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
export async function storePlaylists(rows: StoredPlaylist[], meId: string | null): Promise<void> {
  const client = await getClient();
  const now = new Date().toISOString();

  // Cheap change-probe (a read, never on a render path — this only runs in the background
  // library sync): if the playlist list already matches the cache — same id/name/owner/image/
  // count in the same order — skip the full delete-all + reinsert and just bump the synced-at
  // marker. A steady-state hourly sync then writes ~1 row instead of ~2× the playlist count.
  // (Per-playlist track changes are handled separately by the snapshot-gated loop in
  // syncLibrary; a song swap that leaves the count unchanged correctly doesn't rewrite the
  // list here.)
  const cached = plainRows(
    (
      await client.execute(
        "SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount FROM playlists ORDER BY position",
      )
    ).rows,
  ) as unknown as { id: string; name: string; ownerId: string | null; image: string | null; trackCount: number }[];
  const unchanged =
    cached.length === rows.length &&
    rows.every((r, i) => {
      const c = cached[i];
      return (
        c.id === r.id &&
        c.name === r.name &&
        (c.ownerId ?? null) === (r.ownerId ?? null) &&
        (c.image ?? null) === (r.image ?? null) &&
        Number(c.trackCount) === r.trackCount
      );
    });
  if (unchanged) {
    // Meta only, so no marker bump (and, as before, no sync): nothing the replica serves moved.
    await setMeta("playlists_synced_at", now);
    if (meId) await setMeta("me_id", meId);
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
  // above, so the subquery sees the fresh list.
  stmts.push({
    sql: "DELETE FROM playlist_tracks WHERE playlist_id NOT IN (SELECT id FROM playlists)",
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
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES ('playlists_synced_at', :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { v: new Date().toISOString() },
  });
  if (meId) {
    stmts.push({
      sql: `INSERT INTO meta (key, value) VALUES ('me_id', :v)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: { v: meId },
    });
  }
  // Reached only when the list really changed (the unchanged fast path above returns before
  // this and writes meta only), so the bump is unconditional here.
  stmts.push(writeSeqStmt(), librarySeqStmt());
  await client.batch(stmts, "write");
  // This branch purges playlist_tracks for playlists that no longer exist, so membership can
  // change for several at once — a full pass, not a scoped one. (The unchanged fast path
  // above returns before this and costs nothing.)
  await recomputeOrphanFlags();
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

// LIVE-keyed (see "Read caching"): the grid and the dock's panels both read this on every
// visit, and the list only moves when storePlaylists rewrites it — which is also the only
// branch that bumps the marker, since its unchanged fast path writes meta and nothing else.
const storedPlaylistsCached = unstable_cache(
  (_seq: string) => readStoredPlaylists(),
  ["stored-playlists"],
  { revalidate: LIVE_TTL_S },
);
export async function getStoredPlaylists(): Promise<StoredPlaylist[]> {
  const seq = await liveKey();
  return seq === null ? readStoredPlaylists() : storedPlaylistsCached(seq);
}

async function readStoredPlaylists(): Promise<StoredPlaylist[]> {
  const client = await getReader();
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
 *  playlist_tracks on remote Turso, and it was blocking every Home render. It's refreshed
 *  by recomputeUniqueSongCount() at the end of each library sync (when the underlying data
 *  actually changes). 0 until first cached — Home falls back to the raw track-count sum. */
export async function getUniqueSongCount(): Promise<number> {
  const v = await getMeta("unique_song_count");
  return v ? Number(v) || 0 : 0;
}

/** Run the expensive distinct-song scan once and cache it in meta. Called at the end of a
 *  library sync, not on render. Returns the fresh count. */
export async function recomputeUniqueSongCount(): Promise<number> {
  await syncReader();
  const client = await getReader();
  const res = await client.execute(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT lower(t.artist) AS a, lower(t.name) AS m
       FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     )`,
  );
  const n = res.rows[0] ? Number(res.rows[0].n) : 0;
  await setMeta("unique_song_count", String(n));
  return n;
}

/** One playlist's cached header row (name/owner/image/count) — used by the detail page so
 *  it doesn't load the entire library just to read a single row. */
export async function getStoredPlaylist(id: string): Promise<StoredPlaylist | null> {
  const client = await getReader();
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
export async function upsertStoredPlaylist(p: StoredPlaylist): Promise<void> {
  const client = await getClient();
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
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

export async function getPlaylistsSyncedAt(): Promise<string | null> {
  return getMeta("playlists_synced_at");
}

export async function getMeId(): Promise<string | null> {
  return getMeta("me_id");
}

// ---- playlist tracks (cached per playlist so detail pages load instantly) ----
/** Replace a playlist's cached track list (kept in playlist order). `snapshot` is the
 *  playlist's Spotify snapshot_id, stored so we can skip re-fetching when unchanged. */
export async function storePlaylistTracks(
  playlistId: string,
  tracks: Track[],
  snapshot?: string,
): Promise<void> {
  const client = await getClient();
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
  // Everything queued so far is playlist_tracks/tracks; the two meta stamps below are not
  // replica-served, so a call that diffed to no changes announces nothing.
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
  // Membership for THIS playlist changed, so plays from it may flip orphan either way.
  await recomputeOrphanFlags({ playlistId });
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

/** The Spotify snapshot_id of the cached tracks, if known. */
export async function getPlaylistSnapshot(playlistId: string): Promise<string | null> {
  return getMeta(`plsnap:${playlistId}`);
}

/** A playlist's cached tracks in playlist order (empty if never cached). */
export async function getPlaylistTracks(playlistId: string): Promise<Track[]> {
  const client = await getReader();
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
export type PlaylistTrackRef = { id: string; uri: string; title: string; artist: string };
export async function getPlaylistTrackOrder(playlistId: string): Promise<PlaylistTrackRef[]> {
  const client = await getReader();
  const res = await client.execute({
    sql: `SELECT t.id, t.uri, t.name AS title, t.artist
          FROM playlist_tracks pt LEFT JOIN tracks t ON t.id = pt.track_id
          WHERE pt.playlist_id = :pid ORDER BY pt.position`,
    args: { pid: playlistId },
  });
  return plainRows(res.rows) as unknown as PlaylistTrackRef[];
}

/** Drop one track from a playlist's cache (after a remove) so it doesn't reappear on
 *  the next render before the background refresh. */
export async function removeCachedPlaylistTrack(playlistId: string, uri: string): Promise<void> {
  const client = await getClient();
  await client.batch(
    [
      {
        sql: `DELETE FROM playlist_tracks
              WHERE playlist_id = :pid AND track_id IN (SELECT id FROM tracks WHERE uri = :uri)`,
        args: { pid: playlistId, uri },
      },
      writeSeqStmt(),
      librarySeqStmt(),
    ],
    "write",
  );
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

/** Remove a playlist and all its cached tracks/snapshot from the store (after the
 *  user deletes/unfollows it on Spotify). */
export async function deletePlaylistFromDb(playlistId: string): Promise<void> {
  const client = await getClient();
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
  await recomputeOrphanFlags({ playlistId });
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

// ---- saved tracks (Liked Songs index; the other half of "the library") ----
/** Replace the stored Liked Songs with a fresh full list, in liked order, and stamp
 *  the cheap change-signals (count + newest added_at) used to skip future re-fetches. */
export async function storeSavedTracks(tracks: Track[]): Promise<void> {
  const client = await getClient();
  // Diff against the cache instead of delete-all + reinsert (same row-write-quota reasoning
  // as storePlaylistTracks — this one re-ran in full at least daily via LIKED_FULL_MAX_AGE_MS).
  const cachedRes = await client.execute(
    "SELECT track_id AS trackId, added_at AS addedAt, position FROM saved_tracks",
  );
  const cachedSaved = plainRows(cachedRes.rows) as unknown as {
    trackId: string;
    addedAt: string | null;
    position: number;
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
  const { upserts, deletes } = diffKeyed(
    tracks.map((t, i) => ({ trackId: t.id, addedAt: t.addedAt ?? null, position: i })),
    cachedSaved,
  );
  for (const r of upserts) {
    stmts.push({
      sql: `INSERT INTO saved_tracks (track_id, added_at, position) VALUES (:tid, :added, :pos)
            ON CONFLICT(track_id) DO UPDATE SET added_at = excluded.added_at,
              position = excluded.position`,
      args: { tid: r.trackId, added: r.addedAt, pos: r.position },
    });
  }
  for (let i = 0; i < deletes.length; i += 500) {
    const chunk = deletes.slice(i, i + 500);
    stmts.push({
      sql: `DELETE FROM saved_tracks WHERE track_id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
  }
  // As in storePlaylistTracks: only the saved_tracks/tracks writes above are replica-served,
  // so a diff that came back empty writes the three stamps below and announces nothing.
  if (stmts.length > 0) stmts.push(writeSeqStmt(), librarySeqStmt());
  stmts.push(metaStmt("liked_total", String(tracks.length)));
  stmts.push(metaStmt("liked_top_added_at", tracks[0]?.addedAt ?? ""));
  stmts.push(metaStmt("saved_synced_at", new Date().toISOString()));
  await client.batch(stmts, "write");
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

/** The cheap Liked-Songs change-signals (count + newest added_at). */
export async function getLikedSignals(): Promise<{ total: number; topAddedAt: string | null }> {
  const total = await getMeta("liked_total");
  const top = await getMeta("liked_top_added_at");
  return { total: total ? Number(total) : 0, topAddedAt: top || null };
}

export async function getSavedSyncedAt(): Promise<string | null> {
  return getMeta("saved_synced_at");
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
export async function getLibraryTracks(
  exceptPlaylistId?: string,
  exceptName?: string,
): Promise<Track[]> {
  const client = await getReader();
  const meId = await getMeId();
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
      WHERE p.owner_id = :meId AND pt.playlist_id <> :except
        AND p.name <> :ownCleaned
        AND p.name NOT LIKE :backupLike`,
    args: {
      meId,
      except: exceptPlaylistId ?? "",
      // The target's own cleaned output, excluded by exact name. With no target name there's
      // nothing to exclude → a sentinel no real playlist matches.
      ownCleaned: exceptName ? CLEANED_PREFIX + exceptName : "",
      backupLike: BACKUP_PREFIX + "%",
    },
  });
  return plainRows(res.rows) as unknown as Track[];
}

export async function getLibrarySyncedAt(): Promise<string | null> {
  return getMeta("library_synced_at");
}
export async function setLibrarySyncedAt(): Promise<void> {
  await setMeta("library_synced_at", new Date().toISOString());
}

// Spotify rate-limit backoff, persisted so it survives across serverless invocations
// (the HTTP client's in-memory cooldown is wiped between each cron/API invocation, so
// without this every scheduled tick would re-poke a banned endpoint). Stored as epoch ms.
export async function getSpotifyCooldownUntil(): Promise<number> {
  const v = await getMeta("spotify_cooldown_until");
  return v ? Number(v) || 0 : 0;
}
export async function setSpotifyCooldownUntil(untilMs: number): Promise<void> {
  await setMeta("spotify_cooldown_until", String(Math.floor(untilMs)));
}

// ---- preferences / background-job bookkeeping (meta-backed) ----
/** Whether "Clean" backs removed songs up to a separate playlist. Persisted globally
 *  (DB, so it follows the user across devices), defaulting to on. */
export async function getCleanBackupPref(): Promise<boolean> {
  const v = await getMeta("clean_backup_pref");
  return v === null ? true : v === "1";
}
/** Every play from a given playback context (e.g. a playlist URI), with its timestamp,
 *  oldest→newest. Resume uses the timestamps to scope to the most recent listening
 *  session, so an older/deeper run can't push the resume point past where you actually
 *  stopped this time. */
export async function playedTracksInContext(
  contextUri: string,
): Promise<{ trackId: string; name: string | null; artist: string | null; playedAt: string }[]> {
  const client = await getReader();
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
export async function findTrackWithPlaylists(
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
  const client = await getReader();
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
export async function getContextName(uri: string): Promise<string | null | undefined> {
  const client = await getReader();
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
// (plus the every-2-min cron) share ONE Turso database. Spotify rotates the refresh token
// on every refresh, so if dev and prod use the same row they keep rotating each other's
// token out from under one another → `invalid_grant` → forced re-login (and the occasional
// Configuration error when it happens mid-callback). Namespacing the key by environment
// gives dev its own independent Spotify session while keeping the shared data DB, so a
// dev-server restart no longer logs you out. Prod keeps the canonical `spotify_tokens` key.
const SPOTIFY_TOKENS_KEY =
  process.env.NODE_ENV === "production" ? "spotify_tokens" : "spotify_tokens_dev";

export async function setSpotifyTokens(t: SpotifyTokens): Promise<void> {
  await setMeta(SPOTIFY_TOKENS_KEY, JSON.stringify(t));
}

export async function getSpotifyTokens(): Promise<SpotifyTokens | null> {
  const raw = await getMeta(SPOTIFY_TOKENS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

export async function clearSpotifyTokens(): Promise<void> {
  const client = await getClient();
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
export async function acquireLock(name: string, ttlMs: number): Promise<string | null> {
  const client = await getClient();
  const now = Date.now();
  const exp = String(now + ttlMs);
  const res = await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (:k, :exp)
          ON CONFLICT(key) DO UPDATE SET value = :exp
          WHERE CAST(meta.value AS INTEGER) < :now`,
    args: { k: `lock:${name}`, exp, now },
  });
  return res.rowsAffected > 0 ? exp : null;
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  const client = await getClient();
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

// No write marker here: `meta` is read from the primary, never the replica (write-marker note).
async function setMeta(key: string, value: string): Promise<void> {
  const client = await getClient();
  await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

async function getMeta(key: string): Promise<string | null> {
  const client = await getClient();
  const res = await client.execute({ sql: "SELECT value FROM meta WHERE key = ?", args: [key] });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

// ---- Spotify API request log ----------------------------------------------------------
// Every outgoing Spotify call is recorded here (fire-and-forget from the HTTP client, so
// it never slows a request), so a 429 can be analysed after the fact: how many calls we
// made, over what window, and what wait Spotify demanded. Kept tiny — rows older than an
// hour are pruned, since the limit is a per-second/minute window, not daily.
const API_LOG_TTL_MS = 60 * 60 * 1000; // keep one hour
let apiLogWrites = 0;

export async function logSpotifyRequest(entry: {
  method: string;
  path: string;
  status: number;
  retryAfter: number | null;
}): Promise<void> {
  const client = await getClient();
  // Store just the endpoint path (no host, no query string) — enough to see which calls
  // dominate, without bloating rows or storing query params.
  let p = entry.path;
  try {
    p = entry.path.startsWith("http") ? new URL(entry.path).pathname : entry.path.split("?")[0];
  } catch {
    /* keep the raw path */
  }
  // Don't log successful now-playing polls: they fire every few seconds while the app is
  // open and each log row costs 2 billed Turso row writes (insert + prune delete) for no
  // diagnostic value. Failures (429s, errors) on this endpoint still always log, and the
  // getApiLogSummary windows correspondingly exclude successful now-playing traffic.
  if (entry.status >= 200 && entry.status < 300 && p.endsWith("/me/player/currently-playing")) {
    return;
  }
  await client.execute({
    sql: `INSERT INTO api_log (ts, method, path, status, retry_after) VALUES (?, ?, ?, ?, ?)`,
    args: [Date.now(), entry.method, p, entry.status, entry.retryAfter],
  });
  // Prune occasionally rather than on every write.
  if (++apiLogWrites % 256 === 0) await pruneApiLog();
}

export async function pruneApiLog(): Promise<void> {
  const client = await getClient();
  await client.execute({
    sql: `DELETE FROM api_log WHERE ts < ?`,
    args: [Date.now() - API_LOG_TTL_MS],
  });
}

/** Spotify-call counts (and how many were 429s) within recent windows, for understanding a
 *  throttle. `seconds` = how far back the window reaches. Reads the last minute of the log. */
export async function getApiLogSummary(): Promise<{
  windows: { seconds: number; calls: number; rateLimited: number }[];
}> {
  const client = await getClient();
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
