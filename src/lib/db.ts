// Listen-history store. A personal record of which tracks were played, how often,
// when, and from where. Data comes from Spotify /me/player/recently-played, synced
// on demand. Backed by libSQL (Turso) so it persists on Vercel's serverless
// runtime; falls back to a local SQLite file in dev when TURSO_DATABASE_URL is unset.
import "server-only";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client, type InStatement } from "@libsql/client";
import type { Track } from "@/lib/spotify/types";

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
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      track_id TEXT NOT NULL,
      added_at TEXT,
      PRIMARY KEY (playlist_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_pltracks_pl ON playlist_tracks (playlist_id);
    CREATE TABLE IF NOT EXISTS saved_tracks (
      track_id TEXT PRIMARY KEY,
      added_at TEXT,
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
  return plainRows(res.rows) as unknown as { uri: string; type: string }[];
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

// Estimated time *actually* listened for each play (for `plays p JOIN tracks t`): the gap
// until the next play, capped at the song's length. So a skipped/partial play counts only
// the few seconds it ran; a fully-played one counts ~its length; and stopping then resuming
// hours later is capped at the song length (not the idle gap). This corrects the old
// "every play = full song length" over-count, using only the recently-played timestamps we
// already store — no extra Spotify calls. 10-min fallback when a track's duration is unknown.
const LISTENED_MS = `MIN(
  COALESCE(t.duration_ms, 600000),
  COALESCE(
    (CAST(strftime('%s', LEAD(p.played_at) OVER (ORDER BY p.played_at)) AS INTEGER)
      - CAST(strftime('%s', p.played_at) AS INTEGER)) * 1000,
    COALESCE(t.duration_ms, 600000)
  )
)`;

/** Search history by track name or artist; "" returns most recently played. */
export async function searchHistory(query: string, limit = 100): Promise<TrackStats[]> {
  const client = await getClient();
  const q = query.trim();
  if (!q) {
    const res = await client.execute({
      sql: `${SELECT_TRACK} GROUP BY t.id ORDER BY lastPlayed DESC LIMIT ?`,
      args: [limit],
    });
    return plainRows(res.rows) as unknown as TrackStats[];
  }
  const like = `%${q}%`;
  const res = await client.execute({
    sql: `${SELECT_TRACK} WHERE t.name LIKE ? OR t.artist LIKE ?
          GROUP BY t.id ORDER BY plays DESC, lastPlayed DESC LIMIT ?`,
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
}> {
  const client = await getClient();
  const res = await client.execute(
    `WITH listened AS (
       SELECT p.track_id AS tid, ${LISTENED_MS} AS ms
       FROM plays p JOIN tracks t ON t.id = p.track_id
     )
     SELECT COUNT(*) AS plays, COUNT(DISTINCT tid) AS uniqueTracks,
       COALESCE(SUM(ms), 0) AS durationMs
     FROM listened`,
  );
  return ({ ...res.rows[0] }) as unknown as { plays: number; uniqueTracks: number; durationMs: number };
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
    sql: `WITH listened AS (
            SELECT ${localDay("p.played_at", offsetMin)} AS day, p.track_id AS tid,
              ${LISTENED_MS} AS ms
            FROM plays p JOIN tracks t ON t.id = p.track_id
          )
          SELECT day, COUNT(*) AS plays, COUNT(DISTINCT tid) AS uniqueTracks,
            COALESCE(SUM(ms), 0) AS durationMs
          FROM listened GROUP BY day ORDER BY day DESC LIMIT ?`,
    args: [days],
  });
  return plainRows(res.rows) as unknown as DayStats[];
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
          FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
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
 *  `exceptPlaylistId` excludes the clean target itself. Reads entirely from the store. */
export async function getLibraryTracks(exceptPlaylistId?: string): Promise<Track[]> {
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
      WHERE p.owner_id = :meId AND pt.playlist_id <> :except`,
    args: { meId, except: exceptPlaylistId ?? "" },
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

/** Songs in any playlist whose title matches `query` (case-insensitive substring), one
 *  row per distinct (artist, title), prefix matches first. For the Find quick-lookup. */
export async function searchPlaylistSongs(query: string, limit = 12): Promise<FoundSong[]> {
  const q = query.trim();
  if (!q) return [];
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT t.id, t.name AS title, t.artist, t.album, t.album_image AS albumImage,
            COUNT(DISTINCT pt.playlist_id) AS playlistCount
          FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
          WHERE t.name LIKE :like
          GROUP BY lower(t.artist), lower(t.name)
          ORDER BY (CASE WHEN t.name LIKE :prefix THEN 0 ELSE 1 END),
                   playlistCount DESC, t.name
          LIMIT :limit`,
    args: { like: `%${q}%`, prefix: `${q}%`, limit },
  });
  return plainRows(res.rows) as unknown as FoundSong[];
}

/** Listen history for the song matching `trackId`'s (artist, title): total plays + most
 *  recent timestamps. Keyed on artist+title so any release of the same song counts
 *  (matches the app's song identity). */
export async function getSongListens(
  trackId: string,
  limit = 12,
): Promise<{ total: number; recent: string[] }> {
  const client = await getClient();
  const keyRes = await client.execute({
    sql: "SELECT lower(artist) AS a, lower(name) AS n FROM tracks WHERE id = ?",
    args: [trackId],
  });
  if (!keyRes.rows[0]) return { total: 0, recent: [] };
  const a = String(keyRes.rows[0].a);
  const n = String(keyRes.rows[0].n);
  const [tot, rec] = await Promise.all([
    client.execute({
      sql: `SELECT COUNT(*) AS total FROM plays p JOIN tracks t ON t.id = p.track_id
            WHERE lower(t.artist) = :a AND lower(t.name) = :n`,
      args: { a, n },
    }),
    client.execute({
      sql: `SELECT p.played_at AS playedAt FROM plays p JOIN tracks t ON t.id = p.track_id
            WHERE lower(t.artist) = :a AND lower(t.name) = :n
            ORDER BY p.played_at DESC LIMIT :limit`,
      args: { a, n, limit },
    }),
  ]);
  return {
    total: Number(tot.rows[0].total),
    recent: rec.rows.map((r) => String(r.playedAt)),
  };
}

export type FoundArtist = {
  artist: string;
  songCount: number;
  albumImage: string | null;
};

/** Artists who appear in any playlist whose name matches `query`, one row per artist
 *  (case-insensitive), with how many of their songs you have and a sample image. */
export async function searchPlaylistArtists(query: string, limit = 12): Promise<FoundArtist[]> {
  const q = query.trim();
  if (!q) return [];
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT t.artist,
            COUNT(DISTINCT lower(t.name)) AS songCount,
            MAX(t.album_image) AS albumImage
          FROM tracks t JOIN playlist_tracks pt ON pt.track_id = t.id
          WHERE t.artist LIKE :like
          GROUP BY lower(t.artist)
          ORDER BY (CASE WHEN t.artist LIKE :prefix THEN 0 ELSE 1 END),
                   songCount DESC, t.artist
          LIMIT :limit`,
    args: { like: `%${q}%`, prefix: `${q}%`, limit },
  });
  return plainRows(res.rows) as unknown as FoundArtist[];
}

/** Listen history for an artist: total plays of any of their songs + recent timestamps. */
export async function getArtistListens(
  artist: string,
  limit = 12,
): Promise<{ total: number; recent: string[] }> {
  const client = await getClient();
  const a = artist.toLowerCase();
  const [tot, rec] = await Promise.all([
    client.execute({
      sql: `SELECT COUNT(*) AS total FROM plays p JOIN tracks t ON t.id = p.track_id
            WHERE lower(t.artist) = :a`,
      args: { a },
    }),
    client.execute({
      sql: `SELECT p.played_at AS playedAt FROM plays p JOIN tracks t ON t.id = p.track_id
            WHERE lower(t.artist) = :a ORDER BY p.played_at DESC LIMIT :limit`,
      args: { a, limit },
    }),
  ]);
  return {
    total: Number(tot.rows[0].total),
    recent: rec.rows.map((r) => String(r.playedAt)),
  };
}

/** The set of track ids ever played from a given playback context (e.g. a playlist
 *  URI). Resume uses this to find the *furthest* track reached in playlist order, so
 *  rewinding/skipping back doesn't move your resume point backward. */
export async function playedTrackIdsInContext(contextUri: string): Promise<Set<string>> {
  const client = await getClient();
  const res = await client.execute({
    sql: `SELECT DISTINCT track_id FROM plays WHERE context_uri = :uri`,
    args: { uri: contextUri },
  });
  return new Set(res.rows.map((r) => String(r.track_id)));
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
