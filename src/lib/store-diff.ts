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

export type PlaylistListRow = {
  id: string;
  name: string;
  ownerId: string | null;
  image: string | null;
  trackCount: number;
};

export type PlaylistField = "id" | "name" | "ownerId" | "image" | "trackCount" | "count";

/** The FIRST field that differs, for the one diagnostic line storePlaylists logs. Values are
 *  truncated: this exists to name the volatile field, not to dump the list. */
export type PlaylistFieldDiff = {
  playlistId: string;
  field: PlaylistField;
  cached: string | null;
  incoming: string | null;
};

export type PlaylistListDiff = {
  /** `unchanged` → stamp meta and stop. `image-only` → per-row image UPDATEs. `rewrite` →
   *  delete-all + reinsert + purge. */
  tier: "unchanged" | "image-only" | "rewrite";
  /** Rows whose image moved, in incoming order. Meaningful for both `image-only` (it is the
   *  whole write) and `rewrite` (the reinsert carries them anyway). */
  imageChanges: { id: string; image: string | null }[];
  /** Do the cached and incoming ID SETS differ? This — not "did anything change" — is what
   *  says playlist MEMBERSHIP could have moved, and it gates the full orphan pass. */
  idSetChanged: boolean;
  firstDiff: PlaylistFieldDiff | null;
};

const DIFF_VALUE_MAX = 80;
function diffValue(v: string | number | null): string | null {
  if (v === null) return null;
  const s = String(v);
  return s.length > DIFF_VALUE_MAX ? `${s.slice(0, DIFF_VALUE_MAX)}…` : s;
}

function sameIdSet(a: PlaylistListRow[], b: PlaylistListRow[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(b.map((r) => r.id));
  return a.every((r) => ids.has(r.id));
}

/** Three-tier diff of the playlist LIST against its cache, in cached `position` order.
 *
 *  The tiers exist because the previous two-way split (identical → stamp, anything else →
 *  full rewrite) put a rotating artwork URL on the same footing as a playlist appearing or
 *  disappearing. 156 of 180 stored playlists carry `mosaic.scdn.co` art whose URL rotates, so
 *  "anything else" fired nearly every hour and dragged the delete-all rewrite and the full
 *  orphan pass with it — ~2.5M rows_read + ~640 rows_written per hour
 *  (docs/quota-forensic/PREREG.md, "The burst decomposition").
 *
 *  An image difference alone is therefore its OWN tier: it changes nothing about which
 *  playlists exist, what they are called, or who is in them. Any other difference — including
 *  a reorder, which moves the stored `position` column — is structural and still rewrites. */
export function diffPlaylistList(
  incoming: PlaylistListRow[],
  cached: PlaylistListRow[],
): PlaylistListDiff {
  const imageChanges: { id: string; image: string | null }[] = [];
  let firstDiff: PlaylistFieldDiff | null = null;
  let structural = false;

  const n = Math.max(incoming.length, cached.length);
  for (let i = 0; i < n; i++) {
    const c = cached[i];
    const r = incoming[i];
    if (!c || !r) {
      structural = true;
      firstDiff ??= {
        playlistId: (r ?? c).id,
        field: "count",
        cached: String(cached.length),
        incoming: String(incoming.length),
      };
      continue;
    }
    // Compared in the probe's original order, so `firstDiff` names the field a reader would
    // have hit first.
    const fields: [PlaylistField, string | null, string | null][] = [
      ["id", c.id, r.id],
      ["name", c.name, r.name],
      ["ownerId", c.ownerId ?? null, r.ownerId ?? null],
      ["image", c.image ?? null, r.image ?? null],
      ["trackCount", String(Number(c.trackCount)), String(r.trackCount)],
    ];
    for (const [field, a, b] of fields) {
      if (a === b) continue;
      firstDiff ??= { playlistId: r.id, field, cached: diffValue(a), incoming: diffValue(b) };
      if (field === "image") imageChanges.push({ id: r.id, image: r.image ?? null });
      else structural = true;
    }
  }

  return {
    tier: structural ? "rewrite" : imageChanges.length > 0 ? "image-only" : "unchanged",
    imageChanges,
    idSetChanged: !sameIdSet(incoming, cached),
    firstDiff,
  };
}

/** Does a playlist-list rewrite have to be followed by the UNSCOPED `recomputeOrphanFlags()`?
 *
 *  The full pass is the expensive half of that path, and it exists for one reason: the purge
 *  that follows the reinsert (`DELETE FROM playlist_tracks WHERE playlist_id NOT IN …`) can
 *  drop cached memberships, which flips the orphan verdict of plays that came from those
 *  playlists. Nothing else in a rewrite touches membership — a rename, a reorder or a drifting
 *  track_count rewrites the LIST only, and per-playlist membership edits are already covered by
 *  storePlaylistTracks' scoped `{playlistId}` pass.
 *
 *  So both conditions, not one: `purgedRows > 0` is the direct evidence memberships were
 *  dropped, and `idSetChanged` covers the case where the set moved without the purge biting
 *  (a playlist removed whose tracks were never cached, or one added). */
export function needsFullOrphanPass(idSetChanged: boolean, purgedRows: number): boolean {
  return idSetChanged || purgedRows > 0;
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
