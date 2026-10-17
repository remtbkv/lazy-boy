import "server-only";
import { spotifyClient } from "@/lib/spotify";
import { type UserStore } from "@/lib/db";

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
  store: UserStore,
  // Reports songs looked through so far / total songs across the owned library + Liked.
  onProgress?: (processed: number, total: number) => void,
  // `paceMs`: pause this long after each *actual* playlist-track fetch. Background syncs
  // pass a small value so the burst stays under Spotify's limit and never trips the shared
  // 429 cooldown (which would freeze now-playing/navigation). Interactive callers (clean)
  // leave it 0 for speed.
  opts: { paceMs?: number; deadline?: number } = {},
): Promise<void> {
  const paceMs = opts.paceMs ?? 0;
  // The cron's rescan stops between playlists at its deadline (multi-user PLAN §7.7): each
  // playlist is committed with its snapshot, so the next rescan skips what this one finished,
  // and the completion stamp waits for a run that reaches the end.
  const late = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  const [me, playlists] = await Promise.all([sp.me(), sp.myPlaylistsAll()]);
  await store.storePlaylists(
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
  // Track whether anything in the library actually changed this run, so the expensive
  // derived-index rebuilds below only fire when needed (not every hourly steady-state sync).
  let changed = false;
  let cut = false;
  for (const p of owned) {
    const cachedSnapshot = await store.getPlaylistSnapshot(p.id);
    if (!p.snapshot || cachedSnapshot !== p.snapshot) {
      if (late()) {
        cut = true;
        break;
      }
      const tracks = await sp.playlistTracks(p.id);
      await store.storePlaylistTracks(p.id, tracks, p.snapshot);
      changed = true;
      if (paceMs) await sleep(paceMs);
    }
    processed += p.trackCount;
    onProgress?.(processed, total);
  }

  // Liked Songs: skip the full page-through when the cheap probe matches, unless the
  // last full sync is over a day old.
  const sig = await store.getLikedSignals();
  const savedAt = await store.getSavedSyncedAt();
  const stale = !savedAt || Date.now() - Date.parse(savedAt) > LIKED_FULL_MAX_AGE_MS;
  if (!cut && (stale || sig.total !== head.total || sig.topAddedAt !== head.topAddedAt)) {
    if (late()) cut = true;
    else {
      await store.storeSavedTracks(await sp.savedTracks());
      changed = true;
    }
  }
  processed += head.total;
  onProgress?.(processed, total);

  // Refresh the cached unique-song count ONLY when the library actually changed — running
  // derived-index rebuilds on every steady-state hourly sync burned Turso row writes for
  // no benefit.
  if (changed) {
    await store.recomputeUniqueSongCount();
    // A library sync rewrites tracks' duration_ms, an input of the all-time hours — the
    // old triggers (plays landing, the daily heal) missed it, so a played track whose
    // duration arrived late kept its 10-min fallback in the totals (audit 2026-08-19,
    // T2.2). THROTTLED variant: `changed` fires on any snapshot move (a reorder counts),
    // and the unthrottled recompute made every 30-min cron scan pay a full plays scan on
    // top (wave-2 adversarial review, finding L).
    await store.maybeRecomputeAllTimeStats();
  }

  if (!cut) await store.setLibrarySyncedAt();
}
