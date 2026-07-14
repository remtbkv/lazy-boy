import { getStoredPlaylists, getMeId, getPlaylistsSyncedAt, getUniqueSongCount } from "@/lib/db";
import { PlaylistsSync } from "@/components/playlists-sync";
import { PlaylistsGrid } from "./playlists-grid";

// Playlists — the library grid. Reads the local store
// only; each tile links into the real playlist detail page (not redesigned yet).
// Auth and the chrome are the layout's job now, so this page fetches only its own data.
export const dynamic = "force-dynamic";

export default async function DraftPlaylistsPage() {
  const [playlists, meId, uniqueSongs, syncedAt] = await Promise.all([
    getStoredPlaylists(),
    getMeId(),
    getUniqueSongCount(),
    getPlaylistsSyncedAt(),
  ]);
  const owned = meId ? playlists.filter((p) => p.ownerId === meId).length : 0;

  return (
    <>
      {/* The grid renders the cached library, and nothing here was refreshing that cache — so a
          playlist you created or renamed elsewhere never showed up. Same headless kick the live
          app uses: if the store is >15min stale, start ONE background scan and get out of the
          way. Playlists change on the order of days, not minutes, so it's deliberately not a
          live poll — no on-page churn, and the new tiles are there next time you land here. */}
      <PlaylistsSync syncedAt={syncedAt} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-24 sm:pt-9">
        <PlaylistsGrid playlists={playlists} owned={owned} uniqueSongs={uniqueSongs} />
      </main>
    </>
  );
}
