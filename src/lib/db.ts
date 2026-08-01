// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL (Turso) so it persists on Vercel's serverless
// runtime; falls back to a local SQLite file in dev when TURSO_DATABASE_URL is unset.
import "server-only";
import { cache } from "react";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InStatement } from "@libsql/client";
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

// ── Query conventions (this is a remote DB — round trips and plan choice both matter) ──
// Follow these when adding queries so they stay fast and stable:
//  • Drive joins from the hot, indexed table and LEFT JOIN to `tracks`. Queries over `plays`
//    or `playlist_tracks` use `FROM plays p LEFT JOIN tracks t` / `FROM playlist_tracks pt
//    LEFT JOIN tracks t`. Every play / playlist-track has a matching track, so a LEFT JOIN
//    returns identical rows while keeping Turso on the indexed plays/playlist_tracks plan;
//    an INNER join lets it choose a slow, variable plan that scans the large `tracks` table.
//  • For song-identity equality lookups — `WHERE lower(t.artist) = ?` (optionally `AND
//    lower(t.name) = ?`) — keep an INNER JOIN so the planner uses idx_tracks_artist_name.
//  • Cache expensive whole-table aggregates in `meta` and recompute on write, not on read:
//    `unique_song_count` and `alltime_stats` are refreshed in recordPlays / syncLibrary and
//    read instantly on render. Per-day stats fetch only the recent window they display.
//  • Do gap/sequence math (e.g. listened time) in JS over an ordered fetch — SQL window
//    functions (LEAD/LAG) are very slow on Turso. See playsWithListened / getDailyStats.
//  • Pick the right client. A read that SCANS rows uses getReader() (the local replica); a
//    write, and anything reading `meta`, uses getClient() (the primary). See the Read replica
//    section below for why. A new write must end with `await syncReader()`.

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
    -- this it full-scans the table (slow, and worse against remote Turso — was ~4.5s).
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
  return client;
}

// ── Read replica ────────────────────────────────────────────────────────────────────────
// Turso's remote instance is slow at anything that SCANS rows, and it is not the network:
// the round trip to the primary is ~47ms (median, n=8), but `SELECT COUNT(*) FROM tracks`
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
// How long a write made by ANOTHER process (the cron, the other of dev/prod) can go unseen.
// Our own writes don't wait for this — they call syncReader() directly.
const REPLICA_SYNC_INTERVAL_S = 30;

const gr = globalThis as unknown as {
  __listenReader?: Client;
  __listenReplicaBoot?: Promise<void>;
};

function bootReplica(): void {
  if (gr.__listenReplicaBoot) return;
  gr.__listenReplicaBoot = (async () => {
    // The primary owns the schema; make sure init() has run before copying it down.
    await getClient();
    fs.mkdirSync(path.dirname(REPLICA_PATH), { recursive: true });
    const replica = createClient({
      url: `file:${REPLICA_PATH}`,
      syncUrl: process.env.TURSO_DATABASE_URL,
      authToken,
      intMode: "number",
      syncInterval: REPLICA_SYNC_INTERVAL_S,
    });
    await replica.sync();
    gr.__listenReader = replica;
  })().catch(() => {
    // A replica is an optimisation, never a requirement — drop the cached failure so a
    // later call retries, and keep serving from the primary in the meantime.
    gr.__listenReplicaBoot = undefined;
  });
}

/** Client for reads that scan rows: the local replica once it has synced, the primary until
 *  then. Never blocks on the copy being ready. Not for `meta` — see the note above. */
function getReader(): Promise<Client> {
  if (!REPLICA_ENABLED) return getClient();
  if (gr.__listenReader) return Promise.resolve(gr.__listenReader);
  bootReplica();
  return getClient();
}

/** Pull the replica up to date. Called at the end of every write so the read that follows
 *  sees what was just written — syncInterval alone would leave a window where a play we just
 *  recorded isn't in the copy yet. */
async function syncReader(): Promise<void> {
  const r = gr.__listenReader;
  if (!r) return;
  try {
    await r.sync();
  } catch {
    /* the syncInterval tick retries; a failed sync must not fail the write that triggered it */
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
  // Stamp last_sync atomically with the plays.
  stmts.push({
    sql: `INSERT INTO meta (key, value) VALUES ('last_sync', :v)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: { v: new Date().toISOString() },
  });
  const results = await client.batch(stmts, "write");
  // Give the plays we just inserted their membership verdict before anything reads them.
  await recomputeOrphanFlags({ newOnly: true });
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
  let added = 0;
  for (const i of insertResultIdx) added += Number(results[i].rowsAffected);
  // New plays landed → refresh the cached all-time totals so Home reads them instantly
  // (instead of running the expensive gap scan on render). Only on a real change.
  if (added > 0) await recomputeAllTimeStats();
  return added;
}

/** Cache resolved context (playlist/album/artist) names so "From" shows a name. */
export async function recordContexts(contexts: ContextRecord[]): Promise<void> {
  if (contexts.length === 0) return;
  const client = await getClient();
  const now = new Date().toISOString();
  await client.batch(
    contexts.map((c) => ({
      sql: `INSERT INTO contexts (uri, name, type, checked_at)
            VALUES (:uri, :name, :type, :at)
            ON CONFLICT(uri) DO UPDATE SET name = excluded.name, checked_at = excluded.checked_at`,
      args: { uri: c.uri, name: c.name, type: c.type, at: now },
    })),
    "write",
  );
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

// Negative-cached (name IS NULL) contexts get re-checked this often. Keeps the cache
// self-healing — if the app ever leaves dev mode (403s lift) or a 404 was transient,
// names appear within a month with no manual cleanup, at ~a few extra calls/month.
const NEGATIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Context URIs worth resolving: never-seen ones first, then negative-cached ones whose
 *  re-check window has lapsed. Callers cap the batch, so the ordering keeps stale
 *  re-checks from starving genuinely new contexts. */
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
  return Number(res.rowsAffected);
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
// Computed in JS, not SQL: the equivalent `LEAD() OVER (ORDER BY played_at)` window function
// runs pathologically slowly on Turso (~3s for ~1.5k rows — it was the whole reason the
// history view was slow to load). A plain ordered fetch + linear pass is ~50ms and scales
// fine (the plays table grows slowly).
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

/** Most-played tracks all-time, capped so the list never balloons to thousands.
 *  Feeds the history table when the "All time" card is selected. `plays` is all-time. */
export async function getAllTimePlays(limit: number): Promise<TrackStats[]> {
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
  return stats;
}

/** Per-day plays / unique songs / listening time, most recent first. */
// SQLite date() modifier that shifts UTC timestamps into the *user's* local day.
// `offsetMin` = minutes to ADD to UTC for the user's zone (+120 = UTC+2, −240 = UTC−4),
// sent from the browser (Turso itself runs in UTC, so 'localtime' would mean UTC). It's
// client-supplied, so it's clamped to a valid tz range and integer-ized before inlining.
// One current offset is applied to all rows, so a play within ~1h of a *past* DST change
// can land a day off — acceptable for personal history.
function localDay(col: string, offsetMin: number): string {
  const m = Math.max(-720, Math.min(840, Math.round(offsetMin) || 0));
  return `date(${col}, '${m >= 0 ? "+" : ""}${m} minutes')`;
}

export async function getDailyStats(offsetMin = 0, days = 14): Promise<DayStats[]> {
  const client = await getReader();
  // Only fetch the recent window we actually display (a couple extra days of buffer for the
  // tz day-edge), so this stays cheap as total history grows — not a full-table scan. Uses
  // idx_plays_played_at. Listened ms = gap to the next play, capped at song length, computed
  // in JS (the SQL LEAD() window is pathologically slow on Turso).
  const cutoff = new Date(Date.now() - (days + 2) * 86_400_000).toISOString();
  const res = await client.execute({
    // LEFT JOIN, not INNER: every play has a track so the rows are identical, but it makes
    // Turso drive from plays (idx_plays_played_at) instead of picking a slow, variable plan
    // against the large tracks table — INNER was 150ms–1.5s+ here, LEFT is a steady ~50ms.
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
 *  `plays`/`lastPlayed`/`source` are scoped to that day, not all-time. */
export async function getPlaysByDay(day: string, offsetMin = 0): Promise<TrackStats[]> {
  const client = await getReader();
  const res = await client.execute({
    sql: `${SELECT_TRACK}
          WHERE ${localDay("p.played_at", offsetMin)} = :day
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
    args: { day },
  });
  return plainRows(res.rows) as unknown as TrackStats[];
}

export async function getLastSync(): Promise<string | null> {
  return getMeta("last_sync");
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
  await client.batch(stmts, "write");
  // This branch purges playlist_tracks for playlists that no longer exist, so membership can
  // change for several at once — a full pass, not a scoped one. (The unchanged fast path
  // above returns before this and costs nothing.)
  await recomputeOrphanFlags();
  // Pull the replica up to the write we just made, so the read that follows is fresh.
  await syncReader();
}

export async function getStoredPlaylists(): Promise<StoredPlaylist[]> {
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
  await client.execute({
    sql: `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
          VALUES (:id, :name, :ownerId, :image, :trackCount, -1)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name,
            track_count = excluded.track_count`,
    args: { id: p.id, name: p.name, ownerId: p.ownerId, image: p.image, trackCount: p.trackCount },
  });
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
  await client.execute({
    sql: `DELETE FROM playlist_tracks
          WHERE playlist_id = :pid AND track_id IN (SELECT id FROM tracks WHERE uri = :uri)`,
    args: { pid: playlistId, uri },
  });
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

/** Resolved name for a playback context uri, if we've cached it before. */
export async function getContextName(uri: string): Promise<string | null> {
  const client = await getReader();
  const res = await client.execute({
    sql: "SELECT name FROM contexts WHERE uri = ?",
    args: [uri],
  });
  return res.rows[0] ? String(res.rows[0].name) : null;
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
