// A friend's database at today's version (docs/multi-user/PLAN.md §4.1, §4.5, §12.1): the seven
// core tables with today's columns, keys and indexes, and the four `meta` keys every user
// database holds. Data only, importing nothing, so `scripts/invite.mjs` provisions `lb-u-<uid>`
// on the Mac with exactly these statements. tests/isolation/user-schema.test.ts holds them equal
// to what db.ts's init() builds, so the two cannot drift apart unnoticed. Phase 1's turn moves
// db.ts onto versioned steps (USER_SCHEMA there); this list then becomes its first version.

export const USER_SCHEMA_VERSION = 1;

export const USER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    artist TEXT NOT NULL,
    uri TEXT NOT NULL,
    album TEXT,
    album_image TEXT,
    duration_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    played_at TEXT NOT NULL,
    context_type TEXT,
    context_uri TEXT,
    ctx_orphan INTEGER,
    skipped INTEGER,
    UNIQUE (track_id, played_at)
  )`,
  `CREATE TABLE IF NOT EXISTS contexts (uri TEXT PRIMARY KEY, name TEXT, type TEXT, checked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_plays_track ON plays (track_id)`,
  `CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays (played_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_artist_name ON tracks (lower(artist), lower(name))`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT,
    image TEXT,
    track_count INTEGER,
    position INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    added_at TEXT,
    PRIMARY KEY (playlist_id, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pltracks_pl ON playlist_tracks (playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pltracks_track ON playlist_tracks (track_id)`,
  `CREATE TABLE IF NOT EXISTS saved_tracks (
    track_id TEXT PRIMARY KEY,
    added_at TEXT,
    position INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plays_skip_null ON plays (played_at) WHERE skipped IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_plays_context ON plays (context_uri)`,
  `CREATE INDEX IF NOT EXISTS idx_plays_orphan_null ON plays (id) WHERE ctx_orphan IS NULL`,
];

/** The four keys of §4.5: whose database this is, its version, the oldest code that may read it,
 *  and a random store epoch. Written once: a re-run of a crashed provisioning keeps the first. */
export function userMetaStatement(uid: string, storeEpoch: string): { sql: string; args: Record<string, string> } {
  return {
    sql: `INSERT INTO meta (key, value) VALUES ('owner_uid', :uid), ('schema_version', :v), ('min_reader', :v), ('store_epoch', :e)
          ON CONFLICT(key) DO NOTHING`,
    args: { uid, v: String(USER_SCHEMA_VERSION), e: storeEpoch },
  };
}
