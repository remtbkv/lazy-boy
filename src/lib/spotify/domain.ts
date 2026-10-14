// Pure playlist logic — no network, no React. The actual product value lives here,
// so it stays testable in isolation. See docs/FEATURES.md for specs.
//
// Identity rule (ported from PlaylistManager.py): two tracks are "the same song" when
// their (primary artist, title) match, case-insensitively — NOT by Spotify id.

import type { Track } from "./types";

/** Dedupe key: primary artist + title, lowercased (JS toLowerCase by design — Spotify's
 *  own metadata is what flows in on both sides, so locale-sensitive folding like ß→ss is
 *  deliberately NOT applied). Length-prefixed so the key is injective: a plain separator
 *  could collide when a name contained the separator itself (wave-3 independent suite). */
export function keyOf(t: Track): string {
  const a = t.artist.toLowerCase();
  return `${a.length}:${a}\x00${t.title.toLowerCase()}`;
}

/** Keep the first occurrence of each (artist, title). */
export function dedupeByKey(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    const k = keyOf(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** Concatenate lists in order, then dedupe by key (merge playlists). */
export function mergeUnique(lists: Track[][]): Track[] {
  return dedupeByKey(lists.flat());
}

/** Tracks whose key is NOT present in `others` (clean / song-diff "unsaved"). */
export function subtract(tracks: Track[], others: Track[]): Track[] {
  const otherKeys = new Set(others.map(keyOf));
  return dedupeByKey(tracks).filter((t) => !otherKeys.has(keyOf(t)));
}

/** Tracks whose key IS present in `others` ("already saved" / "similar"). */
export function intersect(tracks: Track[], others: Track[]): Track[] {
  const otherKeys = new Set(others.map(keyOf));
  return dedupeByKey(tracks).filter((t) => otherKeys.has(keyOf(t)));
}

/**
 * Duplicate occurrences within a single list: every track after the first that shares
 * an (artist, title) with an earlier one.
 */
export function findDuplicates(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const dupes: Track[] = [];
  for (const t of tracks) {
    const k = keyOf(t);
    if (seen.has(k)) dupes.push(t);
    else seen.add(k);
  }
  return dupes;
}

/**
 * Positions (playlist order) of the duplicate occurrences: every track after the first that
 * shares an (artist, title) with an earlier one. The playlist page badges THESE rows, never
 * the first copy, so "remove the duplicate" targets a copy the user can lose.
 */
export function duplicatePositions(tracks: Track[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  tracks.forEach((t, i) => {
    const k = keyOf(t);
    if (seen.has(k)) out.push(i);
    else seen.add(k);
  });
  return out;
}

/**
 * Removing ONE copy of a repeated uri: Spotify's DELETE takes every occurrence, so the other
 * copies go back afterwards. Given the playlist's uris before the remove, returns the insert
 * positions for the kept copies, applied in order (each insert sees the earlier ones).
 */
export function reinsertPositions(uris: string[], uri: string, position: number): number[] {
  const out: number[] = [];
  uris.forEach((u, i) => {
    if (u === uri && i !== position) out.push(i > position ? i - 1 : i);
  });
  return out;
}
