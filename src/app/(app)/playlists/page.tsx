import { requirePageUser } from "@/lib/require-user";
import { forUser } from "@/lib/db";
import { PlaylistsSync } from "@/components/playlists-sync";
import { PlaylistsGrid } from "./playlists-grid";

// Playlists — the library grid. Reads the local store
// only; each tile links into the real playlist detail page (not redesigned yet).
// The chrome is the layout's job; the auth gate below is this page's own (see the note on it).
export const dynamic = "force-dynamic";

export default async function DraftPlaylistsPage() {
  // The (app) layout's redirect is NOT this page's gate. Next renders a layout and its page
  // in PARALLEL, so the page's fetches run and its flight payload is flushed into the body
  // of the layout's 307 — measured 2026-08-11: an unauthenticated
  // `curl https://lazy-spotify.vercel.app/playlists` returned 70KB containing every playlist
  // name and cover URL alongside `location: /login`. Every page that reads personal data
  // gates for itself, BEFORE it reads any (never in a Promise.all with the reads — that
  // fetches them anyway).
  // requirePageUser: refused → /login; identity check down → a retryable error, never a read.
  // A dead Spotify grant still goes to /login (multi-user PLAN.md §5.4, decision 20).
  const store = forUser((await requirePageUser()).uid);

  const [playlists, meId, uniqueSongs, syncedAt] = await Promise.all([
    store.getStoredPlaylists(),
    store.getMeId(),
    store.getUniqueSongCount(),
    store.getPlaylistsSyncedAt(),
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-24 pt-7 sm:px-6 sm:pb-24 sm:pt-9">
        <PlaylistsGrid playlists={playlists} owned={owned} uniqueSongs={uniqueSongs} />
      </main>
    </>
  );
}
