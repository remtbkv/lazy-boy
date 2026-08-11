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
      {/* The grid above renders the cached library and never calls Spotify. Keeping that cache
          current is the 2-min cron tick's job (it re-scans when the store is >30min old), so
          this is only a fallback kick: an empty store, or a cron pipeline that has stopped.
          Headless and off the render path either way — the page never waits on a scan, and
          playlists change on the order of days, so there's no live poll and no on-page churn. */}
      <PlaylistsSync syncedAt={syncedAt} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-36 pt-7 sm:px-6 sm:pb-24 sm:pt-9">
        <PlaylistsGrid playlists={playlists} owned={owned} uniqueSongs={uniqueSongs} />
      </main>
    </>
  );
}
