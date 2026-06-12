import "server-only";
import { spotifyClient } from "@/lib/spotify";
import {
  getLikedSignals,
  getPlaylistSnapshot,
  getSavedSyncedAt,
  setLibrarySyncedAt,
  storePlaylists,
  storePlaylistTracks,
  storeSavedTracks,
} from "@/lib/db";

type Spotify = ReturnType<typeof spotifyClient>;

// Re-fetch the full Liked list at least once a day even when the cheap change-probe
// says nothing moved — a safety net against the rare add+remove-in-one-window that
// leaves count and newest-added_at unchanged.
const LIKED_FULL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Build/refresh the persistent library index the clean reads from: the playlist list,
// each OWNED playlist's tracks (only re-fetched when its snapshot_id changed), and
// Liked Songs (only re-fetched when the cheap count/newest-added probe shifts). One
// `/me/playlists` sweep hands us every snapshot_id, so a steady-state run usually
// costs that sweep + a one-item Liked probe and nothing else.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function syncLibrary(
  sp: Spotify,
  // Reports songs looked through so far / total songs across the owned library + Liked.
  onProgress?: (processed: number, total: number) => void,
  // `paceMs`: pause this long after each *actual* playlist-track fetch. Background syncs
  // pass a small value so the burst stays under Spotify's limit and never trips the shared
  // 429 cooldown (which would freeze now-playing/navigation). Interactive callers (clean)
  // leave it 0 for speed.
  opts: { paceMs?: number } = {},
): Promise<void> {
  const paceMs = opts.paceMs ?? 0;
  const [me, playlists] = await Promise.all([sp.me(), sp.myPlaylistsAll()]);
  await storePlaylists(
    playlists.map((p) => ({
      id: p.id,
      name: p.name,
      ownerId: p.ownerId,
      image: p.image,
      trackCount: p.trackCount,
    })),
    me.id,
  );

  // Probe Liked up front so we know the full song total for progress.
  const head = await sp.savedTracksHead();
  const owned = playlists.filter((p) => p.ownerId === me.id);
  const total = owned.reduce((n, p) => n + p.trackCount, 0) + head.total;
  let processed = 0;
  onProgress?.(0, total);

  // Only owned playlists feed the library union; re-fetch tracks just for the ones
  // whose snapshot_id changed since we last cached them. Either way every playlist's
  // songs count toward "looked through".
  for (const p of owned) {
    const cachedSnapshot = await getPlaylistSnapshot(p.id);
    if (!p.snapshot || cachedSnapshot !== p.snapshot) {
      const tracks = await sp.playlistTracks(p.id);
      await storePlaylistTracks(p.id, tracks, p.snapshot);
      if (paceMs) await sleep(paceMs);
    }
    processed += p.trackCount;
    onProgress?.(processed, total);
  }

  // Liked Songs: skip the full page-through when the cheap probe matches, unless the
  // last full sync is over a day old.
  const sig = await getLikedSignals();
  const savedAt = await getSavedSyncedAt();
  const stale = !savedAt || Date.now() - Date.parse(savedAt) > LIKED_FULL_MAX_AGE_MS;
  if (stale || sig.total !== head.total || sig.topAddedAt !== head.topAddedAt) {
    await storeSavedTracks(await sp.savedTracks());
  }
  processed += head.total;
  onProgress?.(processed, total);

  await setLibrarySyncedAt();
}
