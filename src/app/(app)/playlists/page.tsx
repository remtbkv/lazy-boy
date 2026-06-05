import {
  getCleanBackupPref,
  getStoredPlaylists,
  getPlaylistsSyncedAt,
} from "@/lib/db";
import { PlaylistsClient } from "@/components/playlists-client";

export default async function PlaylistsPage() {
  // Served from the local store — instant. The client triggers a background sync
  // when it's empty or stale (see PlaylistsClient → PlaylistsSync).
  const [stored, syncedAt, backupPref] = await Promise.all([
    getStoredPlaylists(),
    getPlaylistsSyncedAt(),
    getCleanBackupPref(),
  ]);
  const items = stored.map((p) => ({
    id: p.id,
    name: p.name,
    image: p.image,
    trackCount: p.trackCount,
  }));

  return (
    <div className="space-y-8">
      {/* The nav already says "Playlists" — don't repeat it. Promote the description
          to the page heading instead. */}
      <h1 className="text-4xl font-bold tracking-tight">Do stuff</h1>

      <PlaylistsClient initialItems={items} syncedAt={syncedAt} backupPref={backupPref} />
    </div>
  );
}