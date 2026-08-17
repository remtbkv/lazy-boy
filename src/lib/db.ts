// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL so it persists on Vercel's serverless runtime: the store is a
// self-hosted `sqld` on the Zenbook, reached over a Tailscale Funnel (docs/quota-forensic/
// BRIDGE.md), and falls back to a local SQLite file in dev when TURSO_DATABASE_URL is unset.
// Turso Cloud is a restore target now, not the live store — the metered-quota defences that
// shaped this file are history unless production ever falls back to it.
import "server-only";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import type { Track } from "@/lib/spotify/types";
import { CLEANED_PREFIX, BACKUP_PREFIX } from "@/lib/clean/names";
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
  playlistRewriteRows,
  searchHistoryLikeRows,
  uniqueSongCountRows,
} from "@/lib/read-costs";
import {
  tracksNeedingWrite,
  playKey,
  newPlays,
  diffPositions,
  diffKeyed,
  diffPlaylistList,
  needsFullOrphanPass,
  type PlaylistListRow,
  type TrackFields,
} from "@/lib/store-diff";

// ── Query conventions (ONE client against a remote store — round trips and plan choice both
// matter) ──
// Every read and every write goes through getClient(). There is no second reader: the libSQL
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

// Local-file fallback for dev; production points at the self-hosted store via env.
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
  // If init fails (a transient network blip on first use), drop the cached
  // rejection so the next call retries — otherwise every DB call in this process
  // fails forever until a restart.
  ready.catch(() => {
    if (g.__listenDbReady === ready) g.__listenDbReady = undefined;
  });
  return ready;
}

// Every store query rides this fetch. Some Vercel invocations intermittently fail to
// RESOLVE the funnel hostname (`getaddrinfo ENOTFOUND ubuntu.tail026729.ts.net` — RSC
// digest 3227098399, Rem's "refresh crashes, second refresh is fine", 2026-08-16): a
// resolver blip, not a store outage, and the very next attempt typically succeeds. So a
// network-level failure (fetch rejects — DNS, reset; NOT an HTTP error response) retries
// twice with a short pause before it is allowed to surface. Bounded: worst case adds
// ~700ms to a request that was about to crash the render.
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(input, init);
      // Gateway-class failures (502/503/504) come from the funnel edge, not sqld — the
      // request almost certainly never executed, so a retry is safe even for writes.
      // A 500 is sqld itself and is NOT retried: it may have executed.
      if (attempt < 2 && (res.status === 502 || res.status === 503 || res.status === 504)) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

async function init(): Promise<Client> {
  if (url.startsWith("file:")) {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  }
  const client = createClient({ url, authToken, intMode: "number", fetch: retryingFetch });
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
    -- far worse against a remote store, where it was seconds-scale on Turso.
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
  // Which traffic source made each Spotify call (cron-sync, now-playing, an action…) —
  // added 2026-08-16 so a 429 is attributable to its CALLER, not just its endpoint.
  const apiLogInfo = await client.execute("PRAGMA table_info(api_log)");
  const apiLogCols = new Set(apiLogInfo.rows.map((r) => String(r.name)));
  if (!apiLogCols.has("source")) {
    await client.execute("ALTER TABLE api_log ADD COLUMN source TEXT");
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
  // less than 35% of the song actually listened is a SKIP: not listed, not counted).
  // NULL = pending: the newest play has no successor yet, so its listened time can't be
  // estimated; treated as not-skipped until recomputeSkipFlags() rules on it.
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
  // recomputeOrphanFlags({newOnly}) filters on `ctx_orphan IS NULL`. Without this partial
  // index that is a full plays scan on every sync tick that lands a play — ~7.2K rows
  // scanned to find the handful of new ones. The index holds only the unverdicted rows
  // (normally ≈0), so the same UPDATE scans just those.
  await client.execute(
    "CREATE INDEX IF NOT EXISTS idx_plays_orphan_null ON plays (id) WHERE ctx_orphan IS NULL",
  );
  return client;
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
// So getClient() is the whole story: one client, every read, every write, all of `meta`.

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
async function readWriteSeq(client: Client): Promise<string | null> {
  const res = await client.execute({
    sql: "SELECT value FROM meta WHERE key = ?",
    args: [WRITE_SEQ_KEY],
  });
  return res.rows[0] ? String(res.rows[0].value) : null;
}

// The store's marker, read ONCE per request and shared: every cached read (see "Read
// caching") keys off it, and three serial single-key reads cost 65-72ms against 23-26ms for
// one (the round-trip note at the top of the file). Same per-request box as playsWithListened
// below and the token box in auth.ts — React cache() gives a per-request box; outside a
// request (the cron path) cache() has no dispatcher and is a pass-through, so each call reads
// again instead, which is correct, just not deduped.
const seqBox = cache(() => ({ p: null as Promise<string | null> | null }));
function primaryWriteSeq(): Promise<string | null> {
  const box = seqBox();
  box.p ??= getClient().then(readWriteSeq);
  return box.p;
}

/** Drop this request's shared copy of the marker. Called at the end of every write that bumped
 *  it: the cached reads below key off that copy, so leaving it in place would serve the
 *  PRE-write entry to the read that follows the write — exactly what refreshHistoryAction does
 *  (sync, then re-read the day). Same shape as publishTokens() in auth.ts: a write republishes
 *  what it just made true instead of leaving the request's snapshot stale. */
function dropWriteSeqCache(): void {
  seqBox().p = null;
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
  // A no-change tick (the steady-state cron every couple of minutes) wrote only last_sync —
  // nothing a cached read serves — so skip the orphan recompute (~0.2s UPDATE over zero rows)
  // it would otherwise pay each tick.
  if (insertResultIdx.length > 0) {
    // Give the plays we just inserted their membership verdict before anything reads them.
    await recomputeOrphanFlags({ newOnly: true });
    // …and rule on skips: each newly-landed play gives its PREDECESSOR a successor, so
    // the pending verdicts can now be decided.
    await recomputeSkipFlags();
  }
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  if (changed) dropWriteSeqCache();
  let added = 0;
  for (const i of insertResultIdx) added += Number(results[i].rowsAffected);
  // New plays landed → refresh the cached all-time totals so Home reads them instantly
  // (instead of running the expensive gap scan on render). Only on a real change, and at
  // most every 10 min: the recompute is a full plays scan (~14K rows),
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
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
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
  const client = await getClient();
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
export async function unresolvedContextUris(): Promise<{ uri: string; type: string }[]> {
  const client = await getClient();
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
  ledgerAddLinear("contexts_full_pass", (plays) =>
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
 *  an unchanged playlist writes zero rows — a no-op UPDATE is still a written row (which Turso
 *  billed). Measured on the live DB: 0 rows and ~0.2-0.4s for the two scoped modes. */
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
  // Only the UNSCOPED pass is ledgered. The other two scopes are bounded by construction (a
  // ≤50-row partial index, one playlist's plays) and would be noise; this one is the ~2.5M
  // term that went unattributed for a month.
  if (!opts.newOnly && !opts.playlistId) ledgerAddLinear("orphan_full_pass", orphanFullPassRows);
  const res = await client.execute({
    sql: `UPDATE plays AS p SET ctx_orphan = (${ORPHAN_PREDICATE}) WHERE ${where}`,
    args: opts.playlistId && !opts.newOnly ? { uri: `spotify:playlist:${opts.playlistId}` } : {},
  });
  const changed = Number(res.rowsAffected);
  // `plays` is served by cached reads and this ran AFTER its caller's batch already bumped,
  // so the flags need their own announcement or an entry cached in between holds rows whose
  // verdict is stale. Only when rows actually flipped: the common case is 0, and a bump there
  // would discard every cached read on every sync tick for nothing. The extra round trip is
  // paid only on a real change, and this is a background write path either way.
  if (changed > 0) await bumpWriteSeq();
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

// A play with less than this fraction of the song actually listened is a SKIP — spam-
// clicking through tracks must not read as listening (Rem, 2026-08-16). Listened time is
// estimated exactly as the hours are: the gap to the NEXT play, capped at song length.
// The verdict is materialized in plays.skipped by recomputeSkipFlags() (NULL = the
// newest play, still pending — shown until its successor rules on it), and every list
// and counter filters on it.
const SKIP_FRACTION = 0.35;
const NOT_SKIPPED = `(p.skipped IS NULL OR p.skipped = 0)`;

/** Rule on every pending (skipped IS NULL) real play that now has a successor: listened
 *  = min(gap to next play, duration); skipped = listened < 35% of duration. Unknown
 *  duration or a clock-weird negative gap counts as not-skipped (be permissive). The
 *  newest play stays pending. Runs after each sync that inserted plays; the pending set
 *  is tiny (idx_plays_skip_null). */
async function recomputeSkipFlags(): Promise<void> {
  const client = await getClient();
  const res = await client.execute(`
    SELECT p.id AS id, p.played_at AS playedAt, p.skipped AS skipped,
           t.duration_ms AS durationMs
    FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
    WHERE ${NOT_BACKFILL}
      AND p.played_at >= (SELECT COALESCE(MIN(p2.played_at), '9999')
                          FROM plays p2
                          WHERE p2.skipped IS NULL
                            AND (p2.context_type IS NULL OR p2.context_type <> 'backfill'))
    ORDER BY p.played_at ASC`);
  const rows = plainRows(res.rows) as unknown as {
    id: number;
    playedAt: string;
    skipped: number | null;
    durationMs: number | null;
  }[];
  const updates: InStatement[] = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i];
    if (r.skipped !== null) continue;
    const gap = Date.parse(rows[i + 1].playedAt) - Date.parse(r.playedAt);
    const dur = r.durationMs;
    const skipped = dur && gap >= 0 && Math.min(gap, dur) < SKIP_FRACTION * dur ? 1 : 0;
    updates.push({ sql: "UPDATE plays SET skipped = ? WHERE id = ?", args: [skipped, r.id] });
  }
  if (updates.length > 0) await client.batch(updates, "write");
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
// Computed in JS, not SQL, as a style choice: the equivalent `LEAD() OVER (ORDER BY
// played_at)` is NOT pathological — against a local SQLite copy it was ~1.5× a plain ordered
// fetch (15.0 vs 10.4ms median, n=9, 2026-08-01), and an earlier "~3s" figure here was a
// single-shot timing that did not reproduce. What matters is that this read is a FULL PLAYS
// SCAN, so nothing on a render path may call it: it is reached only from
// recomputeAllTimeStats, on the write path.
const LISTEN_FALLBACK_MS = 600000;
// A play whose actual run time (gap to the next play) is under this counts as a skip, not a
// listen, and adds 0 to listened-time totals. Plays are still counted as plays.
const LISTEN_MIN_MS = 5000;
type ListenRow = { playedAt: string; trackId: string; listenedMs: number };

// Wrapped in React cache(): getDailyStats and getAllTimeStats both need this, and they run
// together (Home's history boundary, the history refresh action) — cache() dedupes the
// fetch to once per request instead of paying the plays scan twice.
const playsWithListened = cache(async (): Promise<ListenRow[]> => {
  const client = await getClient();
  const res = await client.execute(
    `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs,
            p.skipped AS skipped
     FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
     WHERE ${NOT_BACKFILL}
     ORDER BY p.played_at ASC`,
  );
  const rows = plainRows(res.rows) as unknown as {
    playedAt: string;
    trackId: string;
    durationMs: number | null;
    skipped: number | null;
  }[];
  // Gaps are computed over the FULL chain (a skip still ends its predecessor's listen at
  // the right moment), then flagged skips drop out of the result — so neither the play
  // count nor the listened total sees them.
  return rows
    .map((r, i) => {
      const dur = r.durationMs ?? LISTEN_FALLBACK_MS;
      const next = rows[i + 1];
      const gap = next ? Date.parse(next.playedAt) - Date.parse(r.playedAt) : null;
      const ran = gap != null && gap >= 0 ? Math.min(dur, gap) : dur;
      return {
        playedAt: r.playedAt,
        trackId: r.trackId,
        listenedMs: ran < LISTEN_MIN_MS ? 0 : ran,
        skipped: r.skipped === 1,
      };
    })
    .filter((r) => !r.skipped);
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
  const client = await getClient();
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
//   • FROZEN — a day at or older than today-2 in the USER'S zone. Its plays can no longer
//     change:
//     plays only arrive at "now", and the furthest back a resumed sync can reach is Spotify's
//     last-50-plays window. Two days of slack because that window is the bound, not the clock.
//     Keyed on (day, offset) only, so every later visit — any tab, any instance, any day —
//     is a cache hit and costs ZERO DB reads.
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
  const client = await getClient();
  const res = await client.execute({
    sql: `${SELECT_TRACK} WHERE ${NOT_SKIPPED} GROUP BY t.id
          ORDER BY plays DESC, lastPlayed DESC, t.name ASC LIMIT ?`,
    args: [limit],
  });
  // Inside the read, not in getAllTimePlays: a cache hit costs nothing and must not be
  // charged as a rebuild. Same rule for every instrumented read below.
  ledgerAddLinear("alltime_list", allTimeListRebuildRows);
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
  // which is multi-second against a remote store and shouldn't run on render. It's refreshed on write
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
  const client = await getClient();
  // Only fetch the recent window we actually display (a couple extra days of buffer for the
  // tz day-edge), so this stays cheap as total history grows — not a full-table scan. Uses
  // idx_plays_played_at. Listened ms = gap to the next play, capped at song length, computed
  // in JS (see playsWithListened for why the window function isn't used).
  const cutoff = new Date(Date.now() - (days + 2) * 86_400_000).toISOString();
  const res = await client.execute({
    // LEFT and INNER measured indistinguishable here, rows identical (primary 66/104ms LEFT
    // vs 68/47ms INNER, medians n=15×2, 2026-08-01) — the old "INNER was 150ms-1.5s+" figure
    // did not reproduce. LEFT is kept as the default style, not for performance.
    sql: `SELECT p.played_at AS playedAt, p.track_id AS trackId, t.duration_ms AS durationMs,
                 p.skipped AS skipped
          FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
          WHERE p.played_at >= :cutoff AND ${NOT_BACKFILL}
          ORDER BY p.played_at ASC`,
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
    const dur = rows[i].durationMs ?? LISTEN_FALLBACK_MS;
    const next = rows[i + 1];
    const gap = next ? Date.parse(next.playedAt) - Date.parse(rows[i].playedAt) : null;
    const ran = gap != null && gap >= 0 ? Math.min(dur, gap) : dur;
    const listenedMs = ran < LISTEN_MIN_MS ? 0 : ran;
    // Skips stay in the gap chain (above) but never count as plays or time.
    if (rows[i].skipped === 1) continue;
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
  const client = await getClient();
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
  const client = await getClient();
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
// The user's zone, fixed. The payload is built on the WRITE path, where there is no browser
// and therefore no `tzoffset` cookie — tzOffsetMinutes() returns 0 (UTC) in a cron context,
// which would bucket days wrong for every read of the payload. This app is single-user and
// that user is in New York, so the zone is a constant; the OFFSET is not, and is computed
// per rebuild below rather than pinned to whichever of −240/−300 was true when this shipped.
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

/** Recompute Home's whole first paint and store it. Called from the sync (see
 *  `syncRecentPlays`) whenever plays land, and by Home itself when the row is missing. */
export async function rebuildHomePayload(): Promise<HomePayload> {
  const tzOffsetMinutes = zoneOffsetMinutes(HOME_TZ);
  const [daily, allTime] = await Promise.all([
    readDailyStats(tzOffsetMinutes, HOME_DAILY_DAYS),
    // Already a single meta read off the primary, refreshed on write by recordPlays.
    getAllTimeStats(),
  ]);
  // Write-path time, not a render — the day the payload's `initialDay` falls back to.
  const todayLocal = new Date(Date.now() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
  // Serial by necessity: which day Home opens on depends on which days have plays. It costs
  // one extra round trip HERE, once per sync that landed something, instead of on every load.
  const initialDay = daily[0]?.day ?? todayLocal;
  const initialTracks = await readPlaysByDay(initialDay, tzOffsetMinutes);
  const payload: HomePayload = {
    shape: HOME_PAYLOAD_SHAPE,
    builtAt: new Date().toISOString(),
    tzOffsetMinutes,
    daily,
    allTime,
    initialDay,
    initialTracks,
  };
  await setMeta(HOME_PAYLOAD_KEY, JSON.stringify(payload));
  return payload;
}

/** The stored payload, or null when there is none to serve — absent (nothing has synced into
 *  this store yet), unparseable, or written by a deploy with a different shape. Null is the
 *  caller's cue to compute inline and trigger a rebuild, never to render nothing. */
export async function getHomePayload(): Promise<HomePayload | null> {
  const v = await getMeta(HOME_PAYLOAD_KEY);
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
export async function hasHomePayload(): Promise<boolean> {
  const client = await getClient();
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
 *  (a browser holding the old body). */
export const LIBRARY_INDEX_SHAPE = "v1";
// v2 added the per-song durationMs slot (Home derives its day lists from this payload).
export const HISTORY_INDEX_SHAPE = "v2";

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
  const client = await getClient();
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

async function readHistoryIndex(): Promise<HistoryIndex> {
  const client = await getClient();
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
  // captures stdout and the Zenbook's logtail archives it. First differing field only — a dump
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
    await setMeta("playlists_synced_at", now);
    if (meId) await setMeta("me_id", meId);
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
    dropWriteSeqCache();
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
  // above, so the subquery sees the fresh list. Its index in the batch is kept because its
  // rowsAffected is what decides the orphan pass below.
  const purgeAt = stmts.length;
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
  stmts.push(...stampStmts);
  // Reached only when the LIST really changed (the unchanged and image-only tiers above return
  // before this), so both bumps are unconditional here.
  stmts.push(writeSeqStmt(), librarySeqStmt());
  const results = await client.batch(stmts, "write");
  // ~640 rows_written and ~31K rows_read per rewrite; the ledger accounts reads, so that is
  // what the modeled figure carries (read-costs.ts states the write half).
  void ledgerAdd("playlist_rewrite", playlistRewriteRows());
  // The full orphan pass costs ~2.5M billed reads at the current store, ~80× the rest of this
  // branch put together, so it runs only when the purge above could actually have moved a
  // membership. needsFullOrphanPass owns that rule and states why; a rename or a reorder
  // rewrites the list and skips it.
  const purged = Number(results[purgeAt]?.rowsAffected ?? 0);
  if (needsFullOrphanPass(diff.idSetChanged, purged)) await recomputeOrphanFlags();
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
}

// LIVE-keyed (see "Read caching"): the grid and the dock's panels both read this on every
// visit, and the list only moves when storePlaylists writes to `playlists` — its rewrite
// branch or its image-only branch, both of which bump the marker, so the next read is a
// different cache key. Its unchanged tier writes meta and nothing else, and bumps nothing.
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
  const client = await getClient();
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
export async function getUniqueSongCount(): Promise<number> {
  const v = await getMeta("unique_song_count");
  return v ? Number(v) || 0 : 0;
}

/** Run the expensive distinct-song scan once and cache it in meta. Called at the end of a
 *  library sync, not on render. Returns the fresh count. */
export async function recomputeUniqueSongCount(): Promise<number> {
  // The library sync that calls this has just written, so this request's copy of the marker is
  // stale before the scan below even runs.
  dropWriteSeqCache();
  const client = await getClient();
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
  await setMeta("unique_song_count", String(n));
  return n;
}

/** One playlist's cached header row (name/owner/image/count) — used by the detail page so
 *  it doesn't load the entire library just to read a single row. */
export async function getStoredPlaylist(id: string): Promise<StoredPlaylist | null> {
  const client = await getClient();
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
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
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
  // Membership for THIS playlist changed, so plays from it may flip orphan either way.
  await recomputeOrphanFlags({ playlistId });
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
}

/** The Spotify snapshot_id of the cached tracks, if known. */
export async function getPlaylistSnapshot(playlistId: string): Promise<string | null> {
  return getMeta(`plsnap:${playlistId}`);
}

/** A playlist's cached tracks in playlist order (empty if never cached). */
export async function getPlaylistTracks(playlistId: string): Promise<Track[]> {
  const client = await getClient();
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
  const client = await getClient();
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
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
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
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
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
  // As in storePlaylistTracks: only the saved_tracks/tracks writes above feed a cached read,
  // so a diff that came back empty writes the three stamps below and announces nothing.
  if (stmts.length > 0) stmts.push(writeSeqStmt(), librarySeqStmt());
  stmts.push(metaStmt("liked_total", String(tracks.length)));
  stmts.push(metaStmt("liked_top_added_at", tracks[0]?.addedAt ?? ""));
  stmts.push(metaStmt("saved_synced_at", new Date().toISOString()));
  await client.batch(stmts, "write");
  // The write moved the marker; drop this request's copy so the read that follows re-keys.
  dropWriteSeqCache();
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
  const client = await getClient();
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
// ── The recently-played harvest gate ────────────────────────────────────────────────
// Two timestamps that let the cron tick SKIP the recently-played call when nothing has
// played since the last harvest (Rem, 2026-08-17: two multi-hour QUOTA_EXCEEDED penalties
// on that endpoint in two days — Spotify has this app on a tight quota, so the dominant
// call must stop running around the clock). currently-playing sits in its own quota
// bucket and is what the tick checks instead.
export async function getHarvestGate(): Promise<{ lastActive: number; lastHarvest: number }> {
  const [a, h] = await Promise.all([getMeta("player_last_active"), getMeta("rp_last_harvest")]);
  return { lastActive: Number(a) || 0, lastHarvest: Number(h) || 0 };
}
export async function setHarvestGate(v: {
  lastActive?: number;
  lastHarvest?: number;
}): Promise<void> {
  if (v.lastActive !== undefined) await setMeta("player_last_active", String(v.lastActive));
  if (v.lastHarvest !== undefined) await setMeta("rp_last_harvest", String(v.lastHarvest));
}

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
  const client = await getClient();
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
  const client = await getClient();
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
  const client = await getClient();
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

// No write marker here: nothing cached is derived from `meta` (write-marker note).
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
// made, from which SOURCE, over what window, and what wait Spotify demanded. A week is
// kept (the 2026-08-16 extended rate-limit needed more than the old one-hour window to
// reason about, and the store is self-hosted — rows cost nothing). /usage renders the
// 24h per-source rollup; deeper analysis queries this table directly.
const API_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // keep a week
let apiLogWrites = 0;

export async function logSpotifyRequest(entry: {
  method: string;
  path: string;
  status: number;
  retryAfter: number | null;
  source?: string;
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
  // Successful now-playing polls ARE logged now (they used to be skipped to save Turso
  // row-writes): they are the app's dominant Spotify traffic, and a rate-limit analysis
  // that can't see the dominant source is blind (Rem, 2026-08-16). Self-hosted store —
  // the writes cost nothing.
  await client.execute({
    sql: `INSERT INTO api_log (ts, method, path, status, retry_after, source) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [Date.now(), entry.method, p, entry.status, entry.retryAfter, entry.source ?? null],
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
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT COALESCE(source, 'untagged') AS source, COUNT(*) AS calls,
                 SUM(status >= 400 OR status = 0) AS errors,
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
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT ts, status, retry_after, COALESCE(source, 'untagged') AS source
          FROM api_log WHERE path = ? ORDER BY ts`,
    args: [RP_QUOTA_PATH],
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
    const client = await getClient();
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
    const client = await getClient();
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
  const client = await getClient();
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
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT COALESCE(SUM(modeled_rows), 0) AS total FROM usage_ledger
          WHERE day = :day AND substr(reader, 1, 1) <> '_'`,
    args: { day },
  });
  return res.rows[0] ? Number(res.rows[0].total) || 0 : 0;
}

// The linear terms in the cost model need the store's size. It comes from the cached
// all-time stats (one indexed meta key), memoized briefly so attribution doesn't add a round
// trip to every instrumented call, and falling back to read-costs.ts's calibration size when
// the cache is cold — a modeled cost must never block on a scan to learn how big a table is.
const STORE_SIZE_MEMO_MS = 60_000;
let storeSizeMemo: { at: number; plays: number } | null = null;

async function modeledPlaysCount(): Promise<number> {
  if (storeSizeMemo && Date.now() - storeSizeMemo.at < STORE_SIZE_MEMO_MS) {
    return storeSizeMemo.plays;
  }
  let plays: number = CALIBRATION.plays;
  try {
    const v = await getMeta("alltime_stats");
    if (v) {
      const n = Number((JSON.parse(v) as AllTimeStats).plays);
      if (n > 0) plays = n;
    }
  } catch {
    /* keep the calibration default */
  }
  storeSizeMemo = { at: Date.now(), plays };
  return plays;
}

/** Share of plays carrying a playback context, from the calibration store (6,951 / 7,194).
 *  Used to size the `contexts` probe half of the daily full pass. */
const CONTEXTED_PLAY_FRACTION = CALIBRATION.contextedPlays / CALIBRATION.plays;

/** Ledger a cost that is LINEAR in history size, resolving the size off the awaited path so
 *  the caller pays nothing for it. Not async on purpose: the whole chain, including the
 *  size lookup, hangs off the returned-and-discarded promise. */
function ledgerAddLinear(reader: string, cost: (plays: number) => number): void {
  void modeledPlaysCount()
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
export async function ledgerSyncCall(
  reader: string,
  added: number,
  extraRows = 0,
): Promise<void> {
  try {
    const rows =
      added > 0 ? landedSyncTickRows(await modeledPlaysCount()) : STEADY_SYNC_TICK_ROWS;
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

/** Append a batch of reported timings. One statement batch, on the primary; `ts` is stamped
 *  HERE rather than trusted from the browser, so a clock-skewed tab can't file rows into next
 *  week. No write_seq bump (see the section note). */
export async function recordClientMetrics(rows: ClientMetricInput[]): Promise<void> {
  if (rows.length === 0) return;
  const client = await getClient();
  const ts = new Date().toISOString();
  await client.batch(
    rows.map((r) => ({
      sql: `INSERT INTO client_metrics (ts, session, page, event, value, meta)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [ts, r.session, r.page, r.event, r.value ?? null, r.meta ?? null],
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
  const client = await getClient();
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
    if (event === "js-error" && meta) {
      errors.push({ at: String(row.ts ?? ""), page, message: meta });
    }
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
