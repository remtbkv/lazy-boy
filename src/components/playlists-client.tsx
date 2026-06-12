"use client";

import { PlaylistGrid } from "@/components/playlist-grid";
import { PlaylistsSync } from "@/components/playlists-sync";

export type PlaylistItem = {
  id: string;
  name: string;
  image: string | null;
  trackCount: number;
};

// The quick-action toolbar now lives on Home (QuickActions); this page is just the
// library grid. A background sync (PlaylistsSync) refreshes the store when it's stale.
export function PlaylistsClient({
  initialItems,
  syncedAt,
}: {
  initialItems: PlaylistItem[];
  syncedAt: string | null;
}) {
  const items = initialItems;
  const total = items.length;

  return (
    <div className="space-y-6">
      <PlaylistsSync syncedAt={syncedAt} />
      <PlaylistGrid playlists={items} total={total} loadingMore={false} />
    </div>
  );
}
