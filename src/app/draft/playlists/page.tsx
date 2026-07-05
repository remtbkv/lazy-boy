import { auth } from "@/lib/auth";
import { getStoredPlaylists, getUniqueSongCount, searchHistory } from "@/lib/db";
import { DenBottomNav, DenChrome } from "../chrome";
import { PlaylistsGrid } from "./playlists-grid";

// Draft playlists view — the library grid under the new skin. Reads the local store
// only; each tile links into the real playlist detail page (not redesigned yet).
export const dynamic = "force-dynamic";

export default async function DraftPlaylistsPage() {
  const [session, playlists, uniqueSongs, latest] = await Promise.all([
    auth(),
    getStoredPlaylists(),
    getUniqueSongCount(),
    searchHistory("", 1),
  ]);
  const name = session?.user?.name ?? "You";
  const image = session?.user?.image ?? null;

  // eslint-disable-next-line react-hooks/purity -- per-request liveness check
  const now = Date.now();
  const last = latest[0]?.lastPlayed ? Date.parse(latest[0].lastPlayed) : 0;
  const awake = now - last < 10 * 60_000;

  return (
    <>
      <DenChrome awake={awake} name={name} image={image} active="playlists" />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-7 sm:px-6 sm:pb-12 sm:pt-9">
        <PlaylistsGrid playlists={playlists} uniqueSongs={uniqueSongs} />
      </main>
      <DenBottomNav name={name} image={image} active="playlists" />
    </>
  );
}
