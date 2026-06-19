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
//  • Substring/token search over song or artist names goes through the trigram FTS index
//    (`tracks_fts`, rebuilt on library sync), not a `LIKE '%term%'` scan of the tracks
//    table. See ftsTokenFilter / searchPlaylistSongs. Reuse it for any new text search.

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
    -- Full-text index over playlist-song names/artists for the Find search. The trigram
    -- tokenizer makes substring matching index-backed (same results as the old LIKE scan,
    -- much faster). Rebuilt from playlist tracks at the end of each library sync
    -- (rebuildTracksFts) — a background job, never on a render. Populated lazily if a
    -- search runs before the first sync has filled it.
    CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts
      USING fts5(track_id UNINDEXED, name, artist, tokenize='trigram');
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
  return client;
}

// libSQL Row objects aren't plain objects (they carry a prototype + indexed access), so
// React warns when a Server Component passes them straight to a Client Component. Spread
// each into a plain object so query results cross the RSC boundary cleanly.
function plainRows(rows: readonly unknown[]): unknown[] {
  return rows.map((r) => ({ ...(r as object) }));
}

/** Insert plays, deduped on (track, played_at). Returns how many were new. */
export async function recordPlays(plays: PlayRecord[]): Promise<number> {
  if (plays.length === 0) return 0;
  const client = await getClient();
  const stmts: InStatement[] = [];
  const insertResultIdx: number[] = [];
  for (const r of plays) {
    stmts.push({
      sql: `INSERT INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
            VALUES (:trackId, :name, :artist, :uri, :album, :albumImage, :durationMs)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, artist = excluded.artist,
              album = excluded.album, album_image = excluded.album_image,
              duration_ms = excluded.duration_ms`,
      args: {
        trackId: r.trackId,
        name: r.name,
        artist: r.artist,
        uri: r.uri,
        album: r.album,
        albumImage: r.albumImage,
        durationMs: r.durationMs,
      },
    });
    insertResultIdx.push(stmts.length); // index of the insertPlay result, below
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
}

// Negative-cached (name IS NULL) contexts get re-checked this often. Keeps the cache
// self-healing — if the app ever leaves dev mode (403s lift) or a 404 was transient,
// names appear within a month with no manual cleanup, at ~a few extra calls/month.
const NEGATIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Context URIs worth resolving: never-seen ones first, then negative-cached ones whose
 *  re-check window has lapsed. Callers cap the batch, so the ordering keeps stale
 *  re-checks from starving genuinely new contexts. */
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
  return (plainRows(res.rows) as unknown as { uri: string; type: string }[]).map(
    ({ uri, type }) => ({ uri, type }),
  );
}

// `source` is the context (playlist/album name, or type) of the MOST RECENT play
// only — not every context the track ever appeared in, which would be misleading
// (a one-off queue shouldn't read as "in this playlist").
const SELECT_TRACK = `
  SELECT t.id, t.name, t.artist, t.uri, t.album, t.album_image AS albumImage,
    t.duration_ms AS durationMs,
    COUNT(p.id) AS plays, MAX(p.played_at) AS lastPlayed, MIN(p.played_at) AS firstPlayed,
    (SELECT COALESCE(c2.name, p2.context_type)
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
  const client = await getClient();
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
    COALESCE(c.name, p.context_type) AS source
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
  const client = await getClient();
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
  const client = await getClient();
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
  const client = await getClient();
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
  const client = await getClient();
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
}

export async function getStoredPlaylists(): Promise<StoredPlaylist[]> {
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
  const client = await getClient();
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
  await client.execute({
    sql: `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
          VALUES (:id, :name, :ownerId, :image, :trackCount, -1)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name,
            track_count = excluded.track_count`,
    args: { id: p.id, name: p.name, ownerId: p.ownerId, image: p.image, trackCount: p.trackCount },
  });
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
  const stmts: InStatement[] = [
    { sql: "DELETE FROM playlist_tracks WHERE playlist_id = :pid", args: { pid: playlistId } },
  ];
  tracks.forEach((t, i) => {
    stmts.push({
      sql: `INSERT INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
            VALUES (:id, :name, :artist, :uri, :album, :albumImage, :durationMs)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, artist = excluded.artist,
              album = excluded.album, album_image = excluded.album_image,
              duration_ms = excluded.duration_ms`,
      args: {
        id: t.id,
        name: t.title,
        artist: t.artist,
        uri: t.uri,
        album: t.album ?? null,
        albumImage: t.albumImage ?? null,
        durationMs: t.durationMs ?? null,
      },
    });
    stmts.push({
      sql: `INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at)
            VALUES (:pid, :pos, :tid, :added)`,
      args: { pid: playlistId, pos: i, tid: t.id, added: t.addedAt ?? null },
    });
  });
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

/** Drop one track from a playlist's cache (after a remove) so it doesn't reappear on
 *  the next render before the background refresh. */
export async function removeCachedPlaylistTrack(playlistId: string, uri: string): Promise<void> {
  const client = await getClient();
  await client.execute({
    sql: `DELETE FROM playlist_tracks
          WHERE playlist_id = :pid AND track_id IN (SELECT id FROM tracks WHERE uri = :uri)`,
    args: { pid: playlistId, uri },
  });
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
}

// ---- saved tracks (Liked Songs index; the other half of "the library") ----
/** Replace the stored Liked Songs with a fresh full list, in liked order, and stamp
 *  the cheap change-signals (count + newest added_at) used to skip future re-fetches. */
export async function storeSavedTracks(tracks: Track[]): Promise<void> {
  const client = await getClient();
  const stmts: InStatement[] = [{ sql: "DELETE FROM saved_tracks", args: [] }];
  tracks.forEach((t, i) => {
    stmts.push({
      sql: `INSERT INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
            VALUES (:id, :name, :artist, :uri, :album, :albumImage, :durationMs)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, artist = excluded.artist,
              album = excluded.album, album_image = excluded.album_image,
              duration_ms = excluded.duration_ms`,
      args: {
        id: t.id,
        name: t.title,
        artist: t.artist,
        uri: t.uri,
        album: t.album ?? null,
        albumImage: t.albumImage ?? null,
        durationMs: t.durationMs ?? null,
      },
    });
    stmts.push({
      sql: `INSERT INTO saved_tracks (track_id, added_at, position) VALUES (:tid, :added, :pos)`,
      args: { tid: t.id, added: t.addedAt ?? null, pos: i },
    });
  });
  stmts.push(metaStmt("liked_total", String(tracks.length)));
  stmts.push(metaStmt("liked_top_added_at", tracks[0]?.addedAt ?? ""));
  stmts.push(metaStmt("saved_synced_at", new Date().toISOString()));
  await client.batch(stmts, "write");
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

// ---- preferences / background-job bookkeeping (meta-backed) ----
/** Whether "Clean" backs removed songs up to a separate playlist. Persisted globally
 *  (DB, so it follows the user across devices), defaulting to on. */
export async function getCleanBackupPref(): Promise<boolean> {
  const v = await getMeta("clean_backup_pref");
  return v === null ? true : v === "1";
}
export async function setCleanBackupPref(on: boolean): Promise<void> {
  await setMeta("clean_backup_pref", on ? "1" : "0");
}

// ---- find: songs that appear in any playlist + their listen times ----
export type FoundSong = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumImage: string | null;
  playlistCount: number;
};

// Build a token-AND LIKE filter for `column`: every whitespace-separated token must
// appear somewhere in it, so "old chinese" matches "older chinese parse" even when the
// words aren't contiguous. Returns the WHERE fragment, its bound args, and a
// firstPrefix/phrase pair for ranking exact-ish matches above forgiving ones.
function tokenLike(column: string, query: string) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const where = tokens.map((_, i) => `${column} LIKE :tok${i}`).join(" AND ");
  const args: Record<string, string> = {};
  tokens.forEach((t, i) => (args[`tok${i}`] = `%${t}%`));
  return { where, args, firstPrefix: `${tokens[0] ?? ""}%`, phrase: `%${query}%` };
}

/** Rebuild the Find search index from the songs currently in playlists. Runs at the end of
 *  a library sync (a background job) so search stays fast without touching the render path. */
export async function rebuildTracksFts(): Promise<void> {
  const client = await getClient();
  await client.batch(
    [
      "DELETE FROM tracks_fts",
      `INSERT INTO tracks_fts (track_id, name, artist)
         SELECT id, name, artist FROM tracks
         WHERE id IN (SELECT DISTINCT track_id FROM playlist_tracks)`,
    ],
    "write",
  );
}

// Build the index once per process if a search runs before any sync has filled it (e.g. a
// fresh deploy). On a populated DB the flag short-circuits after the first cheap check.
let ftsPopulated = false;
async function ensureFts(client: Client): Promise<void> {
  if (ftsPopulated) return;
  const r = await client.execute("SELECT 1 FROM tracks_fts LIMIT 1");
  if (r.rows.length === 0) await rebuildTracksFts();
  ftsPopulated = true;
}

// Fast token search: anchor on the longest ≥3-char token via the trigram FTS index
// (`f.<ftsCol> MATCH`), then narrow the small matched set with LIKE on the remaining tokens.
// Same any-order-substring results as tokenLike, but index-backed. Returns null when no
// token reaches trigram's 3-char minimum — callers fall back to tokenLike.
function ftsTokenFilter(ftsCol: "name" | "artist", trackCol: string, query: string) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const anchor = [...tokens].filter((t) => t.length >= 3).sort((a, b) => b.length - a.length)[0];
  if (!anchor) return null;
  const rest = [...tokens];
  rest.splice(rest.indexOf(anchor), 1); // drop one occurrence of the anchor; the rest stay as LIKE
  const conds = [`f.${ftsCol} MATCH :anchor`, ...rest.map((_, i) => `${trackCol} LIKE :r${i}`)];
  const args: Record<string, string> = { anchor };
  rest.forEach((t, i) => (args[`r${i}`] = `%${t}%`));
  return { where: conds.join(" AND "), args, firstPrefix: `${tokens[0]}%`, phrase: `%${query}%` };
}

/** Songs in any playlist whose title matches `query` — forgiving, token-by-token: every
 *  word in the query must appear, in any order (so "old chinese" finds "older chinese
 *  parse"). One row per distinct (artist, title); contiguous/prefix matches rank first. */
export async function searchPlaylistSongs(query: string, limit = 12): Promise<FoundSong[]> {
  const q = query.trim();
  if (!q) return [];
  const client = await getClient();
  await ensureFts(client);
  // Trigram FTS for the common case (any token ≥3 chars); plain LIKE for short queries.
  const fts = ftsTokenFilter("name", "t.name", q);
  const filt = fts ?? tokenLike("t.name", q);
  if (!filt.where) return [];
  const from = fts
    ? "tracks_fts f JOIN tracks t ON t.id = f.track_id JOIN playlist_tracks pt ON pt.track_id = t.id"
    : "tracks t JOIN playlist_tracks pt ON pt.track_id = t.id";
  const res = await client.execute({
    sql: `SELECT t.id, t.name AS title, t.artist, t.album, t.album_image AS albumImage,
            COUNT(DISTINCT pt.playlist_id) AS playlistCount
          FROM ${from}
          WHERE ${filt.where}
          GROUP BY lower(t.artist), lower(t.name)
          ORDER BY (CASE WHEN t.name LIKE :phrase THEN 0 ELSE 1 END),
                   (CASE WHEN t.name LIKE :firstPrefix THEN 0 ELSE 1 END),
                   playlistCount DESC, t.name
          LIMIT :limit`,
    args: { ...filt.args, phrase: filt.phrase, firstPrefix: filt.firstPrefix, limit },
  });
  return plainRows(res.rows) as unknown as FoundSong[];
}

/** Listen history for the song matching `trackId`'s (artist, title): total plays + most
 *  recent timestamps. Keyed on artist+title so any release of the same song counts
 *  (matches the app's song identity). */
// Each recent listen carries the played track id too, so the UI can deep-link a play
// back to that exact song on the right day in History.
export type Listen = { playedAt: string; trackId: string };

export async function getSongListens(
  trackId: string,
  limit = 100,
): Promise<{ total: number; recent: Listen[] }> {
  const client = await getClient();
  // One round-trip: resolve the song's (artist, title) key in a CTE, then count and list
  // its plays in the same statement. COUNT(*) OVER () is the full match count (computed
  // before LIMIT), so the capped `recent` rows and the true `total` come back together.
  const res = await client.execute({
    sql: `WITH k AS (SELECT lower(artist) AS a, lower(name) AS n FROM tracks WHERE id = :id)
          SELECT COUNT(*) OVER () AS total, p.played_at AS playedAt, p.track_id AS trackId
          FROM plays p JOIN tracks t ON t.id = p.track_id, k
          WHERE lower(t.artist) = k.a AND lower(t.name) = k.n
          ORDER BY p.played_at DESC LIMIT :limit`,
    args: { id: trackId, limit },
  });
  return {
    total: res.rows[0] ? Number(res.rows[0].total) : 0,
    recent: res.rows.map((r) => ({ playedAt: String(r.playedAt), trackId: String(r.trackId) })),
  };
}

export type FoundArtist = {
  artist: string;
  songCount: number;
  albumImage: string | null;
};

/** Artists who appear in any playlist whose name matches `query` — forgiving, token-by-
 *  token like the song search — one row per artist, with how many of their songs you have
 *  and a sample image. */
export async function searchPlaylistArtists(query: string, limit = 12): Promise<FoundArtist[]> {
  const q = query.trim();
  if (!q) return [];
  const client = await getClient();
  await ensureFts(client);
  const fts = ftsTokenFilter("artist", "t.artist", q);
  const filt = fts ?? tokenLike("t.artist", q);
  if (!filt.where) return [];
  const from = fts
    ? "tracks_fts f JOIN tracks t ON t.id = f.track_id JOIN playlist_tracks pt ON pt.track_id = t.id"
    : "tracks t JOIN playlist_tracks pt ON pt.track_id = t.id";
  const res = await client.execute({
    sql: `SELECT t.artist,
            COUNT(DISTINCT lower(t.name)) AS songCount,
            MAX(t.album_image) AS albumImage
          FROM ${from}
          WHERE ${filt.where}
          GROUP BY lower(t.artist)
          ORDER BY (CASE WHEN t.artist LIKE :phrase THEN 0 ELSE 1 END),
                   (CASE WHEN t.artist LIKE :firstPrefix THEN 0 ELSE 1 END),
                   songCount DESC, t.artist
          LIMIT :limit`,
    args: { ...filt.args, phrase: filt.phrase, firstPrefix: filt.firstPrefix, limit },
  });
  return plainRows(res.rows) as unknown as FoundArtist[];
}

/** Listen history for an artist: total plays of any of their songs + recent timestamps. */
export async function getArtistListens(
  artist: string,
  limit = 100,
): Promise<{ total: number; recent: Listen[] }> {
  const client = await getClient();
  const a = artist.toLowerCase();
  // One round-trip: window count gives the true total alongside the LIMIT-capped rows.
  const res = await client.execute({
    sql: `SELECT COUNT(*) OVER () AS total, p.played_at AS playedAt, p.track_id AS trackId
          FROM plays p JOIN tracks t ON t.id = p.track_id
          WHERE lower(t.artist) = :a
          ORDER BY p.played_at DESC LIMIT :limit`,
    args: { a, limit },
  });
  return {
    total: res.rows[0] ? Number(res.rows[0].total) : 0,
    recent: res.rows.map((r) => ({ playedAt: String(r.playedAt), trackId: String(r.trackId) })),
  };
}

export type SongLocation = {
  playlistId: string;
  playlistName: string;
  trackId: string; // the track id AT this position (for the jump-to anchor)
  position: number; // 0-based index in that playlist
  title?: string; // only set for the artist view (which song this row is)
};

/** Every owned playlist that contains the song matching `trackId` (by artist+title),
 *  with the track id + position there so the UI can deep-link to that exact spot. */
export async function getSongPlaylists(trackId: string, limit = 25): Promise<SongLocation[]> {
  const client = await getClient();
  const meId = await getMeId();
  // Resolve every track id sharing this song's (artist, title) first (indexed by
  // lower(artist), lower(name)), then look those up in playlist_tracks by track_id
  // (indexed). The old shape joined the whole playlist_tracks table and computed lower()
  // per row — a full scan that ran ~4.5s against remote Turso.
  const res = await client.execute({
    sql: `WITH ids AS (
            SELECT id FROM tracks
            WHERE lower(artist) = (SELECT lower(artist) FROM tracks WHERE id = :id)
              AND lower(name)   = (SELECT lower(name)   FROM tracks WHERE id = :id)
          )
          SELECT p.id AS playlistId, p.name AS playlistName, pt.track_id AS trackId, pt.position AS position
          FROM playlist_tracks pt
            JOIN ids ON ids.id = pt.track_id
            JOIN playlists p ON p.id = pt.playlist_id
          WHERE p.owner_id = :meId
          ORDER BY p.name, pt.position
          LIMIT :limit`,
    args: { id: trackId, meId, limit },
  });
  return plainRows(res.rows) as unknown as SongLocation[];
}

/** An artist's songs across the user's owned playlists — one row per (song, playlist)
 *  with the position there, so the UI can list them and deep-link to each. */
export async function getArtistSongLocations(artist: string, limit = 50): Promise<SongLocation[]> {
  const client = await getClient();
  const meId = await getMeId();
  const res = await client.execute({
    sql: `SELECT p.id AS playlistId, p.name AS playlistName, pt.track_id AS trackId,
            pt.position AS position, t.name AS title
          FROM tracks t
            JOIN playlist_tracks pt ON pt.track_id = t.id
            JOIN playlists p ON p.id = pt.playlist_id
          WHERE lower(t.artist) = :a AND p.owner_id = :meId
          ORDER BY t.name, p.name, pt.position
          LIMIT :limit`,
    args: { a: artist.toLowerCase(), meId, limit },
  });
  return plainRows(res.rows) as unknown as SongLocation[];
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

/** Resolved name for a playback context uri, if we've cached it before. */
export async function getContextName(uri: string): Promise<string | null> {
  const client = await getClient();
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

export async function setSpotifyTokens(t: SpotifyTokens): Promise<void> {
  await setMeta("spotify_tokens", JSON.stringify(t));
}

export async function getSpotifyTokens(): Promise<SpotifyTokens | null> {
  const raw = await getMeta("spotify_tokens");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

export async function clearSpotifyTokens(): Promise<void> {
  const client = await getClient();
  await client.execute({ sql: "DELETE FROM meta WHERE key = ?", args: ["spotify_tokens"] });
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
