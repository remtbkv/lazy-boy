// One full Spotify library scan → persistent SQLite store. Pages read from the
// store (instant, no Spotify call on render); this runs only on an explicit sync
// (stale/empty), so navigation never blocks on — or rate-limits against — Spotify.
import "server-only";
import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { storePlaylists } from "@/lib/db";

// In-process lock so overlapping sync requests (e.g. one fired per page as you
// navigate) collapse into a single scan instead of saturating the server.
let inflightSync: Promise<{ count: number }> | null = null;

export function syncPlaylistsFromSpotify(): Promise<{ count: number }> {
  if (!inflightSync) {
    inflightSync = doSync().finally(() => {
      inflightSync = null;
    });
  }
  return inflightSync;
}

async function doSync(): Promise<{ count: number }> {
  const session = await auth();
  if (!session?.accessToken || session.error) throw new Error("unauthorized");
  const sp = spotifyClient(session.accessToken);
  const [me, playlists] = await Promise.all([sp.me(), sp.myPlaylistsAll()]);
  storePlaylists(
    playlists.map((p) => ({
      id: p.id,
      name: p.name,
      ownerId: p.ownerId,
      image: p.image,
      trackCount: p.trackCount,
    })),
    me.id,
  );
  return { count: playlists.length };
}
