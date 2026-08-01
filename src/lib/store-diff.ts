// Pure diff helpers for the Turso store. Turso bills every INSERT/UPDATE/DELETE as a
// "row written" — including an ON CONFLICT DO UPDATE that writes identical values — and
// the blind upsert-everything writes were burning the monthly quota (~50 identical track
// upserts per 2-minute sync tick). These compute the minimal set of rows that actually
// changed, so a steady-state sync writes ~nothing. Kept free of DB/React imports so
// they're unit-testable (see store-diff.test.ts).

export type TrackFields = {
  id: string;
  name: string;
  artist: string;
  uri: string;
  album: string | null;
  albumImage: string | null;
  durationMs: number | null;
};

/** Tracks whose cached row is missing or differs on a field the upsert would change.
 *  `uri` is intentionally NOT compared — the existing upserts never update it on
 *  conflict, so a uri-only difference would rewrite the row every sync forever.
 *  Dedupes by id (the same track appears repeatedly in a recently-played batch). */
export function tracksNeedingWrite(
  incoming: TrackFields[],
  cached: Map<string, TrackFields>,
): TrackFields[] {
  const out: TrackFields[] = [];
  const seen = new Set<string>();
  for (const t of incoming) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const c = cached.get(t.id);
    if (
      !c ||
      c.name !== t.name ||
      c.artist !== t.artist ||
      (c.album ?? null) !== (t.album ?? null) ||
      (c.albumImage ?? null) !== (t.albumImage ?? null) ||
      (c.durationMs ?? null) !== (t.durationMs ?? null)
    ) {
      out.push(t);
    }
  }
  return out;
}

/** Key for the plays-dedup set: one play = (track, timestamp). */
export function playKey(p: { trackId: string; playedAt: string }): string {
  return `${p.trackId}\n${p.playedAt}`;
}

/** Plays not already recorded (existing = set of playKey()s). */
export function newPlays<T extends { trackId: string; playedAt: string }>(
  incoming: T[],
  existing: Set<string>,
): T[] {
  return incoming.filter((p) => !existing.has(playKey(p)));
}

export type PositionRow = { trackId: string; addedAt: string | null };

/** Diff for a position-keyed list (playlist_tracks): which positions need writing, and
 *  from which position the cached tail must be deleted (null = nothing to trim). An
 *  append touches only the new positions; a mid-list removal rewrites just the shifted
 *  tail; an unchanged list touches nothing. */
export function diffPositions(
  incoming: PositionRow[],
  cached: PositionRow[],
): { changed: number[]; deleteFrom: number | null } {
  const changed: number[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const c = cached[i];
    if (
      !c ||
      c.trackId !== incoming[i].trackId ||
      (c.addedAt ?? null) !== (incoming[i].addedAt ?? null)
    ) {
      changed.push(i);
    }
  }
  return { changed, deleteFrom: cached.length > incoming.length ? incoming.length : null };
}

export type KeyedRow = { trackId: string; addedAt: string | null; position: number };

/** Diff for an id-keyed list (saved_tracks, PK track_id): rows whose added_at/position
 *  changed or that are new → upserts; cached ids no longer present → deletes. */
export function diffKeyed(
  incoming: KeyedRow[],
  cached: KeyedRow[],
): { upserts: KeyedRow[]; deletes: string[] } {
  const cachedById = new Map(cached.map((r) => [r.trackId, r]));
  const incomingIds = new Set(incoming.map((r) => r.trackId));
  const upserts = incoming.filter((r) => {
    const c = cachedById.get(r.trackId);
    return !c || (c.addedAt ?? null) !== (r.addedAt ?? null) || c.position !== r.position;
  });
  const deletes = cached.filter((r) => !incomingIds.has(r.trackId)).map((r) => r.trackId);
  return { upserts, deletes };
}
