// The Liked Songs change for a friend with thousands (docs/multi-user/PLAN.md §7.7, scale 3). Pure;
// known answers in tests/liked-diff.test.ts.
//
// Today `storeSavedTracks` diffs on (added_at, position) (store-diff.ts `diffKeyed`), and Spotify
// lists Liked newest first, so one like moves every row's position and rewrites all N rows, though
// nothing reads `position`; and any change in the count or the newest added_at refetches the whole
// list. Here position is out of the diff, so a like writes one row, and the list is read from the
// newest page until a stored (track, added_at) appears, with a full refetch only when the count
// still disagrees afterwards. Phase 3's turn swaps the calls in `storeSavedTracks` and the
// library scan (store-diff.ts is lane 1910's file).

export type LikedRow = { trackId: string; addedAt: string | null };

const pair = (r: LikedRow) => `${r.trackId}\n${r.addedAt ?? ""}`;

/** Rows new or with a moved added_at → upserts; stored ids no longer liked → deletes. */
export function likedDiff(incoming: LikedRow[], stored: LikedRow[]): { upserts: LikedRow[]; deletes: string[] } {
  const byId = new Map(stored.map((r) => [r.trackId, r.addedAt ?? null]));
  const ids = new Set(incoming.map((r) => r.trackId));
  return {
    upserts: incoming.filter((r) => !byId.has(r.trackId) || byId.get(r.trackId) !== (r.addedAt ?? null)),
    deletes: stored.filter((r) => !ids.has(r.trackId)).map((r) => r.trackId),
  };
}

export type LikedHeadVerdict =
  /** No stored row in what has been read: read the next page. */
  | { kind: "more" }
  /** Write these. */
  | { kind: "diff"; upserts: LikedRow[]; deletes: string[] }
  /** Something the head cannot see changed (an unlike): refetch the whole list. */
  | { kind: "refetch" };

/** After each page of `/me/tracks`, newest first: `read` is every row so far, `total` Spotify's
 *  count, `exhausted` whether the last page had no `next`. */
export function likedHead(read: LikedRow[], total: number, stored: LikedRow[], exhausted: boolean): LikedHeadVerdict {
  const storedPairs = new Set(stored.map(pair));
  const met = read.findIndex((r) => storedPairs.has(pair(r)));
  if (met === -1) return exhausted ? { kind: "diff", ...likedDiff(read, stored) } : { kind: "more" };
  const head = read.slice(0, met);
  const storedIds = new Set(stored.map((r) => r.trackId));
  const after = stored.length + head.filter((r) => !storedIds.has(r.trackId)).length;
  if (after === total) return { kind: "diff", upserts: head, deletes: [] };
  return exhausted ? { kind: "diff", ...likedDiff(read, stored) } : { kind: "refetch" };
}
