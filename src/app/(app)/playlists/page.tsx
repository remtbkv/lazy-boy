import { getStoredPlaylists, getPlaylistsSyncedAt } from "@/lib/db";
import { PlaylistsClient } from "@/components/playlists-client";

export default async function PlaylistsPage() {
  // Served from the local store — instant. The client triggers a background sync
  // when it's empty or stale (see PlaylistsClient → PlaylistsSync).
  const items = getStoredPlaylists().map((p) => ({
    id: p.id,
    name: p.name,
    image: p.image,
    trackCount: p.trackCount,
  }));
  const syncedAt = getPlaylistsSyncedAt();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Playlists</h1>
        <p className="mt-1 text-muted-foreground">
          Quick actions and your full library.
        </p>
      </div>

      <PlaylistsClient initialItems={items} syncedAt={syncedAt} />
    </div>
  );
}
