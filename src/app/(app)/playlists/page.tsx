import { getStoredPlaylists, getPlaylistsSyncedAt, getMeId, getUniqueSongCount } from "@/lib/db";
import { PlaylistsClient } from "@/components/playlists-client";

export default async function PlaylistsPage() {
  // Served from the local store — instant. The client triggers a background sync
  // when it's empty or stale (see PlaylistsClient → PlaylistsSync).
  const [stored, syncedAt, meId, uniqueSongs] = await Promise.all([
    getStoredPlaylists(),
    getPlaylistsSyncedAt(),
    getMeId(),
    getUniqueSongCount(),
  ]);
  const items = stored.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.image,
    trackCount: p.trackCount,
  }));
  const owned = meId ? stored.filter((p) => p.ownerId === meId).length : 0;
  // Cached unique count; fall back to the raw track-count sum until it's first computed.
  const totalSongs = stored.reduce((n, p) => n + p.trackCount, 0);
  const songCount = uniqueSongs || totalSongs;

  // Library stats (moved here from Home) — rendered inline with the grid's sort control so
  // it flows straight into the listing.
  return (
    <PlaylistsClient
      initialItems={items}
      syncedAt={syncedAt}
      stats={{ playlists: stored.length, owned, songs: songCount, unique: !!uniqueSongs }}
    />
  );
}
