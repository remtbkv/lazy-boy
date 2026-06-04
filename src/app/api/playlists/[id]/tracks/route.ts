import { auth } from "@/lib/auth";
import { spotifyClient } from "@/lib/spotify";
import { storePlaylistTracks } from "@/lib/db";

// Refreshes one playlist's cached track list from Spotify into the DB, so the detail
// page can render instantly from cache and revalidate in the background. Fired by
// PlaylistTracksDetail when the cache is empty or stale.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.accessToken || session.error) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await params;
    const tracks = await spotifyClient(session.accessToken).playlistTracks(id);
    await storePlaylistTracks(id, tracks);
    return Response.json({ ok: true, count: tracks.length });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "sync failed" },
      { status: 500 },
    );
  }
}
