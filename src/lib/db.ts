// Local SQLite store for listening history. Simple and unencrypted — a personal
// store of which tracks were played, how often, when, and from where. Data comes
// from Spotify /me/player/recently-played, synced on demand.
import "server-only";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

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
  day: string; // YYYY-MM-DD (local)
  plays: number;
  uniqueTracks: number;
  durationMs: number;
};

const g = globalThis as unknown as { __listenDb?: Database.Database };

function db(): Database.Database {
  if (g.__listenDb) return g.__listenDb;
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  const conn = new Database(path.join(dir, "listens.db"));
  conn.pragma("journal_mode = WAL");
  conn.exec(`
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
  const cols = new Set(
    (conn.prepare("PRAGMA table_info(tracks)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has("album")) conn.exec("ALTER TABLE tracks ADD COLUMN album TEXT");
  if (!cols.has("album_image")) conn.exec("ALTER TABLE tracks ADD COLUMN album_image TEXT");
  if (!cols.has("duration_ms")) conn.exec("ALTER TABLE tracks ADD COLUMN duration_ms INTEGER");
  g.__listenDb = conn;
  return conn;
}

/** Insert plays, deduped on (track, played_at). Returns how many were new. */
export function recordPlays(plays: PlayRecord[]): number {
  if (plays.length === 0) return 0;
  const conn = db();
  const upsertTrack = conn.prepare(
    `INSERT INTO tracks (id, name, artist, uri, album, album_image, duration_ms)
     VALUES (@trackId, @name, @artist, @uri, @album, @albumImage, @durationMs)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, artist = excluded.artist,
       album = excluded.album, album_image = excluded.album_image,
       duration_ms = excluded.duration_ms`,
  );
  const insertPlay = conn.prepare(
    `INSERT OR IGNORE INTO plays (track_id, played_at, context_type, context_uri)
     VALUES (@trackId, @playedAt, @contextType, @contextUri)`,
  );
  const tx = conn.transaction((rows: PlayRecord[]) => {
    let added = 0;
    for (const r of rows) {
      upsertTrack.run(r);
      added += insertPlay.run(r).changes;
    }
    return added;
  });
  const added = tx(plays);
  setMeta("last_sync", new Date().toISOString());
  return added;
}

/** Cache resolved context (playlist/album/artist) names so "From" shows a name. */
export function recordContexts(contexts: ContextRecord[]): void {
  if (contexts.length === 0) return;
  const conn = db();
  const stmt = conn.prepare(
    `INSERT INTO contexts (uri, name, type) VALUES (@uri, @name, @type)
     ON CONFLICT(uri) DO UPDATE SET name = excluded.name`,
  );
  conn.transaction((rows: ContextRecord[]) => rows.forEach((r) => stmt.run(r)))(contexts);
}

/** Context URIs in the store that don't yet have a resolved name. */
export function unresolvedContextUris(): { uri: string; type: string }[] {
  return db()
    .prepare(
      `SELECT DISTINCT p.context_uri AS uri, p.context_type AS type
       FROM plays p LEFT JOIN contexts c ON c.uri = p.context_uri
       WHERE p.context_uri IS NOT NULL AND c.uri IS NULL`,
    )
    .all() as { uri: string; type: string }[];
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
export function searchHistory(query: string, limit = 100): TrackStats[] {
  const conn = db();
  const q = query.trim();
  if (!q) {
    return conn
      .prepare(`${SELECT_TRACK} GROUP BY t.id ORDER BY lastPlayed DESC LIMIT ?`)
      .all(limit) as TrackStats[];
  }
  const like = `%${q}%`;
  return conn
    .prepare(
      `${SELECT_TRACK} WHERE t.name LIKE ? OR t.artist LIKE ?
       GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC LIMIT ?`,
    )
    .all(like, like, limit) as TrackStats[];
}

/** Most-played tracks all-time, capped so the list never balloons to thousands.
 *  Feeds the history table when the "All time" card is selected. `plays` is all-time. */
export function getAllTimePlays(limit: number): TrackStats[] {
  return db()
    .prepare(
      `${SELECT_TRACK} GROUP BY t.id
       ORDER BY plays DESC, lastPlayed DESC, t.name ASC LIMIT ?`,
    )
    .all(limit) as TrackStats[];
}

/** All-time totals across every recorded play (for the history "All time" card). */
export function getAllTimeStats(): { plays: number; uniqueTracks: number; durationMs: number } {
  return db()
    .prepare(
      `SELECT COUNT(*) AS plays,
        COUNT(DISTINCT p.track_id) AS uniqueTracks,
        COALESCE(SUM(t.duration_ms), 0) AS durationMs
       FROM plays p JOIN tracks t ON t.id = p.track_id`,
    )
    .get() as { plays: number; uniqueTracks: number; durationMs: number };
}

/** Per-day plays / unique songs / listening time, most recent first. */
export function getDailyStats(days = 14): DayStats[] {
  return db()
    .prepare(
      `SELECT date(p.played_at, 'localtime') AS day,
        COUNT(*) AS plays,
        COUNT(DISTINCT p.track_id) AS uniqueTracks,
        COALESCE(SUM(t.duration_ms), 0) AS durationMs
       FROM plays p JOIN tracks t ON t.id = p.track_id
       GROUP BY day ORDER BY day DESC LIMIT ?`,
    )
    .all(days) as DayStats[];
}

/** Tracks played on a specific local day (YYYY-MM-DD), most-played first.
 *  `plays`/`lastPlayed`/`source` are scoped to that day, not all-time. */
export function getPlaysByDay(day: string): TrackStats[] {
  return db()
    .prepare(
      `${SELECT_TRACK}
       WHERE date(p.played_at, 'localtime') = @day
       GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC`,
    )
    .all({ day }) as TrackStats[];
}

export function getLastSync(): string | null {
  return getMeta("last_sync");
}

/** Record how many plays the most recent sync added (manual or background), so the
 *  UI / future stats can show sync activity. Single-user for now; key per user later. */
export function setLastSyncStats(added: number): void {
  setMeta("last_sync_added", String(added));
}

export function getLastSyncStats(): { added: number } | null {
  const v = getMeta("last_sync_added");
  return v == null ? null : { added: Number(v) };
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
export function storePlaylists(rows: StoredPlaylist[], meId: string | null): void {
  const conn = db();
  const del = conn.prepare("DELETE FROM playlists");
  const ins = conn.prepare(
    `INSERT INTO playlists (id, name, owner_id, image, track_count, position)
     VALUES (@id, @name, @ownerId, @image, @trackCount, @position)`,
  );
  conn.transaction(() => {
    del.run();
    rows.forEach((r, i) => ins.run({ ...r, position: i }));
  })();
  setMeta("playlists_synced_at", new Date().toISOString());
  if (meId) setMeta("me_id", meId);
}

export function getStoredPlaylists(): StoredPlaylist[] {
  return db()
    .prepare(
      `SELECT id, name, owner_id AS ownerId, image, track_count AS trackCount
       FROM playlists ORDER BY position`,
    )
    .all() as StoredPlaylist[];
}

export function getPlaylistsSyncedAt(): string | null {
  return getMeta("playlists_synced_at");
}

export function getMeId(): string | null {
  return getMeta("me_id");
}

/** Resolved name for a playback context uri, if we've cached it before. */
export function getContextName(uri: string): string | null {
  const row = db().prepare("SELECT name FROM contexts WHERE uri = ?").get(uri) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

// ---- Spotify tokens (server-side source of truth) ----
// Stored here (not just in the JWT cookie) so a single refresh, coordinated by an
// in-process lock in auth.ts, is shared across concurrent requests. Spotify's PKCE
// refresh token rotates on each use; reading the latest from here avoids the
// "concurrent refresh with a stale token → invalid_grant → forced re-login" race.
export type SpotifyTokens = { accessToken: string; refreshToken: string; expiresAt: number };

export function setSpotifyTokens(t: SpotifyTokens): void {
  setMeta("spotify_tokens", JSON.stringify(t));
}

export function getSpotifyTokens(): SpotifyTokens | null {
  const raw = getMeta("spotify_tokens");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

export function clearSpotifyTokens(): void {
  db().prepare("DELETE FROM meta WHERE key = ?").run("spotify_tokens");
}

function setMeta(key: string, value: string): void {
  db()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

function getMeta(key: string): string | null {
  const row = db().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
