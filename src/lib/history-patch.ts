// Patch the in-browser history search payload with plays that just landed, so a listen is
// searchable the moment the refresh reports it. The server payload itself is rebuilt at
// most every 10 min (db.ts, the slow marker) because a rebuild is a full plays scan
// against the primary; a landed play, though, is an APPEND, and the client already holds
// the whole index in memory — so freshness costs the delta, not a rebuild. The next cold
// load gets the reconciled server payload; mid-visit, payload + patches are the complete
// picture.
//
// Shapes are structural mirrors of den-home's HistoryPayload wire tuples and the
// TrackStats fields the patch consumes — no imports, so this stays a pure function a
// plain node run can known-answer test.

export type HistoryPayloadShape = {
  images: string[];
  albums: string[];
  sources: string[];
  tracks: [string, string, number, number, number][];
  plays: [number, number, number][];
};

export type NewPlayRow = {
  name: string;
  artist: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
  lastPlayed: string; // this play's ISO timestamp (searchHistory returns one row per play)
  source: string | null;
};

/** Returns a NEW payload with `newPlays` (newest-first, as searchHistory returns them)
 *  merged in front; plays already present — matched on (track identity, epoch minute) —
 *  are skipped, so re-applying an overlapping delta is idempotent. */
export function patchHistoryPayload(
  hist: HistoryPayloadShape,
  newPlays: NewPlayRow[],
): HistoryPayloadShape {
  const out: HistoryPayloadShape = {
    images: [...hist.images],
    albums: [...hist.albums],
    sources: [...hist.sources],
    tracks: [...hist.tracks],
    plays: hist.plays, // replaced below only if something new lands
  };
  const intern = (table: string[], v: string | null): number => {
    if (v == null || v === "") return -1;
    const at = table.indexOf(v);
    if (at >= 0) return at;
    table.push(v);
    return table.length - 1;
  };
  const trackAt = new Map<string, number>();
  out.tracks.forEach(([name, artist], i) => {
    const key = `${artist.toLowerCase()}\n${name.toLowerCase()}`;
    if (!trackAt.has(key)) trackAt.set(key, i);
  });
  // Seen-keys are IDENTITY:minute, not index:minute — the payload can hold the same song
  // under two track indices (dual Spotify ids), and an index-keyed set re-added a play the
  // payload already had under the sibling index (audit 2026-08-19, T2.5).
  const idxKey = out.tracks.map(
    ([name, artist]) => `${artist.toLowerCase()}\n${name.toLowerCase()}`,
  );
  const seen = new Set(out.plays.map(([t, m]) => `${idxKey[t] ?? t}:${m}`));

  const fresh: [number, number, number][] = [];
  for (const p of newPlays) {
    const key = `${p.artist.toLowerCase()}\n${p.name.toLowerCase()}`;
    let t = trackAt.get(key);
    if (t === undefined) {
      t = out.tracks.length;
      out.tracks.push([
        p.name,
        p.artist,
        intern(out.images, p.albumImage),
        intern(out.albums, p.album),
        // 0 = unknown, the same convention the server-built payload uses (db.ts HistoryTrack).
        p.durationMs ?? 0,
      ]);
      trackAt.set(key, t);
    }
    const minute = Math.floor(Date.parse(p.lastPlayed) / 60000);
    const id = `${key}:${minute}`;
    if (seen.has(id)) continue;
    seen.add(id);
    fresh.push([t, minute, intern(out.sources, p.source)]);
  }
  if (fresh.length === 0) return out;
  // Newest-first is a CONTRACT every consumer leans on (buildDays derives latestSource,
  // per-day fold order and `newest` from it) — so it is ENFORCED here, not assumed: the
  // delta is usually newer than the payload head, but a gap-filling sync or the backstop
  // replay can deliver older plays, and a blind prepend silently broke all three
  // derivations (wave-3 independent suite, E). Fast path when the assumption holds.
  const merged = [...fresh, ...hist.plays];
  for (let i = 1; i < merged.length; i++) {
    if (merged[i][1] > merged[i - 1][1]) {
      merged.sort((a, b) => b[1] - a[1]);
      break;
    }
  }
  out.plays = merged;
  return out;
}
