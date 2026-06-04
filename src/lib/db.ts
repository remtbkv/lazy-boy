// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL (Turso) so it persists on Vercel's serverless
// runtime; falls back to a local SQLite file in dev when TURSO_DATABASE_URL is unset.
import "server-only";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InStatement } from "@libsql/client";

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

export type ContextRecord = { uri: string; name: string; type: string };

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
  g.__listenDbReady = init();
  return g.__listenDbReady;
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
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT,
      image TEXT,
      track_count INTEGER,
      position INTEGER
    );
  `);
  // Migrate older DBs that predate the album/duration columns.
  const info = await client.execute("PRAGMA table_info(tracks)");
  const cols = new Set(info.rows.map((r) => String(r.name)));
  if (!cols.has("album")) await client.execute("ALTER TABLE tracks ADD COLUMN album TEXT");
  if (!cols.has("album_image")) await client.execute("ALTER TABLE tracks ADD COLUMN album_image TEXT");
  if (!cols.has("duration_ms")) await client.execute("ALTER TABLE tracks ADD COLUMN duration_ms INTEGER");
  return client;
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
  return added;
}

/** Cache resolved context (playlist/album/artist) names so "From" shows a name. */
export async function recordContexts(contexts: ContextRecord[]): Promise<void> {
  if (contexts.length === 0) return;
  const client = await getClient();
  await client.batch(
    contexts.map((c) => ({
      sql: `INSERT INTO contexts (uri, name, type) VALUES (:uri, :name, :type)
            ON CONFLICT(uri) DO UPDATE SET name = excluded.name`,
      args: { uri: c.uri, name: c.name, type: c.type },
    })),
    "write",
  );
}

/** Context URIs in the store that don't yet have a resolved name. */
export async function unresolvedContextUris(): Promise<{ uri: string; type: string }[]> {
  const client = await getClient();
  const res = await client.execute(
    `SELECT DISTINCT p.context_uri AS uri, p.context_type AS type
     FROM plays p LEFT JOIN contexts c ON c.uri = p.context_uri
     WHERE p.context_uri IS NOT NULL AND c.uri IS NULL`,
  );
  return res.rows as unknown as { uri: string; type: string }[];
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
  FROM tracks t JOIN plays p ON p.track_id = t.id`;

/** Search history by track name or artist; "" returns most recently played. */
export async function searchHistory(query: string, limit = 100): Promise<TrackStats[]> {
  const client = await getClient();
  const q = query.trim();
  if (!q) {
    const res = await client.execute({
      sql: `${SELECT_TRACK} GROUP BY t.id ORDER BY lastPlayed DESC LIMIT ?`,
      args: [limit],
    });
    return res.rows as unknown as TrackStats[];
  }
  const like = `%${q}%`;
  const res = await client.execute({
    sql: `${SELECT_TRACK} WHERE t.name LIKE ? OR t.artist LIKE ?
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC LIMIT ?`,
    args: [like, like, limit],
  });
  return res.rows as unknown as TrackStats[];
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
  return res.rows as unknown as TrackStats[];
}

/** All-time totals across every recorded play (for the history "All time" card). */
export async function getAllTimeStats(): Promise<{
  plays: number;
  uniqueTracks: number;
  durationMs: number;
}> {
  const client = await getClient();
  const res = await client.execute(
    `SELECT COUNT(*) AS plays,
       COUNT(DISTINCT p.track_id) AS uniqueTracks,
       COALESCE(SUM(t.duration_ms), 0) AS durationMs
     FROM plays p JOIN tracks t ON t.id = p.track_id`,
  );
  return res.rows[0] as unknown as { plays: number; uniqueTracks: number; durationMs: number };
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
  const res = await client.execute({
    sql: `SELECT ${localDay("p.played_at", offsetMin)} AS day,
            COUNT(*) AS plays,
            COUNT(DISTINCT p.track_id) AS uniqueTracks,
            COALESCE(SUM(t.duration_ms), 0) AS durationMs
          FROM plays p JOIN tracks t ON t.id = p.track_id
          GROUP BY day ORDER BY day DESC LIMIT ?`,
    args: [days],
  });
  return res.rows as unknown as DayStats[];
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
  return res.rows as unknown as TrackStats[];
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
  return res.rows as unknown as StoredPlaylist[];
}

export async function getPlaylistsSyncedAt(): Promise<string | null> {
  return getMeta("playlists_synced_at");
}

export async function getMeId(): Promise<string | null> {
  return getMeta("me_id");
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
export async function acquireLock(name: string, ttlMs: number): Promise<boolean> {
  const client = await getClient();
  const now = Date.now();
  const res = await client.execute({
    sql: `INSERT INTO meta (key, value) VALUES (:k, :exp)
          ON CONFLICT(key) DO UPDATE SET value = :exp
          WHERE CAST(meta.value AS INTEGER) < :now`,
    args: { k: `lock:${name}`, exp: String(now + ttlMs), now },
  });
  return res.rowsAffected > 0;
}

export async function releaseLock(name: string): Promise<void> {
  const client = await getClient();
  await client.execute({ sql: "DELETE FROM meta WHERE key = ?", args: [`lock:${name}`] });
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
